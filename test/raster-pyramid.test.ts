import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PNG } from 'pngjs';

import { addRasterOverviews } from '../dist/utils/raster-pyramid.js';
import { withWorkerPool } from '../dist/utils/worker-pool.js';

function solidPng(rgb: [number, number, number]): Buffer {
  const png = new PNG({ width: 256, height: 256 });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = rgb[0];
    png.data[i + 1] = rgb[1];
    png.data[i + 2] = rgb[2];
    png.data[i + 3] = 255;
  }
  return PNG.sync.write(png);
}

function pixel(data: Uint8Array, x: number, y: number): number[] {
  const png = PNG.sync.read(Buffer.from(data));
  const o = (y * png.width + x) * 4;
  return [png.data[o], png.data[o + 1], png.data[o + 2], png.data[o + 3]];
}

describe('addRasterOverviews', () => {
  it('builds each overview level from the four tiles below it', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-charts-pyramid-'));
    const file = path.join(tmp, 'chart.mbtiles');
    try {
      const db = new DatabaseSync(file);
      db.exec(`
        CREATE TABLE metadata (name TEXT, value TEXT);
        CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB);
        CREATE UNIQUE INDEX tile_index ON tiles (zoom_level, tile_column, tile_row);
        INSERT INTO metadata VALUES ('minzoom', '3'), ('maxzoom', '3');
      `);
      // z3 tiles of the z2 parent (2, 1) south-up row 1: columns 2-3, rows
      // 2-3. Row 3 is the northern one.
      const insert = db.prepare('INSERT INTO tiles VALUES (3, ?, ?, ?)');
      insert.run(4, 3, solidPng([255, 0, 0])); // north-west: red
      insert.run(5, 3, solidPng([0, 255, 0])); // north-east: green
      insert.run(4, 2, solidPng([0, 0, 255])); // south-west: blue
      // south-east missing: stays transparent
      db.close();

      const added = await withWorkerPool(2, undefined, (pool) => addRasterOverviews(file, 5, pool));
      // One tile at each of z2, z1, z0; overviews stop at z0.
      assert.strictEqual(added, 3);

      const check = new DatabaseSync(file);
      try {
        const z2 = check
          .prepare(
            'SELECT tile_data FROM tiles WHERE zoom_level = 2 AND tile_column = 2 AND tile_row = 1'
          )
          .get() as { tile_data: Uint8Array };
        assert.deepStrictEqual(pixel(z2.tile_data, 10, 10), [255, 0, 0, 255]);
        assert.deepStrictEqual(pixel(z2.tile_data, 200, 10), [0, 255, 0, 255]);
        assert.deepStrictEqual(pixel(z2.tile_data, 10, 200), [0, 0, 255, 255]);
        assert.strictEqual(pixel(z2.tile_data, 200, 200)[3], 0);
        assert.deepStrictEqual(
          (
            check.prepare('SELECT zoom_level FROM tiles ORDER BY zoom_level').all() as {
              zoom_level: number;
            }[]
          ).map((r) => r.zoom_level),
          [0, 1, 2, 3, 3, 3]
        );
        assert.deepStrictEqual(
          (
            check.prepare("SELECT value FROM metadata WHERE name = 'minzoom'").all() as {
              value: string;
            }[]
          ).map((r) => r.value),
          ['0']
        );
      } finally {
        check.close();
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
