/**
 * Offline copies of online charts whose license allows keeping them.
 *
 * Such a chart is served through the plugin instead of straight from its
 * provider: each tile a chart plotter asks for is fetched once, kept in an
 * MBTiles file under the plugin data dir, and served from there afterwards,
 * so the parts of the chart a boat has looked at keep working with no
 * internet. Charts whose terms do not allow this stay streamed by the
 * plotter, as before.
 */

import fs from 'fs';
import path from 'path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import {
  offlineTemplateProblem,
  type OnlineCatalogChart
} from '../catalog/merged-catalog-schema.js';

/** Where a proxied chart's tiles come from: an XYZ template or a WMS layer set. */
export type OnlineTileSource =
  { kind: 'xyz'; url: string } | { kind: 'wms'; url: string; layers: readonly string[] };

const OfflineSchema = Type.Object({
  tileUrl: Type.Optional(Type.String({ pattern: '^https://' }))
});

/**
 * The tile source to proxy for a catalog entry, or null when the chart is
 * streamed by the plotter: its catalog entry does not allow offline use, it
 * changes over time (radar, forecasts), or it is a style or service the
 * plugin cannot address tile by tile.
 */
export function offlineTileSource(entry: OnlineCatalogChart): OnlineTileSource | null {
  if (entry.offline === undefined || entry.temporal || !Value.Check(OfflineSchema, entry.offline)) {
    return null;
  }
  const { chart } = entry;
  const template = entry.offline.tileUrl ?? (chart.type === 'tilelayer' ? chart.url : null);
  if (template !== null) {
    // The published file is read leniently, so a template the plugin cannot
    // fill keeps the chart streamed rather than routed to tiles it never gets.
    return offlineTemplateProblem(template) ? null : { kind: 'xyz', url: template };
  }
  if (chart.type === 'WMS' && chart.layers && chart.layers.length > 0) {
    return { kind: 'wms', url: chart.url, layers: chart.layers };
  }
  return null;
}

const HALF_WORLD = 20037508.342789244;

/** A tile's extent in Web Mercator metres: [minX, minY, maxX, maxY]. */
export function tileBbox3857(z: number, x: number, y: number): [number, number, number, number] {
  const size = (2 * HALF_WORLD) / 2 ** z;
  return [
    -HALF_WORLD + x * size,
    HALF_WORLD - (y + 1) * size,
    -HALF_WORLD + (x + 1) * size,
    HALF_WORLD - y * size
  ];
}

/** A tile's extent in degrees: [west, south, east, north]. */
export function tileBbox4326(z: number, x: number, y: number): [number, number, number, number] {
  const n = 2 ** z;
  const lon = (col: number): number => (col / n) * 360 - 180;
  const lat = (row: number): number =>
    (Math.atan(Math.sinh(Math.PI * (1 - (2 * row) / n))) * 180) / Math.PI;
  return [lon(x), lat(y + 1), lon(x + 1), lat(y)];
}

/**
 * Whether a tile template uses a placeholder only the plugin fills in, so a
 * chart plotter cannot be handed it directly.
 */
export function needsTileProxy(url: string): boolean {
  return /\{(-y|z-\d+|bbox|bbox_3857)\}/.test(url);
}

/**
 * The upstream URL for one XYZ tile. Templates take `{z}`, `{x}`, `{y}`,
 * `{-y}` (TMS row) and `{z-N}` for services whose level 0 is not zoom 0
 * (NOAA's ArcGIS tile cache starts at zoom 2); null below that first
 * level. `{bbox}` (west,south,east,north in degrees) and `{bbox_3857}`
 * (Web Mercator metres) make a single-image request such as a WMS GetMap
 * work as a tile template. WMS layers are requested as
 * a 256 px EPSG:3857 GetMap, which every WMS 1.1.1 server answers in x,y
 * order, so the axis-order trap of WMS 1.3.0 never arises.
 */
