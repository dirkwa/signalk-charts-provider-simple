/**
 * Worker side of the vector tiler (vector-tiler.ts), in three steps:
 *
 * 1. `bucketFeatures` reads GeoJSON files and sorts their features into
 *    shards. A shard is the subtree of the tile pyramid under one tile at its
 *    group's minzoom; a feature goes into every shard its bounding box (plus
 *    the tile buffer) reaches. A group is an output layer with the zoom range
 *    its features show at.
 * 2. `tileShard` turns one shard into encoded Mapbox Vector Tiles: one
 *    geojson-vt index per group, walked depth-first over the subtree,
 *    emitting a tile wherever a group in range has features, and dropping
 *    visited tiles from the indexes as it goes, so a shard's memory stays at
 *    its features plus one path of the pyramid.
 * 3. `mergeTiles` combines tiles that shards of different minzooms both
 *    produced (zoom ranges of chart bands overlap), merging same-named
 *    layers feature by feature.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { VectorTile } from '@mapbox/vector-tile';
import GeoJSONVT, { type LegacyFeature, type RawFeature } from 'geojson-vt';
import { PbfReader } from 'pbf';
import { fromGeojsonVt, fromVectorTileJs } from 'vt-pbf';
import { forEachLine } from './line-reader.js';
import { scaminMinzoom } from './s57-scamin.js';

export interface ShardGroup {
  /** Output layer name; several groups may share one. */
  layer: string;
  minzoom: number;
  maxzoom: number;
  /**
   * S-57 features: a feature with a SCAMIN appears only from the zoom S-52
   * shows it at (s57-scamin.ts), within the group's zooms.
   */
  scamin?: boolean;
}

// The property a feature's own minzoom travels in, from bucketing to the
// tiles; never written to a tile.
const FEATURE_MINZOOM_KEY = '\u0000minzoom';

export interface ShardTask {
  /** The shard's part files, one per bucketing task that wrote to it. */
  files: string[];
  /** Indexed by the group number on each line of `files`. */
  groups: ShardGroup[];
  z: number;
  x: number;
  y: number;
  extent: number;
  buffer: number;
  /** Gzip each tile, ready for the MBTiles; false leaves them for `mergeTiles`. */
  gzip: boolean;
  /**
   * Emit only the shard's own tile, and count the features reaching each of
   * its four children, so that a caller short of memory can tile the
   * children as shards of their own.
   */
  rootOnly?: boolean;
}

export interface ShardResult {
  tiles: number;
  /**
   * With `rootOnly`: NDJSON bytes of the features reaching each child,
   * in the order (2x, 2y), (2x + 1, 2y), (2x, 2y + 1), (2x + 1, 2y + 1).
   */
  quarters?: [number, number, number, number];
}

/** One encoded, uncompressed tile; `y` counts from the top (XYZ). */
export interface EncodedTile {
  z: number;
  x: number;
  y: number;
  data: Uint8Array;
}

// Tiles handed back per message: large enough to amortize the message, small
// enough that a shard's output never piles up in the worker.
const EMIT_BATCH = 256;

interface GroupIndex {
  layer: string;
  minzoom: number;
  maxzoom: number;
  index: GeoJSONVT;
}

interface VisitedTile {
  vz: number;
  vx: number;
  vy: number;
  groups: GroupIndex[];
}

// geojson-vt's tile id (its `toID`), for dropping visited tiles.
const tileId = (z: number, x: number, y: number): number => ((1 << z) * y + x) * 32 + z;

/*
 * Re-rooting. geojson-vt always starts from the world tile, so a shard at
 * z12 would clip and transform its features through twelve levels before
 * reaching the shard's own tile, which is most of its work. Instead each
 * shard's coordinates are rescaled so that its tile becomes the z3 tile
 * (3, 3, 3): tile (3 + d, 3·2^d + i, 3·2^d + j) of the rescaled index is tile
 * (z + d, x·2^d + i, y·2^d + j) of the shard. Rescaling by a power of two keeps
 * every tile boundary, so the tiles come out the same, after three levels of
 * drilling instead of z.
 *
 * Features are first clipped to the shard plus its buffer — exactly where
 * geojson-vt would clip them at the shard's own tile — so nothing reaches
 * past the rescaled world's edge, where geojson-vt would clamp it or wrap a
 * copy across the antimeridian. (3, 3, 3) keeps the shard and its buffer
 * clear of the wrap zone.
 */
