import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import {
  _testInternals,
  bandZoomRange,
  getConversionProgress,
  planTileSources
} from '../dist/utils/s57-converter.js';

const { surfaceExportErrorsIfEmpty, wantedMbtilesName, SKIP_LAYERS } = _testInternals;

interface GeoJSONFeature {
  type: 'Feature';
  properties: Record<string, unknown>;
  geometry: { type: string; coordinates: unknown };
}

function writeFC(p: string, features: GeoJSONFeature[]): void {
  fs.writeFileSync(p, JSON.stringify({ type: 'FeatureCollection', features }));
}

function point(props: Record<string, unknown>, coords: [number, number] = [0, 0]): GeoJSONFeature {
  return { type: 'Feature', properties: props, geometry: { type: 'Point', coordinates: coords } };
}

/** `layer zmin-zmax: file, file` per source, sorted, for compact asserts. */
function describeSources(sources: ReturnType<typeof planTileSources>): string[] {
  return sources
    .map(
      (s) =>
        `${s.layer} z${String(s.minzoom)}-${String(s.maxzoom)}: ${s.files
          .map((f) => path.basename(f))
          .sort()
          .join(', ')}`
    )
    .sort();
}

describe('bandZoomRange', () => {
  it('clamps a band to its native zooms within the user range', () => {
    // Band 5 (harbour) is drawn z12-z16.
    assert.deepStrictEqual(bandZoomRange(5, 9, 18), { minzoom: 12, maxzoom: 16 });
    // Band 3 (coastal) z8-z12, floor raised to the user's z9.
    assert.deepStrictEqual(bandZoomRange(3, 9, 18), { minzoom: 9, maxzoom: 12 });
  });

  it('never goes past what the user asked for', () => {
    assert.deepStrictEqual(bandZoomRange(5, 13, 14), { minzoom: 13, maxzoom: 14 });
  });

  it('can leave a band an empty range (min above max) when the user range misses it', () => {
    const range = bandZoomRange(1, 9, 16);
    assert.ok(range.minzoom > range.maxzoom);
  });

  it('uses the user range for cells without a band (IENC, hand-named)', () => {
    assert.deepStrictEqual(bandZoomRange(null, 4, 18), { minzoom: 4, maxzoom: 18 });
  });
});

describe('planTileSources', () => {
  let tmp: string;

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-charts-plan-'));
  });

  after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('preserves S-57 layer names that contain underscores (M_COVR, M_QUAL)', () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'm-layers-'));
    writeFC(path.join(dir, 'M_COVR__US3CO100.geojson'), [point({ kind: 'm-covr' })]);
    writeFC(path.join(dir, 'M_QUAL__US3CO100.geojson'), [point({ kind: 'm-qual' })]);
    writeFC(path.join(dir, 'M_NPUB__US3CO100.geojson'), [point({ kind: 'm-npub' })]);

    assert.deepStrictEqual(
      planTileSources(dir, 9, 16)
        .map((s) => s.layer)
        .sort(),
      ['M_COVR', 'M_NPUB', 'M_QUAL']
    );
  });

  it('has every source honour SCAMIN', () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'scamin-'));
    writeFC(path.join(dir, 'SOUNDG__US5MA1SK.geojson'), [point({ SCAMIN: 90000 })]);
    writeFC(path.join(dir, 'DEPARE__IENC_X.geojson'), [point({ DRVAL1: 2 })]);
    const sources = planTileSources(dir, 9, 16);
    assert.strictEqual(sources.length, 2);
    assert.ok(sources.every((s) => s.scamin === true));
  });

  it('gives each band of a layer its own zoom range', () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'bands-'));
    writeFC(path.join(dir, 'DEPARE__US3CO100.geojson'), [point({ band: 3 })]);
    writeFC(path.join(dir, 'DEPARE__US4CO100.geojson'), [point({ band: 4 })]);
    writeFC(path.join(dir, 'DEPARE__US5CO100.geojson'), [point({ band: 5 })]);
    writeFC(path.join(dir, 'DEPARE__US5CO200.geojson'), [point({ band: 5 })]);

    assert.deepStrictEqual(describeSources(planTileSources(dir, 9, 16)), [
      'DEPARE z10-14: DEPARE__US4CO100.geojson',
      'DEPARE z12-16: DEPARE__US5CO100.geojson, DEPARE__US5CO200.geojson',
      'DEPARE z9-12: DEPARE__US3CO100.geojson'
    ]);
  });

  it('reads gzipped GeoJSON beside plain files, and skips empty exports of either kind', () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'gz-'));
    writeFC(path.join(dir, 'BUAARE__US3CO100.geojson'), [point({ name: 'plain' })]);
    fs.writeFileSync(
      path.join(dir, 'BUAARE__US5CO200.geojson.gz'),
      zlib.gzipSync(
        JSON.stringify({ type: 'FeatureCollection', features: [point({ name: 'gz' })] })
      )
    );
    fs.writeFileSync(
      path.join(dir, 'LNDARE__US5CO200.geojson.gz'),
      zlib.gzipSync(JSON.stringify({ type: 'FeatureCollection', features: [] }))
    );
    writeFC(path.join(dir, 'LNDARE__US3CO100.geojson'), []);

    assert.deepStrictEqual(describeSources(planTileSources(dir, 9, 16)), [
      'BUAARE z12-16: BUAARE__US5CO200.geojson.gz',
      'BUAARE z9-12: BUAARE__US3CO100.geojson'
    ]);
  });

  it('reads the layer of cells whose names contain underscores', () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'underscore-cells-'));
    // A trailing `_` (live Dutch cells), and a cell whose name ends like a layer.
    writeFC(path.join(dir, 'DEPARE__IENC_Haven_Waspik_7_.geojson'), [point({ c: 'waspik' })]);
    writeFC(path.join(dir, 'M_COVR__AB_M_COVR.geojson'), [point({ c: 'ab' })]);

    assert.deepStrictEqual(describeSources(planTileSources(dir, 9, 16)), [
      'DEPARE z9-16: DEPARE__IENC_Haven_Waspik_7_.geojson',
      'M_COVR z9-16: M_COVR__AB_M_COVR.geojson'
    ]);
  });

  it('handles single-cell exports named LAYER.geojson with the user range', () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'single-'));
    writeFC(path.join(dir, 'LIGHTS.geojson'), [point({ x: 1 })]);
    assert.deepStrictEqual(describeSources(planTileSources(dir, 4, 18)), [
      'LIGHTS z4-18: LIGHTS.geojson'
    ]);
  });

  it('drops bands whose zooms fall outside the user range', () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'outside-'));
    writeFC(path.join(dir, 'COALNE__US1CO100.geojson'), [point({ band: 1 })]);
    writeFC(path.join(dir, 'COALNE__US5CO100.geojson'), [point({ band: 5 })]);
    assert.deepStrictEqual(describeSources(planTileSources(dir, 9, 16)), [
      'COALNE z12-16: COALNE__US5CO100.geojson'
    ]);
  });

  it('ignores the export error log and completion markers', () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'markers-'));
    writeFC(path.join(dir, 'LIGHTS__US5CO100.geojson'), [point({ x: 1 })]);
    fs.writeFileSync(path.join(dir, '.export-errors.log'), 'ERROR 1: something\n');
    fs.writeFileSync(path.join(dir, '.complete-US5CO100'), '');
    assert.strictEqual(planTileSources(dir, 9, 16).length, 1);
  });
});

