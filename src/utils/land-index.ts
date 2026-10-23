/**
 * The land index: OpenStreetMap's land polygons in a SQLite file with an
 * R-tree, so the polygons under any tile can be found without reading the
 * rest. Masked chart versions ("Water only", "Land only") read it when a
 * tile is first masked.
 *
 * Two OSM sets go in, both in Web Mercator and both from
 * osmdata.openstreetmap.de: the simplified polygons OSM generalises for
 * small scales, read below FULL_DETAIL_MIN_ZOOM, and the full-detail
 * polygons, pre-split into small pieces, read from it up. A tile's zoom
 * picks the set, so a zoomed-out tile never reads full-detail coastline.
 * Below zoom 6, coarser copies made from the simplified set are read (see
 * COARSE_SETS), so a tile showing half the world reads a few hundred
 * kilobytes rather than every coastline.
 *
 * The build streams each zip as it downloads and reads the shapefile out of
 * it record by record, so memory stays flat on a Raspberry Pi however large
 * the download; it writes a `.building` file that is renamed into place only
 * once complete, so a failed or interrupted build leaves nothing behind.
 * Interior rings are kept, so water enclosed by land stays water.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import unzipper, { type Entry } from 'unzipper';
import {
  encodeRings,
  ringsBbox,
  splitPolygon,
  thinRings,
  type Bbox,
  type Rings
} from './land-geometry.js';
import { readShapefilePolygons } from './land-shapefile.js';

/** Tiles from this zoom up read the full-detail polygons; below it, the simplified ones. */
export const FULL_DETAIL_MIN_ZOOM = 10;

/**
 * Coarser copies of the simplified set, for the tiles below `belowZoom`:
 * vertices within `tolerance` metres of the last one kept are dropped, and
 * land smaller than `minSize` metres either way is left out. Both are under
 * half a pixel at the largest zoom each serves (4.9 km per pixel at zoom 5,
 * 39 km at zoom 2). Ordered coarsest first.
 */
const COARSE_SETS = [
  { name: 'world', belowZoom: 3, tolerance: 8000, minSize: 20000 },
  { name: 'coarse', belowZoom: 6, tolerance: 500, minSize: 2000 }
] as const;

/** Pieces larger than this are split when stored, so a tile never reads a whole continent. */
const MAX_POINTS_PER_PIECE = 2048;

const INSERTS_PER_TRANSACTION = 2000;

// Far shorter than fetch's own five minutes: a stalled download should
// fail, so the user can retry it, rather than hang.
const HEAD_TIMEOUT_MS = 30_000;
const STALL_TIMEOUT_MS = 120_000;

/** `signal` and a timeout together, either aborting the request. */
function withTimeout(signal: AbortSignal | undefined, timeout: AbortSignal): AbortSignal {
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export type LandSet = 'simplified' | 'full';

/** The sets stored: the two downloaded, and the coarse copies made from the simplified one. */
type StoredSet = LandSet | (typeof COARSE_SETS)[number]['name'];

export interface LandSource {
  set: LandSet;
  url: string;
}

export const LAND_SOURCES: readonly LandSource[] = [
  {
    set: 'simplified',
    url: 'https://osmdata.openstreetmap.de/download/simplified-land-polygons-complete-3857.zip'
  },
  {
    set: 'full',
    url: 'https://osmdata.openstreetmap.de/download/land-polygons-split-3857.zip'
  }
];

/** What the data takes, measured 2026-10-23, for the confirmation before downloading. */
export const APPROX_DOWNLOAD_BYTES = 977_000_000;
export const APPROX_INDEX_BYTES = 392_000_000;

export interface LandBuildProgress {
  receivedBytes: number;
  /** Null until every source has said how large it is. */
  totalBytes: number | null;
  polygons: number;
}

export interface LandBuildOptions {
  userAgent: string;
  sources?: readonly LandSource[];
  fetch?: typeof fetch;
  signal?: AbortSignal;
  onProgress?: (progress: LandBuildProgress) => void;
  /** How long a download may receive nothing before it fails; tests shorten it. */
  stallTimeoutMs?: number;
}

function rtreeTable(set: StoredSet): string {
  return `rtree_${set}`;
}

function removeDatabase(file: string): void {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    fs.rmSync(file + suffix, { force: true });
  }
}