export function upstreamTileUrl(
  source: OnlineTileSource,
  z: number,
  x: number,
  y: number
): string | null {
  if (source.kind === 'xyz') {
    // Below the service's first level there is no tile to ask for.
    const offsets = [...source.url.matchAll(/\{z-(\d+)\}/g)].map((m) => Number(m[1]));
    if (offsets.some((n) => z < n)) {
      return null;
    }
    return source.url
      .replace(/\{z-(\d+)\}/g, (_m, n: string) => String(z - Number(n)))
      .replace(/\{z\}/g, String(z))
      .replace(/\{x\}/g, String(x))
      .replace(/\{-y\}/g, String(2 ** z - 1 - y))
      .replace(/\{y\}/g, String(y))
      .replace(/\{bbox\}/g, () => tileBbox4326(z, x, y).join(','))
      .replace(/\{bbox_3857\}/g, () => tileBbox3857(z, x, y).join(','));
  }
  const params = new URLSearchParams({
    SERVICE: 'WMS',
    VERSION: '1.1.1',
    REQUEST: 'GetMap',
    LAYERS: source.layers.join(','),
    STYLES: '',
    SRS: 'EPSG:3857',
    BBOX: tileBbox3857(z, x, y).join(','),
    WIDTH: '256',
    HEIGHT: '256',
    FORMAT: 'image/png',
    TRANSPARENT: 'TRUE'
  });
  return `${source.url}${source.url.includes('?') ? '&' : '?'}${params.toString()}`;
}

