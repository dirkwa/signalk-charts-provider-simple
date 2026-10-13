/**
 * On-disk cache for raster tiles synthesized by raster-overzoom.ts.
 *
 * Charts that skip whole zoom levels have every tile at those levels
 * synthesized, at 1–2 s per tile on a Raspberry Pi against ~0.1 s for a
 * stored one. The in-memory LRU holds about one screen and is lost on
 * restart, so each synthesized tile is also written here and later served
 * from disk at stored-tile speed.
 *
 * Layout: <dataDir>/raster-tile-cache/<chart key>/<z>/<x>/<y>.tile. The chart
 * key hashes the chart file's path, size and mtime, so a replaced, renamed or
 * re-imported chart gets a fresh directory and never serves stale tiles; the
 * old directory is pruned on the next chart scan or aged out by the size cap.
 * Chart files and the chart folder are never written to.
 *
 * Disk use is capped at MAX_CACHE_BYTES. When a write would exceed it, whole
 * chart directories are evicted least recently used first, never the one
 * being written; if that one alone fills the cap, new tiles for it are simply
 * not stored. Chart granularity keeps the bookkeeping to one entry per chart
 * instead of one per tile.
 *
 * Reads are synchronous, like the MBTiles reads they stand in for, so tile
 * serving keeps no await between provider lookup and handle use. Writes go
 * to a temporary file in the target directory and are renamed into place, off
 * the response path. Any failure degrades to synthesizing as before, with one
 * log line per process.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { RasterTile } from './raster-compose.js';

// About 7,000–100,000 synthesized tiles: several charts' skipped levels at
// the zooms a boat actually uses, small next to a typical SD card or SSD.
export const MAX_CACHE_BYTES = 1024 * 1024 * 1024;

const KEY_PATTERN = /^[0-9a-f]{16}$/;

interface ChartEntry {
  bytes: number;
  lastUsed: number;
}

let root = '';
let maxBytes = MAX_CACHE_BYTES;
// Writes wait for the startup scan so the byte count starts from what is
// on disk; reads work immediately.
let scanned = false;
let scanDone: Promise<void> = Promise.resolve();
let index = new Map<string, ChartEntry>();
let totalBytes = 0;
let touched = new Set<string>();
let pending = new Set<Promise<void>>();
// Bumped by each init, so a scan or prune from an earlier one leaves the
// current state alone.
let generation = 0;
// Chart directories being removed; a write for that chart waits for it.
let removing = new Map<string, Promise<void>>();
// Tiles being written, so two requests that synthesized the same tile
// store and count it once.
let writing = new Set<string>();
let warned = false;

function warnOnce(what: string, err: unknown): void {
  if (warned) {
    return;
  }
  warned = true;
  const msg = err instanceof Error ? err.message : String(err);
  console.error(
    `[charts-provider] Raster tile cache ${what} failed, continuing without it: ${msg}`
  );
}

/**
 * Point the cache at `dir`, creating it, and scan what an earlier run left
 * there. Resolves when the scan is done; never rejects. On failure the cache
 * stays off and tiles are synthesized as before.
 */
export function initRasterTileCache(
  dir: string,
  options: { maxBytes?: number } = {}
): Promise<void> {
  root = '';
  maxBytes = options.maxBytes ?? MAX_CACHE_BYTES;
  scanned = false;
  index = new Map();
  totalBytes = 0;
  touched = new Set();
  pending = new Set();
  removing = new Map();
  writing = new Set();
  warned = false;
  const gen = ++generation;
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    warnOnce('setup', err);
    scanDone = Promise.resolve();
    return scanDone;
  }
  root = dir;
  scanDone = scan(dir).then((found) => {
    if (gen === generation) {
      index = found.index;
      totalBytes = found.bytes;
      scanned = true;
      evictFor(null, 0);
    }
  });
  return scanDone;
}

/** What `dir` holds, per chart. Kept local until the caller commits it. */
async function scan(dir: string): Promise<{ index: Map<string, ChartEntry>; bytes: number }> {
  const found = { index: new Map<string, ChartEntry>(), bytes: 0 };
  let names: string[];
  try {
    names = await fs.promises.readdir(dir);
  } catch (err) {
    warnOnce('scan', err);
    return found;
  }
  for (const name of names) {
    if (!KEY_PATTERN.test(name)) {
      continue;
    }
    const chartDir = path.join(dir, name);
    const entry: ChartEntry = { bytes: 0, lastUsed: 0 };
    try {
      entry.lastUsed = (await fs.promises.stat(chartDir)).mtimeMs;
      const files = await fs.promises.readdir(chartDir, { recursive: true, withFileTypes: true });
      for (const file of files) {
        if (!file.isFile()) {
          continue;
        }
        const filePath = path.join(file.parentPath, file.name);
        if (file.name.endsWith('.tmp')) {
          // Left by a write interrupted by a crash or power cut.
          await fs.promises.rm(filePath, { force: true });
          continue;
        }
        const st = await fs.promises.stat(filePath);
        entry.bytes += st.size;
        entry.lastUsed = Math.max(entry.lastUsed, st.mtimeMs);
      }
    } catch {
      // A directory removed or half-written while scanning: count what was seen.
    }
    found.index.set(name, entry);
    found.bytes += entry.bytes;
  }
  return found;
}

/**
 * The cache key for a chart file: a hash of its path, size and mtime. Null
 * when the cache is off or the file cannot be read.
 */
