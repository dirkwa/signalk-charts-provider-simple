import { promises as fs } from 'fs';
import { promisify } from 'util';
import { brotliDecompress, gunzip } from 'zlib';
import {
  Compression,
  ResolvedValueCache,
  TileType,
  findTile,
  zxyToTileId,
  type Header,
  type Source
} from 'pmtiles';
import type { TileResult, VectorLayer } from '../types.js';

const brotliDecompressAsync = promisify(brotliDecompress);
const gunzipAsync = promisify(gunzip);

/** A PMTiles directory can nest a root and up to three leaf levels. */
const MAX_DIRECTORY_DEPTH = 4;

const TILE_FORMATS: Partial<Record<TileType, string>> = {
  [TileType.Mvt]: 'pbf',
  [TileType.Png]: 'png',
  [TileType.Jpeg]: 'jpg',
  [TileType.Webp]: 'webp'
};

const CONTENT_TYPES: Record<string, string> = {
  pbf: 'application/x-protobuf',
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp'
};

/** The JSON metadata block; every field is optional and producer-defined. */
export interface PMTilesMetadata {
  name?: string;
  description?: string;
  attribution?: string;
  type?: string;
  scale?: string;
  vector_layers?: VectorLayer[];
  /** Written by tippecanoe for a tile set that crosses the antimeridian. */
  antimeridian_adjusted_bounds?: string;
  [key: string]: unknown;
}

/** Reads byte ranges from a local archive through one open file handle. */
class LocalFileSource implements Source {
  constructor(
    private readonly filePath: string,
    private readonly handle: fs.FileHandle
  ) {}

  getKey(): string {
    return this.filePath;
  }

  async getBytes(offset: number, length: number): Promise<{ data: ArrayBuffer }> {
    const buffer = new Uint8Array(length);
    const { bytesRead } = await this.handle.read(buffer, 0, length, offset);
    return { data: buffer.buffer.slice(0, bytesRead) };
  }
}

function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

/** Inflates directories and the metadata block; tiles are served as stored. */
async function decompressDirectory(
  buf: ArrayBuffer,
  compression: Compression
): Promise<ArrayBuffer> {
  switch (compression) {
    case Compression.None:
    case Compression.Unknown:
      return buf;
    case Compression.Gzip:
      return toArrayBuffer(await gunzipAsync(new Uint8Array(buf)));
    case Compression.Brotli:
      return toArrayBuffer(await brotliDecompressAsync(new Uint8Array(buf)));
    default:
      throw new Error(`Unsupported PMTiles compression ${String(compression)}`);
  }
}

/**
 * A local PMTiles archive. Tiles are returned as stored: a gzip-compressed
 * vector tile is served with `Content-Encoding: gzip`, the same as an
 * MBTiles one, rather than being inflated and sent uncompressed.
 */
export class PMTilesReader {
  private closed = false;

  private constructor(
    private readonly filePath: string,
    private readonly handle: fs.FileHandle,
    private readonly source: LocalFileSource,
    private readonly cache: ResolvedValueCache,
    readonly header: Header,
    readonly metadata: PMTilesMetadata,
    /** `pbf`, `png`, `jpg` or `webp`. */
    readonly format: string
  ) {}

  static async open(filePath: string): Promise<PMTilesReader> {
    const handle = await fs.open(filePath, 'r');
    try {
      const source = new LocalFileSource(filePath, handle);
      const cache = new ResolvedValueCache(64, true, decompressDirectory);
      const header = await cache.getHeader(source);
      const format = TILE_FORMATS[header.tileType];
      if (!format) {
        throw new Error(`Unsupported PMTiles tile type ${header.tileType}`);
      }
      if (header.tileCompression === Compression.Zstd) {
        throw new Error('Zstandard-compressed PMTiles tiles are not supported');
      }
      const metadata = await readMetadata(source, header);
      return new PMTilesReader(filePath, handle, source, cache, header, metadata, format);
    } catch (err) {
      await handle.close().catch(() => undefined);
      throw err;
    }
  }

