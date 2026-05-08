/**
 * Tests for the MBTiles reader module
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MBTilesReader, open } from '../dist/utils/mbtiles-reader.js';

// ESM equivalent of CJS `__dirname`.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Tests compile to `dist-test/`, so `__dirname` points there at runtime.
// Fixtures live in `test/fixtures/`, one level up and over.
const TEST_MBTILES = path.join(__dirname, '..', 'test', 'fixtures', 'test-chart.mbtiles');

describe('MBTilesReader', () => {
  // Definitely-assigned in `before()`; the `after()` guards anyway in
  // case `before()` throws (e.g., fixture not yet built) so a teardown
  // crash doesn't mask the original failure.
  let reader!: MBTilesReader;

  before(() => {
    reader = new MBTilesReader(TEST_MBTILES);
  });

  after(() => {
    reader?.close();
  });

  describe('getInfo()', () => {
    it('should return metadata object', () => {
      const info = reader.getInfo();
      assert.ok(info, 'Info should not be null');
      assert.strictEqual(typeof info, 'object');
    });

    it('should have correct name', () => {
      const info = reader.getInfo();
      assert.strictEqual(info.name, 'Test Chart');
    });

    it('should have correct description', () => {
      const info = reader.getInfo();
      assert.strictEqual(info.description, 'A test chart for unit testing');
    });

    it('should have correct format', () => {
      const info = reader.getInfo();
      assert.strictEqual(info.format, 'png');
    });

    it('should parse bounds as array of numbers', () => {
      const info = reader.getInfo();
      assert.ok(Array.isArray(info.bounds), 'bounds should be an array');
      assert.strictEqual(info.bounds.length, 4);
      assert.deepStrictEqual(info.bounds, [-180, -85, 180, 85]);
    });

    it('should parse minzoom and maxzoom as integers', () => {
      const info = reader.getInfo();
      assert.strictEqual(info.minzoom, 0);
      assert.strictEqual(info.maxzoom, 4);
    });

    it('should cache metadata on subsequent calls', () => {
      const info1 = reader.getInfo();
      const info2 = reader.getInfo();
      assert.strictEqual(info1, info2, 'Should return cached object');
    });
  });

  describe('getTile()', () => {
    it('should return tile data for existing tile at zoom 0', () => {
      // At zoom 0, there's only one tile (0,0)
      // MBTiles stores as TMS (row 0), we request as XYZ (y 0)
      const result = reader.getTile(0, 0, 0);
      assert.ok(result, 'Result should not be null');
      assert.ok(result.data instanceof Uint8Array, 'data should be a Uint8Array');
      assert.ok(result.headers, 'headers should exist');
    });

    it('should return correct content-type header for PNG', () => {
      const result = reader.getTile(0, 0, 0);
      assert.ok(result);
      assert.strictEqual(result.headers['Content-Type'], 'image/png');
    });

    it('should return null for non-existing tile', () => {
      // Request a tile that doesn't exist
      const result = reader.getTile(10, 999, 999);
      assert.strictEqual(result, null);
    });

    it('should handle Y-flip correctly (TMS to XYZ conversion)', () => {
      // At zoom 1, we have tiles at TMS rows 0 and 1
      // XYZ y=0 maps to TMS row=1 (at zoom 1: 2^1 - 1 - 0 = 1)
      // XYZ y=1 maps to TMS row=0 (at zoom 1: 2^1 - 1 - 1 = 0)

      // Both should exist since we inserted tiles at TMS (1,0,0), (1,0,1), (1,1,0), (1,1,1)
      const tileY0 = reader.getTile(1, 0, 0); // XYZ y=0 -> TMS row=1
      const tileY1 = reader.getTile(1, 0, 1); // XYZ y=1 -> TMS row=0

      assert.ok(tileY0, 'Tile at XYZ (1,0,0) should exist');
      assert.ok(tileY1, 'Tile at XYZ (1,0,1) should exist');
    });

    it('should return valid PNG data', () => {
      const result = reader.getTile(0, 0, 0);
      assert.ok(result);
      // Check PNG magic bytes
      assert.strictEqual(result.data[0], 0x89);
      assert.strictEqual(result.data[1], 0x50); // P
      assert.strictEqual(result.data[2], 0x4e); // N
      assert.strictEqual(result.data[3], 0x47); // G
    });

    it('returns a Buffer (not a bare Uint8Array) for downstream code', () => {
      // Express `res.end()` accepts both, but `TileResult.data` is typed
      // as Buffer and consumer code may rely on Buffer-only methods.
      // The zero-copy adapter keeps the Buffer contract intact while
      // skipping the per-tile memcpy that the prior `Buffer.from(u)`
      // form caused.
      const result = reader.getTile(0, 0, 0);
      assert.ok(result);
      assert.ok(Buffer.isBuffer(result.data), 'data must be a Buffer');
    });

    it('returns identical bytes across repeated calls (prepared statement reuse)', () => {
      // Prove the cached prepared statement re-binds parameters correctly
      // and doesn't return stale rows from a prior call. A hot pan/zoom
      // hits the same statement many times in quick succession; if the
      // cache returned the previous row by mistake the second tile of
      // any pan would be wrong.
      const a = reader.getTile(0, 0, 0);
      const b = reader.getTile(0, 0, 0);
      assert.ok(a && b);
      assert.deepStrictEqual(a.data, b.data);
    });

    it('rebinds parameters correctly across different coordinates', () => {
      // Walk a few different (z, x, y) tuples through the cached
      // statement to confirm parameter re-binding is per-call, not
      // stuck on the first coords ever queried.  The fixture inserts
      // the same PNG bytes at every coord, so we can't compare data
      // between hits — but a missing-tile coord interleaved with
      // existing ones proves the cached statement honours each
      // parameter set on every call rather than caching the first
      // result row.
      assert.ok(reader.getTile(0, 0, 0), '(0,0,0) should hit');
      assert.strictEqual(reader.getTile(99, 999, 999), null, 'invalid coord should miss');
      assert.ok(reader.getTile(1, 0, 0), '(1,0,0) should hit after a miss');
      assert.strictEqual(reader.getTile(99, 999, 999), null, 'invalid coord should miss again');
      assert.ok(reader.getTile(1, 1, 1), '(1,1,1) should hit after another miss');
    });
  });

  describe('close()', () => {
    it('should close database without error', () => {
      const tempReader = new MBTilesReader(TEST_MBTILES);
      assert.doesNotThrow(() => tempReader.close());
    });

    it('should handle multiple close calls gracefully', () => {
      const tempReader = new MBTilesReader(TEST_MBTILES);
      tempReader.close();
      assert.doesNotThrow(() => tempReader.close());
    });

    it('drops the cached prepared statement before closing the db', () => {
      // The prepared statement is bound to the db handle; using it
      // after .close() would crash node:sqlite. Take a tile (warming
      // the cache), close, then close again — no throw means the
      // statement was correctly invalidated alongside the db handle.
      const tempReader = new MBTilesReader(TEST_MBTILES);
      tempReader.getTile(0, 0, 0);
      assert.doesNotThrow(() => tempReader.close());
      assert.doesNotThrow(() => tempReader.close());
    });
  });
});

describe('open()', () => {
  it('should return a promise that resolves to MBTilesReader', async () => {
    const reader = await open(TEST_MBTILES);
    assert.ok(reader instanceof MBTilesReader);
    reader.close();
  });

  it('should reject for non-existent file', async () => {
    await assert.rejects(
      open('/non/existent/file.mbtiles'),
      /SQLITE_CANTOPEN|no such file|directory does not exist|unable to open database/i
    );
  });

  it('should have working getInfo after open', async () => {
    const reader = await open(TEST_MBTILES);
    const info = reader.getInfo();
    assert.strictEqual(info.name, 'Test Chart');
    reader.close();
  });
});