const ROOT_Z = 3;
const ROOT_XY = 3;

/** A position in shard units: the shard's tile spans [0, 1] on both axes. */
type ShardPoint = [number, number];

// Keep the part of a ring / line on one side of `axis = k`.
function intersect(a: ShardPoint, b: ShardPoint, axis: 0 | 1, k: number): ShardPoint {
  const t = (k - a[axis]) / (b[axis] - a[axis]);
  return axis === 0 ? [k, a[1] + (b[1] - a[1]) * t] : [a[0] + (b[0] - a[0]) * t, k];
}

function clipRingHalf(ring: ShardPoint[], axis: 0 | 1, k: number, above: boolean): ShardPoint[] {
  const inside = (p: ShardPoint): boolean => (above ? p[axis] >= k : p[axis] <= k);
  const out: ShardPoint[] = [];
  for (let i = 0; i < ring.length; i++) {
    const cur = ring[i];
    const prev = ring[(i + ring.length - 1) % ring.length];
    if (inside(cur)) {
      if (!inside(prev)) {
        out.push(intersect(prev, cur, axis, k));
      }
      out.push(cur);
    } else if (inside(prev)) {
      out.push(intersect(prev, cur, axis, k));
    }
  }
  return out;
}

/** Sutherland–Hodgman against the window; null when nothing is left. */
function clipRing(ring: ShardPoint[], lo: number, hi: number): ShardPoint[] | null {
  // Work on the open ring; GeoJSON repeats the first position at the end.
  let open = ring.slice(0, -1);
  for (const [axis, k, above] of [
    [0, lo, true],
    [0, hi, false],
    [1, lo, true],
    [1, hi, false]
  ] as const) {
    open = clipRingHalf(open, axis, k, above);
    if (open.length < 3) {
      return null;
    }
  }
  return [...open, open[0]];
}

function clipLineHalf(line: ShardPoint[], axis: 0 | 1, k: number, above: boolean): ShardPoint[][] {
  const inside = (p: ShardPoint): boolean => (above ? p[axis] >= k : p[axis] <= k);
  const pieces: ShardPoint[][] = [];
  let piece: ShardPoint[] = [];
  for (let i = 0; i < line.length; i++) {
    const cur = line[i];
    if (i > 0) {
      const prev = line[i - 1];
      if (inside(prev) !== inside(cur)) {
        const cut = intersect(prev, cur, axis, k);
        if (inside(cur)) {
          piece = [cut];
        } else {
          piece.push(cut);
          pieces.push(piece);
          piece = [];
        }
      }
    }
    if (inside(cur)) {
      piece.push(cur);
    }
  }
  if (piece.length > 0) {
    pieces.push(piece);
  }
  return pieces.filter((p) => p.length >= 2);
}

function clipLine(line: ShardPoint[], lo: number, hi: number): ShardPoint[][] {
  let pieces = [line];
  for (const [axis, k, above] of [
    [0, lo, true],
    [0, hi, false],
    [1, lo, true],
    [1, hi, false]
  ] as const) {
    pieces = pieces.flatMap((p) => clipLineHalf(p, axis, k, above));
  }
  return pieces;
}

interface ShardFrame {
  scale: number;
  x: number;
  y: number;
  /** Window in shard units: the shard's tile plus its buffer. */
  lo: number;
  hi: number;
  /**
   * Grid points per shard unit to snap positions to: the grid of the only
   * tile drawn from them, so they come out where they would have anyway.
   */
  grid?: number;
}

function snap(p: ShardPoint, grid: number | undefined): ShardPoint {
  return grid === undefined ? p : [Math.round(p[0] * grid) / grid, Math.round(p[1] * grid) / grid];
}

/** Snapped, without a position equal to the one before it. */
function snapPath(points: readonly ShardPoint[], grid: number | undefined): ShardPoint[] {
  if (grid === undefined) {
    return [...points];
  }
  const out: ShardPoint[] = [];
  for (const p of points) {
    const q = snap(p, grid);
    const last = out.at(-1);
    if (!last || last[0] !== q[0] || last[1] !== q[1]) {
      out.push(q);
    }
  }
  return out;
}

/** A closed ring snapped; null when no area is left. */
function snapRing(ring: ShardPoint[], grid: number | undefined): ShardPoint[] | null {
  if (grid === undefined) {
    return ring;
  }
  const out = snapPath(ring, grid);
  let area = 0;
  for (let i = 1; i < out.length; i++) {
    area += out[i - 1][0] * out[i][1] - out[i][0] * out[i - 1][1];
  }
  return out.length >= 4 && area !== 0 ? out : null;
}

