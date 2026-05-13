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

  getTile(z: number, x: number, y: number): TileResult | null {
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
    const data = Buffer.from(u.buffer, u.byteOffset, u.byteLength);
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
