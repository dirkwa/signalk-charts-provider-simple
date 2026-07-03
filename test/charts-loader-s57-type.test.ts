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
  let root: string;
  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cps-loader-'));
  });
  after(() => {
    // maxRetries/retryDelay rides out the brief window where Windows still
    // holds a lock on a just-closed .mbtiles (EBUSY on unlink otherwise).
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  // Write a one-chart .mbtiles into its own subdir, load it through the real
  // findCharts, then close the reader handle findCharts leaves open (charts
  // hold a live node:sqlite handle, which locks the file on Windows). Returns
  // the served chart type.
  async function loadType(
    name: string,
    opts: { type?: string; format: string; layers: string[] }
  ): Promise<string> {
    const dir = fs.mkdtempSync(path.join(root, `${name}-`));
    writeMbtiles(path.join(dir, `${name}.mbtiles`), opts);
    const charts = await findCharts(dir);
    const chart = charts[name] as { type: string; _mbtilesHandle?: { close?: () => void } };
    chart._mbtilesHandle?.close?.();
    return chart.type;
  }

  it('serves an un-patched ENC vector chart (type=overlay) as S-57', async () => {
    const type = await loadType('unpatched', {
      type: 'overlay',
      format: 'pbf',
      layers: ['DEPARE', 'LNDARE', 'SOUNDG', 'COALNE']
    });
    assert.strictEqual(type, 'S-57');
  });

  it('serves a vector chart with no type row at all as S-57 when S-57 layers are present', async () => {
    const type = await loadType('notype', {
      format: 'pbf',
      layers: ['LNDARE', 'DEPCNT']
    });
    assert.strictEqual(type, 'S-57');
  });

  it('keeps an explicit type=S-57 chart as S-57 (no regression)', async () => {
    const type = await loadType('patched', {
      type: 'S-57',
      format: 'pbf',
      layers: ['LNDARE', 'DEPARE']
    });
    assert.strictEqual(type, 'S-57');
  });

  it('does NOT promote a generic vector tileset (no S-57 layers) to S-57', async () => {
    const type = await loadType('generic', {
      type: 'overlay',
      format: 'pbf',
      layers: ['water', 'roads', 'buildings']
    });
    assert.strictEqual(type, 'tilelayer');
  });

  it('does NOT treat a raster chart as S-57 even if its type is unrecognized', async () => {
    const type = await loadType('raster', {
      type: 'overlay',
      format: 'png',
      layers: []
    });
    assert.strictEqual(type, 'tilelayer');
  });
});
