/**
 * Each chart set's cells, kept between runs so an update downloads and runs
 * GDAL only on the cells whose version changed.
 *
 * `<dataDir>/chart-set-cache/<setId>/cells/<cell>/` holds the cell as it was
 * staged (`raw/`: the `.000` and its update files), its GDAL output
 * (`geojson/<LAYER>_<cell>.geojson.gz`) and `cell.json`, which records the
 * version and the export revision. Building the final MBTiles (tippecanoe
 * and tile-join) still runs over every cell of the set.
 *
 * A cell is built in the set's staging dir and renamed into place with its
 * `cell.json` already written, so a cancelled or failed run never leaves a
 * half-written entry: a staging dir, or a cell dir without `cell.json`, is
 * never read and is removed by `sweepChartSetCache`.
 */

import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import zlib from 'zlib';
import type { DebugFunction } from '../types.js';
import type { PlannedCell } from './enc-chart-set.js';
import { isWithinBase } from './path-safety.js';

/**
 * Bump when the GDAL export changes what it writes for the same cell, so
 * cached output from older plugin versions is exported again.
 */
export const CELL_EXPORT_REVISION = 1;

const CACHE_DIR_NAME = 'chart-set-cache';
const CELLS = 'cells';
const STAGING_PREFIX = '.staging-';
const CELL_FILE = 'cell.json';
const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/;
const SAFE_CELL = /^[A-Za-z0-9_-]{1,64}$/;

/** What `cell.json` records. */
export interface CachedCellInfo {
  version: string | undefined;
  exportRevision: number;
}

/** What a run does with each of a set's cells. */
export interface CachePlan {
  /** Cached at the planned version: neither downloaded nor exported. */
  reuse: PlannedCell[];
  /** Cached at the planned version, but exported by an older revision. */
  reexport: PlannedCell[];
  /** Not cached, or cached at another version. */
  download: PlannedCell[];
}

/**
 * Sort a set's cells by what a run has to do for them. A cell with no
 * version in the index is downloaded every time: nothing says whether the
 * cached copy is current.
 */
export function planCellCache(
  cells: readonly PlannedCell[],
  cached: ReadonlyMap<string, CachedCellInfo>
): CachePlan {
  const plan: CachePlan = { reuse: [], reexport: [], download: [] };
  for (const cell of cells) {
    const entry = cached.get(cell.name);
    if (!entry || cell.version === undefined || entry.version !== cell.version) {
      plan.download.push(cell);
    } else if (entry.exportRevision !== CELL_EXPORT_REVISION) {
      plan.reexport.push(cell);
    } else {
      plan.reuse.push(cell);
    }
  }
  return plan;
}

let rootDir = '';
let debug: DebugFunction = () => {};

export function initChartSetCache(dataDir: string, debugFn: DebugFunction): void {
  rootDir = path.join(dataDir, CACHE_DIR_NAME);
  debug = debugFn || (() => {});
}

function setDir(setId: string): string {
  if (!SAFE_ID.test(setId)) {
    throw new Error(`Invalid chart set id: ${setId}`);
  }
  const dir = path.join(rootDir, setId);
  if (!isWithinBase(dir, rootDir)) {
    throw new Error(`Invalid chart set id: ${setId}`);
  }
  return dir;
}

/** The directory holding a set's committed cells, one sub-directory each. */
export function cellsDir(setId: string): string {
  return path.join(setDir(setId), CELLS);
}

function readInfo(cellDir: string): CachedCellInfo | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(cellDir, CELL_FILE), 'utf8')) as {
      version?: unknown;
      exportRevision?: unknown;
    };
    if (typeof raw.exportRevision !== 'number') {
      return null;
    }
    return {
      version: typeof raw.version === 'string' ? raw.version : undefined,
      exportRevision: raw.exportRevision
    };
  } catch {
    return null;
  }
}

/** The cells a set has cached, by name. */
export function readSetCache(setId: string): Map<string, CachedCellInfo> {
  const result = new Map<string, CachedCellInfo>();
  let names: string[];
  try {
    names = fs.readdirSync(cellsDir(setId));
  } catch {
    return result;
  }
  for (const name of names) {
    if (!SAFE_CELL.test(name)) {
      continue;
    }
    const info = readInfo(path.join(cellsDir(setId), name));
    if (info) {
      result.set(name, info);
    }
  }
  return result;
}

/**
 * A fresh staging dir for one run, inside the set's cache dir so finished
 * cells are moved into place by a rename. The caller removes it when the
 * run ends, however it ends.
 */
