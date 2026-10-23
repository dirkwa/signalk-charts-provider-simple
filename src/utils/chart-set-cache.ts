/**
 * Each chart set's cells, kept between runs so an update downloads and runs
 * GDAL only on the cells whose version changed.
 *
 * `<dataDir>/chart-set-cache/<setId>/cells/<cell>/` holds the cell as it was
 * staged (`raw/`: the `.000` and its update files), its GDAL output
 * (`geojson/<LAYER>__<cell>.geojson.gz`) and `cell.json`, which records the
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
import type { EncDownloadResult } from './custom-catalog-download.js';
import type { PlannedCell } from './enc-chart-set.js';
import { isWithinBase } from './path-safety.js';
import { exportFileParts } from './s57-band.js';
import { COMPLETE_MARKER_PREFIX, EXPORT_ERROR_FILE_BASENAME } from './s57-converter.js';

/**
 * Bump when the GDAL export changes what it writes for the same cell, so
 * cached output from older plugin versions is exported again (from the kept
 * raw cell, without downloading it). 2: files are named `<LAYER>__<cell>`.
 */
export const CELL_EXPORT_REVISION = 2;

const CACHE_DIR_NAME = 'chart-set-cache';
/** Cells per GDAL run; each batch is kept as soon as it is read. */
export const CELLS_PER_EXPORT = 20;
const CELLS = 'cells';
const STAGING_PREFIX = '.staging-';
const CELL_FILE = 'cell.json';
const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/;
const SAFE_CELL = /^[A-Za-z0-9_-]{1,64}$/;

/** What `cell.json` records. */
export interface CachedCellInfo {
  version: string | undefined;
  exportRevision: number;
  /** The GDAL image that exported it; its output depends on GDAL's version. */
  image: string | undefined;
  /** Bytes the cell's entry takes on disk. */
  bytes: number;
}

