import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { gzipSync } from 'node:zlib';

import { mergeTiles, parseCoverage, polygonTiles } from '../dist/utils/chart-coverage.js';
import { findCharts } from '../dist/charts-loader.js';

type Box = [number, number, number, number];

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `coverage-${prefix}-`));
}

/** `[west, south, east, north]` of an XYZ tile. */
function tileBox(z: number, x: number, y: number): Box {
  const n = 2 ** z;
  const lat = (row: number): number =>
    (Math.atan(Math.sinh(Math.PI * (1 - (2 * row) / n))) * 180) / Math.PI;
  return [(x / n) * 360 - 180, lat(y + 1), ((x + 1) / n) * 360 - 180, lat(y)];
}

function polygon([west, south, east, north]: Box): [number, number][][] {
  return [
    [
      [west, south],
      [east, south],
      [east, north],
      [west, north],
      [west, south]
    ]
  ];
}

describe('mergeTiles', () => {
  it('puts a parent in place of its four children, over several zooms', () => {
    const z2 = [0, 1].flatMap((y) => [0, 1].map((x) => ({ x, y })));
    const z3 = [4, 5].flatMap((y) => [0, 1, 2, 3].map((x) => ({ x, y })));
    // At z3: all of z2 tiles 0/0..1/1 (as 16 tiles), two more whole z2
    // tiles, and a lone tile.
    const tiles = [
      ...z2.flatMap((t) =>
        [0, 1].flatMap((dy) => [0, 1].map((dx) => ({ x: t.x * 2 + dx, y: t.y * 2 + dy })))
      ),
      ...z3,
      { x: 7, y: 7 }
    ];
    assert.deepStrictEqual(mergeTiles(tiles, 3), ['1/0/0', '2/0/2', '2/1/2', '3/7/7']);
  });

  it('keeps tiles whose siblings are missing', () => {
    assert.deepStrictEqual(
      mergeTiles(
        [
          { x: 0, y: 0 },
          { x: 1, y: 0 },
          { x: 0, y: 1 }
        ],
        5
      ),
      ['5/0/0', '5/0/1', '5/1/0']
    );
  });
});

describe('polygonTiles', () => {
  it('fills a tile whose borders the polygon follows', () => {
    assert.deepStrictEqual(polygonTiles([polygon(tileBox(9, 492, 288))], 9), ['9/492/288']);
  });

  it('leaves out tiles the polygon only partly fills', () => {
    const [west, south, east, north] = tileBox(6, 60, 20);
    const box: Box = [west, south, east + (east - west) / 2, north];
    assert.deepStrictEqual(polygonTiles([polygon(box)], 6), ['6/60/20']);
    assert.deepStrictEqual(polygonTiles([polygon(box)], 7), ['6/60/20', '7/122/40', '7/122/41']);
  });

  it('looks one zoom less deep while it finds more tiles than asked for', () => {
    const [west, south, east, north] = tileBox(6, 60, 20);
    const box: Box = [west, south, east + (east - west) / 2, north];
    assert.deepStrictEqual(polygonTiles([polygon(box)], 7, 2), ['6/60/20']);
  });

  it('fills a tile two polygons share between them', () => {
    const [west, south, east, north] = tileBox(8, 100, 90);
    const middle = (west + east) / 2;
    assert.deepStrictEqual(
      polygonTiles(
        [polygon([west, south, middle, north]), polygon([middle, south, east, north])],
        8
      ),
      ['8/100/90']
    );
  });

  it('lists nothing for a polygon smaller than a tile', () => {
    assert.deepStrictEqual(polygonTiles([polygon([0.1, 0.1, 0.2, 0.2])], 4), []);
    assert.deepStrictEqual(polygonTiles([], 4), []);
  });
});

describe('parseCoverage', () => {
  const valid = [{ minzoom: 9, tiles: ['9/492/288'] }];

  it('reads a valid coverage', () => {
    assert.deepStrictEqual(parseCoverage(JSON.stringify(valid)), valid);
  });

  it('ignores what it cannot read', () => {
    assert.strictEqual(parseCoverage(undefined), undefined);
    assert.strictEqual(parseCoverage('not json'), undefined);
    assert.strictEqual(parseCoverage('[]'), undefined);
    assert.strictEqual(
      parseCoverage(JSON.stringify([{ minzoom: 9, tiles: ['9/492'] }])),
      undefined
    );
  });
});

describe('charts-loader', () => {
  function writeChart(file: string, coverage: string | null): void {
    const db = new DatabaseSync(file);
    db.exec(`
      CREATE TABLE metadata (name TEXT, value TEXT);
      CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB);
    `);
    const rows: [string, string][] = [
      ['name', path.basename(file)],
      ['format', 'pbf'],
      ['type', 'S-57'],
      ['bounds', '0,0,1,1'],
      ['minzoom', '9'],
      ['maxzoom', '16']
    ];
    if (coverage !== null) {
      rows.push(['coverage', coverage]);
    }
    for (const row of rows) {
      db.prepare('INSERT INTO metadata (name, value) VALUES (?, ?)').run(...row);
    }
    db.prepare('INSERT INTO tiles VALUES (9, 256, 255, ?)').run(gzipSync(Buffer.from([])));
    db.close();
  }

  it('serves a chart’s coverage, and none when it is missing or unreadable', async () => {
    const dir = tmpDir('loader');
    const coverage = [{ minzoom: 9, tiles: ['9/256/256'] }];
    writeChart(path.join(dir, 'with.mbtiles'), JSON.stringify(coverage));
    writeChart(path.join(dir, 'without.mbtiles'), null);
    writeChart(path.join(dir, 'broken.mbtiles'), '{');
    const charts = await findCharts(dir);
    try {
      assert.deepStrictEqual(charts.with.coverage, coverage);
      assert.ok(!('coverage' in charts.without));
      assert.ok(!('coverage' in charts.broken));
    } finally {
      for (const chart of Object.values(charts)) {
        chart._mbtilesHandle?.close();
      }
    }
  });
});
