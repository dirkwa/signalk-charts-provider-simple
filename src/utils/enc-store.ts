/**
 * The shared ENC store: S-57 cells as delivered, kept for other plugins to
 * read. signalk-underkeel, for one, builds its depth index from them.
 *
 * `<dataDir>/enc-store/<collection>/<CELL>/<CELL>.000`, with the cell's
 * update files (`.001`, `.002`, …) beside it, named after the cell so GDAL
 * applies them, and `<collection>/collection.json` describing the
 * collection. A collection is the cells behind one chart: a chart set's
 * cells, mirrored from the chart-set cache by hard link (no extra space on
 * the same disk), or the cells of an S-57 conversion, kept when the plugin's
 * `keepEncCells` option is on.
 *
 * Readers see a cell whole or not at all: it is built in a staging dir and
 * renamed into place, after its older copy is renamed aside, so for that
 * instant the cell is missing. A name starting with `.` is work in progress, never a cell or
 * a collection. A cell whose files did not change keeps its files as they
 * are (names, sizes and modification times), so a reader that stamps cells
 * by them sees no change. Listeners hear of a collection once its write is
 * done.
 */

import fs from 'fs';
import path from 'path';
import type { DebugFunction } from '../types.js';
import { isWithinBase } from './path-safety.js';
import { cellFiles } from './s57-export-files.js';

/** Bumped only by a change readers have to know about. */
export const ENC_STORE_API_VERSION = 1;

const STORE_DIR_NAME = 'enc-store';
const COLLECTION_FILE = 'collection.json';
const WORK_PREFIX = '.';
/** The owner prefix of a collection no longer tied to a chart. */
const DETACHED_OWNER = 'detached:';
const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/;
const SAFE_CELL = /^[A-Za-z0-9_-]{1,64}$/;
/** A cell's own files: the base cell and its numbered updates. */
const CELL_FILE = /^[A-Za-z0-9_-]{1,64}\.\d{3}$/;

/** Where a collection's cells came from. */
export type EncCollectionKind = 'chart-set' | 'conversion';

/** One file of a cell. */
export interface EncStoreFile {
  name: string;
  bytes: number;
  /** ISO time the file was last modified. */
  modified: string;
}

export interface EncStoreCell {
  /** The cell's name, as its `.000` file is named. */
  name: string;
  /** The source's version of the cell, when it states one (chart sets). */
  version?: string;
  /** Absolute path of the cell's directory. */
  dir: string;
  /** Its `.000` first, then its updates in order. */
  files: EncStoreFile[];
}

export interface EncCollectionSummary {
  id: string;
  name: string;
  kind: EncCollectionKind;
  /** The chart file built from these cells, relative to the chart path, if known. */
  chart?: string;
  /** How the cells arrived: `chart-set`, `upload`, `catalog` or `local`. */
  source: string;
  cellCount: number;
  bytes: number;
  updatedAt: string;
  /** Absolute path of the collection's directory: one folder per cell. */
  dir: string;
}

export interface EncCollection extends EncCollectionSummary {
  cells: EncStoreCell[];
}

/** What `collection.json` records. */
interface CollectionRecord {
  id: string;
  name: string;
  kind: EncCollectionKind;
  /** Who writes the collection; only the same owner replaces it. */
  owner: string;
  chart?: string;
  source: string;
  updatedAt: string;
  versions: Record<string, string>;
}

/** A cell to store: its `.000` file, its update files, and its version if known. */
export interface CellToStore {
  /** The `.000` file. Its update files are found beside it unless `files` is given. */
  base: string;
  /** Every file of the cell, `.000` first; found beside `base` when left out. */
  files?: readonly string[];
  version?: string;
}

