/**
 * charts-loader: recover the S-57 chart type from the tile schema when the
 * metadata `type` row is missing or unrecognized.
 *
 * Background (freeboard-sk #436 / this repo's #157): the post-conversion patch
 * that stamps `type=S-57` opens the .mbtiles read-write. Under Docker or
 * rootful podman the container writes the file owned by a different UID than
 * signalk-server, so that patch fails ("attempt to write a readonly database")
 * and the file keeps tippecanoe's default `type=overlay`. charts-loader then
 * served it as a generic `tilelayer`, and Freeboard only applies its land/depth
 * S-57 style when the served type is `S-57` — so land silently stopped
 * rendering. The loader now recognizes an ENC vector tileset from its S-57
 * object-class layers and serves it as `S-57` regardless.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { gzipSync } from 'node:zlib';

import { findCharts } from '../dist/charts-loader.js';

// A minimal valid MVT tile so the file isn't empty. Content is irrelevant to
// the metadata-driven type resolution under test; charts-loader keys off the
// metadata `format`/`vector_layers`, not the tile bytes.
const EMPTY_MVT = gzipSync(Buffer.from([]));

function writeMbtiles(
  file: string,
  opts: { type?: string; format: string; layers: string[] }
): void {
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE metadata (name TEXT, value TEXT);
    CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB);
    CREATE UNIQUE INDEX tile_index ON tiles (zoom_level, tile_column, tile_row);
  `);
  const md = db.prepare('INSERT INTO metadata (name, value) VALUES (?, ?)');
  md.run('name', 'fixture');
  md.run('format', opts.format);
  md.run('bounds', '-5,50,0,54');
  md.run('minzoom', '9');
  md.run('maxzoom', '16');
  if (opts.type !== undefined) {
    md.run('type', opts.type);
  }
  md.run('json', JSON.stringify({ vector_layers: opts.layers.map((id) => ({ id, fields: {} })) }));
  db.prepare('INSERT INTO tiles VALUES (9, 0, 0, ?)').run(EMPTY_MVT);
  db.close();
}

describe('charts-loader S-57 type recovery (freeboard-sk #436)', () => {
  let dir: string;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cps-loader-'));
  });
  after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('serves an un-patched ENC vector chart (type=overlay) as S-57', async () => {
    writeMbtiles(path.join(dir, 'unpatched.mbtiles'), {
      type: 'overlay',
      format: 'pbf',
      layers: ['DEPARE', 'LNDARE', 'SOUNDG', 'COALNE']
    });
    const charts = await findCharts(dir);
    assert.strictEqual(charts['unpatched'].type, 'S-57');
  });

  it('serves a vector chart with no type row at all as S-57 when S-57 layers are present', async () => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    writeMbtiles(path.join(dir, 'notype.mbtiles'), {
      format: 'pbf',
      layers: ['LNDARE', 'DEPCNT']
    });
    const charts = await findCharts(dir);
    assert.strictEqual(charts['notype'].type, 'S-57');
  });

  it('keeps an explicit type=S-57 chart as S-57 (no regression)', async () => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    writeMbtiles(path.join(dir, 'patched.mbtiles'), {
      type: 'S-57',
      format: 'pbf',
      layers: ['LNDARE', 'DEPARE']
    });
    const charts = await findCharts(dir);
    assert.strictEqual(charts['patched'].type, 'S-57');
  });

  it('does NOT promote a generic vector tileset (no S-57 layers) to S-57', async () => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    writeMbtiles(path.join(dir, 'generic.mbtiles'), {
      type: 'overlay',
      format: 'pbf',
      layers: ['water', 'roads', 'buildings']
    });
    const charts = await findCharts(dir);
    assert.strictEqual(charts['generic'].type, 'tilelayer');
  });

  it('does NOT treat a raster chart as S-57 even if its type is unrecognized', async () => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    writeMbtiles(path.join(dir, 'raster.mbtiles'), {
      type: 'overlay',
      format: 'png',
      layers: []
    });
    const charts = await findCharts(dir);
    assert.strictEqual(charts['raster'].type, 'tilelayer');
  });
});