function toShard(pos: GeoJSON.Position, frame: ShardFrame): ShardPoint {
  return [mercX(pos[0]) * frame.scale - frame.x, mercY(pos[1]) * frame.scale - frame.y];
}

/** Shard units → longitude/latitude of the re-rooted world. */
function toRerooted([u, v]: ShardPoint): GeoJSON.Position {
  const vx = (u + ROOT_XY) / (1 << ROOT_Z);
  const vy = (v + ROOT_XY) / (1 << ROOT_Z);
  return [vx * 360 - 180, (Math.atan(Math.sinh(Math.PI * (1 - 2 * vy))) * 180) / Math.PI];
}

const inWindow = (p: ShardPoint, frame: ShardFrame): boolean =>
  p[0] >= frame.lo && p[0] <= frame.hi && p[1] >= frame.lo && p[1] <= frame.hi;

function rerootPolygon(
  rings: GeoJSON.Position[][],
  frame: ShardFrame
): GeoJSON.Position[][] | null {
  const out: GeoJSON.Position[][] = [];
  for (const [i, ring] of rings.entries()) {
    const clipped = clipRing(
      ring.map((p) => toShard(p, frame)),
      frame.lo,
      frame.hi
    );
    const snapped = clipped && snapRing(clipped, frame.grid);
    if (!snapped) {
      if (i === 0) {
        // The outer ring is outside the shard: so is the whole polygon.
        return null;
      }
      continue;
    }
    out.push(snapped.map(toRerooted));
  }
  return out;
}

/** The geometry clipped to the shard and re-rooted; null when nothing is left. */
function rerootGeometry(geometry: GeoJSON.Geometry, frame: ShardFrame): GeoJSON.Geometry | null {
  switch (geometry.type) {
    case 'Point': {
      const p = toShard(geometry.coordinates, frame);
      return inWindow(p, frame)
        ? { type: 'Point', coordinates: toRerooted(snap(p, frame.grid)) }
        : null;
    }
    case 'MultiPoint': {
      const points = geometry.coordinates
        .map((c) => toShard(c, frame))
        .filter((p) => inWindow(p, frame))
        .map((p) => toRerooted(snap(p, frame.grid)));
      return points.length > 0 ? { type: 'MultiPoint', coordinates: points } : null;
    }
    case 'LineString':
    case 'MultiLineString': {
      const lines = geometry.type === 'LineString' ? [geometry.coordinates] : geometry.coordinates;
      const pieces = lines.flatMap((line) =>
        clipLine(
          line.map((p) => toShard(p, frame)),
          frame.lo,
          frame.hi
        )
          .map((piece) => snapPath(piece, frame.grid))
          .filter((piece) => piece.length >= 2)
          .map((piece) => piece.map(toRerooted))
      );
      return pieces.length > 0 ? { type: 'MultiLineString', coordinates: pieces } : null;
    }
    case 'Polygon': {
      const rings = rerootPolygon(geometry.coordinates, frame);
      return rings ? { type: 'Polygon', coordinates: rings } : null;
    }
    case 'MultiPolygon': {
      const polygons = geometry.coordinates
        .map((rings) => rerootPolygon(rings, frame))
        .filter((rings): rings is GeoJSON.Position[][] => rings !== null);
      return polygons.length > 0 ? { type: 'MultiPolygon', coordinates: polygons } : null;
    }
    case 'GeometryCollection': {
      const members = geometry.geometries
        .map((g) => rerootGeometry(g, frame))
        .filter((g): g is GeoJSON.Geometry => g !== null);
      return members.length > 0 ? { type: 'GeometryCollection', geometries: members } : null;
    }
  }
}

/** Visit every position of a geometry. */
function forEachPosition(geometry: GeoJSON.Geometry, fn: (pos: GeoJSON.Position) => void): void {
  switch (geometry.type) {
    case 'Point':
      fn(geometry.coordinates);
      break;
    case 'MultiPoint':
    case 'LineString':
      geometry.coordinates.forEach(fn);
      break;
    case 'MultiLineString':
    case 'Polygon':
      for (const line of geometry.coordinates) {
        line.forEach(fn);
      }
      break;
    case 'MultiPolygon':
      for (const rings of geometry.coordinates) {
        for (const ring of rings) {
          ring.forEach(fn);
        }
      }
      break;
    case 'GeometryCollection':
      for (const member of geometry.geometries) {
        forEachPosition(member, fn);
      }
      break;
  }
}