/** The image type of tile bytes, or null when they are not a PNG, JPEG or WebP. */
export function tileImageType(data: Uint8Array): string | null {
  if (data.length >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e) {
    return 'image/png';
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    data.length >= 12 &&
    Buffer.from(data.subarray(0, 4)).toString('latin1') === 'RIFF' &&
    Buffer.from(data.subarray(8, 12)).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

export interface CachedTile {
  data: Buffer;
  fetchedAt: number;
}

interface TileRow {
  tile_data: Uint8Array;
  fetched_at: number | null;
}

interface TileStatements {
  select: StatementSync;
  insert: StatementSync;
  pin: StatementSync;
}

/** Tiles removed per statement when the cache is over its limit. */
const EVICT_BATCH = 500;
/** Batches removed before yielding to the event loop, so a lowered limit never stalls tile serving. */
const EVICT_BATCHES_PER_TURN = 4;
/** A catalog id, which names its tile file; the published schema allows nothing else. */
const CATALOG_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * One MBTiles file per catalog entry. Rows are stored in TMS order as the
 * MBTiles spec requires, so the file is a valid chart in its own right; the
 * extra `fetched_at` column decides when a tile is refreshed and which go
 * first when the cache is full, and `pinned` marks the tiles of an area
 * download, which the limit never removes: the user asked for that area to
 * work offshore.
 */

export class OnlineTileStore {
  private readonly dbs = new Map<string, DatabaseSync>();
  // Prepared once per file: get and put run for every tile a plotter asks for.
  private readonly statements = new Map<string, TileStatements>();
  private closed = false;
  private writtenSinceCheck = 0;
  private evictionQueued = false;

  /** `limitBytes` 0 keeps every tile. */
  constructor(
    private readonly dir: string,
    private limitBytes = 0
  ) {}

  setLimit(limitBytes: number): void {
    this.limitBytes = limitBytes;
    this.queueEviction();
  }

  private file(catalogId: string): string {
    // The id names a file; the published schema allows nothing else.
    if (!CATALOG_ID.test(catalogId)) {
      throw new Error(`Invalid catalog id for an offline chart: ${catalogId}`);
    }
    return path.join(this.dir, `${catalogId}.mbtiles`);
  }

  private db(catalogId: string): DatabaseSync {
    let db = this.dbs.get(catalogId);
    if (!db) {
      fs.mkdirSync(this.dir, { recursive: true });
      const file = this.file(catalogId);
      db = new DatabaseSync(file);
      try {
        // A new file gives evicted pages back to the disk. One kept from
        // before the limit is not rebuilt, since VACUUM would stall the server
        // and need a second copy's space; it reuses its free pages instead.
        if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table'").get()) {
          db.exec('PRAGMA auto_vacuum = INCREMENTAL');
        }
        db.exec(`
          PRAGMA journal_mode = WAL;
          CREATE TABLE IF NOT EXISTS metadata (name TEXT PRIMARY KEY, value TEXT);
          CREATE TABLE IF NOT EXISTS tiles (
            zoom_level INTEGER NOT NULL,
            tile_column INTEGER NOT NULL,
            tile_row INTEGER NOT NULL,
            tile_data BLOB NOT NULL,
            fetched_at INTEGER,
            pinned INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (zoom_level, tile_column, tile_row)
          );
        `);
        const columns = db.prepare('PRAGMA table_info(tiles)').all() as { name: string }[];
        if (!columns.some((c) => c.name === 'pinned')) {
          db.exec('ALTER TABLE tiles ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0');
        }
        db.exec('CREATE INDEX IF NOT EXISTS tiles_by_age ON tiles (pinned, fetched_at)');
        db.prepare('INSERT OR IGNORE INTO metadata (name, value) VALUES (?, ?)').run(
          'name',
          catalogId
        );
      } catch (err) {
        db.close();
        // A file SQLite cannot read is moved aside, so the next request starts
        // a new copy instead of refetching every tile forever; anything else,
        // such as a locked file, is retried as it is.
        if (isDamagedDatabase(err)) {
          try {
            for (const suffix of ['', '-wal', '-shm']) {
              fs.rmSync(`${file}.damaged${suffix}`, { force: true });
              if (fs.existsSync(file + suffix)) {
                fs.renameSync(file + suffix, `${file}.damaged${suffix}`);
              }
            }
          } catch {
            // The SQLite error says more than a failed move would.
          }
        }
        throw err;
      }
      this.dbs.set(catalogId, db);
    }
    return db;
  }

  private tileStatements(catalogId: string): TileStatements {
    let statements = this.statements.get(catalogId);
    if (!statements) {
      const db = this.db(catalogId);
      statements = {
        select: db.prepare(
          'SELECT tile_data, fetched_at FROM tiles WHERE zoom_level = ? AND tile_column = ? AND tile_row = ?'
        ),
        // A refresh while browsing must not unpin a tile an area download kept.
        insert: db.prepare(
          `INSERT INTO tiles (zoom_level, tile_column, tile_row, tile_data, fetched_at, pinned)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (zoom_level, tile_column, tile_row) DO UPDATE SET
             tile_data = excluded.tile_data,
             fetched_at = excluded.fetched_at,
             pinned = MAX(pinned, excluded.pinned)`
        ),
        pin: db.prepare(
          'UPDATE tiles SET pinned = 1 WHERE zoom_level = ? AND tile_column = ? AND tile_row = ?'
        )
      };
      this.statements.set(catalogId, statements);
    }
    return statements;
  }

  get(catalogId: string, z: number, x: number, y: number): CachedTile | null {
    // A request still in flight when the plugin stopped must not reopen a file.
    if (this.closed) {
      return null;
    }
    const row = this.tileStatements(catalogId).select.get(z, x, 2 ** z - 1 - y) as
      TileRow | undefined;
    if (!row) {
      return null;
    }
    const data = row.tile_data;
    return {
      data: Buffer.from(data.buffer, data.byteOffset, data.byteLength),
      fetchedAt: row.fetched_at ?? 0
    };
  }

  put(
    catalogId: string,
    z: number,
    x: number,
    y: number,
    data: Uint8Array,
    now: number,
    pinned = false
  ): void {
    // A fetch still in flight when the plugin stopped must not reopen a file.
    if (this.closed) {
      return;
    }
    this.tileStatements(catalogId).insert.run(z, x, 2 ** z - 1 - y, data, now, pinned ? 1 : 0);
    this.writtenSinceCheck += data.byteLength;
    // Measuring every file costs a few queries; once per 1/50th of the limit
    // keeps the overshoot small without doing it for every tile.
    if (this.limitBytes > 0 && this.writtenSinceCheck >= this.limitBytes / 50) {
      this.queueEviction();
    }
  }

  /** Keep a tile out of the limit's reach, for an area download. */
  pin(catalogId: string, z: number, x: number, y: number): void {
    if (this.closed) {
      return;
    }
    this.tileStatements(catalogId).pin.run(z, x, 2 ** z - 1 - y);
  }

  /** Whether any tile is kept for a chart. */
  hasTiles(catalogId: string): boolean {
    if (this.closed || !CATALOG_ID.test(catalogId) || !fs.existsSync(this.file(catalogId))) {
      return false;
    }
    return this.db(catalogId).prepare('SELECT 1 FROM tiles LIMIT 1').get() !== undefined;
  }

  /** How many tiles are kept for a chart and how much space they take. */
  stats(catalogId: string): { tiles: number; bytes: number } {
    if (this.closed || !fs.existsSync(this.file(catalogId))) {
      return { tiles: 0, bytes: 0 };
    }
    const row = this.db(catalogId)
      .prepare('SELECT COUNT(*) AS tiles, COALESCE(SUM(LENGTH(tile_data)), 0) AS bytes FROM tiles')
      .get() as { tiles: number; bytes: number };
    return { tiles: row.tiles, bytes: row.bytes };
  }

  /** The space every kept chart takes, in bytes; free pages a later tile reuses are not counted. */
  totalBytes(): number {
    if (this.closed) {
      return 0;
    }
    return this.catalogIds().reduce((sum, id) => sum + this.usedBytes(this.db(id)), 0);
  }

  private catalogIds(): string[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return [];
    }
    return names
      .filter((n) => n.endsWith('.mbtiles'))
      .map((n) => n.slice(0, -'.mbtiles'.length))
      .filter((id) => CATALOG_ID.test(id));
  }

  private usedBytes(db: DatabaseSync): number {
    return (
      (pragmaValue(db, 'page_count') - pragmaValue(db, 'freelist_count')) *
      pragmaValue(db, 'page_size')
    );
  }

  private queueEviction(): void {
    if (this.evictionQueued) {
      return;
    }
    this.evictionQueued = true;
    setImmediate(() => {
      this.evictionQueued = false;
      try {
        if (this.evict()) {
          this.queueEviction();
        }
      } catch {
        // A damaged file must not stop tiles being served; the next check tries again.
      }
    });
  }

  /**
   * Remove the longest-kept tiles that no area download asked for, across
   * every chart, until the cache fits its limit. Returns true when it
   * stopped only to yield and more remains to remove.
   */
  evict(): boolean {
    this.writtenSinceCheck = 0;
    if (this.closed || this.limitBytes <= 0) {
      return false;
    }
    // A damaged file is left out rather than turning the limit off for every chart.
    const files = this.catalogIds().flatMap((id) => {
      try {
        return [{ id, db: this.db(id) }];
      } catch {
        return [];
      }
    });
    const more = this.removeOldest(files);
    return this.reclaim(files) || more;
  }

  /**
   * Give the pages of removed tiles back to the disk, a bounded amount per
   * turn so a large cache never holds up tile requests. Returns true when
   * pages are left for the next turn.
   */
  private reclaim(files: { id: string; db: DatabaseSync }[]): boolean {
    let left = false;
    for (const f of files) {
      if (
        pragmaValue(f.db, 'auto_vacuum') !== AUTO_VACUUM_INCREMENTAL ||
        pragmaValue(f.db, 'freelist_count') === 0
      ) {
        continue;
      }
      f.db.exec(`PRAGMA incremental_vacuum(${String(VACUUM_PAGES_PER_TURN)})`);
      f.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      left ||= pragmaValue(f.db, 'freelist_count') > 0;
    }
    return left;
  }

  private removeOldest(files: { id: string; db: DatabaseSync }[]): boolean {
    const used = new Map(files.map((f) => [f.id, this.usedBytes(f.db)]));
    let total = [...used.values()].reduce((a, b) => a + b, 0);
    for (let batch = 0; total > this.limitBytes; batch++) {
      if (batch === EVICT_BATCHES_PER_TURN) {
        return true;
      }
      // The oldest unpinned tiles of every chart, merged by age, and only as
      // many as the overshoot takes, so the limit is not undercut.
      const candidates = files
        .flatMap((f) =>
          (
            f.db
              .prepare(
                'SELECT rowid AS id, LENGTH(tile_data) AS bytes, fetched_at AS at FROM tiles WHERE pinned = 0 ORDER BY fetched_at LIMIT ?'
              )
              .all(EVICT_BATCH) as { id: number; bytes: number; at: number | null }[]
          ).map((c) => ({ ...c, file: f }))
        )
        .sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
      if (candidates.length === 0) {
        // Only area downloads are left; they stay whatever the limit.
        return false;
      }
      const doomed = new Map<string, number[]>();
      let freed = 0;
      for (const c of candidates.slice(0, EVICT_BATCH)) {
        const ids = doomed.get(c.file.id) ?? [];
        ids.push(c.id);
        doomed.set(c.file.id, ids);
        freed += c.bytes;
        if (freed >= total - this.limitBytes) {
          break;
        }
      }
      for (const f of files) {
        const ids = doomed.get(f.id);
        if (!ids) {
          continue;
        }
        const remove = f.db.prepare('DELETE FROM tiles WHERE rowid = ?');
        f.db.exec('BEGIN');
        try {
          for (const id of ids) {
            remove.run(id);
          }
          f.db.exec('COMMIT');
        } catch (err) {
          f.db.exec('ROLLBACK');
          throw err;
        }
        const before = used.get(f.id) ?? 0;
        const after = this.usedBytes(f.db);
        used.set(f.id, after);
        total -= before - after;
      }
    }
    return false;
  }

  /** Drop every tile kept for a chart. */
  clear(catalogId: string): void {
    const file = this.file(catalogId);
    this.statements.delete(catalogId);
    this.dbs.get(catalogId)?.close();
    this.dbs.delete(catalogId);
    for (const f of [file, `${file}-wal`, `${file}-shm`]) {
      fs.rmSync(f, { force: true });
    }
  }

  close(): void {
    this.closed = true;
    this.statements.clear();
    for (const db of this.dbs.values()) {
      db.close();
    }
    this.dbs.clear();
  }
}