/** What a run does with each of a set's cells. */
export interface CachePlan {
  /** Cached at the planned version: neither downloaded nor exported. */
  reuse: PlannedCell[];
  /** Cached at the planned version, but exported by an older revision or GDAL. */
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
  cached: ReadonlyMap<string, CachedCellInfo>,
  image: string
): CachePlan {
  const plan: CachePlan = { reuse: [], reexport: [], download: [] };
  for (const cell of cells) {
    const entry = cached.get(cell.name);
    if (!entry || cell.version === undefined || entry.version !== cell.version) {
      plan.download.push(cell);
    } else if (entry.exportRevision !== CELL_EXPORT_REVISION || entry.image !== image) {
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
      image?: unknown;
      bytes?: unknown;
    };
    if (typeof raw.exportRevision !== 'number') {
      return null;
    }
    return {
      version: typeof raw.version === 'string' ? raw.version : undefined,
      exportRevision: raw.exportRevision,
      image: typeof raw.image === 'string' ? raw.image : undefined,
      bytes: typeof raw.bytes === 'number' ? raw.bytes : 0
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

/** Bytes of every file under `dir`. */
function bytesUnder(dir: string): number {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    total += entry.isDirectory() ? bytesUnder(full) : entry.isFile() ? fs.statSync(full).size : 0;
  }
  return total;
}

export interface CommitResult {
  committed: string[];
  /** Cells GDAL did not read completely; not cached, so they are read again. */
  incomplete: string[];
}

/**
 * Move freshly exported cells into the cache: each cell's raw files and its
 * share of the GDAL output in `exportDir` (the files named `<LAYER>__<cell>.geojson`,
 * gzipped). Only a cell the export marked complete is kept: one that GDAL
 * could not read, or read in part, would otherwise be reused as it is until
 * its edition changes. A cell replaces its older cached copy only once
 * complete.
 */
export async function commitCells(
  setId: string,
  stagingDir: string,
  exportDir: string,
  cells: readonly CellToCommit[],
  image: string
): Promise<CommitResult> {
  const exported = fs.existsSync(exportDir) ? fs.readdirSync(exportDir) : [];
  const complete = new Set(
    exported
      .filter((f) => f.startsWith(COMPLETE_MARKER_PREFIX))
      .map((f) => f.slice(COMPLETE_MARKER_PREFIX.length))
  );
  // Output files by the cell they came from: `<LAYER>__<cell>.geojson`.
  const byStem = new Map<string, string[]>();
  for (const file of exported.filter((f) => f.endsWith('.geojson'))) {
    const { cell } = exportFileParts(file);
    if (cell !== null) {
      byStem.set(cell, [...(byStem.get(cell) ?? []), file]);
    }
  }
  const result: CommitResult = { committed: [], incomplete: [] };
  fs.mkdirSync(cellsDir(setId), { recursive: true });
  for (const cell of cells) {
    if (!SAFE_CELL.test(cell.name)) {
      continue;
    }
    const base = baseFileIn(cell.rawDir);
    const stem = base?.replace(/\.000$/i, '');
    if (stem === undefined || !complete.has(stem)) {
      result.incomplete.push(cell.name);
      continue;
    }
    const build = path.join(stagingDir, 'commit', cell.name);
    fs.rmSync(build, { recursive: true, force: true });
    linkCellFiles(cell.rawDir, path.join(build, 'raw'));
    const geojsonDir = path.join(build, 'geojson');
    fs.mkdirSync(geojsonDir, { recursive: true });
    for (const file of byStem.get(stem) ?? []) {
      await pipeline(
        fs.createReadStream(path.join(exportDir, file)),
        zlib.createGzip({ level: 6 }),
        fs.createWriteStream(path.join(geojsonDir, `${file}.gz`))
      );
    }
    const info: CachedCellInfo = {
      version: cell.version,
      exportRevision: CELL_EXPORT_REVISION,
      image,
      bytes: bytesUnder(build)
    };
    fs.writeFileSync(path.join(build, CELL_FILE), JSON.stringify(info));

    const target = path.join(cellsDir(setId), cell.name);
    const old = path.join(stagingDir, 'replaced', cell.name);
    if (fs.existsSync(target)) {
      fs.mkdirSync(path.dirname(old), { recursive: true });
      fs.renameSync(target, old);
    }
    fs.renameSync(build, target);
    fs.rmSync(old, { recursive: true, force: true });
    result.committed.push(cell.name);
  }
  return result;
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
 * without `cell.json`; and the caches of sets that no longer exist (deleted
 * by hand, or by an older plugin version). Run at start, when no chart set
 * is being built.
 */
export function sweepChartSetCache(knownSets: ReadonlySet<string>): void {
  let sets: string[];
  try {
    sets = fs.readdirSync(rootDir);
  } catch {
    return;
  }
  for (const set of sets) {
    const dir = path.join(rootDir, set);
    if (!knownSets.has(set)) {
      fs.rmSync(dir, { recursive: true, force: true });
      continue;
    }
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

/** Bytes a set's cached cells take on disk, as recorded when each was cached. */
export function setCacheBytes(setId: string): number {
  let total = 0;
  for (const info of readSetCache(setId).values()) {
    total += info.bytes;
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

/** The first lines GDAL wrote to the export's error log, if any. */
function exportErrorSample(exportDir: string): string[] {
  try {
    return fs
      .readFileSync(path.join(exportDir, EXPORT_ERROR_FILE_BASENAME), 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '')
      .slice(0, 10);
  } catch {
    return [];
  }
}

/** The steps of a cache update that touch the network or the container. */
export interface CacheUpdateSteps {
  /** Download and stage cells, each into `<encDir>/<cell>/`. */
  download: (cells: PlannedCell[], encDir: string) => Promise<EncDownloadResult>;
  /** Called once GDAL is about to run; may throw to stop the run (CPU budget). */
  beforeExport: (cellCount: number) => void;
  /** Run GDAL on every cell under `inDir`, writing per-cell output to `outDir`. */
  exportCells: (inDir: string, outDir: string) => Promise<void>;
  isCancelled: () => boolean;
  log: (line: string) => void;
  /** The plan, once known: cells reused or read again count as landed. */
  onPlan?: (plan: CachePlan) => void;
}

export interface CacheUpdateResult {
  /** The set's cells now cached, in the order of `cells`: what the chart is built from. */
  used: string[];
  /** Cell → the version cached, for each used cell that has one. */
  versions: Record<string, string>;
  /**
   * Some cell is missing, cached at an older version than the index has, or
   * could not be read again (it keeps its earlier GDAL output).
   */
  partial: boolean;
  /**
   * A cell was added, replaced or removed, so the chart has to be built
   * again. A cell GDAL could not read keeps its entry, so it changes nothing.
   */
  changed: boolean;
}

/** Thrown when the user cancelled the run. */
export class CacheUpdateCancelled extends Error {
  constructor() {
    super('Cancelled by user');
    this.name = 'CacheUpdateCancelled';
  }
}

/**
 * Bring a set's cache up to date with its cells: download the new and
 * changed cells, run GDAL on them (and on cached cells an older export read),
 * keep the ones read completely, and remove cells the set no longer has. A
 * cell that fails to download or to read keeps its earlier copy, if any.
 */
export async function updateSetCache(
  setId: string,
  cells: readonly PlannedCell[],
  stagingDir: string,
  image: string,
  steps: CacheUpdateSteps
): Promise<CacheUpdateResult> {
  const cached = readSetCache(setId);
  const plan = planCellCache(cells, cached, image);
  steps.log(
    `${String(plan.reuse.length)} cell(s) unchanged since the last download, ` +
      `${String(plan.download.length)} to download` +
      (plan.reexport.length > 0 ? `, ${String(plan.reexport.length)} to read again` : '')
  );
  const changedNames = plan.download
    .filter((c) => c.version !== undefined && cached.has(c.name))
    .map((c) => c.name);
  if (changedNames.length > 0) {
    steps.log(`Changed since the last download: ${changedNames.join(', ')}`);
  }
  steps.onPlan?.(plan);

  const encDir = path.join(stagingDir, 'enc');
  const downloaded: EncDownloadResult =
    plan.download.length === 0
      ? { staged: [], failed: [], versions: {} }
      : await steps.download(plan.download, encDir);
  if (steps.isCancelled()) {
    throw new CacheUpdateCancelled();
  }
  if (plan.download.length > 0) {
    steps.log(
      `Downloaded ${String(downloaded.staged.length)}/${String(plan.download.length)} ENC cell(s)` +
        (downloaded.failed.length > 0 ? `, ${String(downloaded.failed.length)} failed` : '')
    );
  }
  if (downloaded.failed.length > 0) {
    const kept = downloaded.failed.filter((f) => cached.has(f.chartId)).map((f) => f.chartId);
    steps.log(
      `WARNING: ${String(downloaded.failed.length)} cell(s) failed to download: ` +
        downloaded.failed.map((f) => f.chartId).join(', ') +
        (kept.length > 0 ? ` (using the earlier copy of ${kept.join(', ')})` : '') +
        ' — the set stays flagged for an update.'
    );
  }
  const staged = new Set(downloaded.staged);
  const usable = cells.filter((c) => cached.has(c.name) || staged.has(c.name));
  if (usable.length === 0) {
    throw new Error('All ENC downloads failed — check network connectivity');
  }

  const toCommit: CellToCommit[] = [
    ...downloaded.staged.map((name) => ({
      name,
      rawDir: path.join(encDir, name),
      version: downloaded.versions[name]
    })),
    ...plan.reexport.map((c) => ({
      name: c.name,
      rawDir: cachedRawDir(setId, c.name),
      version: cached.get(c.name)?.version
    }))
  ];
  // GDAL runs on a batch of cells at a time, each committed when done, so a
  // run that fails part-way through a large first build keeps what it read.
  const commit: CommitResult = { committed: [], incomplete: [] };
  if (toCommit.length > 0) {
    steps.beforeExport(toCommit.length);
  }
  for (let start = 0; start < toCommit.length; start += CELLS_PER_EXPORT) {
    if (steps.isCancelled()) {
      throw new CacheUpdateCancelled();
    }
    const batch = toCommit.slice(start, start + CELLS_PER_EXPORT);
    const exportIn = path.join(stagingDir, `export-in-${String(start)}`);
    const exportOut = path.join(stagingDir, `export-out-${String(start)}`);
    for (const cell of batch) {
      linkCellFiles(cell.rawDir, path.join(exportIn, cell.name));
    }
    await steps.exportCells(exportIn, exportOut);
    if (steps.isCancelled()) {
      throw new CacheUpdateCancelled();
    }
    const done = await commitCells(setId, stagingDir, exportOut, batch, image);
    commit.committed.push(...done.committed);
    commit.incomplete.push(...done.incomplete);
    if (done.incomplete.length > 0) {
      // What GDAL said about the cells it could not read, before it goes.
      for (const line of exportErrorSample(exportOut)) {
        steps.log(`  ${line}`);
      }
    }
    fs.rmSync(exportIn, { recursive: true, force: true });
    fs.rmSync(exportOut, { recursive: true, force: true });
  }
  if (commit.committed.length > 0) {
    steps.log(
      `Read ${String(commit.committed.length)} changed cell(s) with GDAL: ${commit.committed.join(', ')}`
    );
  }
  if (commit.incomplete.length > 0) {
    steps.log(
      `WARNING: GDAL could not read all of ${commit.incomplete.join(', ')}; ` +
        'kept as before and read again on the next update.'
    );
  }
  const removed = pruneSetCache(setId, new Set(cells.map((c) => c.name)));
  if (removed.length > 0) {
    steps.log(`Removed ${String(removed.length)} cell(s) the set no longer has`);
  }

  const inCache = readSetCache(setId);
  const used = cells.map((c) => c.name).filter((name) => inCache.has(name));
  if (used.length === 0) {
    throw new Error('No cell of this set could be read — see the log');
  }
  const versions: Record<string, string> = {};
  for (const name of used) {
    const version = inCache.get(name)?.version;
    if (version !== undefined) {
      versions[name] = version;
    }
  }
  const current = cells.every(
    (c) => inCache.has(c.name) && inCache.get(c.name)?.version === c.version
  );
  return {
    used,
    versions,
    partial: !current || commit.incomplete.length > 0,
    changed: commit.committed.length > 0 || removed.length > 0
  };
}
