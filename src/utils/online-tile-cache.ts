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
import { DatabaseSync } from 'node:sqlite';
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type { OnlineCatalogChart } from '../catalog/merged-catalog-schema.js';

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
  const { tileUrl } = entry.offline;
  if (tileUrl) {
    return { kind: 'xyz', url: tileUrl };
  }
  const { chart } = entry;
  if (chart.type === 'tilelayer') {
    return { kind: 'xyz', url: chart.url };
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

/**
 * The upstream URL for one XYZ tile. Templates take `{z}`, `{x}`, `{y}`,
 * `{-y}` (TMS row) and `{z-N}` for services whose level 0 is not zoom 0
 * (NOAA's ArcGIS tile cache starts at zoom 2); null below that first
 * level. WMS layers are requested as
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
      .replace(/\{y\}/g, String(y));
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

/**
 * One MBTiles file per catalog entry. Rows are stored in TMS order as the
 * MBTiles spec requires, so the file is a valid chart in its own right; the
 * extra `fetched_at` column only decides when a tile is refreshed.
 */
export class OnlineTileStore {
  private readonly dbs = new Map<string, DatabaseSync>();
  private closed = false;

  constructor(private readonly dir: string) {}

  private file(catalogId: string): string {
    // The id names a file; the published schema allows nothing else.
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(catalogId)) {
      throw new Error(`Invalid catalog id for an offline chart: ${catalogId}`);
    }
    return path.join(this.dir, `${catalogId}.mbtiles`);
  }

  private db(catalogId: string): DatabaseSync {
    let db = this.dbs.get(catalogId);
    if (!db) {
      fs.mkdirSync(this.dir, { recursive: true });
      db = new DatabaseSync(this.file(catalogId));
      db.exec(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS metadata (name TEXT PRIMARY KEY, value TEXT);
        CREATE TABLE IF NOT EXISTS tiles (
          zoom_level INTEGER NOT NULL,
          tile_column INTEGER NOT NULL,
          tile_row INTEGER NOT NULL,
          tile_data BLOB NOT NULL,
          fetched_at INTEGER,
          PRIMARY KEY (zoom_level, tile_column, tile_row)
        );
      `);
      db.prepare('INSERT OR IGNORE INTO metadata (name, value) VALUES (?, ?)').run(
        'name',
        catalogId
      );
      this.dbs.set(catalogId, db);
    }
    return db;
  }

  get(catalogId: string, z: number, x: number, y: number): CachedTile | null {
    // A request still in flight when the plugin stopped must not reopen a file.
    if (this.closed) {
      return null;
    }
    const row = this.db(catalogId)
      .prepare(
        'SELECT tile_data, fetched_at FROM tiles WHERE zoom_level = ? AND tile_column = ? AND tile_row = ?'
      )
      .get(z, x, 2 ** z - 1 - y) as TileRow | undefined;
    if (!row) {
      return null;
    }
    const data = row.tile_data;
    return {
      data: Buffer.from(data.buffer, data.byteOffset, data.byteLength),
      fetchedAt: row.fetched_at ?? 0
    };
  }

  put(catalogId: string, z: number, x: number, y: number, data: Uint8Array, now: number): void {
    // A fetch still in flight when the plugin stopped must not reopen a file.
    if (this.closed) {
      return;
    }
    this.db(catalogId)
      .prepare(
        'INSERT OR REPLACE INTO tiles (zoom_level, tile_column, tile_row, tile_data, fetched_at) VALUES (?, ?, ?, ?, ?)'
      )
      .run(z, x, 2 ** z - 1 - y, data, now);
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

  /** Drop every tile kept for a chart. */
  clear(catalogId: string): void {
    const file = this.file(catalogId);
    this.dbs.get(catalogId)?.close();
    this.dbs.delete(catalogId);
    for (const f of [file, `${file}-wal`, `${file}-shm`]) {
      fs.rmSync(f, { force: true });
    }
  }

  close(): void {
    this.closed = true;
    for (const db of this.dbs.values()) {
      db.close();
    }
    this.dbs.clear();
  }
}

/** A kept tile older than this is fetched again when the provider answers. */
export const TILE_REFRESH_MS = 30 * 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 20_000;

export type TileFetcher = (url: string) => Promise<Uint8Array | null>;

/** Fetch one tile; null when the provider fails or answers with something that is not an image. */
export function httpTileFetcher(userAgent: string): TileFetcher {
  return async (url) => {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': userAgent },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
      });
      if (!res.ok) {
        return null;
      }
      const data = new Uint8Array(await res.arrayBuffer());
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
  private readonly inFlight = new Map<string, Promise<Buffer | null>>();

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
    const cached = this.store.get(catalogId, z, x, y);
    if (cached && this.now() - cached.fetchedAt < TILE_REFRESH_MS) {
      return cached.data;
    }
    return (await this.fetchAndKeep(catalogId, source, z, x, y)) ?? cached?.data ?? null;
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
      return 'kept';
    }
    const data = await this.fetchAndKeep(catalogId, source, z, x, y);
    return data ? 'fetched' : 'failed';
  }

  /** The provider's tile, kept on the way through; null when it can't be had. */
  private fetchAndKeep(
    catalogId: string,
    source: OnlineTileSource,
    z: number,
    x: number,
    y: number
  ): Promise<Buffer | null> {
    const url = upstreamTileUrl(source, z, x, y);
    if (!url) {
      return Promise.resolve(null);
    }
    const key = `${catalogId}/${String(z)}/${String(x)}/${String(y)}`;
    let pending = this.inFlight.get(key);
    if (!pending) {
      pending = this.fetchTile(url)
        .catch(() => null)
        .then((data) => {
          if (!data) {
            return null;
          }
          try {
            this.store.put(catalogId, z, x, y, data, this.now());
          } catch {
            // A full disk must not stop the chart showing while online.
          }
          return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
        })
        .finally(() => this.inFlight.delete(key));
      this.inFlight.set(key, pending);
    }
    return pending;
  }
}
