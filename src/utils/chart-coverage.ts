/**
 * Where a chart hides the charts beneath it, published as the chart
 * resource's `coverage` so a plotter can skip their tiles there (see
 * `docs/chart-coverage.md`): the Web Mercator tiles the chart fills
 * entirely, a parent standing for its four children. The converters write
 * it into the MBTiles `metadata` table at build time; the loader passes it
 * through.
 */

import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';
import { union, type Geom } from 'polyclip-ts';

export const COVERAGE_METADATA_KEY = 'coverage';

const Zoom = Type.Integer({ minimum: 0, maximum: 30 });

export const ChartCoverageSchema = Type.Array(
  Type.Object({
    /** The first zoom the chart draws these tiles opaquely at. */
    minzoom: Zoom,
    /** The last such zoom; without it, every zoom above, overzoom included. */
    maxzoom: Type.Optional(Zoom),
    /** `z/x/y` of each tile filled entirely (XYZ rows, from the north). */
    tiles: Type.Array(Type.String({ pattern: '^[0-9]{1,2}/[0-9]{1,10}/[0-9]{1,10}$' }), {
      minItems: 1
    })
  }),
  { minItems: 1 }
);

export type ChartCoverage = Static<typeof ChartCoverageSchema>;
export type CoverageEntry = ChartCoverage[number];
/** A GeoJSON polygon's rings, in longitude and latitude. */
export type CoveragePolygon = [number, number][][];

export interface TileXY {
  x: number;
  y: number;
}

const MAX_MERCATOR_LAT = 85.0511287798066;
// Edges within this share of a tile of its border count as on it: coverage
// drawn along tile borders meets them only up to rounding.
const BORDER_EPSILON = 1e-6;

/**
 * Tiles at zoom `z`, with every four siblings all present replaced by
 * their parent, down to zoom 0.
 */
export function mergeTiles(tiles: Iterable<TileXY>, z: number): string[] {
  const key = (t: TileXY): string => `${String(t.x)}/${String(t.y)}`;
  const parentOf = (t: TileXY): TileXY => ({ x: t.x >> 1, y: t.y >> 1 });
  const out: string[] = [];
  let level = new Map<string, TileXY>();
  for (const t of tiles) {
    level.set(key(t), t);
  }
  for (let zoom = z; zoom > 0; zoom--) {
    const parents = new Map<string, TileXY>();
    for (const t of level.values()) {
      const parent = parentOf(t);
      const children = [0, 1].flatMap((dy) =>
        [0, 1].map((dx) => key({ x: parent.x * 2 + dx, y: parent.y * 2 + dy }))
      );
      if (children.every((k) => level.has(k))) {
        parents.set(key(parent), parent);
      }
    }
    for (const t of level.values()) {
      if (!parents.has(key(parentOf(t)))) {
        out.push(`${String(zoom)}/${key(t)}`);
      }
    }
    level = parents;
  }
  out.push(...[...level.values()].map((t) => `0/${key(t)}`));
  return out.sort();
}

function project([lon, lat]: [number, number], n: number): [number, number] {
  const clamped = Math.max(-MAX_MERCATOR_LAT, Math.min(MAX_MERCATOR_LAT, lat));
  const rad = (clamped * Math.PI) / 180;
  return [((lon + 180) / 360) * n, ((1 - Math.asinh(Math.tan(rad)) / Math.PI) / 2) * n];
}

type Interval = [number, number];

function insideAt(edges: readonly number[][], y: number): Interval[] {
  const xs: number[] = [];
  for (const [x1, y1, x2, y2] of edges) {
    if (y1 <= y !== y2 <= y) {
      xs.push(x1 + ((y - y1) / (y2 - y1)) * (x2 - x1));
    }
  }
  xs.sort((a, b) => a - b);
  const intervals: Interval[] = [];
  for (let i = 0; i + 1 < xs.length; i += 2) {
    intervals.push([xs[i], xs[i + 1]]);
  }
  return intervals;
}

function intersect(a: readonly Interval[], b: readonly Interval[]): Interval[] {
  const out: Interval[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const lo = Math.max(a[i][0], b[j][0]);
    const hi = Math.min(a[i][1], b[j][1]);
    if (lo < hi) {
      out.push([lo, hi]);
    }
    if (a[i][1] < b[j][1]) {
      i++;
    } else {
      j++;
    }
  }
  return out;
}

