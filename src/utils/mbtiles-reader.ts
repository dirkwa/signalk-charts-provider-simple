import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { MBTilesMetadata, TileResult } from '../types.js';

interface MetadataRow {
  name: string;
  value: string;
}

interface TileRow {
  // node:sqlite returns BLOB columns as Uint8Array on a fresh ArrayBuffer
  // per row (verified against Node 22.5+). We adapt to Buffer below
  // without a copy via the (buffer, byteOffset, byteLength) overload.
  tile_data: Uint8Array;
}

/**
 * Convert a tile column/row range at a single zoom into Web-Mercator
 * geographic bounds `[minLon, minLat, maxLon, maxLat]` (the MBTiles
 * `bounds` order). Pure so it can be unit-tested without a database.
 *
 * MBTiles stores `tile_row` in **TMS** order (origin bottom-left), but the
 * standard slippy-tile → lat/lon formulas are stated in **XYZ** order
 * (origin top-left), so the rows are flipped first (`xyzY = n - 1 - tmsY`).
 * Edges (not tile centers) are used: a tile column spans `[col, col+1)` and
 * a tile row spans `[xyzY, xyzY+1)`, so the east/south edges add 1.
 */
export function tileRangeToBounds(
  z: number,
  minCol: number,
  maxCol: number,
  minTmsRow: number,
  maxTmsRow: number
): [number, number, number, number] {
  const n = 2 ** z;
  const lon = (col: number): number => (col / n) * 360 - 180;
  const lat = (xyzRow: number): number =>
    (Math.atan(Math.sinh(Math.PI * (1 - (2 * xyzRow) / n))) * 180) / Math.PI;

  // TMS → XYZ: the highest TMS row is the northernmost tile.
  const xyzTop = n - 1 - maxTmsRow;
  const xyzBottom = n - 1 - minTmsRow;

  const west = lon(minCol);
  const east = lon(maxCol + 1);
  const north = lat(xyzTop);
  const south = lat(xyzBottom + 1);

  return [west, south, east, north];
}

