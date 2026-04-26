const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { _testInternals } = require('../dist/utils/s57-converter');
const { consolidateGeoJSONByLayer, buildExportScript, bandClampedMaxzoom } = _testInternals;

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

  it('mixed-band bundles preserve harbour-tier layers from band-5 charts', () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'mixed-band-'));

    for (const chart of ['US3CO100', 'US3CO200', 'US5MA1SK']) {
      writeFC(path.join(dir, `LNDARE_${chart}.geojson`), [point({ src: chart })]);
      writeFC(path.join(dir, `DEPARE_${chart}.geojson`), [point({ src: chart })]);
      writeFC(path.join(dir, `COALNE_${chart}.geojson`), [point({ src: chart })]);
    }

    writeFC(path.join(dir, 'HRBFAC_US5MA1SK.geojson'), [point({ obj: 'harbour' })]);
    writeFC(path.join(dir, 'ACHARE_US5MA1SK.geojson'), [point({ obj: 'anchorage' })]);
    writeFC(path.join(dir, 'BRIDGE_US5MA1SK.geojson'), [point({ obj: 'bridge' })]);
    writeFC(path.join(dir, 'MORFAC_US5MA1SK.geojson'), [point({ obj: 'mooring' })]);
    writeFC(path.join(dir, 'PILBOP_US5MA1SK.geojson'), [point({ obj: 'pilot-boarding' })]);

    const merged = consolidateGeoJSONByLayer(dir);
    const layerNames = new Set(merged.map((p) => path.basename(p, '.geojson')));

    for (const layer of ['LNDARE', 'DEPARE', 'COALNE']) {
      assert.ok(layerNames.has(layer), `bulk layer ${layer} should be merged`);
      const fc = JSON.parse(
        fs.readFileSync(
          merged.find((p) => p.endsWith(`${layer}.geojson`)),
          'utf8'
        )
      );
      assert.strictEqual(fc.features.length, 3, `${layer} should have 3 features (1 per chart)`);
    }

    for (const layer of ['HRBFAC', 'ACHARE', 'BRIDGE', 'MORFAC', 'PILBOP']) {
      assert.ok(
        layerNames.has(layer),
        `harbour-tier layer ${layer} from US5MA1SK must survive consolidation`
      );
    }
  });
});

describe('buildExportScript', () => {
  const skipLayers = ['DSID', 'C_AGGR', 'C_ASSO', 'Generic'];

  it('produces the sequential branch when parallelism === 1', () => {
    const s = buildExportScript({ multiFile: false, parallelism: 1, skipLayers });
    assert.match(s, /for layer in \$layers; do/, 'expected `for layer` loop in sequential branch');
    assert.doesNotMatch(s, /xargs/, 'sequential branch should not invoke xargs');
    assert.match(s, /SPLIT_MULTIPOINT=YES/, 'SOUNDG handling must still be present');
    assert.match(s, /ADD_SOUNDG_DEPTH=YES/);
  });

  it('uses xargs -P with the configured parallelism when > 1', () => {
    const s = buildExportScript({ multiFile: true, parallelism: 4, skipLayers });
    assert.match(s, /xargs -P 4 /, 'expected xargs -P with the requested fan-out');
    assert.doesNotMatch(s, /for layer in \$layers; do/, 'parallel branch should not use for-layer');
  });

  it('coerces non-integer parallelism with Math.floor and a 1-floor', () => {
    const s = buildExportScript({ multiFile: false, parallelism: 2.7, skipLayers });
    assert.match(s, /xargs -P 2 /);
  });

  it('falls back to the sequential branch when parallelism === 0', () => {
    const s = buildExportScript({ multiFile: false, parallelism: 0, skipLayers });
    assert.match(s, /for layer in \$layers; do/);
    assert.doesNotMatch(s, /xargs/);
  });

  it('multi-file=true emits LAYER_<chart> output names; multi-file=false emits LAYER', () => {
    const multi = buildExportScript({ multiFile: true, parallelism: 1, skipLayers });
    assert.match(multi, /\$\{layer\}_\$\{name\}/);
    const single = buildExportScript({ multiFile: false, parallelism: 1, skipLayers });
    // Single-file path keeps just $layer in the outname assignment.
    assert.match(single, /outname="\$\{layer\}"/);
  });

  it('passes enc / name / multi to the parallel inner shell as positional args, not interpolated', () => {
    // Defence-in-depth: the parallel branch must invoke `sh -c '...' _ '{}' "$enc" "$name"
    // "<multi>"` so chart names with shell metacharacters can't escape the command.
    const s = buildExportScript({ multiFile: true, parallelism: 4, skipLayers });
    assert.match(s, /sh -c [\s\S]*' _ '\{\}' "\$enc" "\$name" "1"/);
  });

  it('keeps the skip-layer pattern in both branches', () => {
    const seq = buildExportScript({ multiFile: false, parallelism: 1, skipLayers });
    const par = buildExportScript({ multiFile: false, parallelism: 4, skipLayers });
    for (const layer of skipLayers) {
      assert.ok(seq.includes(layer), `sequential branch missing skip layer ${layer}`);
      assert.ok(par.includes(layer), `parallel branch missing skip layer ${layer}`);
    }
  });
});

// Smoke that the helper is reachable through s57-converter's _testInternals
// (the deeper coverage lives in test/s57-band.test.js — this just confirms
// processS57Zip's wiring uses the same export the test suite does).
describe('bandClampedMaxzoom (re-export from s57-converter._testInternals)', () => {
  it('clamps an AQ_ENCs-style band-3 bundle to z12', () => {
    const r = bandClampedMaxzoom(
      ['US3CO100.000', 'US3CO200.000', 'US3CO300.000', 'US3CO400.000'],
      16
    );
    assert.strictEqual(r.effective, 12);
    assert.strictEqual(r.highestBand, 3);
  });

  it('IENC fallback preserves user maxzoom (regression guard for processS57Zip)', () => {
    const r = bandClampedMaxzoom(['IENC_PASS_001.000'], 16);
    assert.strictEqual(r.effective, 16);
    assert.strictEqual(r.highestBand, null);
  });
});