export function createStagingDir(setId: string): string {
  const dir = path.join(
    setDir(setId),
    `${STAGING_PREFIX}${String(Date.now())}-${String(process.pid)}`
  );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** The `.000` file in a cell's raw dir. */
function baseFileIn(rawDir: string): string | null {
  try {
    return fs.readdirSync(rawDir).find((f) => /\.000$/i.test(f)) ?? null;
  } catch {
    return null;
  }
}

/** Hardlink (or, across filesystems, copy) every file in `from` into `to`. */
export function linkCellFiles(from: string, to: string): void {
  fs.mkdirSync(to, { recursive: true });
  for (const name of fs.readdirSync(from)) {
    const src = path.join(from, name);
    if (!fs.statSync(src).isFile()) {
      continue;
    }
    try {
      fs.linkSync(src, path.join(to, name));
    } catch {
      fs.copyFileSync(src, path.join(to, name));
    }
  }
}

/** A cell's cached raw dir, for exporting it again. */
export function cachedRawDir(setId: string, cell: string): string {
  return path.join(cellsDir(setId), cell, 'raw');
}

export interface CellToCommit {
  name: string;
  /** The staged cell: its `.000` and update files. */
  rawDir: string;
  version: string | undefined;
}

/**
 * Move freshly exported cells into the cache: each cell's raw files and its
 * share of the GDAL output in `exportDir` (the files named `_<cell>.geojson`,
 * gzipped). A cell replaces its older cached copy only once complete.
 * Returns the names committed.
 */
export async function commitCells(
  setId: string,
  stagingDir: string,
  exportDir: string,
  cells: readonly CellToCommit[]
): Promise<string[]> {
  const exported = fs.existsSync(exportDir) ? fs.readdirSync(exportDir) : [];
  const committed: string[] = [];
  fs.mkdirSync(cellsDir(setId), { recursive: true });
  for (const cell of cells) {
    if (!SAFE_CELL.test(cell.name)) {
      continue;
    }
    const base = baseFileIn(cell.rawDir);
    if (base === null) {
      continue;
    }
    const stem = base.replace(/\.000$/i, '');
    const build = path.join(stagingDir, 'commit', cell.name);
    fs.rmSync(build, { recursive: true, force: true });
    linkCellFiles(cell.rawDir, path.join(build, 'raw'));
    const geojsonDir = path.join(build, 'geojson');
    fs.mkdirSync(geojsonDir, { recursive: true });
    for (const file of exported.filter((f) => f.endsWith(`_${stem}.geojson`))) {
      await pipeline(
        fs.createReadStream(path.join(exportDir, file)),
        zlib.createGzip({ level: 6 }),
        fs.createWriteStream(path.join(geojsonDir, `${file}.gz`))
      );
    }
    const info: CachedCellInfo = { version: cell.version, exportRevision: CELL_EXPORT_REVISION };
    fs.writeFileSync(path.join(build, CELL_FILE), JSON.stringify(info));

    const target = path.join(cellsDir(setId), cell.name);
    const old = path.join(stagingDir, 'replaced', cell.name);
    if (fs.existsSync(target)) {
      fs.mkdirSync(path.dirname(old), { recursive: true });
      fs.renameSync(target, old);
    }
    fs.renameSync(build, target);
    fs.rmSync(old, { recursive: true, force: true });
    committed.push(cell.name);
  }
  return committed;
}

/** Remove cached cells the set no longer brings in. */
export function pruneSetCache(setId: string, keep: ReadonlySet<string>): string[] {
  const removed: string[] = [];
  let names: string[];
  try {
    names = fs.readdirSync(cellsDir(setId));
  } catch {
    return removed;
  }
  for (const name of names) {
    if (!keep.has(name)) {
      fs.rmSync(path.join(cellsDir(setId), name), { recursive: true, force: true });
      removed.push(name);
    }
  }
  return removed;
}

/** Remove a set's whole cache; for a deleted set. */
export function removeSetCache(setId: string): void {
  try {
    fs.rmSync(setDir(setId), { recursive: true, force: true });
  } catch (err) {
    debug(
      `Could not remove the cache of ${setId}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Remove what a run killed mid-way left behind: staging dirs, and cell dirs
 * without `cell.json`. Run at start, when no chart set is being built.
 */
export function sweepChartSetCache(): void {
  let sets: string[];
  try {
    sets = fs.readdirSync(rootDir);
  } catch {
    return;
  }
  for (const set of sets) {
    const dir = path.join(rootDir, set);
    try {
      for (const name of fs.readdirSync(dir)) {
        if (name.startsWith(STAGING_PREFIX)) {
          fs.rmSync(path.join(dir, name), { recursive: true, force: true });
        }
      }
      const cells = path.join(dir, CELLS);
      for (const name of fs.existsSync(cells) ? fs.readdirSync(cells) : []) {
        if (readInfo(path.join(cells, name)) === null) {
          fs.rmSync(path.join(cells, name), { recursive: true, force: true });
        }
      }
    } catch (err) {
      debug(`Chart set cache sweep of ${set}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/**
 * A run needs room for a set's downloads, their GDAL output and the new
 * MBTiles next to the old one. A floor, not an estimate: it stops a run
 * from filling the disk the server runs on before anything is known.
 */
export const MIN_FREE_BYTES_FOR_CHART_SET = 512 * 1024 * 1024;

/** `bytes` as whole megabytes, for messages. */
export function formatMegabytes(bytes: number): string {
  return `${String(Math.round(bytes / (1024 * 1024)))} MB`;
}

/** Free bytes on the filesystem holding `dir`, or null when unknown. */
export function freeDiskBytes(dir: string): number | null {
  try {
    const stats = fs.statfsSync(dir);
    return stats.bavail * stats.bsize;
  } catch {
    return null;
  }
}

/** Bytes a set's cache takes on disk. */
export function setCacheBytes(setId: string): number {
  let total = 0;
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        total += fs.statSync(full).size;
      }
    }
  };
  try {
    walk(setDir(setId));
  } catch {
    return 0;
  }
  return total;
}

/**
 * A `geojsonFor` hook for `processS57Directory` over `cellsDir(setId)`: it
 * hardlinks each cell's cached GeoJSON into the bucket's dir in place of
 * running GDAL. A cell's files are named after its `.000` file, as GDAL
 * named them.
 */
export function cachedGeojsonFor(
  setId: string
): (encFiles: readonly string[], outDir: string) => Promise<void> {
  return (encFiles, outDir) => {
    fs.mkdirSync(outDir, { recursive: true });
    for (const encFile of encFiles) {
      // <cellsDir>/<cell>/raw/<cell>.000 → <cellsDir>/<cell>/geojson/
      const geojsonDir = path.join(path.dirname(path.dirname(encFile)), 'geojson');
      if (isWithinBase(geojsonDir, cellsDir(setId)) && fs.existsSync(geojsonDir)) {
        linkCellFiles(geojsonDir, outDir);
      }
    }
    return Promise.resolve();
  };
}
