/**
 * Builds a vector MBTiles from GeoJSON, in worker threads — the plugin's own
 * replacement for tippecanoe + tile-join.
 *
 * Input is a list of sources: GeoJSON files, the output layer they feed, and
 * the zoom range their features show at. S-57 conversion passes one source
 * per layer and IHO band, so a band's features appear only at the zooms the
 * band is drawn for, and every band of a bundle goes into one pass: there are
 * no per-band intermediate files to join afterwards.
 *
 * The work is split so that every step parallelizes across the conversion's
 * workers (worker-pool.ts) and none holds a whole bundle in memory:
 *
 * 1. Bucket: workers read the GeoJSON files and sort each feature into the
 *    shards it reaches — the tiles at its source's minzoom, plus the tile
 *    buffer — as line-delimited files on disk.
 * 2. Tile: each shard is a self-contained subtree of the pyramid, tiled by
 *    one worker with geojson-vt and encoded with vt-pbf, largest shards
 *    first so the pool drains evenly.
 * 3. Merge: sources with different minzooms shard at different levels, so
 *    their tiles can meet at the same z/x/y (adjacent bands overlap by two
 *    zooms). When that can happen, tiles land in a scratch table first and
 *    tiles with several parts are merged layer by layer before going into
 *    the MBTiles; otherwise tiles go straight in.
 *
 * Geometry is kept exactly (no simplification, no dropped small polygons, no
 * feature or tile size limits), as the S-57 pipeline ran tippecanoe.
 */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { BucketResult, EncodedTile, FieldType, ShardGroup } from './vector-tile-shard.js';
import { shardPartPath } from './vector-tile-shard.js';
import { forEachConcurrent, type WorkerPool } from './worker-pool.js';

export interface TileSource {
  layer: string;
  minzoom: number;
  maxzoom: number;
  /** GeoJSON files (`.geojson`, or gzipped `.geojson.gz`). */
  files: string[];
  /** S-57 features: each with a SCAMIN starts at the zoom S-52 shows it at. */
  scamin?: boolean;
}

export interface VectorTilerOptions {
  sources: readonly TileSource[];
  /** The MBTiles to write; replaced if it exists. */
  output: string;
  /** Scratch directory; created, and removed on the way out. */
  scratchDir: string;
  pool: WorkerPool;
  /** `name` metadata row. */
  name: string;
  description?: string;
  /** `type` metadata row; `overlay` unless given. */
  type?: string;
  signal?: AbortSignal;
  /**
   * A shard of more NDJSON bytes than this is tiled in parts: its own tile first,
   * then each of its children as a shard of its own, so that one worker never
   * holds all of it. Unlimited when not given.
   */
  shardBytesLimit?: number;
  /** Overall progress, 0–100. */
  onPercent?: (pct: number) => void;
  log?: (message: string) => void;
}

export interface VectorTilerResult {
  tiles: number;
  features: number;
  minzoom: number;
  maxzoom: number;
}

// Tile geometry resolution and buffer. 4096 is the MVT norm. The buffer is
// what the S-57 pipeline gave tippecanoe (--buffer=80, in 1/256ths of a
// tile): polygon edges that hug a tile boundary stay intact.
export const TILE_EXTENT = 4096;
export const TILE_BUFFER = (80 / 256) * TILE_EXTENT;

// Heap a worker reaches while tiling a shard, per byte of the shard's NDJSON:
// about three times its size on dense ENC bundles (a 180 MB part of the Dutch
// cells needs 560 MB), with headroom on top.
const HEAP_PER_SHARD_BYTE = 4;

/** The largest shard a worker with `heapMb` of heap tiles in one piece. */
export function shardBytesForHeap(heapMb: number): number {
  return Math.floor((heapMb * 1024 * 1024) / HEAP_PER_SHARD_BYTE);
}

// Share of the progress bar each stage gets.
const BUCKET_SHARE = 15;
const TILE_SHARE = 75;

