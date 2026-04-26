const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { _testInternals } = require('../dist/utils/s57-converter');
const { consolidateGeoJSONByLayer } = _testInternals;

function writeFC(p, features) {
  fs.writeFileSync(p, JSON.stringify({ type: 'FeatureCollection', features }));
}

function point(props, coords = [0, 0]) {
  return { type: 'Feature', properties: props, geometry: { type: 'Point', coordinates: coords } };
}

describe('consolidateGeoJSONByLayer', () => {
  let tmp;

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-charts-consolidate-'));
  });

  after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('preserves S-57 layer names that contain underscores (M_COVR, M_QUAL)', () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'm-layers-'));
    writeFC(path.join(dir, 'M_COVR_US3CO100.geojson'), [point({ kind: 'm-covr' })]);
    writeFC(path.join(dir, 'M_QUAL_US3CO100.geojson'), [point({ kind: 'm-qual' })]);
    writeFC(path.join(dir, 'M_NPUB_US3CO100.geojson'), [point({ kind: 'm-npub' })]);

    const merged = consolidateGeoJSONByLayer(dir);
    const names = merged.map((p) => path.basename(p, '.geojson')).sort();
    assert.deepStrictEqual(names, ['M_COVR', 'M_NPUB', 'M_QUAL']);

    // Each merged file should contain exactly its own feature, not all three
    // smashed together.
    for (const file of merged) {
      const fc = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.strictEqual(fc.features.length, 1, `${file} should hold one feature`);
    }
  });

  it('merges multi-source layers across charts', () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'multi-'));
    writeFC(path.join(dir, 'BUAARE_US3CO100.geojson'), [point({ name: 'a' })]);
    writeFC(path.join(dir, 'BUAARE_US3CO200.geojson'), [point({ name: 'b' })]);
    writeFC(path.join(dir, 'BUAARE_US3CO400.geojson'), [point({ name: 'c' })]);

    const merged = consolidateGeoJSONByLayer(dir);
    assert.strictEqual(merged.length, 1);
    assert.strictEqual(path.basename(merged[0], '.geojson'), 'BUAARE');

    const fc = JSON.parse(fs.readFileSync(merged[0], 'utf8'));
    assert.strictEqual(fc.features.length, 3);
    const names = fc.features.map((f) => f.properties.name).sort();
    assert.deepStrictEqual(names, ['a', 'b', 'c']);
  });

  it('handles single-chart bundles where files are already named LAYER.geojson', () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'single-'));
    writeFC(path.join(dir, 'COALNE.geojson'), [point({ k: 'coalne' })]);
    writeFC(path.join(dir, 'M_COVR.geojson'), [point({ k: 'm-covr' })]);

    const merged = consolidateGeoJSONByLayer(dir);
    const names = merged.map((p) => path.basename(p, '.geojson')).sort();
    assert.deepStrictEqual(names, ['COALNE', 'M_COVR']);

    // Output must be a real file, not a symlink — the caller bind-mounts only
    // the merged dir into the container, so a symlink to the parent geojsonDir
    // would dangle.
    for (const file of merged) {
      const lst = fs.lstatSync(file);
      assert.ok(!lst.isSymbolicLink(), `${file} must not be a symlink`);
      const fc = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.strictEqual(fc.features.length, 1);
    }
  });

  it('skips empty files (size <= 100 bytes)', () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'empty-'));
    fs.writeFileSync(path.join(dir, 'EMPTY_US3CO100.geojson'), '{}');
    writeFC(path.join(dir, 'REAL_US3CO100.geojson'), [point({ k: 'real' })]);

    const merged = consolidateGeoJSONByLayer(dir);
    const names = merged.map((p) => path.basename(p, '.geojson'));
    assert.deepStrictEqual(names, ['REAL']);
  });

  it('returns an empty array when there are no usable inputs', () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'none-'));
    const merged = consolidateGeoJSONByLayer(dir);
    assert.deepStrictEqual(merged, []);
  });

  it('does not collapse M_COVR + M_QUAL into a single "M" layer in multi-chart bundles', () => {
    // The pre-fix bug: lastIndexOf('_') on 'M_COVR_US3CO100' yielded layer='M_COVR',
    // but indexOf('_') would have yielded layer='M' and merged unrelated layers.
    // This regression test ensures both layers stay distinct across multiple charts.
    const dir = fs.mkdtempSync(path.join(tmp, 'm-multi-'));
    writeFC(path.join(dir, 'M_COVR_US3CO100.geojson'), [point({ k: 'covr-100' })]);
    writeFC(path.join(dir, 'M_COVR_US3CO200.geojson'), [point({ k: 'covr-200' })]);
    writeFC(path.join(dir, 'M_QUAL_US3CO100.geojson'), [point({ k: 'qual-100' })]);
    writeFC(path.join(dir, 'M_QUAL_US3CO200.geojson'), [point({ k: 'qual-200' })]);

    const merged = consolidateGeoJSONByLayer(dir);
    const names = merged.map((p) => path.basename(p, '.geojson')).sort();
    assert.deepStrictEqual(names, ['M_COVR', 'M_QUAL']);

    for (const file of merged) {
      const fc = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.strictEqual(fc.features.length, 2);
    }
  });
});