function subtract(from: readonly Interval[], cuts: Interval[]): Interval[] {
  cuts.sort((a, b) => a[0] - b[0]);
  let out = [...from];
  for (const [lo, hi] of cuts) {
    out = out.flatMap(([a, b]): Interval[] =>
      hi <= a || lo >= b
        ? [[a, b]]
        : [...(a < lo ? [[a, lo] as Interval] : []), ...(hi < b ? [[hi, b] as Interval] : [])]
    );
  }
  return out;
}

/**
 * The tiles at zoom `z` that `area`, in tile units scaled by `scale` to
 * zoom `z`, fills entirely. A row of tiles is filled where both its
 * borders lie inside and no edge enters it.
 */
function filledTiles(area: Geom[], z: number, scale: number): TileXY[] {
  const n = 2 ** z;
  const rows = new Map<number, number[][]>();
  for (const polygon of area as CoveragePolygon[]) {
    for (const ring of polygon) {
      const points = ring.map(([x, y]) => [x * scale, y * scale]);
      for (let i = 0; i + 1 < points.length; i++) {
        const edge = [...points[i], ...points[i + 1]];
        const top = Math.min(edge[1], edge[3]);
        const bottom = Math.max(edge[1], edge[3]);
        for (let row = Math.floor(top); row <= Math.min(n - 1, Math.floor(bottom)); row++) {
          const list = rows.get(row) ?? [];
          list.push(edge);
          rows.set(row, list);
        }
      }
    }
  }
  const tiles: TileXY[] = [];
  for (const [row, edges] of rows) {
    const top = row + BORDER_EPSILON;
    const bottom = row + 1 - BORDER_EPSILON;
    const entering: Interval[] = [];
    for (const [x1, y1, x2, y2] of edges) {
      const lo = Math.max(top, Math.min(y1, y2));
      const hi = Math.min(bottom, Math.max(y1, y2));
      if (lo > hi) {
        continue;
      }
      const at = (y: number): number => (y1 === y2 ? x1 : x1 + ((y - y1) / (y2 - y1)) * (x2 - x1));
      const xs = y1 === y2 ? [x1, x2] : [at(lo), at(hi)];
      entering.push([Math.min(...xs), Math.max(...xs)]);
    }
    const filled = subtract(intersect(insideAt(edges, top), insideAt(edges, bottom)), entering);
    for (const [a, b] of filled) {
      const firstColumn = Math.ceil(a - BORDER_EPSILON);
      const lastColumn = Math.floor(b + BORDER_EPSILON) - 1;
      for (let x = Math.max(0, firstColumn); x <= Math.min(n - 1, lastColumn); x++) {
        tiles.push({ x, y: row });
      }
    }
  }
  return tiles;
}

/**
 * The tiles the union of `polygons` fills entirely, found at zoom `z` and
 * merged as by `mergeTiles`. While that lists more than `maxTiles`, they
 * are found one zoom less deep. Throws when the polygons cannot be merged.
 */
export function polygonTiles(
  polygons: readonly CoveragePolygon[],
  z: number,
  maxTiles = Infinity
): string[] {
  if (polygons.length === 0) {
    return [];
  }
  // Tilers draw edges straight in Web Mercator, and the union drops vertices
  // that lie on a straight line: projected first, it keeps the edges the
  // tiles show.
  const n = 2 ** z;
  const projected = polygons.map((polygon) =>
    polygon.map((ring) => ring.map((point) => project(point, n)))
  ) as Geom[];
  const [first, ...rest] = projected;
  const area = union(first, ...rest);
  for (let zoom = z; ; zoom--) {
    const tiles = mergeTiles(filledTiles(area, zoom, 2 ** (zoom - z)), zoom);
    if (tiles.length <= maxTiles || zoom === 0) {
      return tiles;
    }
  }
}

/** The `coverage` metadata value, or undefined when absent or unreadable. */
export function parseCoverage(value: unknown): ChartCoverage | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return Value.Check(ChartCoverageSchema, parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}