// Tiles per message to and from a merge worker.
const MERGE_BATCH = 256;

const MBTILES_SCHEMA = `
  CREATE TABLE metadata (name TEXT, value TEXT);
  CREATE UNIQUE INDEX metadata_name ON metadata (name);
  CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB);
  CREATE UNIQUE INDEX tile_index ON tiles (zoom_level, tile_column, tile_row);
`;

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new Error('Conversion cancelled');
  }
}

/** Collapse sources with the same layer and zoom range into one group. */
export function groupSources(sources: readonly TileSource[]): {
  groups: ShardGroup[];
  files: { path: string; group: number }[];
} {
  const groups: ShardGroup[] = [];
  const byKey = new Map<string, number>();
  const files: { path: string; group: number }[] = [];
  for (const source of sources) {
    if (source.minzoom > source.maxzoom || source.files.length === 0) {
      continue;
    }
    const scamin = source.scamin === true;
    const key = `${source.layer}\u0000${String(source.minzoom)}\u0000${String(source.maxzoom)}\u0000${String(scamin)}`;
    let group = byKey.get(key);
    if (group === undefined) {
      group = groups.length;
      groups.push({
        layer: source.layer,
        minzoom: source.minzoom,
        maxzoom: source.maxzoom,
        ...(scamin ? { scamin } : {})
      });
      byKey.set(key, group);
    }
    for (const file of source.files) {
      files.push({ path: file, group });
    }
  }
  return { groups, files };
}

/** Split `items` into `n` lists of about equal total `weight`. */
function balance<T>(items: readonly T[], n: number, weight: (item: T) => number): T[][] {
  const lanes = Array.from({ length: Math.max(1, n) }, () => ({ items: [] as T[], total: 0 }));
  for (const item of [...items].sort((a, b) => weight(b) - weight(a))) {
    const lane = lanes.reduce((min, l) => (l.total < min.total ? l : min));
    lane.items.push(item);
    lane.total += weight(item);
  }
  return lanes.map((l) => l.items).filter((l) => l.length > 0);
}

const fileSize = (file: string): number => {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
};

function mergeFields(
  into: Record<string, Record<string, FieldType>>,
  from: BucketResult['fields']
): void {
  for (const [layer, fields] of Object.entries(from)) {
    const target = (into[layer] ??= {});
    for (const [field, type] of Object.entries(fields)) {
      const known = target[field] as FieldType | undefined;
      target[field] = known === undefined || known === type ? type : 'Mixed';
    }
  }
}

