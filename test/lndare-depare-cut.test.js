const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { cutLndareByDepare } = require('../dist/utils/lndare-depare-cut');

function writeFC(p, features) {
  fs.writeFileSync(p, JSON.stringify({ type: 'FeatureCollection', features }));
}

function readFC(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function poly(coords, props = {}) {
  return {
    type: 'Feature',
    properties: props,
    geometry: { type: 'Polygon', coordinates: coords }
  };
}

// 0..10 square, used as "land that surrounds a basin"
const LAND_SQUARE = [
  [
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
    [0, 0]
  ]
];

// 3..7 inner square, used as "basin water inside the land"
const BASIN_SQUARE = [
  [
    [3, 3],
    [7, 3],
    [7, 7],
    [3, 7],
    [3, 3]
  ]
];

describe('cutLndareByDepare', () => {
  let tmp;

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-lndare-cut-'));
  });

  after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('cuts a basin (DRVAL2 > 0) out of an enclosing LNDARE polygon', () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'basin-'));
    writeFC(path.join(dir, 'LNDARE_US5MA1SK.geojson'), [poly(LAND_SQUARE, { OBJNAM: 'island' })]);
    writeFC(path.join(dir, 'DEPARE_US5MA1SK.geojson'), [
      poly(BASIN_SQUARE, { DRVAL1: 0, DRVAL2: 1.8 })
    ]);

    const stats = cutLndareByDepare(dir);

    assert.strictEqual(stats.lndareCut, 1, 'one LNDARE feature was modified');
    assert.strictEqual(stats.depareApplied, 1, 'one DEPARE was applied');
    assert.strictEqual(stats.cutFailures, 0);

    const lndare = readFC(path.join(dir, 'LNDARE_US5MA1SK.geojson'));
    assert.strictEqual(lndare.features.length, 1);
    const g = lndare.features[0].geometry;
    assert.strictEqual(g.type, 'Polygon', 'difference produced a single polygon (with a hole)');
    assert.strictEqual(g.coordinates.length, 2, 'exterior + 1 hole = 2 rings');
    assert.deepStrictEqual(g.coordinates[0][0], [0, 0], 'exterior ring preserved');
  });

  it('skips DEPARE features whose DRVAL2 <= 0 (drying flats stay land)', () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'drying-'));
    writeFC(path.join(dir, 'LNDARE_US5MA1SK.geojson'), [poly(LAND_SQUARE, { OBJNAM: 'flats' })]);
    writeFC(path.join(dir, 'DEPARE_US5MA1SK.geojson'), [
      poly(BASIN_SQUARE, { DRVAL1: 0, DRVAL2: 0 })
    ]);

    const stats = cutLndareByDepare(dir);

    assert.strictEqual(stats.lndareCut, 0);
    assert.strictEqual(stats.depareApplied, 0);
    assert.strictEqual(stats.depareSkippedDrying, 1);

    const lndare = readFC(path.join(dir, 'LNDARE_US5MA1SK.geojson'));
    const g = lndare.features[0].geometry;
    assert.strictEqual(g.coordinates.length, 1, 'no hole was added');
  });

  it('skips DEPARE features that lack DRVAL2 (defensive — never guess)', () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'no-drval2-'));
    writeFC(path.join(dir, 'LNDARE_US5MA1SK.geojson'), [poly(LAND_SQUARE)]);
    writeFC(path.join(dir, 'DEPARE_US5MA1SK.geojson'), [poly(BASIN_SQUARE, { DRVAL1: 0 })]);

    const stats = cutLndareByDepare(dir);
    assert.strictEqual(stats.lndareCut, 0);
    assert.strictEqual(stats.depareSkippedDrying, 1);
  });

  it('does nothing when LNDARE and DEPARE do not overlap', () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'no-overlap-'));
    writeFC(path.join(dir, 'LNDARE_US5MA1SK.geojson'), [poly(LAND_SQUARE)]);
    writeFC(path.join(dir, 'DEPARE_US5MA1SK.geojson'), [
      poly(
        [
          [
            [100, 100],
            [110, 100],
            [110, 110],
            [100, 110],
            [100, 100]
          ]
        ],
        { DRVAL2: 1.8 }
      )
    ]);

    const stats = cutLndareByDepare(dir);
    assert.strictEqual(stats.lndareCut, 0);
    assert.strictEqual(stats.depareApplied, 0);

    const lndare = readFC(path.join(dir, 'LNDARE_US5MA1SK.geojson'));
    assert.strictEqual(lndare.features[0].geometry.coordinates.length, 1);
  });

  it('handles charts that have LNDARE but no DEPARE file (no-op)', () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'no-depare-'));
    writeFC(path.join(dir, 'LNDARE_US5MA1SK.geojson'), [poly(LAND_SQUARE)]);
    // Intentionally no DEPARE file written.

    const stats = cutLndareByDepare(dir);
    assert.strictEqual(stats.filesScanned, 1);
    assert.strictEqual(stats.lndareCut, 0);
    assert.strictEqual(stats.depareApplied, 0);
  });

  it('only pairs LNDARE and DEPARE from the same chart cell', () => {
    // Two charts in the same dir. Chart A has LNDARE that LOOKS like it could
    // be cut by chart B's DEPARE if we cross-paired charts. We must not — bands
    // and chart geometries differ across cells, so cross-cutting would silently
    // damage data.
    const dir = fs.mkdtempSync(path.join(tmp, 'cross-chart-'));
    writeFC(path.join(dir, 'LNDARE_CHARTA.geojson'), [poly(LAND_SQUARE)]);
    writeFC(path.join(dir, 'DEPARE_CHARTB.geojson'), [poly(BASIN_SQUARE, { DRVAL2: 1.8 })]);

    const stats = cutLndareByDepare(dir);
    assert.strictEqual(stats.lndareCut, 0, 'no cuts because A and B do not pair');
    assert.strictEqual(stats.depareApplied, 0);
  });

  it('writes the file in place and preserves features that were not cut', () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'mixed-'));
    const cuttable = poly(LAND_SQUARE, { OBJNAM: 'with-basin' });
    const untouched = poly(
      [
        [
          [50, 50],
          [60, 50],
          [60, 60],
          [50, 60],
          [50, 50]
        ]
      ],
      { OBJNAM: 'far-island' }
    );
    writeFC(path.join(dir, 'LNDARE_US5MA1SK.geojson'), [cuttable, untouched]);
    writeFC(path.join(dir, 'DEPARE_US5MA1SK.geojson'), [poly(BASIN_SQUARE, { DRVAL2: 1.8 })]);

    const stats = cutLndareByDepare(dir);
    assert.strictEqual(stats.lndareCut, 1);

    const lndare = readFC(path.join(dir, 'LNDARE_US5MA1SK.geojson'));
    assert.strictEqual(lndare.features.length, 2);
    const cut = lndare.features.find((f) => f.properties?.OBJNAM === 'with-basin');
    const same = lndare.features.find((f) => f.properties?.OBJNAM === 'far-island');
    assert.strictEqual(cut.geometry.coordinates.length, 2, 'first feature got a hole');
    assert.strictEqual(same.geometry.coordinates.length, 1, 'second feature unchanged');
  });

  it('reports a per-bundle progress line via onProgress', () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'progress-'));
    writeFC(path.join(dir, 'LNDARE_US5MA1SK.geojson'), [poly(LAND_SQUARE)]);
    writeFC(path.join(dir, 'DEPARE_US5MA1SK.geojson'), [poly(BASIN_SQUARE, { DRVAL2: 1.8 })]);

    const messages = [];
    cutLndareByDepare(dir, { onProgress: (m) => messages.push(m) });
    assert.strictEqual(messages.length, 1);
    assert.match(messages[0], /LNDARE cut by DEPARE: scanned/);
    assert.match(messages[0], /cut 1/);
  });

  it('returns zeroed stats when the directory does not exist (best-effort)', () => {
    const stats = cutLndareByDepare(path.join(tmp, 'definitely-not-here'));
    assert.deepStrictEqual(stats, {
      filesScanned: 0,
      filesModified: 0,
      lndareScanned: 0,
      lndareCut: 0,
      depareApplied: 0,
      depareSkippedDrying: 0,
      cutFailures: 0
    });
  });
});
