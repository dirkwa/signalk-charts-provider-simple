import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { gzipSync } from 'node:zlib';

import { mergeTiles, parseCoverage, polygonTiles } from '../dist/utils/chart-coverage.js';
import { encCoverage } from '../dist/utils/s57-coverage.js';
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

function coverageExport(
  file: string,
  features: { catcov?: number | string; box: Box }[],
  gzip = false
): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = JSON.stringify({
    type: 'FeatureCollection',
    features: features.map(({ catcov, box }) => ({
      type: 'Feature',
      properties: catcov === undefined ? {} : { CATCOV: catcov },
      geometry: { type: 'Polygon', coordinates: polygon(box) }
    }))
  });
  fs.writeFileSync(file, gzip ? gzipSync(text) : text);
}

function markComplete(dir: string, ...cells: string[]): void {
  for (const cell of cells) {
    fs.writeFileSync(path.join(dir, `.complete-${cell}`), '');
  }
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

  it('keeps the edges a tiler draws where the union would drop a vertex', () => {
    // [10, 40] lies on the straight line from [0, 0] to [20, 80] in
    // longitude and latitude, not in Web Mercator, where the polygon bends
    // in there and leaves 10/535/387 out.
    const ring: [number, number][] = [
      [0, 0],
      [20, 0],
      [20, 80],
      [10, 40],
      [0, 0]
    ];
    const covers = (tile: string, z: number, x: number, y: number): boolean => {
      const [tz, tx, ty] = tile.split('/').map(Number);
      return tz <= z && x >> (z - tz) === tx && y >> (z - tz) === ty;
    };
    const tiles = polygonTiles([[ring]], 10);
    assert.ok(tiles.length > 0);
    assert.ok(!tiles.some((t) => covers(t, 10, 535, 387)));
  });

  it('lists a large area by its parents without walking its deepest tiles', () => {
    const started = Date.now();
    assert.deepStrictEqual(polygonTiles([polygon(tileBox(2, 1, 1))], 14), ['2/1/1']);
    assert.ok(Date.now() - started < 1000);
  });

  it('holds a coarse tile to the deepest zoom’s border tolerance', () => {
    // About 5 m inside the west border of 2/1/1: within a z2 tile's
    // tolerance, far outside a z14 tile's.
    const [west, south, east, north] = tileBox(2, 1, 1);
    const tiles = polygonTiles([polygon([west + 0.00005, south, east, north])], 14);
    assert.ok(tiles.length > 0);
    assert.ok(!tiles.includes('2/1/1'));
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

describe('encCoverage', () => {
  it('lists each band’s tiles at the band’s zooms, the top band without a maxzoom', () => {
    const dir = tmpDir('bands');
    // A band-3 cell over two z12 tiles, two band-4 cells sharing one z14 tile,
    // a band-5 cell over one z14 tile and its no-coverage area.
    const [w, s] = tileBox(12, 1200, 1500);
    const [, , e, n] = tileBox(12, 1201, 1500);
    coverageExport(path.join(dir, 'geojson', 'M_COVR__US3AA1AA.geojson'), [
      { catcov: 1, box: [w, s, e, n] }
    ]);
    const b4 = tileBox(14, 4800, 6000);
    const mid = (b4[0] + b4[2]) / 2;
    coverageExport(path.join(dir, 'geojson', 'M_COVR__US4AA1AA.geojson'), [
      { catcov: 1, box: [b4[0], b4[1], mid, b4[3]] }
    ]);
    coverageExport(
      path.join(dir, 'geojson', 'M_COVR__US4AA1AB.geojson.gz'),
      [{ catcov: '1', box: [mid, b4[1], b4[2], b4[3]] }],
      true
    );
    coverageExport(path.join(dir, 'geojson', 'M_COVR__US5AA1AA.geojson'), [
      { catcov: 1, box: tileBox(14, 4801, 6000) },
      { catcov: 2, box: tileBox(14, 4802, 6000) }
    ]);
    // Not coverage, and a merged copy of the exports.
    coverageExport(path.join(dir, 'geojson', 'DEPARE__US5AA1AA.geojson'), [
      { box: tileBox(14, 4803, 6000) }
    ]);
    coverageExport(path.join(dir, 'geojson', '.merged', 'M_COVR.geojson'), [
      { box: tileBox(1, 0, 0) }
    ]);

    markComplete(path.join(dir, 'geojson'), 'US3AA1AA', 'US4AA1AA', 'US4AA1AB', 'US5AA1AA');

    assert.deepStrictEqual(encCoverage(dir, 9, 16, 16), [
      { minzoom: 9, maxzoom: 12, tiles: ['12/1200/1500', '12/1201/1500'] },
      { minzoom: 10, maxzoom: 14, tiles: ['14/4800/6000'] },
      { minzoom: 12, tiles: ['14/4801/6000'] }
    ]);
  });

  it('places the export of a lone cell at the user’s zooms', () => {
    const dir = tmpDir('lone');
    coverageExport(path.join(dir, 'geojson', 'M_COVR.geojson'), [{ box: tileBox(9, 10, 10) }]);
    markComplete(path.join(dir, 'geojson'), 'US5AA1AA');
    assert.deepStrictEqual(encCoverage(dir, 9, 16, 16), [{ minzoom: 9, tiles: ['9/10/10'] }]);
  });

  it('leaves out a ring across the antimeridian, and gives null without coverage', () => {
    const dir = tmpDir('none');
    coverageExport(path.join(dir, 'geojson', 'M_COVR__US3AA1AA.geojson'), [
      { box: [-179.5, 0, 179.5, 1] },
      { catcov: 2, box: tileBox(9, 10, 10) }
    ]);
    markComplete(path.join(dir, 'geojson'), 'US3AA1AA');
    assert.strictEqual(encCoverage(dir, 9, 16, 16), null);
  });

  it('leaves out cells exported in part', () => {
    const dir = tmpDir('partial');
    coverageExport(path.join(dir, 'geojson', 'M_COVR__US5AA1AA.geojson'), [
      { box: tileBox(14, 4801, 6000) }
    ]);
    coverageExport(path.join(dir, 'geojson', 'M_COVR__US5AA1AB.geojson'), [
      { box: tileBox(14, 4802, 6000) }
    ]);
    coverageExport(path.join(dir, 'lone', 'M_COVR.geojson'), [{ box: tileBox(14, 4803, 6000) }]);
    markComplete(path.join(dir, 'geojson'), 'US5AA1AB');
    assert.deepStrictEqual(encCoverage(dir, 9, 16, 16), [{ minzoom: 12, tiles: ['14/4802/6000'] }]);
  });

  it('leaves out bands the chart is not tiled at', () => {
    const dir = tmpDir('beyond');
    coverageExport(path.join(dir, 'geojson', 'M_COVR__US6AA1AA.geojson'), [
      { box: tileBox(14, 4801, 6000) }
    ]);
    coverageExport(path.join(dir, 'geojson', 'M_COVR__US3AA1AA.geojson'), [
      { box: tileBox(10, 300, 375) }
    ]);
    markComplete(path.join(dir, 'geojson'), 'US6AA1AA', 'US3AA1AA');
    assert.deepStrictEqual(encCoverage(dir, 9, 12, 12), [{ minzoom: 9, tiles: ['10/300/375'] }]);
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