async function sourceSize(
  source: LandSource,
  options: LandBuildOptions,
  fetchImpl: typeof fetch
): Promise<number | null> {
  try {
    const res = await fetchImpl(source.url, {
      method: 'HEAD',
      headers: { 'User-Agent': options.userAgent },
      signal: withTimeout(options.signal, AbortSignal.timeout(HEAD_TIMEOUT_MS))
    });
    const length = Number(res.headers.get('content-length'));
    return res.ok && length > 0 ? length : null;
  } catch {
    return null;
  }
}

/**
 * Download the land polygons and build the index at `file`. Resolves with
 * the new index's version; rejects on any failure, leaving no file behind.
 */
export async function buildLandIndex(
  file: string,
  options: LandBuildOptions
): Promise<{ version: string }> {
  const fetchImpl = options.fetch ?? fetch;
  const sources = options.sources ?? LAND_SOURCES;
  const building = `${file}.building`;
  removeDatabase(building);
  const progress: LandBuildProgress = { receivedBytes: 0, totalBytes: null, polygons: 0 };
  const sizes = await Promise.all(sources.map((s) => sourceSize(s, options, fetchImpl)));
  if (sizes.every((s) => s !== null)) {
    progress.totalBytes = sizes.reduce((a, b) => a + b, 0);
  }
  options.onProgress?.({ ...progress });

  const db = new DatabaseSync(building);
  try {
    db.exec(`
      PRAGMA journal_mode = OFF;
      PRAGMA synchronous = OFF;
      CREATE TABLE meta (name TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE polygons (id INTEGER PRIMARY KEY, data BLOB NOT NULL);
      CREATE VIRTUAL TABLE rtree_simplified USING rtree(id, minx, maxx, miny, maxy);
      CREATE VIRTUAL TABLE rtree_full USING rtree(id, minx, maxx, miny, maxy);
      CREATE VIRTUAL TABLE rtree_coarse USING rtree(id, minx, maxx, miny, maxy);
      CREATE VIRTUAL TABLE rtree_world USING rtree(id, minx, maxx, miny, maxy);
    `);
    const insertPolygon = db.prepare('INSERT INTO polygons (data) VALUES (?)');
    const meta = db.prepare('INSERT OR REPLACE INTO meta (name, value) VALUES (?, ?)');
    for (const source of sources) {
      const lastModified = await readSource(
        source,
        db,
        insertPolygon,
        progress,
        options,
        fetchImpl
      );
      meta.run(`${source.set}-last-modified`, lastModified ?? '');
    }
    const version = `${new Date().toISOString().slice(0, 10)}-${crypto.randomBytes(4).toString('hex')}`;
    meta.run('version', version);
    db.close();
    fs.renameSync(building, file);
    return { version };
  } catch (err) {
    try {
      db.close();
    } catch {
      // Already closed.
    }
    removeDatabase(building);
    throw err;
  }
}

