/**
 * Puts a set's units together into one MBTiles. A unit's rows are the tiles
 * at z >= 9 whose z9 ancestor is the unit, so they can be added, replaced
 * and removed one unit at a time; the rows below z9 are the region
 * overviews, replaced as a whole, a tile two overviews hold being their
 * layers merged.
 *
 * A set's terrain shading is put together the same way into a raster
 * chart of its own, drawn over the vector one.
 *
 * The chart is written to a temporary file in the target folder, starting
 * from a copy of the current chart when there is one, and renamed into
 * place, so a plotter keeps reading a complete chart while it is updated
 * and a power cut leaves the old one.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'worker_threads';
import zlib from 'zlib';
import {
  OPEN_DATA_SET_METADATA_KEY,
  UNIT_ROWS_SQL,
  UNIT_ZOOM,
  unionBounds,
  type UnitTile
} from './tiles.js';
import { COVERAGE_METADATA_KEY, mergeTiles, type ChartCoverage } from '../chart-coverage.js';
import { mergeTiles as mergeVectorTiles } from '../vector-tile-shard.js';

export const TEMP_SUFFIX = '.odc-tmp';
const GZIP_MAGIC = [0x1f, 0x8b];

export interface VectorLayerInfo {
  id: string;
  description?: string;
  minzoom?: number;
  maxzoom?: number;
  fields?: Record<string, string>;
}

/**
 * Freeboard draws charts of a smaller scale under those of a larger one;
 * the shading is given a larger scale than the vector chart's default
 * (250000), so it lies on top.
 */
export const SHADING_SCALE = 200000;

export interface AssemblyInput {
  /** The vector chart, or the raster terrain shading drawn over it. */
  kind: 'chart' | 'shading';
  target: string;
  /** The chart to start from, or null to start from an empty MBTiles. */
  base: string | null;
  /** Units whose rows are taken out before any are added. */
  remove: UnitTile[];
  add: { tile: UnitTile; file: string }[];
  /** Overview files whose rows below z9 replace those of the base, or null to keep them. */
  overviews: string[] | null;
  /** Every unit the finished chart holds, for its bounds and coverage. */
  units: UnitTile[];
  name: string;
  description: string;
  attribution: string | null;
  setId: string;
}

/** The base is not a chart this module wrote; build a new one instead. */
export class NotPatchableError extends Error {}

const SCHEMA = `
  CREATE TABLE metadata (name TEXT, value TEXT);
  CREATE UNIQUE INDEX name ON metadata (name);
  CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB);
  CREATE UNIQUE INDEX tile_index ON tiles (zoom_level, tile_column, tile_row);
`;

export function tempPathFor(target: string): string {
  return path.join(
    path.dirname(target),
    `.${path.basename(target)}.${crypto.randomBytes(4).toString('hex')}${TEMP_SUFFIX}`
  );
}

export function mergeVectorLayers(lists: readonly VectorLayerInfo[][]): VectorLayerInfo[] {
  const byId = new Map<string, VectorLayerInfo>();
  for (const list of lists) {
    for (const layer of list) {
      const seen = byId.get(layer.id);
      if (!seen) {
        byId.set(layer.id, { ...layer, fields: { ...layer.fields } });
        continue;
      }
      seen.fields = { ...layer.fields, ...seen.fields };
      if (layer.minzoom !== undefined) {
        seen.minzoom = Math.min(seen.minzoom ?? layer.minzoom, layer.minzoom);
      }
      if (layer.maxzoom !== undefined) {
        seen.maxzoom = Math.max(seen.maxzoom ?? layer.maxzoom, layer.maxzoom);
      }
      if (!seen.description && layer.description) {
        seen.description = layer.description;
      }
    }
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function isVectorLayer(value: unknown): value is VectorLayerInfo {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { id?: unknown }).id === 'string'
  );
}

function readVectorLayers(db: DatabaseSync, schema: string): VectorLayerInfo[] {
  const row = db.prepare(`SELECT value FROM ${schema}.metadata WHERE name = 'json'`).get() as
    { value: unknown } | undefined;
  if (typeof row?.value !== 'string') {
    return [];
  }
  try {
    const parsed = JSON.parse(row.value) as { vector_layers?: unknown };
    return Array.isArray(parsed.vector_layers) ? parsed.vector_layers.filter(isVectorLayer) : [];
  } catch {
    return [];
  }
}

