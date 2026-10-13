/**
 * Tests for the on-disk cache of synthesized raster tiles.
 *
 * The fixture is a jpg chart advertising z0–z2 with z1 skipped: z0 (0,0) is
 * red and the four z2 children of z1 (0,0) are blue, so z1 (0,0) is
 * synthesized blue. A cached tile is recognised by planting a yellow one in
 * its place: synthesis can only ever produce blue there.
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
import { getRasterOverzoomedTile } from '../dist/utils/raster-overzoom.js';
import {
  chartCacheKey,
  flushRasterTileCache,
  initRasterTileCache,
  pruneRasterTileCache,
  writeCachedTile
} from '../dist/utils/raster-tile-cache.js';

const SIZE = 16;
type Rgb = [number, number, number];
const RED: Rgb = [255, 0, 0];
const BLUE: Rgb = [0, 0, 255];
const YELLOW: Rgb = [255, 255, 0];

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

function centre(tile: Uint8Array): Rgb {
  const img =
    tile[0] === 0xff
      ? jpeg.decode(tile, { useTArray: true, formatAsRGBA: true })
      : PNG.sync.read(Buffer.from(tile));
  const o = ((SIZE / 2) * img.width + SIZE / 2) * 4;
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

function createChart(file: string): void {
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE metadata (name TEXT, value TEXT);
    CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB);
    CREATE UNIQUE INDEX tile_index ON tiles (zoom_level, tile_column, tile_row);
  `);
  const meta = db.prepare('INSERT INTO metadata (name, value) VALUES (?, ?)');
  for (const [k, v] of [
    ['name', 'Skipped level'],
    ['format', 'jpg'],
    ['minzoom', '0'],
    ['maxzoom', '2']
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
  db.close();
}

describe('raster tile disk cache', () => {
  let tempDir!: string;
  let cacheDir!: string;
  let chartFile!: string;
  const readers: MBTilesReader[] = [];

  // A fresh reader has an empty in-memory LRU, like the first request
  // after a restart or chart reload.
  function freshReader(file = chartFile): MBTilesReader {
    const reader = new MBTilesReader(file);
    readers.push(reader);
    return reader;
  }

  function cachedTilePath(key: string): string {
    return path.join(cacheDir, key, '1', '0', '0.tile');
  }

  before(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'raster-tile-cache-'));
    cacheDir = path.join(tempDir, 'raster-tile-cache');
    chartFile = path.join(tempDir, 'skipped.mbtiles');
    createChart(chartFile);
  });

  after(() => {
    for (const reader of readers) {
      reader.close();
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('serves a synthesized tile from disk on the next run instead of synthesizing it', async () => {
    await initRasterTileCache(cacheDir);
    const first = await getRasterOverzoomedTile(freshReader(), 1, 0, 0);
    assert.ok(first);
    assertColor(centre(first.data), BLUE, 'synthesized');
    await flushRasterTileCache();

    const key = chartCacheKey(chartFile);
    assert.ok(key);
    assert.ok(fs.existsSync(cachedTilePath(key)), 'tile written to the cache');
    assert.deepStrictEqual(
      fs.readdirSync(path.dirname(cachedTilePath(key))),
      ['0.tile'],
      'no temporary file left behind'
    );

    fs.writeFileSync(cachedTilePath(key), solidPng(YELLOW));
    const second = await getRasterOverzoomedTile(freshReader(), 1, 0, 0);
    assert.ok(second);
    assert.strictEqual(second.contentType, 'image/png');
    assertColor(centre(second.data), YELLOW, 'served from disk');
  });

  it('does not serve tiles cached for an earlier version of the chart file', async () => {
    await initRasterTileCache(cacheDir);
    const oldKey = chartCacheKey(chartFile);
    assert.ok(oldKey);
    assert.ok(fs.existsSync(cachedTilePath(oldKey)), 'planted tile from the previous test');

    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(chartFile, later, later);
    const newKey = chartCacheKey(chartFile);
    assert.ok(newKey);
    assert.notStrictEqual(newKey, oldKey);

    const tile = await getRasterOverzoomedTile(freshReader(), 1, 0, 0);
    assert.ok(tile);
    assertColor(centre(tile.data), BLUE, 'synthesized afresh');
    await flushRasterTileCache();
    assert.ok(fs.existsSync(cachedTilePath(newKey)));

    await pruneRasterTileCache([chartFile]);
    await flushRasterTileCache();
    assert.ok(!fs.existsSync(path.join(cacheDir, oldKey)), 'stale chart directory pruned');
    assert.ok(fs.existsSync(cachedTilePath(newKey)), 'current chart directory kept');
  });

  it('evicts the least recently used chart to stay under the size cap', async () => {
    const otherFile = path.join(tempDir, 'other.mbtiles');
    createChart(otherFile);
    await initRasterTileCache(cacheDir);
    const key = chartCacheKey(chartFile);
    assert.ok(key);
    const tileBytes = fs.statSync(cachedTilePath(key)).size;

    // Room for one tile and a bit: the second chart's tile pushes the first out.
    await initRasterTileCache(cacheDir, { maxBytes: tileBytes * 1.5 });
    const tile = await getRasterOverzoomedTile(freshReader(otherFile), 1, 0, 0);
    assert.ok(tile);
    await flushRasterTileCache();

    const otherKey = chartCacheKey(otherFile);
    assert.ok(otherKey);
    assert.ok(fs.existsSync(cachedTilePath(otherKey)), 'new tile stored');
    assert.ok(!fs.existsSync(path.join(cacheDir, key)), 'older chart evicted');
  });

  it('keeps serving synthesized tiles when the cache cannot be written', async () => {
    await initRasterTileCache(cacheDir);
    // Replace the cache directory with a file, so every write fails.
    fs.rmSync(cacheDir, { recursive: true, force: true });
    fs.writeFileSync(cacheDir, 'not a directory');

    const tile = await getRasterOverzoomedTile(freshReader(), 1, 0, 0);
    assert.ok(tile);
    assertColor(centre(tile.data), BLUE, 'synthesized despite the failed write');
    await flushRasterTileCache();

    // Set up over the file fails too; the cache stays off.
    await initRasterTileCache(cacheDir);
    assert.strictEqual(chartCacheKey(chartFile), null);
    const again = await getRasterOverzoomedTile(freshReader(), 1, 0, 0);
    assert.ok(again);
    assertColor(centre(again.data), BLUE, 'synthesized with the cache off');
  });
});

describe('raster tile disk cache accounting', () => {
  const A = 'a'.repeat(16);
  const B = 'b'.repeat(16);
  const C = 'c'.repeat(16);
  const tile = { data: solidJpeg(BLUE), contentType: 'image/jpeg' as const };
  const S = tile.data.byteLength;
  let tempDir!: string;
  let cacheDir!: string;

  const stored = (key: string, x = 0) =>
    fs.existsSync(path.join(cacheDir, key, '1', String(x), '0.tile'));

  before(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'raster-tile-cache-acct-'));
    cacheDir = path.join(tempDir, 'raster-tile-cache');
  });

  after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  // Room for two tiles but not three: a chart counted twice gets evicted.
  const cap = { maxBytes: S * 2.5 };

  it('counts a tile written by two requests at once only once', async () => {
    await initRasterTileCache(cacheDir, cap);
    writeCachedTile(A, 1, 0, 0, tile);
    writeCachedTile(A, 1, 0, 0, tile);
    await flushRasterTileCache();
    writeCachedTile(A, 1, 0, 0, tile);
    await flushRasterTileCache();

    writeCachedTile(B, 1, 0, 0, tile);
    await flushRasterTileCache();
    assert.ok(stored(A), 'first chart kept');
    assert.ok(stored(B), 'second chart stored');
  });

  it('keeps the count from one scan when the cache is set up twice at once', async () => {
    fs.rmSync(path.join(cacheDir, B), { recursive: true, force: true });
    const first = initRasterTileCache(cacheDir, cap);
    await initRasterTileCache(cacheDir, cap);
    await first;

    writeCachedTile(B, 1, 0, 0, tile);
    await flushRasterTileCache();
    assert.ok(stored(A), 'first chart kept');
    assert.ok(stored(B), 'second chart stored');
  });

  it('stores a tile written while its chart directory is being removed', async () => {
    await initRasterTileCache(cacheDir, cap);
    assert.ok(stored(A));
    // Prune starts removing A and B; a new tile for A arrives meanwhile.
    await pruneRasterTileCache([]);
    writeCachedTile(A, 1, 1, 0, tile);
    await flushRasterTileCache();
    assert.ok(stored(A, 1), 'new tile survives the removal');
    assert.ok(!stored(A), 'old tile removed');

    writeCachedTile(C, 1, 0, 0, tile);
    await flushRasterTileCache();
    assert.ok(stored(A, 1) && stored(C), 'counted as one tile, not evicted');
  });
});