export async function buildVectorMbtiles(opts: VectorTilerOptions): Promise<VectorTilerResult> {
  const { pool, signal } = opts;
  const log = opts.log ?? ((): void => undefined);
  let lastPct = -1;
  const progress = (pct: number): void => {
    const rounded = Math.min(100, Math.max(0, Math.round(pct)));
    if (rounded > lastPct) {
      lastPct = rounded;
      opts.onPercent?.(rounded);
    }
  };

  const { groups, files } = groupSources(opts.sources);
  if (files.length === 0) {
    throw new Error('No valid GeoJSON layers to process');
  }
  const minzoom = Math.min(...groups.map((g) => g.minzoom));
  const maxzoom = Math.max(...groups.map((g) => g.maxzoom));
  const shardLevels = new Set(groups.map((g) => g.minzoom));
  const mayCollide = shardLevels.size > 1;

  fs.rmSync(opts.scratchDir, { recursive: true, force: true });
  const shardDir = path.join(opts.scratchDir, 'shards');
  fs.mkdirSync(shardDir, { recursive: true });
  fs.rmSync(opts.output, { force: true });

  let out: DatabaseSync | null = null;
  let frag: DatabaseSync | null = null;
  try {
    // 1. Bucket.
    const lanes = balance(files, pool.size * 2, (f) => fileSize(f.path));
    const shardBytes = new Map<string, number>();
    const shardParts = new Map<string, number[]>();
    const fields: Record<string, Record<string, FieldType>> = {};
    let bounds: [number, number, number, number] | null = null;
    let features = 0;
    let bucketed = 0;
    await forEachConcurrent(lanes, pool.size, async (lane, part) => {
      const { bucket } = await pool.run({
        op: 'bucket-features',
        bucket: {
          files: lane,
          groups,
          dir: shardDir,
          part,
          extent: TILE_EXTENT,
          buffer: TILE_BUFFER
        }
      });
      for (const [key, bytes] of Object.entries(bucket.shards)) {
        shardBytes.set(key, (shardBytes.get(key) ?? 0) + bytes);
        const parts = shardParts.get(key) ?? [];
        parts.push(part);
        shardParts.set(key, parts);
      }
      mergeFields(fields, bucket.fields);
      if (bucket.bounds) {
        const b = bucket.bounds;
        bounds = bounds
          ? [
              Math.min(bounds[0], b[0]),
              Math.min(bounds[1], b[1]),
              Math.max(bounds[2], b[2]),
              Math.max(bounds[3], b[3])
            ]
          : b;
      }
      features += bucket.features;
      bucketed++;
      progress((bucketed / lanes.length) * BUCKET_SHARE);
    });
    throwIfAborted(signal);
    if (features === 0) {
      throw new Error('No valid GeoJSON layers to process');
    }
    log(
      `Tiling ${String(features)} features in ${String(shardBytes.size)} shard(s), ` +
        `z${String(minzoom)}-z${String(maxzoom)}, ${String(pool.size)} worker(s)`
    );

    // 2. Tile.
    out = new DatabaseSync(opts.output);
    out.exec('PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF;');
    out.exec(MBTILES_SCHEMA);
    const insertTile = out.prepare(
      'INSERT OR REPLACE INTO tiles (zoom_level, tile_column, tile_row, tile_data) VALUES (?, ?, ?, ?)'
    );
    let sink: (tiles: EncodedTile[]) => void;
    if (mayCollide) {
      frag = new DatabaseSync(path.join(opts.scratchDir, 'fragments.sqlite'));
      frag.exec('PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF;');
      frag.exec('CREATE TABLE frag (z INTEGER, x INTEGER, y INTEGER, data BLOB)');
      const insertFrag = frag.prepare('INSERT INTO frag (z, x, y, data) VALUES (?, ?, ?, ?)');
      const db = frag;
      sink = (tiles): void => {
        db.exec('BEGIN');
        for (const t of tiles) {
          insertFrag.run(t.z, t.x, t.y, t.data);
        }
        db.exec('COMMIT');
      };
    } else {
      const db = out;
      sink = (tiles): void => {
        db.exec('BEGIN');
        for (const t of tiles) {
          // MBTiles rows count from the south (TMS).
          insertTile.run(t.z, t.x, (1 << t.z) - 1 - t.y, t.data);
        }
        db.exec('COMMIT');
      };
    }

    const shards = [...shardBytes.entries()].sort((a, b) => b[1] - a[1]);
    const totalBytes = shards.reduce((n, [, bytes]) => n + bytes, 0) || 1;
    const limit = opts.shardBytesLimit ?? Infinity;
    let doneBytes = 0;
    let tileCount = 0;
    let splits = 0;
    // Tile the subtree under z/x/y from a shard's files; `share` is the
    // shard's bytes this subtree accounts for in the progress bar.
    const tile = async (
      files: string[],
      z: number,
      x: number,
      y: number,
      size: number,
      share: number
    ): Promise<void> => {
      const rootOnly = size > limit && z < maxzoom;
      const result = await pool.run(
        {
          op: 'tile-shard',
          shard: {
            files,
            groups,
            z,
            x,
            y,
            extent: TILE_EXTENT,
            buffer: TILE_BUFFER,
            gzip: !mayCollide,
            ...(rootOnly ? { rootOnly } : {})
          }
        },
        {
          onEvent: (event) => {
            sink(event.tiles);
          }
        }
      );
      tileCount += result.tiles;
      if (!rootOnly || !result.quarters) {
        doneBytes += share;
        progress(BUCKET_SHARE + (doneBytes / totalBytes) * TILE_SHARE);
        return;
      }
      splits++;
      const quarters = result.quarters;
      const reached = quarters.reduce((n, c) => n + c, 0);
      // The shard's own tile counts as a fifth of its share.
      doneBytes += reached === 0 ? share : share / 5;
      progress(BUCKET_SHARE + (doneBytes / totalBytes) * TILE_SHARE);
      // A child no feature reaches would re-read the whole shard for nothing.
      const children = [0, 1, 2, 3].filter((q) => quarters[q] > 0);
      await forEachConcurrent(children, pool.size, (q) =>
        tile(
          files,
          z + 1,
          x * 2 + (q % 2),
          y * 2 + Math.floor(q / 2),
          quarters[q],
          ((share * 4) / 5) * (quarters[q] / reached)
        )
      );
    };
    await forEachConcurrent(shards, pool.size, async ([key, bytes]) => {
      const [z, x, y] = key.split('-').map(Number);
      const parts = shardParts.get(key) ?? [];
      await tile(
        parts.map((part) => shardPartPath(shardDir, key, part)),
        z,
        x,
        y,
        bytes,
        bytes
      );
      // The shard's input is no longer needed; free the disk as we go.
      for (const part of parts) {
        fs.rmSync(shardPartPath(shardDir, key, part), { force: true });
      }
    });
    if (splits > 0) {
      log(`Tiled ${String(splits)} large shard(s) in parts, to fit the memory`);
    }
    throwIfAborted(signal);

    // 3. Merge.
    if (frag) {
      tileCount = await mergeFragments(frag, out, pool, signal, (pct) => {
        progress(BUCKET_SHARE + TILE_SHARE + pct * (100 - BUCKET_SHARE - TILE_SHARE));
      });
    }
    if (tileCount === 0) {
      throw new Error('Tiling produced no tiles');
    }

    writeMetadata(out, {
      name: opts.name,
      description: opts.description ?? '',
      type: opts.type ?? 'overlay',
      minzoom,
      maxzoom,
      bounds: bounds ?? [-180, -85, 180, 85],
      groups,
      fields
    });
    progress(100);
    return { tiles: tileCount, features, minzoom, maxzoom };
  } catch (err) {
    out?.close();
    out = null;
    fs.rmSync(opts.output, { force: true });
    throw err;
  } finally {
    out?.close();
    frag?.close();
    fs.rmSync(opts.scratchDir, { recursive: true, force: true });
  }
}