/**
 * Which of the shard's children a re-rooted geometry reaches, each with its
 * own buffer, as bits in `ShardResult.quarters` order.
 */
function reachedQuarters(geometry: GeoJSON.Geometry, margin: number): number {
  let minU = Infinity;
  let minV = Infinity;
  let maxU = -Infinity;
  let maxV = -Infinity;
  forEachPosition(geometry, (pos) => {
    const u = mercX(pos[0]) * (1 << ROOT_Z) - ROOT_XY;
    const v = mercY(pos[1]) * (1 << ROOT_Z) - ROOT_XY;
    minU = Math.min(minU, u);
    maxU = Math.max(maxU, u);
    minV = Math.min(minV, v);
    maxV = Math.max(maxV, v);
  });
  // A child's buffer, in the shard's units, is half the shard's.
  const m = margin / 2;
  let bits = 0;
  for (let j = 0; j < 2; j++) {
    for (let i = 0; i < 2; i++) {
      if (
        maxU >= i / 2 - m &&
        minU <= (i + 1) / 2 + m &&
        maxV >= j / 2 - m &&
        minV <= (j + 1) / 2 + m
      ) {
        bits |= 1 << (i + 2 * j);
      }
    }
  }
  return bits;
}

// NDJSON characters of features a shard holds parsed before they go into an
// index. A parsed GeoJSON feature takes several times its text; the index
// keeps the geometry in compact typed arrays, so features are indexed in
// chunks instead of all of a shard's at once.
const limits = { pendingChars: 32 * 1024 * 1024 };

/**
 * Read a shard into geojson-vt indexes, one or more per group: once the
 * parsed features waiting for an index pass `limits.pendingChars`, the group holding
 * most of them is indexed and its features let go. Several indexes of one
 * group together hold its features, and the walk merges them into its layer.
 */
function indexShard(task: ShardTask): {
  indexes: GroupIndex[];
  quarters: [number, number, number, number];
} {
  const margin = task.buffer / task.extent;
  const exactFrame: ShardFrame = {
    scale: 2 ** task.z,
    x: task.x,
    y: task.y,
    lo: -margin,
    hi: 1 + margin
  };
  const frame: ShardFrame = task.rootOnly ? { ...exactFrame, grid: task.extent } : exactFrame;
  // A real zoom as a zoom of the re-rooted indexes.
  const local = (zoom: number): number => zoom - task.z + ROOT_Z;
  // Indexes in the order their groups first appear in the shard, chunks of
  // a group in the order they were read: the order a tile's layers and
  // features are written in.
  const indexes: { rank: number; index: GroupIndex }[] = [];
  const rank = new Map<number, number>();
  const pending = new Map<number, { features: GeoJSON.Feature[]; chars: number }>();
  let pendingChars = 0;
  const quarters: [number, number, number, number] = [0, 0, 0, 0];

  const index = (group: number): void => {
    const chunk = pending.get(group);
    const meta = task.groups[group] as ShardGroup | undefined;
    if (!chunk || !meta) {
      return;
    }
    pending.delete(group);
    pendingChars -= chunk.chars;
    indexes.push({
      rank: rank.get(group) ?? 0,
      index: {
        layer: meta.layer,
        minzoom: meta.minzoom,
        maxzoom: meta.maxzoom,
        // tolerance 0: charts keep every vertex (tippecanoe ran with
        // --no-line-simplification / --no-tiny-polygon-reduction for the same
        // reason — simplification eats harbour basins and narrow channels).
        // indexMaxZoom 0: build nothing up front; the walk drills to each
        // tile it needs.
        index: new GeoJSONVT(
          { type: 'FeatureCollection', features: chunk.features },
          {
            maxZoom: local(meta.maxzoom),
            indexMaxZoom: 0,
            indexMaxPoints: 0,
            tolerance: 0,
            extent: task.extent,
            buffer: task.buffer
          }
        )
      }
    });
  };

  for (const file of task.files) {
    forEachLine(file, (line) => {
      const tab = line.indexOf('\t');
      if (tab <= 0) {
        return;
      }
      const group = Number(line.slice(0, tab));
      const meta = task.groups[group] as ShardGroup | undefined;
      if (!meta || meta.maxzoom < task.z) {
        return;
      }
      const feature = JSON.parse(line.slice(tab + 1)) as GeoJSON.Feature;
      const geometry = feature.geometry as GeoJSON.Geometry | null;
      if (!geometry) {
        return;
      }
      // Counted from the exact geometry: a feature too small for this tile's
      // grid can still show at the finer zooms below it.
      if (task.rootOnly && meta.maxzoom > task.z) {
        const exact = rerootGeometry(geometry, exactFrame);
        const bits = exact ? reachedQuarters(exact, margin) : 0;
        for (let q = 0; q < 4; q++) {
          if (bits & (1 << q)) {
            quarters[q] += line.length;
          }
        }
      }
      const rerooted = rerootGeometry(geometry, frame);
      if (!rerooted) {
        return;
      }
      feature.geometry = rerooted;
      if (!rank.has(group)) {
        rank.set(group, rank.size);
      }
      let chunk = pending.get(group);
      if (!chunk) {
        chunk = { features: [], chars: 0 };
        pending.set(group, chunk);
      }
      chunk.features.push(feature);
      chunk.chars += line.length;
      pendingChars += line.length;
      if (pendingChars > limits.pendingChars) {
        let largest = group;
        for (const [g, c] of pending) {
          if (c.chars > (pending.get(largest)?.chars ?? 0)) {
            largest = g;
          }
        }
        index(largest);
      }
    });
  }
  for (const group of [...pending.keys()]) {
    index(group);
  }
  return { indexes: indexes.sort((a, b) => a.rank - b.rank).map((entry) => entry.index), quarters };
}

