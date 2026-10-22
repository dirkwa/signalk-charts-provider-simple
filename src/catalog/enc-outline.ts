/**
 * Map outlines for the ENC index: an S-57 cell's `M_COVR` coverage reduced
 * to something small enough to draw and click on a map.
 *
 * The index is built both on a maintainer's machine and in CI, and the two
 * must agree byte for byte or every run would see "changes" everywhere. So
 * the reduction is fixed (one tolerance, one rounding) and uses only
 * arithmetic whose result IEEE 754 pins down, never trigonometry.
 */

export type Position = [number, number];
/** A closed ring: the first and last positions are equal. */
export type Ring = Position[];

export interface PolygonGeometry {
  type: 'Polygon';
  coordinates: Ring[];
}

export interface MultiPolygonGeometry {
  type: 'MultiPolygon';
  coordinates: Ring[][];
}

export type OutlineGeometry = PolygonGeometry | MultiPolygonGeometry;

/** [west, south, east, north] in degrees. */
export type Bbox = [number, number, number, number];

/**
 * Douglas-Peucker tolerance in degrees, about 11 m north-south. Inland
 * cells follow rivers a few hundred metres wide, so a coarser tolerance
 * starts to cut the river out of its own outline.
 */
export const OUTLINE_TOLERANCE = 0.0001;

/** Decimal places kept in published coordinates (about 1 m). */
export const OUTLINE_DECIMALS = 5;

const SCALE = 10 ** OUTLINE_DECIMALS;

export function roundCoord(value: number): number {
  // `+ 0` turns -0 into 0, so it serialises the same as 0.
  return Math.round(value * SCALE) / SCALE + 0;
}

/**
 * A position rounded and kept on the globe. A producer's coverage can poke
 * a little past ±180°, and one such point must not make the whole index
 * fail validation.
 */
function finishPosition([lon, lat]: Position): Position {
  return [
    Math.min(180, Math.max(-180, roundCoord(lon))),
    Math.min(90, Math.max(-90, roundCoord(lat)))
  ];
}

function squaredSegmentDistance(p: Position, a: Position, b: Position): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lengthSq = dx * dx + dy * dy;
  let x = a[0];
  let y = a[1];
  if (lengthSq > 0) {
    const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lengthSq;
    if (t >= 1) {
      x = b[0];
      y = b[1];
    } else if (t > 0) {
      x += dx * t;
      y += dy * t;
    }
  }
  const ex = p[0] - x;
  const ey = p[1] - y;
  return ex * ex + ey * ey;
}

/**
 * Douglas-Peucker over a polyline, keeping both ends. A closed ring works
 * as-is: its two ends are the same point, so the first split falls on the
 * point farthest from it.
 */
export function simplifyLine(points: readonly Position[], tolerance: number): Position[] {
  if (points.length <= 2) {
    return [...points];
  }
  const keep = new Array<boolean>(points.length).fill(false);
  keep[0] = true;
  keep[points.length - 1] = true;
  const toleranceSq = tolerance * tolerance;
  // An explicit stack: a river outline can have tens of thousands of
  // points, which would overflow a recursive version.
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop() as [number, number];
    let maxSq = 0;
    let index = -1;
    for (let i = first + 1; i < last; i++) {
      const d = squaredSegmentDistance(points[i], points[first], points[last]);
      if (d > maxSq) {
        maxSq = d;
        index = i;
      }
    }
    if (index !== -1 && maxSq > toleranceSq) {
      keep[index] = true;
      stack.push([first, index], [index, last]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

function dropRepeats(points: readonly Position[]): Position[] {
  return points.filter((p, i) => i === 0 || p[0] !== points[i - 1][0] || p[1] !== points[i - 1][1]);
}

function ringBbox(ring: readonly Position[]): Bbox {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const [lon, lat] of ring) {
    west = Math.min(west, lon);
    south = Math.min(south, lat);
    east = Math.max(east, lon);
    north = Math.max(north, lat);
  }
  return [west, south, east, north];
}

/** A closed rectangle ring for a bbox, counter-clockwise from the south-west corner. */
export function bboxRing([west, south, east, north]: Bbox): Ring {
  return [
    [west, south],
    [east, south],
    [east, north],
    [west, north],
    [west, south]
  ];
}

/**
 * Simplify and round one ring. A ring smaller than the tolerance would
 * collapse to a line, so it becomes its rounded bounding box instead and
 * stays clickable; one that is still degenerate after that is dropped.
 */
export function reduceRing(ring: readonly Position[]): Ring | null {
  const finite = ring.filter(
    (p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])
  );
  if (finite.length < 3) {
    return null;
  }
  const closed =
    finite[0][0] === finite[finite.length - 1][0] && finite[0][1] === finite[finite.length - 1][1]
      ? finite
      : [...finite, finite[0]];
  const reduced = dropRepeats(simplifyLine(closed, OUTLINE_TOLERANCE).map(finishPosition));
  if (reduced.length >= 4) {
    return reduced;
  }
  const box = ringBbox(closed);
  const [west, south] = finishPosition([box[0], box[1]]);
  const [east, north] = finishPosition([box[2], box[3]]);
  return west < east && south < north ? bboxRing([west, south, east, north]) : null;
}

/** Bounding box of every position in an outline. */
export function outlineBbox(outline: OutlineGeometry): Bbox {
  const rings = outline.type === 'Polygon' ? outline.coordinates : outline.coordinates.flat();
  return ringBbox(rings.flat());
}

/**
 * The outline of a cell from its `M_COVR` coverage polygons (CATCOV not 2),
 * each given as GeoJSON polygon rings. Only exterior rings are kept: holes
 * in coverage are rare and do not matter for picking a cell on a map.
 * Polygons that reduce to the same ring (producers sometimes repeat a
 * coverage object) appear once. Returns null when nothing usable is left.
 */
export function outlineFromCoverage(polygons: readonly (readonly Position[][])[]): {
  outline: OutlineGeometry;
  bbox: Bbox;
} | null {
  const rings: Ring[] = [];
  const seen = new Set<string>();
  for (const polygon of polygons) {
    const exterior = polygon[0] as Position[] | undefined;
    const ring = exterior ? reduceRing(exterior) : null;
    if (!ring) {
      continue;
    }
    const key = JSON.stringify(ring);
    if (!seen.has(key)) {
      seen.add(key);
      rings.push(ring);
    }
  }
  if (rings.length === 0) {
    return null;
  }
  const outline: OutlineGeometry =
    rings.length === 1
      ? { type: 'Polygon', coordinates: [rings[0]] }
      : { type: 'MultiPolygon', coordinates: rings.map((r) => [r]) };
  return { outline, bbox: outlineBbox(outline) };
}