const AUTO_VACUUM_INCREMENTAL = 2;
// 4 MB of 4 KB pages: enough to keep pace with eviction, small enough not to stall a turn.
const VACUUM_PAGES_PER_TURN = 1024;

function pragmaValue(db: DatabaseSync, name: string): number {
  return (db.prepare(`PRAGMA ${name}`).get() as Record<string, number>)[name] ?? 0;
}
const SQLITE_CORRUPT = 11;
const SQLITE_NOTADB = 26;

function isDamagedDatabase(err: unknown): boolean {
  const code = (err as { errcode?: unknown } | null)?.errcode;
  return typeof code === 'number' && [SQLITE_CORRUPT, SQLITE_NOTADB].includes(code & 0xff);
}

/** A kept tile older than this is fetched again when the provider answers. */
export const TILE_REFRESH_MS = 30 * 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 20_000;
/** Far above any real map tile; a larger answer is not one. */
const MAX_TILE_BYTES = 10 * 1024 * 1024;

/**
 * A tile's bytes; `'absent'` when the provider says it has no tile there,
 * which sparse services do outside their coverage; null when it failed.
 */
export type TileFetcher = (url: string) => Promise<Uint8Array | 'absent' | null>;

/**
 * The body, or null once it passes `limit` bytes. Read in chunks, because a
 * chunked answer has no Content-Length to refuse it by up front.
 */