/** Tile one shard, handing tiles to `emit` in batches. */
export function tileShard(task: ShardTask, emit: (tiles: EncodedTile[]) => void): ShardResult {
  const { indexes, quarters } = indexShard(task);
  // A real zoom as a zoom of the re-rooted indexes.
  const local = (zoom: number): number => zoom - task.z + ROOT_Z;

  let count = 0;
  let batch: EncodedTile[] = [];
  const flush = (): void => {
    if (batch.length > 0) {
      emit(batch);
      batch = [];
    }
  };

  // Depth-first, iteratively, in the re-rooted indexes' tile coordinates;
  // `z` is the real zoom, and real x/y are derived only for emitted tiles.
  const stack: { z: number; vx: number; vy: number; active: GroupIndex[] }[] = [
    { z: task.z, vx: ROOT_XY, vy: ROOT_XY, active: indexes }
  ];
  // A tile's entry is needed only to drill its children from, which happens
  // when the first of them is visited, right after it (depth-first), so each
  // tile is forgotten once the next one has been visited.
  let previous: VisitedTile | null = null;
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) {
      break;
    }
    const { z, vx, vy } = node;
    const vz = local(z);
    const layers: Record<string, { features: LegacyFeature[] }> = {};
    let hasLayer = false;
    const next: GroupIndex[] = [];
    for (const g of node.active) {
      const tile = g.index.getTileRaw(vz, vx, vy);
      if (!tile || tile.features.length === 0) {
        continue;
      }
      next.push(g);
      if (z >= g.minzoom) {
        for (const f of tile.features) {
          const own = f.tags?.[FEATURE_MINZOOM_KEY];
          if (typeof own === 'number' && z < own) {
            continue;
          }
          const feature = tileFeature(f);
          if (!feature) {
            continue;
          }
          if (typeof own === 'number' && feature.tags) {
            const tags = { ...feature.tags };
            delete tags[FEATURE_MINZOOM_KEY];
            feature.tags = tags;
          }
          (layers[g.layer] ??= { features: [] }).features.push(feature);
          hasLayer = true;
        }
      }
    }
    if (hasLayer) {
      const d = vz - ROOT_Z;
      const x = vx - ROOT_XY * 2 ** d + task.x * 2 ** d;
      const y = vy - ROOT_XY * 2 ** d + task.y * 2 ** d;
      const encoded = fromGeojsonVt(layers, { version: 2, extent: task.extent });
      // `encoded` views a larger growable buffer; copy out exactly the tile so
      // its buffer can be transferred.
      batch.push({ z, x, y, data: task.gzip ? gzip(encoded) : encoded.slice() });
      count++;
      if (batch.length >= EMIT_BATCH) {
        flush();
      }
    }
    const deeper = task.rootOnly ? [] : next.filter((g) => g.maxzoom > z);
    if (deeper.length > 0) {
      for (const [dx, dy] of [
        [1, 1],
        [0, 1],
        [1, 0],
        [0, 0]
      ] as const) {
        stack.push({ z: z + 1, vx: vx * 2 + dx, vy: vy * 2 + dy, active: deeper });
      }
    }
    if (previous) {
      forget(previous);
    }
    previous = { vz, vx, vy, groups: next };
  }
  if (previous) {
    forget(previous);
  }
  flush();
  return task.rootOnly ? { tiles: count, quarters } : { tiles: count };
}

