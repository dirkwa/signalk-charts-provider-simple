/**
 * On-disk caches for raster tiles the plugin makes itself: those synthesized
 * by raster-overzoom.ts, and masked versions of online charts
 * (masked-tiles.ts). Each has its own instance, directory and size cap, so
 * masking a large downloaded area never pushes out the synthesized tiles.
 *
 * Charts that skip whole zoom levels have every tile at those levels
 * synthesized, at 1–2 s per tile on a Raspberry Pi against ~0.1 s for a
 * stored one. The in-memory LRU holds about one screen and is lost on
 * restart, so each synthesized tile is also written here and later served
 * from disk at stored-tile speed.
 *
 * Layout: <cache dir>/<chart key>/<z>/<x>/<y>.tile. For synthesized tiles the
 * chart key hashes the chart file's path, size and mtime, so a replaced,
 * renamed or re-imported chart gets a fresh directory and never serves stale
 * tiles; the old directory is pruned on the next chart scan or aged out by the
 * size cap. Masked tiles key on what they were made from instead, and stamp
 * each file with the source tile it came from (see writeStamped). Chart files
 * and the chart folder are never written to.
 *
 * Disk use is capped, by default at MAX_CACHE_BYTES. When a write would
 * exceed the cap, whole chart directories are evicted least recently used
 * first, never the one being written; if that one alone fills the cap, new
 * tiles for it are simply not stored. Chart granularity keeps the bookkeeping
 * to one entry per chart instead of one per tile.
 *
 * Reads are synchronous, like the MBTiles reads they stand in for, so tile
 * serving keeps no await between provider lookup and handle use. Writes go
 * to a temporary file in the target directory and are renamed into place, off
 * the response path. Any failure degrades to making the tile again, with one
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

/** Starts a stamped file; neither PNG nor JPEG starts this way, so read() never serves one. */
const STAMP_MAGIC = Buffer.from('SKT1', 'latin1');
const STAMP_BYTES = STAMP_MAGIC.length + 8;

interface ChartEntry {
  bytes: number;
  lastUsed: number;
}

function hashKey(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}

export class RasterTileCache {
  private root = '';
  private maxBytes = MAX_CACHE_BYTES;
  // Writes wait for the startup scan so the byte count starts from what is
  // on disk; reads work immediately.
  private scanned = false;
  private scanDone: Promise<void> = Promise.resolve();
  private index = new Map<string, ChartEntry>();
  private totalBytes = 0;
  private touched = new Set<string>();
  private pending = new Set<Promise<void>>();
  // Bumped by each init, so a scan or prune from an earlier one leaves the
  // current state alone.
  private generation = 0;
  // Chart directories being removed; a write for that chart waits for it.
  private removing = new Map<string, Promise<void>>();
  // Tiles being written, so two requests that made the same tile store and
  // count it once.
  private writing = new Set<string>();
  private warned = false;

  /** `label` names the cache in the one log line a failure gets. */
  constructor(private readonly label: string) {}

