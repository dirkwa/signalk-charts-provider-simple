/**
 * Tests for the MBTiles reader module
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { MBTilesReader, open } = require('../src/utils/mbtiles-reader');

const TEST_MBTILES = path.join(__dirname, 'fixtures', 'test-chart.mbtiles');

describe('MBTilesReader', () => {
  let reader;

  before(() => {
    reader = new MBTilesReader(TEST_MBTILES);
  });

  after(() => {
    if (reader) {
      reader.close();
    }
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
      assert.ok(Buffer.isBuffer(result.data), 'data should be a Buffer');
      assert.ok(result.headers, 'headers should exist');
    });

    it('should return correct content-type header for PNG', () => {
      const result = reader.getTile(0, 0, 0);
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
      const tile_y0 = reader.getTile(1, 0, 0); // XYZ y=0 -> TMS row=1
      const tile_y1 = reader.getTile(1, 0, 1); // XYZ y=1 -> TMS row=0

      assert.ok(tile_y0, 'Tile at XYZ (1,0,0) should exist');
      assert.ok(tile_y1, 'Tile at XYZ (1,0,1) should exist');
    });

    it('should return valid PNG data', () => {
      const result = reader.getTile(0, 0, 0);
      // Check PNG magic bytes
      assert.strictEqual(result.data[0], 0x89);
      assert.strictEqual(result.data[1], 0x50); // P
      assert.strictEqual(result.data[2], 0x4e); // N
      assert.strictEqual(result.data[3], 0x47); // G
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
      /SQLITE_CANTOPEN|no such file|directory does not exist/i
    );
  });

  it('should have working getInfo after open', async () => {
    const reader = await open(TEST_MBTILES);
    const info = reader.getInfo();
    assert.strictEqual(info.name, 'Test Chart');
    reader.close();
  });
});