/**
 * A tile's feature in the shape vt-pbf encodes. geojson-vt keeps every source
 * vertex (tolerance 0) and only then rounds them to the tile grid, so at low
 * zooms long runs of vertices land on one grid point. Dropping a vertex equal
 * to the one before it loses nothing at tile resolution. A ring with no area
 * goes too, since renderers skip it, and so does a line left with fewer than
 * two points. Null when nothing is left.
 */
function tileFeature(f: RawFeature): LegacyFeature | null {
  const tags = f.tags ?? null;
  const id = f.id !== undefined ? { id: f.id } : {};
  if (f.type === 4) {
    return { type: 1, geometry: [[f.x, f.y]], tags, ...id };
  }
  if (f.type === 1) {
    const points: [number, number][] = [];
    for (let i = 0; i < f.geometry.length; i += 2) {
      points.push([f.geometry[i], f.geometry[i + 1]]);
    }
    return { type: 1, geometry: points, tags, ...id };
  }
  const rings: [number, number][][] = [];
  for (const flat of f.geometry) {
    const ring: [number, number][] = [];
    let area = 0;
    for (let i = 0; i < flat.length; i += 2) {
      const x = flat[i];
      const y = flat[i + 1];
      const last = ring.at(-1);
      if (last && last[0] === x && last[1] === y) {
        continue;
      }
      if (last) {
        area += last[0] * y - x * last[1];
      }
      ring.push([x, y]);
    }
    if (f.type === 2 ? ring.length >= 2 : ring.length >= 4 && area !== 0) {
      rings.push(ring);
    }
  }
  return rings.length > 0 ? { type: f.type, geometry: rings, tags, ...id } : null;
}

// Drop tiles from the indexes' caches. Only tiles that are no longer on the
// walk's path are passed in: geojson-vt rebuilds any it is asked for again
// from the nearest cached ancestor, so an early drop costs time, not
// correctness.
function forget({ vz, vx, vy, groups }: VisitedTile): void {
  const id = tileId(vz, vx, vy);
  for (const g of groups) {
    // geojson-vt documents `tiles` as public API; its typings omit it.
    delete (g.index as unknown as { tiles: Record<number, unknown> }).tiles[id];
    g.index.tileCoords.length = 0;
  }
}

function gzip(data: Uint8Array): Uint8Array {
  const out = zlib.gzipSync(data);
  // A Buffer from gzipSync may share Node's pooled ArrayBuffer; copy it so
  // the transferred buffer holds exactly this tile.
  return new Uint8Array(out);
}

// ---------------------------------------------------------------------------
// Bucketing

export interface BucketTask {
  files: { path: string; group: number }[];
  /** Indexed by `files[].group`; a group's shards sit at its minzoom. */
  groups: ShardGroup[];
  /** Directory the shard part files go in. */
  dir: string;
  /** Distinguishes this task's part files from other tasks'. */
  part: number;
  extent: number;
  buffer: number;
}

export type FieldType = 'Number' | 'String' | 'Boolean' | 'Mixed';

export interface BucketResult {
  /** Shard key (`z-x-y`) → bytes this task wrote to it. */
  shards: Record<string, number>;
  /** `[west, south, east, north]` of every feature read, or null if none. */
  bounds: [number, number, number, number] | null;
  /** Output layer → attribute → type, as the MBTiles `json` metadata lists them. */
  fields: Record<string, Record<string, FieldType>>;
  features: number;
}

/** Path of one bucketing task's part of a shard. */
export function shardPartPath(dir: string, key: string, part: number): string {
  return path.join(dir, `${key}.${String(part)}.ndjson`);
}

// Flush a shard's buffered lines once they reach this size, and every
// shard's once all buffers together do, so bucketing a large bundle never
// holds more than a few tens of MB.
const SHARD_FLUSH_BYTES = 256 * 1024;
const TOTAL_FLUSH_BYTES = 32 * 1024 * 1024;

const MAX_LAT = 85.0511287798066;