/**
 * Move the scratch tiles into the MBTiles, merging tiles with several parts
 * in the workers. Returns the number of tiles written; `onFraction` gets 0–1.
 */
async function mergeFragments(
  frag: DatabaseSync,
  out: DatabaseSync,
  pool: WorkerPool,
  signal: AbortSignal | undefined,
  onFraction: (fraction: number) => void
): Promise<number> {
  frag.exec('CREATE INDEX frag_tile ON frag (z, x, y)');
  const total =
    (
      frag.prepare('SELECT COUNT(*) AS n FROM (SELECT 1 FROM frag GROUP BY z, x, y)').get() as {
        n: number;
      }
    ).n || 1;
  const page = frag.prepare(
    'SELECT z, x, y, data FROM frag WHERE (z, x, y) > (?, ?, ?) ORDER BY z, x, y LIMIT ?'
  );
  const insertTile = out.prepare(
    'INSERT OR REPLACE INTO tiles (zoom_level, tile_column, tile_row, tile_data) VALUES (?, ?, ?, ?)'
  );

  const partsOf = frag.prepare('SELECT data FROM frag WHERE z = ? AND x = ? AND y = ?');
  type Pending = { z: number; x: number; y: number; parts: Uint8Array[] };

  // Read the scratch table a batch of whole tiles at a time, so the merge
  // parallelizes without loading the table.
  let cursor: [number, number, number] = [-1, 0, 0];
  let exhausted = false;
  const readBatch = (): Pending[] => {
    const tiles: Pending[] = [];
    while (!exhausted && tiles.length < MERGE_BATCH) {
      const rows = page.all(cursor[0], cursor[1], cursor[2], MERGE_BATCH * 4) as {
        z: number;
        x: number;
        y: number;
        data: Uint8Array;
      }[];
      if (rows.length === 0) {
        exhausted = true;
        break;
      }
      for (const row of rows) {
        const last = tiles.at(-1);
        if (last?.z === row.z && last.x === row.x && last.y === row.y) {
          last.parts.push(row.data);
        } else {
          tiles.push({ z: row.z, x: row.x, y: row.y, parts: [row.data] });
        }
      }
      // The page may have cut the last tile's parts short, and the next page
      // starts after it: re-read that tile whole.
      const tail = tiles[tiles.length - 1];
      tail.parts = (partsOf.all(tail.z, tail.x, tail.y) as { data: Uint8Array }[]).map(
        (r) => r.data
      );
      cursor = [tail.z, tail.x, tail.y];
    }
    return tiles;
  };

  let written = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      throwIfAborted(signal);
      const batch = readBatch();
      if (batch.length === 0) {
        return;
      }
      const { tiles } = await pool.run({ op: 'merge-tiles', merge: { tiles: batch } });
      out.exec('BEGIN');
      for (const t of tiles) {
        insertTile.run(t.z, t.x, (1 << t.z) - 1 - t.y, t.data);
      }
      out.exec('COMMIT');
      written += tiles.length;
      onFraction(written / total);
    }
  };
  await Promise.all(Array.from({ length: pool.size }, worker));
  return written;
}