export interface StoreCollectionRequest {
  /** Who the collection belongs to: `chart-set:<id>`, `chart:<file>` or `detached:<id>`. */
  owner: string;
  /** The id wanted; another owner's collection of that id gets `-2`, `-3`, … instead. */
  preferredId: string;
  name: string;
  kind: EncCollectionKind;
  chart?: string;
  source: string;
  cells: readonly CellToStore[];
  /** Hard link the files (copying across file systems), or copy them. */
  mode: 'link' | 'copy';
}

export interface StoreResult {
  id: string;
  /** Cells added or whose files changed. */
  written: string[];
  /** Cells the collection no longer has. */
  removed: string[];
  /** Cells left out: a name that is not a cell's, or met twice. */
  skipped: string[];
}

export type EncStoreListener = (collectionId: string) => void;

let rootDir = '';
let debug: DebugFunction = () => {};
// Kept across plugin restarts (a config save), as other plugins subscribe once.
const listeners = new Set<EncStoreListener>();
// Collections being written, so two writes to one never interleave.
const writing = new Map<string, Promise<unknown>>();
// Store roots swept in this process; see sweepEncStore.
const sweptRoots = new Set<string>();

export function initEncStore(dataDir: string, debugFn: DebugFunction): void {
  rootDir = path.join(dataDir, STORE_DIR_NAME);
  debug = debugFn || (() => {});
  fs.mkdirSync(rootDir, { recursive: true });
}

/** The directory holding every collection. */
export function encStoreRoot(): string {
  return rootDir;
}

export function isValidCollectionId(id: string): boolean {
  return SAFE_ID.test(id);
}

/** An id made of what a collection id may hold, from a chart or set name. */
export function collectionIdFor(name: string): string {
  const slug = name
    .trim()
    .replace(/\.mbtiles$/i, '')
    .replace(/\s+/g, '_')
    .replace(/[^A-Za-z0-9_-]/g, '')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 72);
  return slug || 'enc';
}

function collectionDir(id: string): string {
  if (!SAFE_ID.test(id)) {
    throw new Error(`Invalid ENC collection id: ${id}`);
  }
  const dir = path.join(rootDir, id);
  if (!isWithinBase(dir, rootDir)) {
    throw new Error(`Invalid ENC collection id: ${id}`);
  }
  return dir;
}

function readRecord(dir: string): CollectionRecord | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, COLLECTION_FILE), 'utf8')) as Partial<
      Record<keyof CollectionRecord, unknown>
    >;
    if (
      typeof raw.id !== 'string' ||
      typeof raw.owner !== 'string' ||
      (raw.kind !== 'chart-set' && raw.kind !== 'conversion')
    ) {
      return null;
    }
    const versions: Record<string, string> = {};
    if (raw.versions && typeof raw.versions === 'object') {
      for (const [cell, version] of Object.entries(raw.versions as Record<string, unknown>)) {
        if (typeof version === 'string') {
          versions[cell] = version;
        }
      }
    }
    return {
      id: raw.id,
      name: typeof raw.name === 'string' ? raw.name : raw.id,
      kind: raw.kind,
      owner: raw.owner,
      chart: typeof raw.chart === 'string' ? raw.chart : undefined,
      source: typeof raw.source === 'string' ? raw.source : raw.kind,
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
      versions
    };
  } catch {
    return null;
  }
}