function mercX(lon: number): number {
  return Math.min(1, Math.max(0, (lon + 180) / 360));
}

function mercY(lat: number): number {
  const clamped = Math.min(MAX_LAT, Math.max(-MAX_LAT, lat));
  const sin = Math.sin((clamped * Math.PI) / 180);
  const y = 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI);
  return Math.min(1, Math.max(0, y));
}

function extendBounds(coords: unknown, box: number[]): void {
  if (!Array.isArray(coords)) {
    return;
  }
  if (typeof coords[0] === 'number' && typeof coords[1] === 'number') {
    const [lon, lat] = coords as number[];
    if (lon < box[0]) {
      box[0] = lon;
    }
    if (lat < box[1]) {
      box[1] = lat;
    }
    if (lon > box[2]) {
      box[2] = lon;
    }
    if (lat > box[3]) {
      box[3] = lat;
    }
    return;
  }
  for (const c of coords) {
    extendBounds(c, box);
  }
}

function geometryBounds(geometry: GeoJSON.Geometry | null): number[] | null {
  if (!geometry) {
    return null;
  }
  const box = [Infinity, Infinity, -Infinity, -Infinity];
  if (geometry.type === 'GeometryCollection') {
    for (const g of geometry.geometries) {
      const b = geometryBounds(g);
      if (b) {
        box[0] = Math.min(box[0], b[0]);
        box[1] = Math.min(box[1], b[1]);
        box[2] = Math.max(box[2], b[2]);
        box[3] = Math.max(box[3], b[3]);
      }
    }
  } else {
    extendBounds(geometry.coordinates, box);
  }
  return box[0] <= box[2] ? box : null;
}

/**
 * Vector tile attributes are scalars. GDAL writes S-57 list attributes
 * (COLOUR, STATUS, CATLIT, …) as JSON arrays; join them with commas, the form
 * chart renderers split on. Nulls carry nothing and are dropped, as
 * tippecanoe did.
 */
export function tileProperties(
  props: GeoJSON.GeoJsonProperties
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (!props) {
    return out;
  }
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined) {
      continue;
    }
    if (Array.isArray(value)) {
      out[key] = value.join(',');
    } else if (typeof value === 'object') {
      out[key] = JSON.stringify(value);
    } else {
      out[key] = value as string | number | boolean;
    }
  }
  return out;
}

function readGeoJson(file: string): { features?: GeoJSON.Feature[] } {
  const bytes = fs.readFileSync(file);
  const text = (file.endsWith('.gz') ? zlib.gunzipSync(bytes) : bytes).toString('utf8');
  return JSON.parse(text) as { features?: GeoJSON.Feature[] };
}