  getFilePath(): string {
    return this.filePath;
  }

  /** The tile at XYZ coordinates as stored, or null when the archive has none. */
  async getRawTile(z: number, x: number, y: number): Promise<Buffer | null> {
    if (this.closed) {
      throw new Error('Archive is closed');
    }
    const { header } = this;
    if (z < header.minZoom || z > header.maxZoom || x < 0 || y < 0 || x >= 2 ** z || y >= 2 ** z) {
      return null;
    }
    const tileId = zxyToTileId(z, x, y);
    let offset = header.rootDirectoryOffset;
    let length = header.rootDirectoryLength;
    for (let depth = 0; depth < MAX_DIRECTORY_DEPTH; depth++) {
      const directory = await this.cache.getDirectory(this.source, offset, length, header);
      const entry = findTile(directory, tileId);
      if (!entry) {
        return null;
      }
      if (entry.runLength > 0) {
        const { data } = await this.source.getBytes(
          header.tileDataOffset + entry.offset,
          entry.length
        );
        return Buffer.from(data);
      }
      offset = header.leafDirectoryOffset + entry.offset;
      length = entry.length;
    }
    throw new Error('PMTiles directory nesting exceeds the spec maximum');
  }

  async getTile(z: number, x: number, y: number): Promise<TileResult | null> {
    const stored = await this.getRawTile(z, x, y);
    if (!stored) {
      return null;
    }
    const headers: Record<string, string> = {
      'Content-Type': CONTENT_TYPES[this.format] ?? 'application/octet-stream'
    };
    switch (this.header.tileCompression) {
      case Compression.Gzip:
        headers['Content-Encoding'] = 'gzip';
        return { data: stored, headers };
      case Compression.Brotli:
        // Browsers accept brotli only over HTTPS, and a boat's server is
        // usually plain HTTP, so inflate it here.
        return { data: await brotliDecompressAsync(stored), headers };
      default:
        return { data: stored, headers };
    }
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    await this.handle.close();
  }
}

async function readMetadata(source: Source, header: Header): Promise<PMTilesMetadata> {
  if (header.jsonMetadataLength === 0) {
    return {};
  }
  const { data } = await source.getBytes(header.jsonMetadataOffset, header.jsonMetadataLength);
  const text = new TextDecoder().decode(
    await decompressDirectory(data, header.internalCompression)
  );
  const parsed: unknown = JSON.parse(text);
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? (parsed as PMTilesMetadata)
    : {};
}

/** Some writers store the full width as ±179.99… rather than ±180. */
const FULL_WIDTH_MIN_SPAN_DEG = 359.9;

/**
 * The archive's bounds as `[west, south, east, north]`. The PMTiles header
 * cannot express a box crossing the antimeridian, so such an archive has
 * the full width there; tippecanoe records the real extent in
 * `antimeridian_adjusted_bounds` with an east edge beyond 180, which is
 * published as a crossing box (west > east), as for MBTiles.
 */
export function pmtilesBounds(header: Header, metadata: PMTilesMetadata): number[] {
  const bounds = [header.minLon, header.minLat, header.maxLon, header.maxLat];
  if (header.maxLon - header.minLon < FULL_WIDTH_MIN_SPAN_DEG) {
    return bounds;
  }
  const adjusted = metadata.antimeridian_adjusted_bounds?.split(',').map(Number);
  if (!adjusted || adjusted.length !== 4 || adjusted.some((v) => !Number.isFinite(v))) {
    return bounds;
  }
  const [west, , east] = adjusted as [number, number, number, number];
  if (east <= 180 || east - west >= FULL_WIDTH_MIN_SPAN_DEG) {
    return bounds;
  }
  return [west, header.minLat, east - 360, header.maxLat];
}