  private warnOnce(what: string, err: unknown): void {
    if (this.warned) {
      return;
    }
    this.warned = true;
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[charts-provider] ${this.label} ${what} failed, continuing without it: ${msg}`);
  }

  /**
   * Point the cache at `dir`, creating it, and scan what an earlier run left
   * there. Resolves when the scan is done; never rejects. On failure the
   * cache stays off and tiles are made as if it were not there.
   */
  init(dir: string, options: { maxBytes?: number } = {}): Promise<void> {
    this.root = '';
    this.maxBytes = options.maxBytes ?? MAX_CACHE_BYTES;
    this.scanned = false;
    this.index = new Map();
    this.totalBytes = 0;
    this.touched = new Set();
    this.pending = new Set();
    this.removing = new Map();
    this.writing = new Set();
    this.warned = false;
    const gen = ++this.generation;
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (err) {
      this.warnOnce('setup', err);
      this.scanDone = Promise.resolve();
      return this.scanDone;
    }
    this.root = dir;
    this.scanDone = this.scan(dir).then((found) => {
      if (gen === this.generation) {
        this.index = found.index;
        this.totalBytes = found.bytes;
        this.scanned = true;
        this.evictFor(null, 0);
      }
    });
    return this.scanDone;
  }

  /** What `dir` holds, per chart. Kept local until the caller commits it. */
  private async scan(dir: string): Promise<{ index: Map<string, ChartEntry>; bytes: number }> {
    const found = { index: new Map<string, ChartEntry>(), bytes: 0 };
    let names: string[];
    try {
      names = await fs.promises.readdir(dir);
    } catch (err) {
      this.warnOnce('scan', err);
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
        const files = await fs.promises.readdir(chartDir, {
          recursive: true,
          withFileTypes: true
        });
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
  fileKey(filePath: string): string | null {
    if (!this.root) {
      return null;
    }
    try {
      const st = fs.statSync(filePath);
      return hashKey(`${path.resolve(filePath)}\0${String(st.size)}\0${String(st.mtimeMs)}`);
    } catch {
      return null;
    }
  }

  /** The cache key for anything else tiles are made from, named by `text`. Null when the cache is off. */
  key(text: string): string | null {
    return this.root ? hashKey(text) : null;
  }

  private tilePath(key: string, z: number, x: number, y: number): string {
    return path.join(this.root, key, String(z), String(x), `${String(y)}.tile`);
  }

  private readFile(key: string, z: number, x: number, y: number): Buffer | null {
    if (!this.root) {
      return null;
    }
    try {
      return fs.readFileSync(this.tilePath(key, z, x, y));
    } catch {
      return null;
    }
  }

  /** A cached tile, or null on a miss or any read error. */
  read(key: string, z: number, x: number, y: number): RasterTile | null {
    const data = this.readFile(key, z, x, y);
    if (!data) {
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
    this.markUsed(key);
    return { data, contentType };
  }

  /**
   * What writeStamped stored, or null on a miss, a read error, or a stamp
   * other than `stamp`: the tile it was made from has changed since.
   */
  readStamped(key: string, z: number, x: number, y: number, stamp: number): Buffer | null {
    const data = this.readFile(key, z, x, y);
    if (
      !data ||
      data.length < STAMP_BYTES ||
      !data.subarray(0, STAMP_MAGIC.length).equals(STAMP_MAGIC) ||
      data.readDoubleLE(STAMP_MAGIC.length) !== stamp
    ) {
      return null;
    }
    this.markUsed(key);
    return data.subarray(STAMP_BYTES);
  }

  private markUsed(key: string): void {
    const now = Date.now();
    const entry = this.index.get(key);
    if (entry) {
      entry.lastUsed = now;
    }
    // The directory mtime carries last use across restarts; once per chart
    // per run is enough.
    if (!this.touched.has(key)) {
      this.touched.add(key);
      const date = new Date(now);
      fs.promises.utimes(path.join(this.root, key), date, date).catch(() => undefined);
    }
  }

  /**
   * Evict least recently used charts other than `keep` until `incoming` more
   * bytes fit under the cap. Returns whether they fit.
   */
  private evictFor(keep: string | null, incoming: number): boolean {
    if (this.totalBytes + incoming <= this.maxBytes) {
      return true;
    }
    const victims = [...this.index.entries()]
      .filter(([key]) => key !== keep)
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (const [key, entry] of victims) {
      if (this.totalBytes + incoming <= this.maxBytes) {
        break;
      }
      this.removeChart(key, entry);
    }
    return this.totalBytes + incoming <= this.maxBytes;
  }

  private removeChart(key: string, entry: ChartEntry): void {
    this.index.delete(key);
    this.totalBytes -= entry.bytes;
    const removals = this.removing;
    const op: Promise<void> = fs.promises
      .rm(path.join(this.root, key), { recursive: true, force: true })
      .catch((err: unknown) => {
        this.warnOnce('cleanup', err);
      })
      .then(() => {
        if (removals.get(key) === op) {
          removals.delete(key);
        }
      });
    removals.set(key, op);
    this.track(op);
  }

  private track(op: Promise<void>): void {
    this.pending.add(op);
    void op.finally(() => this.pending.delete(op));
  }

  /**
   * Store a tile in the background. Never throws; a failure is logged once
   * and the tile is made again next time.
   */
  write(key: string, z: number, x: number, y: number, tile: RasterTile): void {
    this.writeFile(key, z, x, y, tile.data, false);
  }

  /**
   * Store bytes stamped with `stamp`, which readStamped must be given to
   * read them back, replacing what is stored for the tile. Masked tiles are
   * stamped with when the tile they were made from was fetched.
   */
  writeStamped(
    key: string,
    z: number,
    x: number,
    y: number,
    stamp: number,
    data: Uint8Array
  ): void {
    const header = Buffer.alloc(STAMP_BYTES);
    STAMP_MAGIC.copy(header);
    header.writeDoubleLE(stamp, STAMP_MAGIC.length);
    this.writeFile(key, z, x, y, Buffer.concat([header, data]), true);
  }

  private writeFile(
    key: string,
    z: number,
    x: number,
    y: number,
    data: Uint8Array,
    replace: boolean
  ): void {
    if (!this.root || !this.scanned) {
      return;
    }
    const target = this.tilePath(key, z, x, y);
    if (this.writing.has(target)) {
      return;
    }
    const size = data.byteLength;
    // A replacement only grows the cache by the difference: room for all of
    // it could evict other charts, or skip the write and leave a stale tile.
    let replaced = 0;
    if (replace) {
      try {
        replaced = fs.statSync(target).size;
      } catch {
        // Nothing there yet.
      }
    }
    if (!this.evictFor(key, size - replaced)) {
      return;
    }
    const entry = this.index.get(key) ?? { bytes: 0, lastUsed: 0 };
    entry.bytes += size;
    entry.lastUsed = Date.now();
    this.index.set(key, entry);
    this.totalBytes += size;
    // Undo the reservation unless the chart was evicted meanwhile.
    const release = (bytes: number): void => {
      if (this.index.get(key) === entry) {
        entry.bytes -= bytes;
        this.totalBytes -= bytes;
      }
    };

    const tmp = `${target}.${String(process.pid)}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    const inFlight = this.writing;
    inFlight.add(target);
    const write = (async () => {
      try {
        // Otherwise the removal could delete the new tile.
        await this.removing.get(key);
        const existing = await fs.promises.stat(target).catch(() => null);
        if (existing && !replace) {
          // Stored by a request that made it too and finished first.
          release(size);
          return;
        }
        await fs.promises.mkdir(path.dirname(target), { recursive: true });
        await fs.promises.writeFile(tmp, data);
        await fs.promises.rename(tmp, target);
        if (existing) {
          // The replaced file no longer takes space.
          release(existing.size);
        }
        if (this.index.get(key) !== entry) {
          // Evicted while writing: the tile is no longer counted, so drop it.
          await fs.promises.rm(target, { force: true });
        }
      } catch (err) {
        this.warnOnce('write', err);
        release(size);
        await fs.promises.rm(tmp, { force: true }).catch(() => undefined);
      } finally {
        inFlight.delete(target);
      }
    })();
    this.track(write);
  }

  /** Resolves once every write and removal started so far has finished. For tests. */
  async flush(): Promise<void> {
    await Promise.all([...this.pending]);
  }

  /**
   * Remove the tiles of every chart key not in `live`: charts no longer in
   * the library, or whose tiles were made from something that has since
   * changed. Never rejects.
   */
  async prune(live: Iterable<string>): Promise<void> {
    if (!this.root) {
      return;
    }
    const keep = new Set(live);
    const gen = this.generation;
    await this.scanDone;
    if (!this.root || gen !== this.generation) {
      return;
    }
    let names: string[];
    try {
      names = await fs.promises.readdir(this.root);
    } catch {
      return;
    }
    if (gen !== this.generation) {
      return;
    }
    for (const name of names) {
      if (KEY_PATTERN.test(name) && !keep.has(name)) {
        this.removeChart(name, this.index.get(name) ?? { bytes: 0, lastUsed: 0 });
      }
    }
  }
}

/** Tiles synthesized for raster MBTiles missing them (raster-overzoom.ts). */
export const overzoomTileCache = new RasterTileCache('Raster tile cache');

/** Masked versions of online chart tiles (masked-tiles.ts). */
export const maskedTileCache = new RasterTileCache('Masked tile cache');