async function readCapped(res: Response, limit: number): Promise<Uint8Array | null> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (res.body) {
    // Leaving the loop early cancels the rest of the body.
    for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
      size += chunk.byteLength;
      if (size > limit) {
        return null;
      }
      chunks.push(chunk);
    }
  }
  return Buffer.concat(chunks);
}

/** Fetch one tile; null when the provider fails or answers with something that is not an image. */
export function httpTileFetcher(userAgent: string): TileFetcher {
  return async (url) => {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': userAgent },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
      });
      if (res.status === 404 || res.status === 204) {
        return 'absent';
      }
      if (!res.ok || Number(res.headers.get('content-length') ?? 0) > MAX_TILE_BYTES) {
        return null;
      }
      const data = await readCapped(res, MAX_TILE_BYTES);
      if (!data) {
        return null;
      }
      // WMS servers report errors as XML with a 200 status.
      return tileImageType(data) ? data : null;
    } catch {
      return null;
    }
  };
}

/** What happened to one tile an area download asked for. */
export type EnsureOutcome = 'kept' | 'fetched' | 'failed' | 'none';

/**
 * Serves proxied tiles: a kept tile when there is a fresh one, otherwise
 * the provider's, which is then kept. A kept tile is served however old it
 * is when the provider cannot be reached, which is the whole point offshore.
 */
export class OnlineTileProxy {
  private readonly inFlight = new Map<string, Promise<Buffer | 'absent' | null>>();
  private readonly generation = new Map<string, number>();
  private readonly streaming = new Map<string, Promise<Uint8Array | 'absent' | null>>();

  constructor(
    private readonly store: OnlineTileStore,
    private readonly fetchTile: TileFetcher,
    private readonly now: () => number = Date.now
  ) {}

