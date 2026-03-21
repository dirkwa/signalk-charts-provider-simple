import { DatabaseSync } from 'node:sqlite';
import type { MBTilesMetadata, TileResult } from '../types';

interface MetadataRow {
  name: string;
  value: string;
}

interface TileRow {
  tile_data: Buffer;
}

export class MBTilesReader {
  private filePath: string;
  private db: DatabaseSync | null;
  private _metadata: MBTilesMetadata | null;

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

    const tmsY = (1 << z) - 1 - y;

    const row = this.db
      .prepare(
        'SELECT tile_data FROM tiles WHERE zoom_level = ? AND tile_column = ? AND tile_row = ?'
      )
      .get(z, x, tmsY) as TileRow | undefined;

    if (!row?.tile_data) {
      return null;
    }

    const data = Buffer.from(row.tile_data);
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