export class MBTilesReader {
  private filePath: string;
  private db: DatabaseSync | null;
  private _metadata: MBTilesMetadata | null;
  // Tile lookups happen many times per pan/zoom (50–200 hits per Freeboard
  // gesture), so cache the prepared statement and reuse it instead of
  // letting `db.prepare(...)` recompile on every call. The compiled
  // statement is invalidated in `close()` along with the database handle.
  private _tileStmt: StatementSync | null = null;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.db = new DatabaseSync(filePath, { readOnly: true });
    this._metadata = null;
  }

  getInfo(): MBTilesMetadata {
    if (this._metadata) {
      return this._metadata;
    }

    if (!this.db) {
      throw new Error('Database is closed');
    }

    const rows = this.db
      .prepare('SELECT name, value FROM metadata')
      .all() as unknown as MetadataRow[];
    const metadata: MBTilesMetadata = {};

    for (const row of rows) {
      const { name, value } = row;

      switch (name) {
        case 'bounds':
          metadata.bounds = value.split(',').map(Number);
          break;
        case 'center':
          metadata.center = value.split(',').map(Number);
          break;
        case 'minzoom':
        case 'maxzoom':
          metadata[name] = parseInt(value, 10);
          break;
        case 'json':
          try {
            const parsed: unknown = JSON.parse(value);
            if (
              typeof parsed === 'object' &&
              parsed !== null &&
              'vector_layers' in parsed &&
              Array.isArray((parsed as Record<string, unknown>).vector_layers)
            ) {
              metadata.vector_layers = (parsed as Record<string, unknown>)
                .vector_layers as MBTilesMetadata['vector_layers'];
            }
          } catch {
            // Ignore JSON parse errors
          }
          break;
        case 'vector_layers':
          try {
            metadata.vector_layers = JSON.parse(value) as MBTilesMetadata['vector_layers'];
          } catch {
            // Ignore JSON parse errors
          }
          break;
        default:
          metadata[name] = value;
      }
    }

    this._metadata = metadata;
    return metadata;
  }

  /** Raw tile blob for XYZ coordinates (TMS flip applied), without HTTP headers. */
  getRawTile(z: number, x: number, y: number): Buffer | null {
    if (!this.db) {
      throw new Error('Database is closed');
    }

    if (!this._tileStmt) {
      this._tileStmt = this.db.prepare(
        'SELECT tile_data FROM tiles WHERE zoom_level = ? AND tile_column = ? AND tile_row = ?'
      );
    }

    const tmsY = (1 << z) - 1 - y;
    const row = this._tileStmt.get(z, x, tmsY) as unknown as TileRow | undefined;

    if (!row?.tile_data) {
      return null;
    }

    // Adapt the Uint8Array to a Buffer without copying. node:sqlite
    // returns each BLOB on its own ArrayBuffer per .get() call
    // (verified empirically on Node 22.5+), so the bytes are owned and
    // safe to view through Buffer. The two-arg `Buffer.from(uint8array)`
    // form copies; the (buffer, byteOffset, byteLength) overload does
    // not. For a 200KB pbf tile that's 200KB of malloc+memcpy avoided
    // per request — material at Freeboard pan/zoom rates.
    const u = row.tile_data;
    return Buffer.from(u.buffer, u.byteOffset, u.byteLength);
  }

  getTile(z: number, x: number, y: number): TileResult | null {
    const data = this.getRawTile(z, x, y);

    if (!data) {
      return null;
    }

    const metadata = this.getInfo();
    const format = metadata.format ?? 'png';

    const headers: Record<string, string> = {};

    switch (format) {
      case 'pbf':
        headers['Content-Type'] = 'application/x-protobuf';
        if (data[0] === 0x1f && data[1] === 0x8b) {
          headers['Content-Encoding'] = 'gzip';
        }
        break;
      case 'jpg':
      case 'jpeg':
        headers['Content-Type'] = 'image/jpeg';
        break;
      case 'webp':
        headers['Content-Type'] = 'image/webp';
        break;
      case 'png':
      default:
        headers['Content-Type'] = 'image/png';
        break;
    }

    return { data, headers };
  }

  // ---- Repair helpers ----
  // These read-only queries support `findRepairableCharts`: an MBTiles with
  // a valid tile pyramid but no `metadata.bounds` is dropped by the loader
  // gate, yet bounds/zoom/format/tileSize can all be derived from the tiles
  // table. The reader is opened readOnly (see constructor), so these are
  // safe to run during the management-UI scan without a write handle.

  /** True if the `tiles` table exists and has at least one row. */
  hasTiles(): boolean {
    if (!this.db) {
      throw new Error('Database is closed');
    }
    try {
      const row = this.db.prepare('SELECT 1 AS one FROM tiles LIMIT 1').get();
      return row !== undefined;
    } catch {
      // No `tiles` table at all (malformed file) — not repairable.
      return false;
    }
  }

  /** MIN/MAX of `zoom_level`, or null if the tiles table is empty. */
  getZoomRangeFromTiles(): { minzoom: number; maxzoom: number } | null {
    if (!this.db) {
      throw new Error('Database is closed');
    }
    try {
      const row = this.db
        .prepare('SELECT MIN(zoom_level) AS lo, MAX(zoom_level) AS hi FROM tiles')
        .get() as { lo: number | null; hi: number | null } | undefined;
      if (!row || row.lo === null || row.hi === null) {
        return null;
      }
      return { minzoom: row.lo, maxzoom: row.hi };
    } catch {
      return null;
    }
  }

  /**
   * First tile blob as a Buffer (no copy), or null if empty. Used to sniff
   * format and read PNG pixel dimensions for the repair derivation.
   */
  getFirstTileRaw(): Buffer | null {
    if (!this.db) {
      throw new Error('Database is closed');
    }
    try {
      const row = this.db.prepare('SELECT tile_data FROM tiles LIMIT 1').get() as unknown as
        TileRow | undefined;
      if (!row?.tile_data) {
        return null;
      }
      const u = row.tile_data;
      return Buffer.from(u.buffer, u.byteOffset, u.byteLength);
    } catch {
      return null;
    }
  }

  /**
   * Sniff the tile format from the first tile's magic bytes:
   * PNG/JPEG/WEBP raster or gzip-wrapped PBF vector. Returns null when the
   * tiles table is empty or the bytes match nothing known.
   */
  sniffFormatFromTiles(): string | null {
    const b = this.getFirstTileRaw();
    if (!b || b.length < 4) {
      return null;
    }
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
      return 'png';
    }
    if (b[0] === 0xff && b[1] === 0xd8) {
      return 'jpg';
    }
    // gzip magic — MBTiles stores vector PBF tiles gzip-compressed.
    if (b[0] === 0x1f && b[1] === 0x8b) {
      return 'pbf';
    }
    if (
      b.length >= 12 &&
      b[0] === 0x52 &&
      b[1] === 0x49 &&
      b[2] === 0x46 &&
      b[3] === 0x46 && // 'RIFF'
      b[8] === 0x57 &&
      b[9] === 0x45 &&
      b[10] === 0x42 &&
      b[11] === 0x50 // 'WEBP'
    ) {
      return 'webp';
    }
    return null;
  }

  /**
   * Tile edge length in pixels, read from the first tile. Only PNG is
   * decoded (the IHDR width is a fixed big-endian uint32 at byte offset 16);
   * JPEG/WEBP/PBF return undefined because their dimensions need a real
   * decoder and a vector tile has no fixed pixel size. Undefined means
   * "assume the conventional 256".
   */
  getTilePixelSize(): number | undefined {
    const b = this.getFirstTileRaw();
    if (!b || b.length < 24) {
      return undefined;
    }
    // PNG only: signature (8) + IHDR length+type (8) → width at offset 16.
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
      return b.readUInt32BE(16);
    }
    return undefined;
  }

  /**
   * Derive Web-Mercator bounds from the tile column/row extent at maxzoom.
   * Returns null if there are no tiles. The bounds are the bounding box of
   * the populated tiles — for a sparse pyramid this can be larger than the
   * actual data extent, which is the standard (advisory) interpretation.
   */
  deriveBoundsFromTiles(): number[] | null {
    if (!this.db) {
      throw new Error('Database is closed');
    }
    const zr = this.getZoomRangeFromTiles();
    if (!zr) {
      return null;
    }
    const z = zr.maxzoom;
    try {
      const row = this.db
        .prepare(
          'SELECT MIN(tile_column) AS minc, MAX(tile_column) AS maxc, ' +
            'MIN(tile_row) AS minr, MAX(tile_row) AS maxr FROM tiles WHERE zoom_level = ?'
        )
        .get(z) as
        | { minc: number | null; maxc: number | null; minr: number | null; maxr: number | null }
        | undefined;
      if (
        !row ||
        row.minc === null ||
        row.maxc === null ||
        row.minr === null ||
        row.maxr === null
      ) {
        return null;
      }
      return tileRangeToBounds(z, row.minc, row.maxc, row.minr, row.maxr);
    } catch {
      return null;
    }
  }

  close(): void {
    // Drop the cached prepared statement before closing the db; the
    // statement is bound to the db handle and using it after .close()
    // would crash node:sqlite.
    this._tileStmt = null;
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

export function open(filePath: string): Promise<MBTilesReader> {
  return new Promise((resolve, reject) => {
    try {
      const reader = new MBTilesReader(filePath);
      reader.getInfo();
      resolve(reader);
    } catch (err) {
      reject(err);
    }
  });
}