function isPatchable(db: DatabaseSync): boolean {
  const rows = db
    .prepare("SELECT type, name FROM sqlite_master WHERE name IN ('tiles', 'tile_index')")
    .all() as { type: string; name: string }[];
  return (
    rows.some((r) => r.name === 'tiles' && r.type === 'table') &&
    rows.some((r) => r.name === 'tile_index')
  );
}

function fsyncFile(file: string): void {
  const fd = fs.openSync(file, 'r+');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function fsyncDir(dir: string): void {
  try {
    const fd = fs.openSync(dir, 'r');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // Not every platform opens a directory; the rename stays atomic either way.
  }
}

/** Writes the chart `input` describes to `input.target`. */
export function assembleChart(input: AssemblyInput): void {
  fs.mkdirSync(path.dirname(input.target), { recursive: true });
  const tmp = tempPathFor(input.target);
  try {
    if (input.base !== null) {
      fs.copyFileSync(input.base, tmp, fs.constants.COPYFILE_FICLONE);
    }
    const db = new DatabaseSync(tmp);
    try {
      // A temporary file: a crash discards it, so no journal is needed.
      db.exec('PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF;');
      if (input.base === null) {
        // Set before any table exists, so rows taken out later give their space back.
        db.exec('PRAGMA auto_vacuum = INCREMENTAL;');
        db.exec(SCHEMA);
      } else if (!isPatchable(db)) {
        throw new NotPatchableError(`${input.base} was not built by Open Data Charts`);
      }
      writeRows(db, input);
      db.exec('PRAGMA incremental_vacuum;');
    } finally {
      db.close();
    }
    fsyncFile(tmp);
    fs.renameSync(tmp, input.target);
    fsyncDir(path.dirname(input.target));
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

function writeRows(db: DatabaseSync, input: AssemblyInput): void {
  const layers: VectorLayerInfo[][] = [];
  if (input.base !== null) {
    layers.push(readVectorLayers(db, 'main'));
  }
  const deleteUnit = db.prepare(`DELETE FROM tiles WHERE ${UNIT_ROWS_SQL}`);
  for (const tile of input.remove) {
    deleteUnit.run({ ux: tile.x, uy: tile.y });
  }
  if (input.overviews !== null) {
    db.prepare('DELETE FROM tiles WHERE zoom_level < ?').run(UNIT_ZOOM);
  }
  // ATTACH cannot run inside a transaction, so each copy commits on its own;
  // the file is not in place before every copy is done.
  const copyFrom = (
    file: string,
    where: string,
    params: Record<string, number>,
    conflict: 'REPLACE' | 'IGNORE' = 'REPLACE'
  ): void => {
    db.prepare('ATTACH DATABASE ? AS src').run(file);
    try {
      db.prepare(
        `INSERT OR ${conflict} INTO main.tiles (zoom_level, tile_column, tile_row, tile_data)
         SELECT zoom_level, tile_column, tile_row, tile_data FROM src.tiles WHERE ${where}`
      ).run(params);
      layers.push(readVectorLayers(db, 'src'));
    } finally {
      db.exec('DETACH DATABASE src');
    }
  };
  for (const file of input.overviews ?? []) {
    mergeOverlap(db, file);
    copyFrom(file, 'zoom_level < :uz', { uz: UNIT_ZOOM }, 'IGNORE');
  }
  // A unit's file may hold tiles of its neighbours (a tiler's buffer); only
  // its own go in, so units never overwrite each other.
  for (const { tile, file } of input.add) {
    copyFrom(file, UNIT_ROWS_SQL, { ux: tile.x, uy: tile.y });
  }
  writeMetadata(db, input, mergeVectorLayers(layers));
}

/**
 * The overviews of two seas hold the same tiles near their edge (a z4 tile
 * is 22.5 degrees wide), and a set spanning both takes both. Where `file`
 * has a tile the chart already holds, the chart's tile becomes the two
 * tiles' layers merged, and the copy that follows leaves it be, so neither
 * sea is lost there.
 */
function mergeOverlap(db: DatabaseSync, file: string): void {
  db.prepare('ATTACH DATABASE ? AS src').run(file);
  try {
    const rows = db
      .prepare(
        `SELECT s.zoom_level AS z, s.tile_column AS x, s.tile_row AS y,
                m.tile_data AS have, s.tile_data AS incoming
         FROM src.tiles s JOIN main.tiles m
           ON m.zoom_level = s.zoom_level AND m.tile_column = s.tile_column AND m.tile_row = s.tile_row
         WHERE s.zoom_level < ?`
      )
      .all(UNIT_ZOOM) as {
      z: number;
      x: number;
      y: number;
      have: Uint8Array;
      incoming: Uint8Array;
    }[];
    const update = db.prepare(
      'UPDATE main.tiles SET tile_data = ? WHERE zoom_level = ? AND tile_column = ? AND tile_row = ?'
    );
    for (const merged of mergeVectorTiles({
      tiles: rows.map(({ z, x, y, have, incoming }) => ({
        z,
        x,
        y,
        parts: [inflated(have), inflated(incoming)]
      }))
    })) {
      update.run(merged.data, merged.z, merged.x, merged.y);
    }
  } finally {
    db.exec('DETACH DATABASE src');
  }
}

function inflated(tile: Uint8Array): Uint8Array {
  return tile[0] === GZIP_MAGIC[0] && tile[1] === GZIP_MAGIC[1] ? zlib.gunzipSync(tile) : tile;
}

/**
 * Every unit fills its whole z9 tile (depth areas, land, and unsurveyed
 * areas where no depth is known), so the chart is opaque over its units
 * from z9 up. Below z9 the region overviews draw, which are not claimed.
 */
export function unitCoverage(units: readonly UnitTile[]): ChartCoverage | null {
  return units.length > 0 ? [{ minzoom: UNIT_ZOOM, tiles: mergeTiles(units, UNIT_ZOOM) }] : null;
}

/**
 * Whether `file`, a chart this module wrote, lacks a coverage: written by
 * an older version, or unreadable, which the assembly then deals with.
 */
export function lacksCoverage(file: string): boolean {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    return (
      db.prepare('SELECT 1 FROM metadata WHERE name = ?').get(COVERAGE_METADATA_KEY) === undefined
    );
  } catch {
    return true;
  } finally {
    db?.close();
  }
}

function writeMetadata(db: DatabaseSync, input: AssemblyInput, layers: VectorLayerInfo[]): void {
  const zooms = db
    .prepare('SELECT MIN(zoom_level) AS lo, MAX(zoom_level) AS hi FROM tiles')
    .get() as { lo: number | null; hi: number | null };
  const bounds = unionBounds(input.units);
  const kindRows: [string, string][] =
    input.kind === 'shading'
      ? [
          ['type', 'overlay'],
          ['format', 'webp'],
          ['scale', String(SHADING_SCALE)]
        ]
      : [
          ['type', 'S-57'],
          ['format', 'pbf'],
          ['json', JSON.stringify({ vector_layers: layers })]
        ];
  const rows: [string, string][] = [
    ['name', input.name],
    ['description', input.description],
    ...kindRows,
    ['version', '1'],
    ['minzoom', String(zooms.lo ?? UNIT_ZOOM)],
    ['maxzoom', String(zooms.hi ?? UNIT_ZOOM)],
    [OPEN_DATA_SET_METADATA_KEY, input.setId]
  ];
  if (bounds) {
    rows.push(['bounds', bounds.map((v) => v.toFixed(6)).join(',')]);
  }
  const coverage = input.kind === 'chart' ? unitCoverage(input.units) : null;
  if (coverage) {
    rows.push([COVERAGE_METADATA_KEY, JSON.stringify(coverage)]);
  }
  if (input.attribution) {
    rows.push(['attribution', input.attribution]);
  }
  db.exec('DELETE FROM metadata');
  const insert = db.prepare('INSERT INTO metadata (name, value) VALUES (?, ?)');
  for (const [name, value] of rows) {
    insert.run(name, value);
  }
}

interface WorkerAnswer {
  ok: boolean;
  notPatchable?: boolean;
  message?: string;
}

/**
 * `assembleChart` on a worker thread: copying a unit's rows takes seconds
 * on a Raspberry Pi, and the server's event loop must keep serving tiles.
 */
export function runAssembly(input: AssemblyInput): Promise<void> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./assemble-worker.js', import.meta.url), {
      workerData: input
    });
    let answered = false;
    worker.once('message', (answer: WorkerAnswer) => {
      answered = true;
      if (answer.ok) {
        resolve();
      } else if (answer.notPatchable) {
        reject(new NotPatchableError(answer.message));
      } else {
        reject(new Error(answer.message ?? 'Building the chart failed'));
      }
    });
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (!answered) {
        reject(new Error(`Building the chart stopped (exit code ${String(code)})`));
      }
    });
  });
}
