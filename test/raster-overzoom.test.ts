/**
 * Tests for serve-time filling of missing raster tiles.
 *
 * The fixture is built per run: a jpg chart advertising z0–z8 whose z1 level
 * is skipped except where its children exist, the way real exports drop a
 * whole level or leave ragged edges.
 *   z0 (0,0)              red JPEG
 *   z2 (0..1, 0..1)       blue JPEGs — all four children of z1 (0,0)
 *   z2 (2,2)              green PNG — one child of z1 (1,1)
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';

import { MBTilesReader } from '../dist/utils/mbtiles-reader.js';
import {
  getRasterOverzoomedTile,
  MAX_RASTER_OVERZOOM_DELTA
} from '../dist/utils/raster-overzoom.js';
import { serveTileFromMbtiles } from '../dist/index.js';

const SIZE = 16;
type Rgb = [number, number, number];
const RED: Rgb = [255, 0, 0];
const BLUE: Rgb = [0, 0, 255];
const GREEN: Rgb = [0, 255, 0];

function solid(rgb: Rgb): Buffer {
  const data = Buffer.alloc(SIZE * SIZE * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = rgb[0];
    data[i + 1] = rgb[1];
    data[i + 2] = rgb[2];
    data[i + 3] = 255;
  }
  return data;
}

function solidJpeg(rgb: Rgb): Buffer {
  return jpeg.encode({ data: solid(rgb), width: SIZE, height: SIZE }, 95).data;
}

function solidPng(rgb: Rgb): Buffer {
  const png = new PNG({ width: SIZE, height: SIZE });
  png.data = solid(rgb);
  return PNG.sync.write(png);
}

function pixel(tile: Uint8Array, x: number, y: number): Rgb {
  const img =
    tile[0] === 0xff
      ? jpeg.decode(tile, { useTArray: true, formatAsRGBA: true })
      : PNG.sync.read(Buffer.from(tile));
  const o = (y * img.width + x) * 4;
  return [img.data[o], img.data[o + 1], img.data[o + 2]];
}

// JPEG round trips shift solid colours by a few levels.
function assertColor(actual: Rgb, expected: Rgb, where: string): void {
  for (let c = 0; c < 3; c++) {
    assert.ok(
      Math.abs(actual[c] - expected[c]) <= 8,
      `${where}: expected ~${expected.join(',')}, got ${actual.join(',')}`
    );
  }
}

describe('getRasterOverzoomedTile()', () => {
  let tempDir!: string;
  let reader!: MBTilesReader;

  before(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'raster-overzoom-'));
    const file = path.join(tempDir, 'holes.mbtiles');
    const db = new DatabaseSync(file);
    db.exec(`
      CREATE TABLE metadata (name TEXT, value TEXT);
      CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB);
      CREATE UNIQUE INDEX tile_index ON tiles (zoom_level, tile_column, tile_row);
    `);
    const meta = db.prepare('INSERT INTO metadata (name, value) VALUES (?, ?)');
    for (const [k, v] of [
      ['name', 'Holes'],
      ['format', 'jpg'],
      ['minzoom', '0'],
      ['maxzoom', '8']
    ]) {
      meta.run(k, v);
    }
    const tile = db.prepare(
      'INSERT INTO tiles (zoom_level, tile_column, tile_row, tile_data) VALUES (?, ?, ?, ?)'
    );
    // XYZ y → TMS row
    const put = (z: number, x: number, y: number, data: Buffer) =>
      tile.run(z, x, (1 << z) - 1 - y, data);
    put(0, 0, 0, solidJpeg(RED));
    for (const [x, y] of [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1]
    ]) {
      put(2, x, y, solidJpeg(BLUE));
    }
    put(2, 2, 2, solidPng(GREEN));
    db.close();
    reader = new MBTilesReader(file);
  });

  after(() => {
    reader?.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('fills a skipped level from its four stored children', async () => {
    const tile = await getRasterOverzoomedTile(reader, 1, 0, 0);
    assert.ok(tile);
    assert.strictEqual(tile.contentType, 'image/jpeg', 'an opaque jpg chart tile stays JPEG');
    assertColor(pixel(tile.data, 2, 2), BLUE, 'top-left');
    assertColor(pixel(tile.data, SIZE - 3, SIZE - 3), BLUE, 'bottom-right');
  });

  it('falls back to the nearest ancestor, upscaled, when no child is stored', async () => {
    const tile = await getRasterOverzoomedTile(reader, 1, 1, 0);
    assert.ok(tile);
    assertColor(pixel(tile.data, SIZE / 2, SIZE / 2), RED, 'centre');
  });

  it('overlays the stored children on the ancestor where only some exist', async () => {
    const tile = await getRasterOverzoomedTile(reader, 1, 1, 1);
    assert.ok(tile);
    assertColor(pixel(tile.data, 2, 2), GREEN, 'top-left quadrant (stored child)');
    assertColor(pixel(tile.data, SIZE - 3, SIZE - 3), RED, 'bottom-right quadrant (ancestor)');
  });

  it('walks several levels up past further holes', async () => {
    const tile = await getRasterOverzoomedTile(reader, 4, 15, 15);
    assert.ok(tile);
    assertColor(pixel(tile.data, 4, 4), RED, 'deep tile');
  });

  it('returns null when nothing stored is within reach', async () => {
    const z = MAX_RASTER_OVERZOOM_DELTA + 1;
    assert.strictEqual(await getRasterOverzoomedTile(reader, z, (1 << z) - 1, 0), null);
  });

  it('serves the filled tile from the tile route instead of a 404', async () => {
    const res = await serve(1, 0, 0);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.headers['Content-Type'], 'image/jpeg');
    assert.ok(res.headers['Cache-Control']);
    assert.ok(Buffer.isBuffer(res.body));
  });

  it('keeps the 404 from the tile route when nothing stored is within reach', async () => {
    const z = MAX_RASTER_OVERZOOM_DELTA + 1;
    const res = await serve(z, (1 << z) - 1, 0);
    assert.strictEqual(res.statusCode, 404);
  });

  type ServeArgs = Parameters<typeof serveTileFromMbtiles>;

  function serve(z: number, x: number, y: number) {
    return new Promise<{ statusCode: number; headers: Record<string, string>; body: unknown }>(
      (resolve) => {
        const res = {
          statusCode: 0,
          headers: {} as Record<string, string>,
          body: undefined as unknown,
          writeHead(code: number, headers: Record<string, string>) {
            res.statusCode = code;
            res.headers = headers;
            return res;
          },
          end(data?: unknown) {
            res.body = data;
            resolve(res);
          },
          sendStatus(code: number) {
            res.statusCode = code;
            resolve(res);
          }
        };
        const provider = {
          identifier: 'holes',
          format: 'jpg',
          _mbtilesHandle: reader
        } as unknown as ServeArgs[1];
        serveTileFromMbtiles(res as unknown as ServeArgs[0], provider, z, x, y);
      }
    );
  }
});