async function readSource(
  source: LandSource,
  db: DatabaseSync,
  insertPolygon: StatementSync,
  progress: LandBuildProgress,
  options: LandBuildOptions,
  fetchImpl: typeof fetch
): Promise<string | null> {
  // Aborts the download once nothing has arrived for STALL_TIMEOUT_MS.
  const stall = new AbortController();
  let stallTimer: ReturnType<typeof setTimeout> | undefined;
  const watchStall = (): void => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      stall.abort(new Error(`Downloading ${source.url} stalled`));
    }, options.stallTimeoutMs ?? STALL_TIMEOUT_MS);
  };
  watchStall();
  let res: Response;
  try {
    res = await fetchImpl(source.url, {
      headers: { 'User-Agent': options.userAgent },
      signal: withTimeout(options.signal, stall.signal)
    });
  } catch (err) {
    clearTimeout(stallTimer);
    throw err;
  }
  if (!res.ok || !res.body) {
    clearTimeout(stallTimer);
    throw new Error(`Downloading ${source.url} failed: HTTP ${String(res.status)}`);
  }
  const boxInserter = (set: StoredSet): StatementSync =>
    db.prepare(
      `INSERT INTO ${rtreeTable(set)} (id, minx, maxx, miny, maxy) VALUES (?, ?, ?, ?, ?)`
    );
  const insertBox = boxInserter(source.set);
  const coarseSets =
    source.set === 'simplified'
      ? COARSE_SETS.map((set) => ({ ...set, boxes: boxInserter(set.name) }))
      : [];
  const store = (pieces: Rings[], boxes: StatementSync): void => {
    for (const piece of pieces) {
      const [minX, minY, maxX, maxY] = ringsBbox(piece);
      const { lastInsertRowid } = insertPolygon.run(encodeRings(piece));
      boxes.run(lastInsertRowid, minX, maxX, minY, maxY);
      progress.polygons++;
      if (++pending >= INSERTS_PER_TRANSACTION) {
        db.exec('COMMIT');
        db.exec('BEGIN');
        pending = 0;
      }
    }
  };
  let reported = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      watchStall();
      progress.receivedBytes += chunk.length;
      // About every megabyte: enough for a progress bar, few enough messages.
      if (progress.receivedBytes - reported >= 1 << 20) {
        reported = progress.receivedBytes;
        options.onProgress?.({ ...progress });
      }
      done(null, chunk);
    }
  });
  const body = Readable.fromWeb(res.body);
  const zip = unzipper.Parse({ forceStream: true });
  // .pipe() passes data on but not errors: a dropped connection must end the
  // read below rather than surface as an uncaught exception. The entry being
  // read is a stream of its own and would otherwise wait for data forever.
  let reading: Entry | null = null;
  const fail = (err: Error): void => {
    reading?.destroy(err);
    zip.destroy(err);
  };
  body.on('error', fail);
  counter.on('error', fail);
  body.pipe(counter).pipe(zip);
  let found = false;
  let pending = 0;
  db.exec('BEGIN');
  try {
    for await (const item of zip) {
      const entry = item as Entry;
      if (found || !entry.path.toLowerCase().endsWith('.shp')) {
        entry.autodrain();
        continue;
      }
      found = true;
      reading = entry;
      for await (const polygon of readShapefilePolygons(entry)) {
        const pieces = splitPolygon(polygon, MAX_POINTS_PER_PIECE);
        store(pieces, insertBox);
        for (const set of coarseSets) {
          const coarse = coarsePolygon(polygon, set.tolerance, set.minSize);
          store(coarse ? splitPolygon(coarse, MAX_POINTS_PER_PIECE) : [], set.boxes);
        }
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // No transaction was open.
    }
    throw err;
  } finally {
    clearTimeout(stallTimer);
    // Stops the download when the read ended early.
    body.destroy();
  }
  if (!found) {
    throw new Error(`No shapefile in ${source.url}`);
  }
  options.onProgress?.({ ...progress });
  return res.headers.get('last-modified');
}

/** A polygon as a coarse set keeps it, or null when it is too small to show there. */
function coarsePolygon(polygon: Rings, tolerance: number, minSize: number): Rings | null {
  const [minX, minY, maxX, maxY] = ringsBbox(polygon);
  if (maxX - minX < minSize && maxY - minY < minSize) {
    return null;
  }
  const thinned = thinRings(polygon, tolerance);
  return thinned.length > 0 ? thinned : null;
}

/** A built land index, open for reading. */
export class LandIndex {
  private readonly queries: Record<StoredSet, StatementSync>;

  private constructor(
    private readonly db: DatabaseSync,
    /** Changes with every build, so masked tiles made from an older one are made again. */
    readonly version: string
  ) {
    const query = (set: StoredSet): StatementSync =>
      db.prepare(
        `SELECT p.data AS data FROM ${rtreeTable(set)} r JOIN polygons p ON p.id = r.id
         WHERE r.maxx >= ? AND r.minx <= ? AND r.maxy >= ? AND r.miny <= ?`
      );
    this.queries = {
      world: query('world'),
      coarse: query('coarse'),
      simplified: query('simplified'),
      full: query('full')
    };
  }

  /** The index at `file`, or null when there is none or it cannot be read. */
  static open(file: string): LandIndex | null {
    if (!fs.existsSync(file)) {
      return null;
    }
    let db: DatabaseSync | null = null;
    try {
      db = new DatabaseSync(file, { readOnly: true });
      const row = db.prepare("SELECT value FROM meta WHERE name = 'version'").get() as
        { value: string } | undefined;
      if (!row) {
        db.close();
        return null;
      }
      return new LandIndex(db, row.value);
    } catch {
      db?.close();
      return null;
    }
  }

  /** The encoded polygons that may reach into `bbox`, from the set for zoom `z`. */
  polygonsIn(bbox: Bbox, z: number): Uint8Array[] {
    const set: StoredSet =
      z >= FULL_DETAIL_MIN_ZOOM
        ? 'full'
        : (COARSE_SETS.find((c) => z < c.belowZoom)?.name ?? 'simplified');
    const rows = this.queries[set].all(bbox[0], bbox[2], bbox[1], bbox[3]) as {
      data: Uint8Array;
    }[];
    return rows.map((r) => r.data);
  }

  close(): void {
    this.db.close();
  }
}
