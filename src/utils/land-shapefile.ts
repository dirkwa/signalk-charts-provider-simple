/**
 * A streaming reader for the polygons of an ESRI shapefile's `.shp` part.
 *
 * The OSM land polygons ship as a shapefile of over a gigabyte, read straight
 * out of the zip as it downloads, so the reader keeps only the record it is
 * reading in memory. It knows the one shape the land polygons use (Polygon,
 * type 5) and skips null shapes; anything else is an error, since it would
 * mean the file is not what the land index expects.
 */

import type { Rings } from './land-geometry.js';

const HEADER_BYTES = 100;
const FILE_CODE = 9994;
const SHAPE_NULL = 0;
const SHAPE_POLYGON = 5;

/**
 * Bytes from a stream, taken in pieces of a known size. Chunks are queued and
 * joined only once a whole piece has arrived, so a record of megabytes is
 * copied once rather than once per chunk.
 */
class ByteQueue {
  private chunks: Buffer[] = [];
  private size = 0;

  push(chunk: Uint8Array): void {
    this.chunks.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    this.size += chunk.byteLength;
  }

  get length(): number {
    return this.size;
  }

  /** The next `n` bytes, or null until that many have arrived. */
  take(n: number): Buffer | null {
    const head = this.peek(n);
    if (!head) {
      return null;
    }
    const rest = this.chunks[0].subarray(n);
    if (rest.length > 0) {
      this.chunks[0] = rest;
    } else {
      this.chunks.shift();
    }
    this.size -= n;
    return head;
  }

  /** The next `n` bytes without taking them, or null until that many have arrived. */
  peek(n: number): Buffer | null {
    if (this.size < n) {
      return null;
    }
    if (this.chunks[0].length < n) {
      // Join only the chunks the piece spans.
      let count = 0;
      let bytes = 0;
      while (bytes < n) {
        bytes += this.chunks[count++].length;
      }
      this.chunks.splice(0, count, Buffer.concat(this.chunks.slice(0, count), bytes));
    }
    return this.chunks[0].subarray(0, n);
  }
}

/** The polygons of a `.shp` stream, one per record, with its rings as stored. */
export async function* readShapefilePolygons(
  chunks: AsyncIterable<Uint8Array>
): AsyncGenerator<Rings> {
  const queue = new ByteQueue();
  let headerRead = false;
  for await (const chunk of chunks) {
    queue.push(chunk);
    if (!headerRead) {
      const header = queue.take(HEADER_BYTES);
      if (!header) {
        continue;
      }
      if (header.readInt32BE(0) !== FILE_CODE) {
        throw new Error('Not a shapefile');
      }
      headerRead = true;
    }
    for (;;) {
      // Record header: number and content length in 16-bit words, both big-endian.
      const recordHeader = queue.peek(8);
      if (!recordHeader) {
        break;
      }
      const record = queue.take(8 + recordHeader.readInt32BE(4) * 2);
      if (!record) {
        break;
      }
      const polygon = parseRecord(record.subarray(8));
      if (polygon) {
        yield polygon;
      }
    }
  }
  if (!headerRead || queue.length > 0) {
    throw new Error('Shapefile ended part way through');
  }
}

function parseRecord(record: Buffer): Rings | null {
  const type = record.readInt32LE(0);
  if (type === SHAPE_NULL) {
    return null;
  }
  if (type !== SHAPE_POLYGON) {
    throw new Error(`Unexpected shape type ${String(type)} in the land polygons`);
  }
  // After the type: the bbox (4 doubles), part and point counts, part starts, points.
  const parts = record.readInt32LE(36);
  const points = record.readInt32LE(40);
  const pointsAt = 44 + 4 * parts;
  if (record.length < pointsAt + 16 * points) {
    throw new Error('Truncated shapefile record');
  }
  const rings: Rings = [];
  for (let p = 0; p < parts; p++) {
    const start = record.readInt32LE(44 + 4 * p);
    const end = p + 1 < parts ? record.readInt32LE(44 + 4 * (p + 1)) : points;
    if (end - start < 3) {
      continue;
    }
    const ring = new Float64Array((end - start) * 2);
    for (let i = start; i < end; i++) {
      ring[2 * (i - start)] = record.readDoubleLE(pointsAt + 16 * i);
      ring[2 * (i - start) + 1] = record.readDoubleLE(pointsAt + 16 * i + 8);
    }
    rings.push(ring);
  }
  return rings.length > 0 ? rings : null;
}