  async getTile(
    catalogId: string,
    source: OnlineTileSource,
    z: number,
    x: number,
    y: number
  ): Promise<Buffer | null> {
    if (z > 24 || x >= 2 ** z || y >= 2 ** z) {
      return null;
    }
    let cached: CachedTile | null = null;
    try {
      cached = this.store.get(catalogId, z, x, y);
    } catch {
      // A damaged tile file must not stop the chart showing while online.
    }
    if (cached && this.now() - cached.fetchedAt < TILE_REFRESH_MS) {
      return cached.data;
    }
    const fetching = this.fetchAndKeep(catalogId, source, z, x, y).then((data) =>
      data === 'absent' ? null : data
    );
    // An old tile is shown at once and refreshed behind it, so a link that
    // hangs rather than fails never leaves the chart blank while it times out.
    return cached ? cached.data : fetching;
  }

  /** The provider's tile, passed through without keeping it, for charts whose terms forbid copies. */
  async streamTile(
    source: OnlineTileSource,
    z: number,
    x: number,
    y: number
  ): Promise<Buffer | null> {
    const url = z > 24 || x >= 2 ** z || y >= 2 ** z ? null : upstreamTileUrl(source, z, x, y);
    if (!url) {
      return null;
    }
    // Plotters ask for the same tile more than once; the provider is asked once.
    let pending = this.streaming.get(url);
    if (!pending) {
      pending = this.fetchTile(url)
        .catch(() => null)
        .finally(() => this.streaming.delete(url));
      this.streaming.set(url, pending);
    }
    const data = await pending;
    return data && data !== 'absent'
      ? Buffer.from(data.buffer, data.byteOffset, data.byteLength)
      : null;
  }

  /**
   * Make sure a fresh copy of a tile is kept, for an area download. A tile
   * the service has no level for counts as `none`, not as a failure.
   */
  async ensureTile(
    catalogId: string,
    source: OnlineTileSource,
    z: number,
    x: number,
    y: number
  ): Promise<EnsureOutcome> {
    if (z > 24 || x >= 2 ** z || y >= 2 ** z || !upstreamTileUrl(source, z, x, y)) {
      return 'none';
    }
    const cached = this.store.get(catalogId, z, x, y);
    if (cached && this.now() - cached.fetchedAt < TILE_REFRESH_MS) {
      this.store.pin(catalogId, z, x, y);
      return 'kept';
    }
    const data = await this.fetchAndKeep(catalogId, source, z, x, y, true);
    if (!data || data === 'absent') {
      // An old copy is still part of the area the user asked to keep.
      if (cached) {
        this.store.pin(catalogId, z, x, y);
      }
      return data === 'absent' ? 'none' : 'failed';
    }
    // The fetch may have been one a plotter started, which keeps it unpinned.
    this.store.pin(catalogId, z, x, y);
    return 'fetched';
  }

  /**
   * Drop every tile kept for a chart. Fetches already under way for it land
   * without writing, so none of them puts a tile back behind the delete.
   */
  forget(catalogId: string): void {
    this.generation.set(catalogId, (this.generation.get(catalogId) ?? 0) + 1);
    const prefix = `${catalogId}/`;
    for (const key of [...this.inFlight.keys()]) {
      if (key.startsWith(prefix)) {
        this.inFlight.delete(key);
      }
    }
    this.store.clear(catalogId);
  }

  /** The provider's tile, kept on the way through; null when it can't be had. */
  private fetchAndKeep(
    catalogId: string,
    source: OnlineTileSource,
    z: number,
    x: number,
    y: number,
    pinned = false
  ): Promise<Buffer | 'absent' | null> {
    const url = upstreamTileUrl(source, z, x, y);
    if (!url) {
      return Promise.resolve(null);
    }
    const key = `${catalogId}/${String(z)}/${String(x)}/${String(y)}`;
    const existing = this.inFlight.get(key);
    if (existing) {
      return existing;
    }
    const generation = this.generation.get(catalogId) ?? 0;
    const pending: Promise<Buffer | 'absent' | null> = this.fetchTile(url)
      .catch(() => null)
      .then((data) => {
        if (!data || data === 'absent') {
          return data;
        }
        if ((this.generation.get(catalogId) ?? 0) === generation) {
          try {
            this.store.put(catalogId, z, x, y, data, this.now(), pinned);
          } catch {
            // A full disk must not stop the chart showing while online.
          }
        }
        return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
      })
      .finally(() => {
        if (this.inFlight.get(key) === pending) {
          this.inFlight.delete(key);
        }
      });
    this.inFlight.set(key, pending);
    return pending;
  }
}