export function bucketFeatures(task: BucketTask): BucketResult {
  const buffers = new Map<string, { chunks: string[]; size: number }>();
  const written: Record<string, number> = {};
  const fields: BucketResult['fields'] = {};
  const bounds = [Infinity, Infinity, -Infinity, -Infinity];
  let buffered = 0;
  let features = 0;

  const flushShard = (key: string): void => {
    const buf = buffers.get(key);
    if (!buf || buf.size === 0) {
      return;
    }
    fs.appendFileSync(shardPartPath(task.dir, key, task.part), buf.chunks.join(''));
    written[key] = (written[key] ?? 0) + buf.size;
    buffered -= buf.size;
    buf.chunks = [];
    buf.size = 0;
  };
  const flushAll = (): void => {
    for (const key of buffers.keys()) {
      flushShard(key);
    }
  };

  // Margin around a shard, as a fraction of the shard's tile: the tile
  // buffer, so a feature just outside the shard still reaches the buffers of
  // the shard's edge tiles.
  const margin = task.buffer / task.extent;

  for (const { path: file, group } of task.files) {
    const meta = task.groups[group] as ShardGroup | undefined;
    if (!meta) {
      continue;
    }
    let parsed: { features?: GeoJSON.Feature[] };
    try {
      parsed = readGeoJson(file);
    } catch {
      // An unreadable export is one layer of one cell missing, not a failed
      // conversion; the export step already logged why.
      continue;
    }
    const layerFields = (fields[meta.layer] ??= {});
    const z = meta.minzoom;
    const n = 1 << z;
    for (const feature of parsed.features ?? []) {
      const box = geometryBounds(feature.geometry);
      if (!box) {
        continue;
      }
      const properties: Record<string, string | number | boolean> = tileProperties(
        feature.properties
      );
      for (const [key, value] of Object.entries(properties)) {
        const type: FieldType =
          typeof value === 'number' ? 'Number' : typeof value === 'boolean' ? 'Boolean' : 'String';
        const known = layerFields[key] as FieldType | undefined;
        layerFields[key] = known === undefined || known === type ? type : 'Mixed';
      }
      bounds[0] = Math.min(bounds[0], box[0]);
      bounds[1] = Math.min(bounds[1], box[1]);
      bounds[2] = Math.max(bounds[2], box[2]);
      bounds[3] = Math.max(bounds[3], box[3]);
      features++;

      // Recorded after the fields above, so it never shows in the metadata.
      const own = meta.scamin ? scaminMinzoom(feature) : null;
      if (own !== null && own > meta.minzoom) {
        properties[FEATURE_MINZOOM_KEY] = Math.min(meta.maxzoom, own);
      }

      const line = `${String(group)}\t${JSON.stringify({
        type: 'Feature',
        ...(feature.id !== undefined ? { id: feature.id } : {}),
        properties,
        geometry: feature.geometry
      })}\n`;
      const x0 = Math.max(0, Math.floor((mercX(box[0]) - margin / n) * n));
      const x1 = Math.min(n - 1, Math.floor((mercX(box[2]) + margin / n) * n));
      // North is the smaller y.
      const y0 = Math.max(0, Math.floor((mercY(box[3]) - margin / n) * n));
      const y1 = Math.min(n - 1, Math.floor((mercY(box[1]) + margin / n) * n));
      for (let x = x0; x <= x1; x++) {
        for (let y = y0; y <= y1; y++) {
          const key = `${String(z)}-${String(x)}-${String(y)}`;
          let buf = buffers.get(key);
          if (!buf) {
            buf = { chunks: [], size: 0 };
            buffers.set(key, buf);
          }
          buf.chunks.push(line);
          buf.size += line.length;
          buffered += line.length;
          if (buf.size >= SHARD_FLUSH_BYTES) {
            flushShard(key);
          }
        }
      }
      if (buffered >= TOTAL_FLUSH_BYTES) {
        flushAll();
      }
    }
  }
  flushAll();
  return {
    shards: written,
    bounds: bounds[0] <= bounds[2] ? [bounds[0], bounds[1], bounds[2], bounds[3]] : null,
    fields,
    features
  };
}

// ---------------------------------------------------------------------------
// Merging

export interface MergeTask {
  /** Each tile's uncompressed parts, as shards of different minzooms wrote them. */
  tiles: { z: number; x: number; y: number; parts: Uint8Array[] }[];
}

type VtLayer = VectorTile['layers'][string];

// A layer of the merged tile, presented the way vt-pbf reads a
// @mapbox/vector-tile layer: its features are those of every part's
// same-named layer, in part order.
class MergedLayer {
  readonly version = 2;
  readonly length: number;
  readonly extent: number;

  constructor(
    readonly name: string,
    private readonly parts: VtLayer[]
  ) {
    this.length = parts.reduce((n, l) => n + l.length, 0);
    this.extent = parts[0].extent;
  }

  feature(i: number): ReturnType<VtLayer['feature']> {
    let index = i;
    for (const part of this.parts) {
      if (index < part.length) {
        return part.feature(index);
      }
      index -= part.length;
    }
    throw new RangeError(`feature ${String(i)} out of range`);
  }
}

/** Merge each tile's parts into one gzipped tile. */
export function mergeTiles(task: MergeTask): EncodedTile[] {
  return task.tiles.map(({ z, x, y, parts }) => {
    const layers = new Map<string, VtLayer[]>();
    for (const part of parts) {
      const tile = new VectorTile(new PbfReader(part));
      for (const [name, layer] of Object.entries(tile.layers)) {
        const list = layers.get(name) ?? [];
        list.push(layer);
        layers.set(name, list);
      }
    }
    let data: Uint8Array;
    if ([...layers.values()].every((list) => list.length === 1)) {
      // No layer name repeats, so the parts concatenate: a tile is a list of
      // layer messages, and concatenated messages are their union.
      data = Buffer.concat(parts);
    } else {
      const merged: Record<string, MergedLayer> = {};
      for (const [name, list] of layers) {
        merged[name] = new MergedLayer(name, list);
      }
      data = fromVectorTileJs({ layers: merged });
    }
    return { z, x, y, data: gzip(data) };
  });
}

export const _testInternals = { limits };