function writeMetadata(
  db: DatabaseSync,
  meta: {
    name: string;
    description: string;
    type: string;
    minzoom: number;
    maxzoom: number;
    bounds: [number, number, number, number];
    groups: ShardGroup[];
    fields: Record<string, Record<string, FieldType>>;
  }
): void {
  const [west, south, east, north] = meta.bounds;
  const centerZoom = Math.min(meta.maxzoom, Math.max(meta.minzoom, 12));
  const layers = new Map<string, { minzoom: number; maxzoom: number }>();
  for (const g of meta.groups) {
    const known = layers.get(g.layer);
    layers.set(g.layer, {
      minzoom: Math.min(known?.minzoom ?? g.minzoom, g.minzoom),
      maxzoom: Math.max(known?.maxzoom ?? g.maxzoom, g.maxzoom)
    });
  }
  const vectorLayers = [...layers.entries()]
    .filter(([layer]) => layer in meta.fields)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, zooms]) => ({
      id,
      description: '',
      minzoom: zooms.minzoom,
      maxzoom: zooms.maxzoom,
      fields: meta.fields[id]
    }));
  const rows: [string, string][] = [
    ['name', meta.name],
    ['description', meta.description],
    ['type', meta.type],
    ['version', '2'],
    ['format', 'pbf'],
    ['minzoom', String(meta.minzoom)],
    ['maxzoom', String(meta.maxzoom)],
    ['bounds', [west, south, east, north].map((v) => v.toFixed(6)).join(',')],
    [
      'center',
      `${((west + east) / 2).toFixed(6)},${((south + north) / 2).toFixed(6)},${String(centerZoom)}`
    ],
    ['json', JSON.stringify({ vector_layers: vectorLayers })],
    ['generator', 'signalk-charts-provider-simple vector tiler']
  ];
  const insert = db.prepare('INSERT OR REPLACE INTO metadata (name, value) VALUES (?, ?)');
  db.exec('BEGIN');
  for (const [name, value] of rows) {
    insert.run(name, value);
  }
  db.exec('COMMIT');
}