export function chartCacheKey(filePath: string): string | null {
  if (!root) {
    return null;
  }
  try {
    const st = fs.statSync(filePath);
    return crypto
      .createHash('sha256')
      .update(`${path.resolve(filePath)}\0${String(st.size)}\0${String(st.mtimeMs)}`)
      .digest('hex')
      .slice(0, 16);
  } catch {
    return null;
  }
}

function tilePath(key: string, z: number, x: number, y: number): string {
  return path.join(root, key, String(z), String(x), `${String(y)}.tile`);
}

/** A cached tile, or null on a miss or any read error. */
export function readCachedTile(key: string, z: number, x: number, y: number): RasterTile | null {
  if (!root) {
    return null;
  }
  let data: Buffer;
  try {
    data = fs.readFileSync(tilePath(key, z, x, y));
  } catch {
    return null;
  }
  // Sniffed so the file needs no side record of its type.
  let contentType: RasterTile['contentType'];
  if (data[0] === 0xff && data[1] === 0xd8) {
    contentType = 'image/jpeg';
  } else if (data[0] === 0x89 && data[1] === 0x50) {
    contentType = 'image/png';
  } else {
    return null;
  }
  markUsed(key);
  return { data, contentType };
}

function markUsed(key: string): void {
  const now = Date.now();
  const entry = index.get(key);
  if (entry) {
    entry.lastUsed = now;
  }
  // The directory mtime carries last use across restarts; once per chart
  // per run is enough.
  if (!touched.has(key)) {
    touched.add(key);
    const date = new Date(now);
    fs.promises.utimes(path.join(root, key), date, date).catch(() => undefined);
  }
}

/**
 * Evict least recently used charts other than `keep` until `incoming` more
 * bytes fit under the cap. Returns whether they fit.
 */
function evictFor(keep: string | null, incoming: number): boolean {
  if (totalBytes + incoming <= maxBytes) {
    return true;
  }
  const victims = [...index.entries()]
    .filter(([key]) => key !== keep)
    .sort((a, b) => a[1].lastUsed - b[1].lastUsed);
  for (const [key, entry] of victims) {
    if (totalBytes + incoming <= maxBytes) {
      break;
    }
    removeChart(key, entry);
  }
  return totalBytes + incoming <= maxBytes;
}

function removeChart(key: string, entry: ChartEntry): void {
  index.delete(key);
  totalBytes -= entry.bytes;
  const removals = removing;
  const op: Promise<void> = fs.promises
    .rm(path.join(root, key), { recursive: true, force: true })
    .catch((err: unknown) => {
      warnOnce('cleanup', err);
    })
    .then(() => {
      if (removals.get(key) === op) {
        removals.delete(key);
      }
    });
  removals.set(key, op);
  track(op);
}

function track(op: Promise<void>): void {
  pending.add(op);
  void op.finally(() => pending.delete(op));
}

/**
 * Store a synthesized tile in the background. Never throws; a failure is
 * logged once and the tile is synthesized again next time.
 */
export function writeCachedTile(
  key: string,
  z: number,
  x: number,
  y: number,
  tile: RasterTile
): void {
  if (!root || !scanned) {
    return;
  }
  const target = tilePath(key, z, x, y);
  if (writing.has(target)) {
    return;
  }
  const size = tile.data.byteLength;
  if (!evictFor(key, size)) {
    return;
  }
  const entry = index.get(key) ?? { bytes: 0, lastUsed: 0 };
  entry.bytes += size;
  entry.lastUsed = Date.now();
  index.set(key, entry);
  totalBytes += size;
  // Undo the reservation unless the chart was evicted meanwhile.
  const release = () => {
    if (index.get(key) === entry) {
      entry.bytes -= size;
      totalBytes -= size;
    }
  };

  const tmp = `${target}.${String(process.pid)}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const inFlight = writing;
  inFlight.add(target);
  const write = (async () => {
    try {
      // Otherwise the removal could delete the new tile.
      await removing.get(key);
      if (await fs.promises.stat(target).catch(() => null)) {
        // Stored by a request that synthesized it too and finished first.
        release();
        return;
      }
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      await fs.promises.writeFile(tmp, tile.data);
      await fs.promises.rename(tmp, target);
      if (index.get(key) !== entry) {
        // Evicted while writing: the tile is no longer counted, so drop it.
        await fs.promises.rm(target, { force: true });
      }
    } catch (err) {
      warnOnce('write', err);
      release();
      await fs.promises.rm(tmp, { force: true }).catch(() => undefined);
    } finally {
      inFlight.delete(target);
    }
  })();
  track(write);
}

/** Resolves once every write and removal started so far has finished. For tests. */
export async function flushRasterTileCache(): Promise<void> {
  await Promise.all([...pending]);
}

/**
 * Remove cached tiles of charts that are no longer in `chartFiles` (the
 * full chart scan, disabled charts included), or whose file has changed
 * since its tiles were cached. Never rejects.
 */
export async function pruneRasterTileCache(chartFiles: Iterable<string>): Promise<void> {
  if (!root) {
    return;
  }
  const live = new Set<string>();
  for (const file of chartFiles) {
    const key = chartCacheKey(file);
    if (key) {
      live.add(key);
    }
  }
  const gen = generation;
  await scanDone;
  if (!root || gen !== generation) {
    return;
  }
  let names: string[];
  try {
    names = await fs.promises.readdir(root);
  } catch {
    return;
  }
  if (gen !== generation) {
    return;
  }
  for (const name of names) {
    if (KEY_PATTERN.test(name) && !live.has(name)) {
      removeChart(name, index.get(name) ?? { bytes: 0, lastUsed: 0 });
    }
  }
}