describe('SKIP_LAYERS', () => {
  it('leaves out the S-57 records that are not chart features', () => {
    assert.deepStrictEqual([...SKIP_LAYERS].sort(), ['C_AGGR', 'C_ASSO', 'DSID', 'Generic']);
  });
});

describe('surfaceExportErrorsIfEmpty', () => {
  let tmp: string;
  const chartNumber = 'test-surface-empty';

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-charts-surface-'));
  });

  after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('surfaces a sample of captured errors when the geojson dir is empty', () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'errs-'));
    fs.writeFileSync(
      path.join(dir, '.export-errors.log'),
      'ERROR 4: Cannot open IENC profile\nERROR 4: Unrecognized S57 product\n'
    );
    surfaceExportErrorsIfEmpty(dir, chartNumber);
    const log = getConversionProgress(chartNumber)?.log ?? [];
    assert.ok(
      log.some((l) => l.includes('produced no usable GeoJSON layers')),
      'expected a "no usable layers" headline in the surfaced log'
    );
    assert.ok(
      log.some((l) => l.includes('Cannot open IENC profile')),
      'expected the captured GDAL error line to be surfaced verbatim'
    );
  });

  it('skips surfacing when usable geojson output exists', () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'ok-'));
    writeFC(path.join(dir, 'HRBFAC.geojson'), [point({ OBJL: 1 })]);
    fs.writeFileSync(
      path.join(dir, '.export-errors.log'),
      'ERROR 4: this should NOT be surfaced because output exists\n'
    );
    const skipChartNumber = 'test-surface-skip';
    surfaceExportErrorsIfEmpty(dir, skipChartNumber);
    assert.deepStrictEqual(getConversionProgress(skipChartNumber)?.log ?? [], []);
  });

  it('says so when the dir is empty AND no errors were captured', () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'missinglog-'));
    const noLogChartNumber = 'test-surface-nolog';
    surfaceExportErrorsIfEmpty(dir, noLogChartNumber);
    const log = getConversionProgress(noLogChartNumber)?.log ?? [];
    assert.ok(log.some((l) => l.includes('no per-file errors were captured')));
  });
});

describe('wantedMbtilesName', () => {
  it('uses the cleaned displayName when the catalog supplied one', () => {
    assert.strictEqual(
      wantedMbtilesName('1', 'Waddenzee met Diepte 2026 - Week 18'),
      'Waddenzee met Diepte 2026 - Week 18'
    );
  });

  it('trims surrounding whitespace from the displayName', () => {
    assert.strictEqual(wantedMbtilesName('1', '  Port of Rotterdam  '), 'Port of Rotterdam');
  });

  it('falls back to `S-57 <chartNumber>` when displayName is missing or blank', () => {
    assert.strictEqual(wantedMbtilesName('7', undefined), 'S-57 7');
    assert.strictEqual(wantedMbtilesName('7', '   '), 'S-57 7');
  });

  it('falls back to `S-57 ENC` when both chartNumber and displayName are empty', () => {
    assert.strictEqual(wantedMbtilesName('', undefined), 'S-57 ENC');
  });
});