function writeRecord(dir: string, record: CollectionRecord): void {
  const tmp = path.join(dir, `${WORK_PREFIX}${COLLECTION_FILE}.${String(process.pid)}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2));
  fs.renameSync(tmp, path.join(dir, COLLECTION_FILE));
}

/** A stored cell's files, `.000` first, then its updates in order. */
function storedFiles(cellDir: string): EncStoreFile[] {
  let names: string[];
  try {
    names = fs.readdirSync(cellDir);
  } catch {
    return [];
  }
  const files: EncStoreFile[] = [];
  for (const name of names.filter((n) => CELL_FILE.test(n)).sort()) {
    try {
      const st = fs.statSync(path.join(cellDir, name));
      if (st.isFile()) {
        files.push({ name, bytes: st.size, modified: new Date(st.mtimeMs).toISOString() });
      }
    } catch {
      // Removed while listed.
    }
  }
  return files[0]?.name.endsWith('.000') ? files : [];
}

function readCells(dir: string, record: CollectionRecord): EncStoreCell[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const cells: EncStoreCell[] = [];
  for (const name of names.filter((n) => SAFE_CELL.test(n)).sort()) {
    const cellDir = path.join(dir, name);
    const files = storedFiles(cellDir);
    if (files.length > 0) {
      const version = record.versions[name];
      cells.push(
        version === undefined
          ? { name, dir: cellDir, files }
          : { name, version, dir: cellDir, files }
      );
    }
  }
  return cells;
}

function toCollection(dir: string, record: CollectionRecord): EncCollection {
  const cells = readCells(dir, record);
  const summary: EncCollection = {
    id: record.id,
    name: record.name,
    kind: record.kind,
    source: record.source,
    cellCount: cells.length,
    bytes: cells.reduce((sum, c) => sum + c.files.reduce((s, f) => s + f.bytes, 0), 0),
    updatedAt: record.updatedAt,
    dir,
    cells
  };
  if (record.chart !== undefined) {
    summary.chart = record.chart;
  }
  return summary;
}

/** Every collection, by id. A collection still being written for the first time is left out. */
export function listCollections(): EncCollectionSummary[] {
  let names: string[];
  try {
    names = fs.readdirSync(rootDir);
  } catch {
    return [];
  }
  const result: EncCollectionSummary[] = [];
  for (const name of names.filter((n) => SAFE_ID.test(n)).sort()) {
    const dir = path.join(rootDir, name);
    const record = readRecord(dir);
    if (record?.id === name) {
      const { cells: _cells, ...summary } = toCollection(dir, record);
      result.push(summary);
    }
  }
  return result;
}

export function getCollection(id: string): EncCollection | null {
  if (!SAFE_ID.test(id)) {
    return null;
  }
  const dir = collectionDir(id);
  const record = readRecord(dir);
  return record?.id === id ? toCollection(dir, record) : null;
}

/** The absolute path of one file of a stored cell, or null when there is no such file. */
export function storedFilePath(id: string, cell: string, file: string): string | null {
  if (!SAFE_ID.test(id) || !SAFE_CELL.test(cell) || !CELL_FILE.test(file)) {
    return null;
  }
  if (path.basename(file, path.extname(file)) !== cell) {
    return null;
  }
  const full = path.join(collectionDir(id), cell, file);
  if (!isWithinBase(full, rootDir)) {
    return null;
  }
  try {
    return fs.statSync(full).isFile() ? full : null;
  } catch {
    return null;
  }
}

/** Hear of every collection written or removed, by id. Returns the unsubscribe. */
export function onEncStoreChange(listener: EncStoreListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function emit(id: string): void {
  for (const listener of [...listeners]) {
    try {
      listener(id);
    } catch (err) {
      debug(`ENC store listener failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/** The collection `owner` wrote, or null. */
export function collectionOf(owner: string): string | null {
  let names: string[];
  try {
    names = fs.readdirSync(rootDir);
  } catch {
    return null;
  }
  for (const name of names.filter((n) => SAFE_ID.test(n))) {
    if (readRecord(path.join(rootDir, name))?.owner === owner) {
      return name;
    }
  }
  return null;
}

/**
 * `owner`'s collection, or a free id for it near `preferred`, reserved by
 * creating its directory: a directory without `collection.json` is taken.
 */
function claimId(owner: string, preferred: string): string {
  const existing = collectionOf(owner);
  if (existing !== null) {
    return existing;
  }
  const base = collectionIdFor(preferred);
  for (let n = 1; ; n++) {
    const id = n === 1 ? base : `${base}-${String(n)}`;
    const dir = collectionDir(id);
    try {
      fs.mkdirSync(dir);
      return id;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw err;
      }
    }
  }
}

/** The files to store for a cell, each under the name GDAL looks for: `<cell>.<nnn>`. */
function namedFiles(cell: CellToStore): { name: string; files: Map<string, string> } | null {
  const stem = path.basename(cell.base, path.extname(cell.base));
  if (!SAFE_CELL.test(stem) || !/\.000$/i.test(cell.base)) {
    return null;
  }
  const files = new Map<string, string>();
  for (const file of cell.files ?? cellFiles(cell.base)) {
    const ext = path.extname(file);
    if (!/^\.\d{3}$/.test(ext)) {
      continue;
    }
    const name = `${stem}${ext}`;
    if (!files.has(name)) {
      files.set(name, file);
    }
  }
  return files.has(`${stem}.000`) ? { name: stem, files } : null;
}

/**
 * Whether the stored cell holds exactly these files, by name, size and
 * modification time; a copy's time is set to its source's to the
 * millisecond or so.
 */
function sameFiles(cellDir: string, files: ReadonlyMap<string, string>): boolean {
  const stored = storedFiles(cellDir);
  if (stored.length !== files.size) {
    return false;
  }
  return stored.every((f) => {
    const source = files.get(f.name);
    if (source === undefined) {
      return false;
    }
    try {
      const a = fs.statSync(source);
      const b = fs.statSync(path.join(cellDir, f.name));
      return a.size === b.size && Math.abs(a.mtimeMs - b.mtimeMs) < 2;
    } catch {
      return false;
    }
  });
}

async function placeFile(from: string, to: string, mode: 'link' | 'copy'): Promise<void> {
  if (mode === 'link') {
    try {
      await fs.promises.link(from, to);
      return;
    } catch {
      // Another file system: copy below.
    }
  }
  await fs.promises.copyFile(from, to, fs.constants.COPYFILE_FICLONE);
  // Keep the modification time, which readers stamp a cell by.
  const st = await fs.promises.stat(from);
  await fs.promises.utimes(to, st.atimeMs / 1000, st.mtimeMs / 1000);
}

/**
 * Put back the cells a failed write changed, newest change first: a cell it
 * placed goes, and the old copy set aside returns. The record was not yet
 * written, so the collection is again as it was.
 */
function restoreCells(
  dir: string,
  changed: readonly { name: string; aside: string | null; placed: boolean }[]
): void {
  for (const { name, aside, placed } of [...changed].reverse()) {
    const target = path.join(dir, name);
    try {
      if (placed) {
        fs.rmSync(target, { recursive: true, force: true });
      }
      if (aside !== null) {
        fs.renameSync(aside, target);
      }
    } catch (err) {
      console.error(
        `[charts-provider] Could not restore ENC cell ${name} in ${dir}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}

async function writeCollection(request: StoreCollectionRequest): Promise<StoreResult> {
  const id = claimId(request.owner, request.preferredId);
  const dir = collectionDir(id);
  const result: StoreResult = { id, written: [], removed: [], skipped: [] };
  const work = path.join(
    rootDir,
    `${WORK_PREFIX}staging-${id}-${String(Date.now())}-${String(process.pid)}`
  );
  fs.mkdirSync(work, { recursive: true });
  // Each cell changed so far and where its old copy waits, so a failed write is undone.
  const changed: { name: string; aside: string | null; placed: boolean }[] = [];
  try {
    const wanted = new Map<string, { files: Map<string, string>; version?: string }>();
    for (const cell of request.cells) {
      const named = namedFiles(cell);
      if (named === null || wanted.has(named.name)) {
        result.skipped.push(path.basename(cell.base));
        continue;
      }
      wanted.set(named.name, { files: named.files, version: cell.version });
    }
    for (const [name, cell] of wanted) {
      const target = path.join(dir, name);
      if (sameFiles(target, cell.files)) {
        continue;
      }
      const built = path.join(work, name);
      fs.mkdirSync(built);
      for (const [fileName, from] of cell.files) {
        await placeFile(from, path.join(built, fileName), request.mode);
      }
      // Swap it in: the old copy goes aside first, so a reader never finds half a cell.
      const change = {
        name,
        aside: fs.existsSync(target) ? path.join(work, `${WORK_PREFIX}old-${name}`) : null,
        placed: false
      };
      changed.push(change);
      if (change.aside !== null) {
        fs.renameSync(target, change.aside);
      }
      fs.renameSync(built, target);
      change.placed = true;
      result.written.push(name);
    }
    for (const name of fs.readdirSync(dir)) {
      if (SAFE_CELL.test(name) && !wanted.has(name)) {
        const aside = path.join(work, `${WORK_PREFIX}gone-${name}`);
        fs.renameSync(path.join(dir, name), aside);
        changed.push({ name, aside, placed: false });
        result.removed.push(name);
      }
    }
    const versions: Record<string, string> = {};
    for (const [name, cell] of wanted) {
      if (cell.version !== undefined) {
        versions[name] = cell.version;
      }
    }
    const before = readRecord(dir);
    const record: CollectionRecord = {
      id,
      name: request.name,
      kind: request.kind,
      owner: request.owner,
      source: request.source,
      updatedAt:
        before !== null && result.written.length === 0 && result.removed.length === 0
          ? before.updatedAt
          : new Date().toISOString(),
      versions
    };
    if (request.chart !== undefined) {
      record.chart = request.chart;
    }
    writeRecord(dir, record);
    return result;
  } catch (err) {
    restoreCells(dir, changed);
    throw err;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
    // A first write that failed leaves no half collection behind.
    if (readRecord(dir) === null) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}

/** Run `fn` once any write already running for `key` is done. */
async function serially<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const before = writing.get(key) ?? Promise.resolve();
  const run = before.catch(() => undefined).then(fn);
  writing.set(key, run);
  try {
    return await run;
  } finally {
    if (writing.get(key) === run) {
      writing.delete(key);
    }
  }
}

/**
 * Make `request.owner`'s collection hold exactly `request.cells`: cells new
 * or changed are written, cells left out removed, unchanged cells kept as
 * they are. Listeners hear of it when something changed or the collection
 * is new.
 */
export async function storeCollection(request: StoreCollectionRequest): Promise<StoreResult> {
  const result = await serially(request.owner, () => writeCollection(request));
  if (result.written.length > 0 || result.removed.length > 0) {
    emit(result.id);
  }
  return result;
}

/** Cells set aside for a collection until the chart they belong to is installed. */
export interface StagedCollection {
  /** Cells staged. */
  staged: number;
  /** Cells left out: a name that is not a cell's, or met twice. */
  skipped: string[];
  /** Make the collection hold the staged cells, as `storeCollection` does. The staging goes either way. */
  commit: () => Promise<StoreResult>;
  /** Drop the staged cells; the collection stays as it was. */
  discard: () => void;
}

let stagings = 0;

/**
 * Set a collection's cells aside, linked or copied as `request.mode` says,
 * without touching the collection: a conversion stages its cells while
 * they are still on disk and commits them only once its chart is
 * installed, so a cancelled or failed conversion leaves the collection
 * matching the chart still installed. Staged cells keep their sources'
 * modification times, and a commit hard links them into place.
 */
export async function stageCollection(request: StoreCollectionRequest): Promise<StagedCollection> {
  stagings += 1;
  const dir = path.join(
    rootDir,
    `${WORK_PREFIX}pending-${String(process.pid)}-${String(Date.now())}-${String(stagings)}`
  );
  fs.mkdirSync(dir, { recursive: true });
  const cells: CellToStore[] = [];
  const skipped: string[] = [];
  try {
    for (const cell of request.cells) {
      const named = namedFiles(cell);
      if (named === null || cells.some((c) => path.basename(c.base, '.000') === named.name)) {
        skipped.push(path.basename(cell.base));
        continue;
      }
      const cellDir = path.join(dir, named.name);
      fs.mkdirSync(cellDir);
      const files: string[] = [];
      for (const [fileName, from] of named.files) {
        const to = path.join(cellDir, fileName);
        await placeFile(from, to, request.mode);
        files.push(to);
      }
      const staged: CellToStore = { base: path.join(cellDir, `${named.name}.000`), files };
      if (cell.version !== undefined) {
        staged.version = cell.version;
      }
      cells.push(staged);
    }
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  }
  let open = true;
  const discard = (): void => {
    open = false;
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return {
    staged: cells.length,
    skipped,
    commit: async () => {
      if (!open) {
        throw new Error('These staged cells were already committed or discarded');
      }
      try {
        return await storeCollection({ ...request, cells, mode: 'link' });
      } finally {
        discard();
      }
    },
    discard
  };
}

/** Remove a collection; false when there is none of that id. */
export async function removeCollection(id: string): Promise<boolean> {
  if (!SAFE_ID.test(id)) {
    return false;
  }
  const dir = collectionDir(id);
  const record = readRecord(dir);
  if (record === null) {
    return false;
  }
  // Read again once earlier writes and removals are done: another may have removed it.
  const removed = await serially(record.owner, async () => {
    if (readRecord(dir) === null) {
      return false;
    }
    // Renamed aside first, so readers find it whole or not at all.
    const gone = path.join(rootDir, `${WORK_PREFIX}removed-${id}-${String(Date.now())}`);
    fs.renameSync(dir, gone);
    await fs.promises.rm(gone, { recursive: true, force: true });
    return true;
  });
  if (removed) {
    emit(id);
  }
  return removed;
}

/** Remove the collection `owner` wrote, if any. */
export async function removeCollectionOf(owner: string): Promise<void> {
  const id = collectionOf(owner);
  if (id !== null) {
    await removeCollection(id);
  }
}

/**
 * Give the collection `owner` wrote, if any, the owner `next(id)` and that
 * chart. Its id when it changed. Run inside the owner's turn to write.
 */
function retie(
  owner: string,
  next: (id: string) => string,
  chart: string | undefined
): string | null {
  const id = collectionOf(owner);
  if (id === null) {
    return null;
  }
  const dir = collectionDir(id);
  const record = readRecord(dir);
  if (record?.owner !== owner) {
    return null;
  }
  const { chart: _was, ...rest } = record;
  writeRecord(
    dir,
    chart === undefined ? { ...rest, owner: next(id) } : { ...rest, owner: next(id), chart }
  );
  return id;
}

/** A chart's collection move. */
export interface ChartCollectionMove {
  /** Whether the chart had a collection, which now belongs to its new path. */
  moved: boolean;
}

/** Run `fn` inside the turns to write of both owners, taken in a fixed order. */
function inBothTurns<T>(a: string, b: string, fn: () => T | Promise<T>): Promise<T> {
  const [first, second] = [a, b].sort();
  return serially(first, () => serially(second, () => Promise.resolve(fn())));
}

function emitEach(ids: (string | null)[]): void {
  for (const id of ids) {
    if (id !== null) {
      emit(id);
    }
  }
}

/**
 * A chart moved or renamed in the chart folder, from `from` to `to` (relative
 * to the chart path). Its collection, if any, follows it, so a chart
 * converted later at the old path does not replace it. A collection still
 * tied to `to` belongs to a chart no longer there: it keeps its cells, which
 * readers may be using, until the user removes them, but is no longer tied
 * to that path.
 *
 * `moveFile` moves the chart file itself once the collections have moved.
 * When it fails, both collections are put back as they were and its error is
 * thrown. Both owners' writes wait for the whole move, the file's included,
 * so a conversion committing its cells for `to` meanwhile comes before or
 * after it, never between.
 */
export async function moveChartCollection(
  from: string,
  to: string,
  moveFile: () => Promise<void> = () => Promise.resolve()
): Promise<ChartCollectionMove> {
  if (from === to) {
    await moveFile();
    return { moved: false };
  }
  const source = chartOwner(from);
  const target = chartOwner(to);
  const untied = (id: string): string => `${DETACHED_OWNER}${id}`;
  const [detached, moved] = await inBothTurns(source, target, async () => {
    const left = retie(target, untied, undefined);
    let done: [string | null, string | null];
    try {
      done = [left, retie(source, () => target, to)];
    } catch (err) {
      if (left !== null) {
        retie(untied(left), () => target, to);
      }
      throw err;
    }
    try {
      await moveFile();
    } catch (err) {
      // Nothing else wrote either owner meanwhile, so both go back as they were.
      try {
        const back = done[1] === null ? null : retie(target, () => source, from);
        const retied = left === null ? null : retie(untied(left), () => target, to);
        emitEach([back, retied]);
      } catch (back) {
        console.error(
          `[charts-provider] Could not move the kept ENC cells of ${to} back: ${back instanceof Error ? back.message : String(back)}`
        );
      }
      throw err;
    }
    return done;
  });
  emitEach([detached, moved]);
  return { moved: moved !== null };
}

/**
 * Untie the collection kept for the chart at `chart` (relative to the chart
 * path), if any, keeping its cells: the chart installed there now is not the
 * one they came from. False when the chart has no collection.
 */
export async function detachChartCollection(chart: string): Promise<boolean> {
  const owner = chartOwner(chart);
  const id = await serially(owner, () =>
    Promise.resolve(retie(owner, (was) => `${DETACHED_OWNER}${was}`, undefined))
  );
  if (id !== null) {
    emit(id);
  }
  return id !== null;
}

/** The owner of the collection of this id, or null. */
export function collectionOwner(id: string): string | null {
  return SAFE_ID.test(id) ? (readRecord(collectionDir(id))?.owner ?? null) : null;
}

/**
 * Remove what a write killed mid-way left: work dirs, and collection dirs
 * that never got their `collection.json`. Only the first call in a process
 * removes anything: a config save restarts the plugin while its
 * conversions, and their writes here, keep running.
 */
export function sweepEncStore(): string[] {
  const removed: string[] = [];
  if (sweptRoots.has(rootDir)) {
    return removed;
  }
  sweptRoots.add(rootDir);
  let names: string[];
  try {
    names = fs.readdirSync(rootDir);
  } catch {
    return removed;
  }
  for (const name of names) {
    const full = path.join(rootDir, name);
    const leftover =
      name.startsWith(WORK_PREFIX) || (SAFE_ID.test(name) && readRecord(full) === null);
    if (leftover) {
      try {
        if (fs.statSync(full).isDirectory()) {
          fs.rmSync(full, { recursive: true, force: true });
          removed.push(name);
        }
      } catch (err) {
        debug(`ENC store sweep of ${name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  return removed;
}

/** The owner of a chart set's collection. */
export function chartSetOwner(setId: string): string {
  return `chart-set:${setId}`;
}

/** The owner of a converted chart's collection, by its path relative to the chart path. */
export function chartOwner(chartFile: string): string {
  return `chart:${chartFile}`;
}

/** The ids of the chart sets that have a collection. */
export function chartSetCollections(): Map<string, string> {
  const result = new Map<string, string>();
  let names: string[];
  try {
    names = fs.readdirSync(rootDir);
  } catch {
    return result;
  }
  // The records alone, without listing every cell's files.
  for (const name of names.filter((n) => SAFE_ID.test(n)).sort()) {
    const record = readRecord(path.join(rootDir, name));
    if (record?.id === name && record.owner.startsWith('chart-set:')) {
      result.set(record.owner.slice('chart-set:'.length), name);
    }
  }
  return result;
}
