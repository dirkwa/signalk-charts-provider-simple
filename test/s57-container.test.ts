import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';

import { _testInternals, EXPORT_ERRORS_LOG } from '../dist/utils/s57-container.js';
import type { ConversionReport } from '../dist/utils/conversion-backend.js';
import { exportFileParts } from '../dist/utils/s57-band.js';

const {
  consolidateGeoJSONByLayer,
  scaminMinzoom,
  buildExportScript,
  bandClampedMaxzoom,
  buildLayerManifest,
  buildTippecanoeCommand,
  TIPPECANOE_LAYER_MANIFEST,
  surfaceExportErrorsIfEmpty,
  stampMbtilesName,
  stageCells
} = _testInternals;

/** A report that keeps what a toolchain logs. */
function collectingReport(): { report: ConversionReport; log: string[] } {
  const log: string[] = [];
  return {
    log,
    report: {
      log: (text) => {
        log.push(text);
      },
      progress: () => {},
      message: () => {},
      debug: () => {}
    }
  };
}

interface GeoJSONFeature {
  type: 'Feature';
  properties: Record<string, unknown>;
  geometry: { type: string; coordinates: unknown };
  tippecanoe?: Record<string, unknown>;
}
interface FeatureCollection {
  type: 'FeatureCollection';
  features: GeoJSONFeature[];
}

function writeFC(p: string, features: GeoJSONFeature[]): void {
  fs.writeFileSync(p, JSON.stringify({ type: 'FeatureCollection', features }));
}

function point(props: Record<string, unknown>, coords: [number, number] = [0, 0]): GeoJSONFeature {
  return { type: 'Feature', properties: props, geometry: { type: 'Point', coordinates: coords } };
}

describe('consolidateGeoJSONByLayer', () => {
  let tmp: string;

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-charts-consolidate-'));
  });

  after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('preserves S-57 layer names that contain underscores (M_COVR, M_QUAL)', () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'm-layers-'));
    writeFC(path.join(dir, 'M_COVR__US3CO100.geojson'), [point({ kind: 'm-covr' })]);
    writeFC(path.join(dir, 'M_QUAL__US3CO100.geojson'), [point({ kind: 'm-qual' })]);
    writeFC(path.join(dir, 'M_NPUB__US3CO100.geojson'), [point({ kind: 'm-npub' })]);

    const merged = consolidateGeoJSONByLayer(dir, 9);
    const names = merged.map((m) => path.basename(m.file, '.geojson')).sort();
    assert.deepStrictEqual(names, ['M_COVR', 'M_NPUB', 'M_QUAL']);

    // Each merged file should contain exactly its own feature, not all three
    // smashed together.
    for (const { file } of merged) {
      const fc = JSON.parse(fs.readFileSync(file, 'utf8')) as FeatureCollection;
      assert.strictEqual(fc.features.length, 1, `${file} should hold one feature`);
    }
  });

  it('reads gzipped GeoJSON beside plain files, with the band from the name', () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'gz-'));
    writeFC(path.join(dir, 'BUAARE__US3CO100.geojson'), [point({ name: 'plain' })]);
    fs.writeFileSync(
      path.join(dir, 'BUAARE__US5CO200.geojson.gz'),
      zlib.gzipSync(
        JSON.stringify({ type: 'FeatureCollection', features: [point({ name: 'gz' })] })
      )
    );
    // An empty collection, gzipped: no layer of its own.
    fs.writeFileSync(
      path.join(dir, 'LNDARE__US5CO200.geojson.gz'),
      zlib.gzipSync(JSON.stringify({ type: 'FeatureCollection', features: [] }))
    );

    const merged = consolidateGeoJSONByLayer(dir, 9);
    assert.deepStrictEqual(
      merged.map((m) => path.basename(m.file, '.geojson')),
      ['BUAARE']
    );
    const fc = JSON.parse(fs.readFileSync(merged[0]!.file, 'utf8')) as FeatureCollection;
    const byName = new Map(fc.features.map((f) => [f.properties.name as string, f]));
    assert.deepStrictEqual([...byName.keys()].sort(), ['gz', 'plain']);
    // Band 5 (from US5CO200 in the gzipped file's name) starts at z12.
    assert.strictEqual(byName.get('gz')?.tippecanoe?.minzoom, 12);
  });

  it('reads the standard layer of cells whose names contain underscores', () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'underscore-cells-'));
    // A trailing `_` (live Dutch cells), an `_` before a digit, and a cell
    // whose name ends like a layer.
    writeFC(path.join(dir, 'DEPARE__IENC_Haven_Waspik_7_.geojson'), [point({ c: 'waspik' })]);
    writeFC(path.join(dir, 'LIGHTS__IENC_Haven_Waspik_7_.geojson'), [point({ c: 'waspik' })]);
    writeFC(path.join(dir, 'DEPARE__AB_CELL_01.geojson'), [point({ c: 'nl' })]);
    writeFC(path.join(dir, 'M_COVR__AB_M_COVR.geojson'), [point({ c: 'ab' })]);
    writeFC(path.join(dir, 'DEPARE__US5MA1SK.geojson'), [point({ c: 'us5' })]);

    const merged = consolidateGeoJSONByLayer(dir, 9);
    const byLayer = new Map(
      merged.map((m) => [
        path.basename(m.file, '.geojson'),
        (JSON.parse(fs.readFileSync(m.file, 'utf8')) as FeatureCollection).features
      ])
    );
    assert.deepStrictEqual([...byLayer.keys()].sort(), ['DEPARE', 'LIGHTS', 'M_COVR']);
    assert.deepStrictEqual(
      byLayer
        .get('DEPARE')
        ?.map((f) => f.properties.c)
        .sort(),
      ['nl', 'us5', 'waspik']
    );
    // Band 5 from the US cell's name still sets its features' minzoom.
    const us5 = byLayer.get('DEPARE')?.find((f) => f.properties.c === 'us5');
    assert.strictEqual(us5?.tippecanoe?.minzoom, 12);
  });

  it('merges multi-source layers across charts', () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'multi-'));
    writeFC(path.join(dir, 'BUAARE__US3CO100.geojson'), [point({ name: 'a' })]);
    writeFC(path.join(dir, 'BUAARE__US3CO200.geojson'), [point({ name: 'b' })]);
    writeFC(path.join(dir, 'BUAARE__US3CO400.geojson'), [point({ name: 'c' })]);

    const merged = consolidateGeoJSONByLayer(dir, 9);
    assert.strictEqual(merged.length, 1);
    assert.strictEqual(path.basename(merged[0]!.file, '.geojson'), 'BUAARE');

    const fc = JSON.parse(fs.readFileSync(merged[0]!.file, 'utf8')) as FeatureCollection;
    assert.strictEqual(fc.features.length, 3);
    const names = fc.features.map((f) => f.properties.name as string).sort();
    assert.deepStrictEqual(names, ['a', 'b', 'c']);
  });

  it('handles single-chart bundles where files are already named LAYER.geojson', () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'single-'));
    writeFC(path.join(dir, 'COALNE.geojson'), [point({ k: 'coalne' })]);
    writeFC(path.join(dir, 'M_COVR.geojson'), [point({ k: 'm-covr' })]);

    const merged = consolidateGeoJSONByLayer(dir, 9);
    const names = merged.map((m) => path.basename(m.file, '.geojson')).sort();
    assert.deepStrictEqual(names, ['COALNE', 'M_COVR']);

    // Output must be a real file, not a symlink — the caller bind-mounts only
    // the merged dir into the container, so a symlink to the parent geojsonDir
    // would dangle.
    for (const { file } of merged) {
      const lst = fs.lstatSync(file);
      assert.ok(!lst.isSymbolicLink(), `${file} must not be a symlink`);
      const fc = JSON.parse(fs.readFileSync(file, 'utf8')) as FeatureCollection;
      assert.strictEqual(fc.features.length, 1);
    }
  });

  it('skips empty files (size <= 100 bytes)', () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'empty-'));
    fs.writeFileSync(path.join(dir, 'EMPTY__US3CO100.geojson'), '{}');
    writeFC(path.join(dir, 'REAL__US3CO100.geojson'), [point({ k: 'real' })]);

    const merged = consolidateGeoJSONByLayer(dir, 9);
    const names = merged.map((m) => path.basename(m.file, '.geojson'));
    assert.deepStrictEqual(names, ['REAL']);
  });

  it('returns an empty array when there are no usable inputs', () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'none-'));
    const merged = consolidateGeoJSONByLayer(dir, 9);
    assert.deepStrictEqual(merged, []);
  });

  it('does not collapse M_COVR + M_QUAL into a single "M" layer in multi-chart bundles', () => {
    // Layer names hold single underscores (M_COVR, M_QUAL); the `__` separator
    // keeps them whole and distinct across multiple charts.
    const dir = fs.mkdtempSync(path.join(tmp, 'm-multi-'));
    writeFC(path.join(dir, 'M_COVR__US3CO100.geojson'), [point({ k: 'covr-100' })]);
    writeFC(path.join(dir, 'M_COVR__US3CO200.geojson'), [point({ k: 'covr-200' })]);
    writeFC(path.join(dir, 'M_QUAL__US3CO100.geojson'), [point({ k: 'qual-100' })]);
    writeFC(path.join(dir, 'M_QUAL__US3CO200.geojson'), [point({ k: 'qual-200' })]);

    const merged = consolidateGeoJSONByLayer(dir, 9);
    const names = merged.map((m) => path.basename(m.file, '.geojson')).sort();
    assert.deepStrictEqual(names, ['M_COVR', 'M_QUAL']);

    for (const { file } of merged) {
      const fc = JSON.parse(fs.readFileSync(file, 'utf8')) as FeatureCollection;
      assert.strictEqual(fc.features.length, 2);
    }
  });

  it('mixed-band bundles preserve harbour-tier layers from band-5 charts', () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'mixed-band-'));

    for (const chart of ['US3CO100', 'US3CO200', 'US5MA1SK']) {
      writeFC(path.join(dir, `LNDARE__${chart}.geojson`), [point({ src: chart })]);
      writeFC(path.join(dir, `DEPARE__${chart}.geojson`), [point({ src: chart })]);
      writeFC(path.join(dir, `COALNE__${chart}.geojson`), [point({ src: chart })]);
    }

    writeFC(path.join(dir, 'HRBFAC__US5MA1SK.geojson'), [point({ obj: 'harbour' })]);
    writeFC(path.join(dir, 'ACHARE__US5MA1SK.geojson'), [point({ obj: 'anchorage' })]);
    writeFC(path.join(dir, 'BRIDGE__US5MA1SK.geojson'), [point({ obj: 'bridge' })]);
    writeFC(path.join(dir, 'MORFAC__US5MA1SK.geojson'), [point({ obj: 'mooring' })]);
    writeFC(path.join(dir, 'PILBOP__US5MA1SK.geojson'), [point({ obj: 'pilot-boarding' })]);

    const merged = consolidateGeoJSONByLayer(dir, 9);
    const layerNames = new Set(merged.map((m) => path.basename(m.file, '.geojson')));

    for (const layer of ['LNDARE', 'DEPARE', 'COALNE']) {
      assert.ok(layerNames.has(layer), `bulk layer ${layer} should be merged`);
      const entry = merged.find((m) => m.file.endsWith(`${layer}.geojson`));
      assert.ok(entry);
      const fc = JSON.parse(fs.readFileSync(entry.file, 'utf8')) as FeatureCollection;
      assert.strictEqual(fc.features.length, 3, `${layer} should have 3 features (1 per chart)`);
    }

    for (const layer of ['HRBFAC', 'ACHARE', 'BRIDGE', 'MORFAC', 'PILBOP']) {
      assert.ok(
        layerNames.has(layer),
        `harbour-tier layer ${layer} from US5MA1SK must survive consolidation`
      );
    }
  });

  it('flattens GDAL list-type properties (COLOUR, STATUS, …) to comma-separated strings', () => {
    // GDAL emits S-57 multi-value attributes (COLOUR, STATUS, COLPAT, CATLIT,
    // CATSPM, QUASOU, …) as JSON arrays. MVT/tippecanoe can only carry scalar
    // property values, and would stringify the array as `["3"]` — breaking
    // client-side decoders that expect `"3"` or `"3,1"`. The consolidator
    // flattens any array-valued property to a comma-separated string so
    // downstream code sees a uniform shape.
    const dir = fs.mkdtempSync(path.join(tmp, 'flatten-'));
    writeFC(path.join(dir, 'BCNLAT.geojson'), [
      point({ COLOUR: ['3'], STATUS: ['1'], OBJNAM: 'X', SCAMIN: 29999 }),
      point({ COLOUR: ['3', '1', '3'], COLPAT: ['1'], OBJNAM: 'Y' }),
      point({ OBJNAM: 'no-array' })
    ]);

    const merged = consolidateGeoJSONByLayer(dir, 9);
    assert.strictEqual(merged.length, 1);
    const fc = JSON.parse(fs.readFileSync(merged[0]!.file, 'utf8')) as FeatureCollection;
    assert.strictEqual(fc.features[0]!.properties.COLOUR, '3');
    assert.strictEqual(fc.features[0]!.properties.STATUS, '1');
    assert.strictEqual(fc.features[0]!.properties.OBJNAM, 'X');
    assert.strictEqual(fc.features[0]!.properties.SCAMIN, 29999);
    assert.strictEqual(fc.features[1]!.properties.COLOUR, '3,1,3');
    assert.strictEqual(fc.features[1]!.properties.COLPAT, '1');
    assert.strictEqual(fc.features[2]!.properties.OBJNAM, 'no-array');
  });
  it('raises a feature minzoom to where its SCAMIN lets S-52 show it', () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'scamin-'));
    // Band 3 (US3…) floors at z8, below the requested z9.
    writeFC(path.join(dir, 'SOUNDG__US3LA1DC.geojson'), [
      point({ c: 'coastal', SCAMIN: 90000 }),
      point({ c: 'overview', SCAMIN: 1e9 }),
      point({ c: 'berth', SCAMIN: 1000 }),
      point({ c: 'none' })
    ]);
    // No band in the name: no floor of its own.
    writeFC(path.join(dir, 'LIGHTS__handnamed.geojson'), [
      point({ c: 'unbanded', SCAMIN: 90000 }),
      point({ c: 'unbanded-none' })
    ]);

    const merged = consolidateGeoJSONByLayer(dir, 9, 14);
    const minzoomOf = new Map(
      merged.flatMap((m) =>
        (JSON.parse(fs.readFileSync(m.file, 'utf8')) as FeatureCollection).features.map((f) => [
          f.properties.c,
          f.tippecanoe?.minzoom
        ])
      )
    );
    assert.strictEqual(minzoomOf.get('coastal'), 13);
    assert.strictEqual(minzoomOf.get('overview'), 9, 'never below the requested minzoom');
    assert.strictEqual(minzoomOf.get('berth'), 14, 'capped at maxzoom so overzoom still shows it');
    assert.strictEqual(minzoomOf.get('none'), 9);
    assert.strictEqual(minzoomOf.get('unbanded'), 13);
    assert.strictEqual(minzoomOf.get('unbanded-none'), undefined);
  });
});

describe('scaminMinzoom', () => {
  const at = (scamin: unknown, coordinates: unknown): number | null =>
    scaminMinzoom({ type: 'Feature', properties: { SCAMIN: scamin }, geometry: { coordinates } });

  it('gives the first zoom whose scale reaches 1:SCAMIN', () => {
    // On the equator z12 is 1:136,495 and z13 is 1:68,247.
    assert.strictEqual(at(90000, [0, 0]), 13);
    assert.strictEqual(at(136500, [0, 0]), 12);
    assert.strictEqual(at(1_000_000, [0, 0]), 10);
  });

  it('accounts for the mercator scale shrinking with latitude', () => {
    // At 60° a tile shows half the ground distance, so one zoom earlier.
    assert.strictEqual(at(90000, [10, 60]), 12);
    assert.strictEqual(at(90000, [10, -60]), 12);
  });

  it('takes the position farthest from the equator, so no part of the feature is cut', () => {
    // A line from 0° to 60°: its 60° end qualifies at z12, the equator end only at z13.
    assert.strictEqual(
      at(90000, [
        [10, 0],
        [10, 60]
      ]),
      12
    );
    assert.strictEqual(
      at(90000, [
        [
          [10, 0],
          [10, -60],
          [11, 0],
          [10, 0]
        ]
      ]),
      12
    );
  });

  it('reads the positions of lines, polygons and 3D sounding points', () => {
    assert.strictEqual(
      at(90000, [
        [
          [10, 60],
          [11, 61]
        ]
      ]),
      12
    );
    assert.strictEqual(at(90000, [[10, 60, 4.2]]), 12);
  });

  it('takes a numeric string, ignores missing, zero or unparseable values', () => {
    assert.strictEqual(at('90000', [0, 0]), 13);
    assert.strictEqual(at(undefined, [0, 0]), null);
    assert.strictEqual(at(0, [0, 0]), null);
    assert.strictEqual(at('n/a', [0, 0]), null);
    assert.strictEqual(at(90000, []), null);
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

  it('multi-file=true emits LAYER__<chart> output names; multi-file=false emits LAYER', () => {
    const multi = buildExportScript({ multiFile: true, parallelism: 1, skipLayers });
    assert.match(multi, /outname="\$\{layer\}__\$\{name\}"/);
    const single = buildExportScript({ multiFile: false, parallelism: 1, skipLayers });
    // Single-file path keeps just $layer in the outname assignment.
    assert.match(single, /outname="\$\{layer\}"/);
    // The parallel inner shell picks the name from its `multi` argument.
    const parallel = buildExportScript({ multiFile: true, parallelism: 4, skipLayers });
    assert.match(
      parallel,
      /if \[ "\$multi" = "1" \]; then outname="\$\{layer\}__\$\{name\}"; else outname="\$layer"; fi/
    );
  });

  // The script runs in the GDAL container, so it is run here only where
  // the temp dir has POSIX paths.
  it(
    'writes files the merge parses back into layer and cell, in both branches',
    { skip: process.platform === 'win32' && 'needs POSIX paths' },
    () => {
      if (spawnSync('bash', ['--version']).status !== 0) {
        return;
      }
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 's57-export-run-'));
      try {
        // Stand-ins for GDAL: two layers per cell, and an empty output file.
        const bin = path.join(root, 'bin');
        fs.mkdirSync(bin);
        fs.writeFileSync(
          path.join(bin, 'ogrinfo'),
          '#!/bin/bash\necho "1: DEPARE (Polygon)"\necho "2: M_COVR (Polygon)"\n',
          { mode: 0o755 }
        );
        fs.writeFileSync(
          path.join(bin, 'ogr2ogr'),
          '#!/bin/bash\nfor a in "$@"; do case "$a" in *.geojson) : > "$a";; esac; done\n',
          { mode: 0o755 }
        );
        const cells = ['IENC_Haven_Waspik_7_', 'US5MA1SK', '_LEADING'];
        for (const parallelism of [1, 4]) {
          const input = path.join(root, `in-${String(parallelism)}`);
          const output = path.join(root, `out-${String(parallelism)}`);
          fs.mkdirSync(path.join(input, 'ENC_ROOT'), { recursive: true });
          fs.mkdirSync(output);
          for (const cell of cells) {
            fs.writeFileSync(path.join(input, 'ENC_ROOT', `${cell}.000`), '');
          }
          const script = buildExportScript({
            multiFile: true,
            parallelism,
            skipLayers,
            inputPrefix: input,
            outputPrefix: output
          });
          const result = spawnSync('bash', ['-c', script], {
            env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` }
          });
          assert.strictEqual(result.status, 0, result.stderr.toString());
          const parsed = fs
            .readdirSync(output)
            .filter((f) => f.endsWith('.geojson'))
            .map((f) => exportFileParts(f))
            .sort((a, b) => `${a.cell ?? ''}${a.layer}`.localeCompare(`${b.cell ?? ''}${b.layer}`));
          const expected = cells
            .flatMap((cell) => ['DEPARE', 'M_COVR'].map((layer) => ({ layer, cell })))
            .sort((a, b) => `${a.cell}${a.layer}`.localeCompare(`${b.cell}${b.layer}`));
          assert.deepStrictEqual(parsed, expected, `parallelism ${String(parallelism)}`);
        }
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  );

  it('passes enc / name / multi to the parallel inner shell as positional args, not interpolated', () => {
    // Defence-in-depth: the parallel branch must invoke `sh -c '...' _ '{}' "$enc" "$name"
    // "<multi>"` so chart names with shell metacharacters can't escape the command.
    const s = buildExportScript({ multiFile: true, parallelism: 4, skipLayers });
    assert.match(s, /sh -c [\s\S]*' _ '\{\}' "\$enc" "\$name" "1"/);
  });

  it('marks a cell complete only when asked, and only when nothing failed', () => {
    for (const parallelism of [1, 4]) {
      const marked = buildExportScript({
        multiFile: true,
        parallelism,
        skipLayers: ['DSID'],
        markComplete: true
      });
      assert.match(marked, /if \[ "\$failed" = 0 \]; then : > "\/output\/\.complete-\$name"; fi/);
      assert.match(marked, /\|\| failed=1/);
      const plain = buildExportScript({ multiFile: true, parallelism, skipLayers: ['DSID'] });
      assert.doesNotMatch(plain, /\.complete-/);
    }
  });

  it('keeps the skip-layer pattern in both branches', () => {
    const seq = buildExportScript({ multiFile: false, parallelism: 1, skipLayers });
    const par = buildExportScript({ multiFile: false, parallelism: 4, skipLayers });
    for (const layer of skipLayers) {
      assert.ok(seq.includes(layer), `sequential branch missing skip layer ${layer}`);
      assert.ok(par.includes(layer), `parallel branch missing skip layer ${layer}`);
    }
  });

  it('redirects per-file ogr2ogr stderr to the export error log in both branches', () => {
    // Regression for charts where every per-file ogr2ogr call failed
    // (e.g. IENC bundles on a GDAL build without inland S-57 support):
    // the previous `2>/dev/null` swallowed the error so the user only
    // saw a confusing downstream "No valid GeoJSON layers" message.
    const seq = buildExportScript({ multiFile: false, parallelism: 1, skipLayers });
    const par = buildExportScript({ multiFile: true, parallelism: 4, skipLayers });
    assert.match(seq, new RegExp(`2>>${EXPORT_ERRORS_LOG.replace(/\//g, '\\/')}`));
    assert.match(par, new RegExp(`2>>${EXPORT_ERRORS_LOG.replace(/\//g, '\\/')}`));
    assert.doesNotMatch(seq, /2>\/dev\/null/);
    assert.doesNotMatch(par, /2>\/dev\/null/);
  });

  it('initializes the error log with `: > <path>` so a stale log from a prior run is cleared', () => {
    const s = buildExportScript({ multiFile: false, parallelism: 1, skipLayers });
    assert.match(s, new RegExp(`: > ${EXPORT_ERRORS_LOG.replace(/\//g, '\\/')}`));
  });

  it('threads inputPrefix / outputPrefix through both branches for named-volume deployments', () => {
    // When SignalK is on a named volume that covers a parent directory,
    // the runtime layer mounts the whole volume at /input and /output;
    // the consumer points the script at the actual subpath inside.
    // Both branches must read from inputPrefix and write to outputPrefix
    // (including the per-file error log).
    const seq = buildExportScript({
      multiFile: false,
      parallelism: 1,
      skipLayers,
      inputPrefix: '/input/charts/scratch',
      outputPrefix: '/output/charts/scratch'
    });
    const par = buildExportScript({
      multiFile: true,
      parallelism: 4,
      skipLayers,
      inputPrefix: '/input/charts/scratch',
      outputPrefix: '/output/charts/scratch'
    });
    for (const s of [seq, par]) {
      assert.match(s, /find \/input\/charts\/scratch -name '\*\.000'/);
      assert.match(s, /\/output\/charts\/scratch\/\$/);
      assert.match(s, /2>>\/output\/charts\/scratch\/\.export-errors\.log/);
      // Defaults must NOT leak through when prefixes are set.
      assert.doesNotMatch(s, /find \/input -name/);
    }
  });

  it('parses cleanly under `bash -n` (regression: read -d is bash-only)', () => {
    // The script uses `read -r -d ''` to consume `find -print0` output
    // safely, which is a bash-ism; dash (Ubuntu's /bin/sh) rejects
    // `-d` as illegal.  This test runs `bash -n` on both branches as
    // a parse check — catches a regression where someone changes the
    // converter back to invoke `sh -c` instead of `bash -c`, or
    // introduces a different bash-only construct.  Skip if the test
    // host has no bash (rare; CI runners and dev boxes all have it).
    const which = spawnSync('bash', ['--version']);
    if (which.status !== 0) {
      // No bash on this host; skip rather than fail.
      return;
    }
    for (const params of [
      { multiFile: false, parallelism: 1 },
      { multiFile: true, parallelism: 4 },
      { multiFile: true, parallelism: 1, inputPrefix: '/input/sub', outputPrefix: '/output/sub' }
    ]) {
      const script = buildExportScript({ ...params, skipLayers });
      const tmp = path.join(os.tmpdir(), `s57-export-script-${Date.now()}-${Math.random()}.sh`);
      fs.writeFileSync(tmp, script);
      try {
        const result = spawnSync('bash', ['-n', tmp]);
        assert.strictEqual(
          result.status,
          0,
          `bash -n failed for params=${JSON.stringify(params)}:\n${result.stderr.toString()}`
        );
      } finally {
        try {
          fs.unlinkSync(tmp);
        } catch {
          // ignore
        }
      }
    }
  });
});

describe('surfaceExportErrorsIfEmpty', () => {
  let tmp: string;

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
    const { report, log } = collectingReport();
    surfaceExportErrorsIfEmpty(dir, report);
    assert.ok(
      log.some((l) => l.includes('produced no usable GeoJSON layers')),
      'expected a "no usable layers" headline in the surfaced log'
    );
    assert.ok(
      log.some((l) => l.includes('Cannot open IENC profile')),
      'expected the captured ogr2ogr error line to be surfaced verbatim'
    );
  });

  it('skips surfacing when usable geojson output exists', () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'ok-'));
    // A real-feature-bearing GeoJSON file is well over the 100-byte
    // threshold, so the helper should treat it as "we have output" and
    // leave the conversion log alone.
    fs.writeFileSync(
      path.join(dir, 'HRBFAC.geojson'),
      JSON.stringify({
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            properties: { OBJL: 1 },
            geometry: { type: 'Point', coordinates: [0, 0] }
          }
        ]
      })
    );
    fs.writeFileSync(
      path.join(dir, '.export-errors.log'),
      'ERROR 4: this should NOT be surfaced because output exists\n'
    );
    const { report, log } = collectingReport();
    surfaceExportErrorsIfEmpty(dir, report);
    assert.deepStrictEqual(
      log,
      [],
      'no log lines should be surfaced when usable output is present'
    );
  });

  it('reports a chart-path/SELinux hint when the dir is empty AND the error log is missing', () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'missinglog-'));
    const { report, log } = collectingReport();
    surfaceExportErrorsIfEmpty(dir, report);
    assert.ok(
      log.some((l) => l.includes('SELinux/AppArmor')),
      'expected the missing-log diagnostic when no errors were captured'
    );
  });
});

// Smoke that the helper is reachable through s57-container's _testInternals
// (the deeper coverage lives in test/s57-band.test.ts — this just confirms
// the single-pass tippecanoe wiring uses the same export the test suite does).
describe('bandClampedMaxzoom (re-export from s57-container._testInternals)', () => {
  it('clamps an AQ_ENCs-style band-3 bundle to z12', () => {
    const r = bandClampedMaxzoom(
      ['US3CO100.000', 'US3CO200.000', 'US3CO300.000', 'US3CO400.000'],
      16
    );
    assert.strictEqual(r.effective, 12);
    assert.strictEqual(r.highestBand, 3);
  });

  it('IENC fallback preserves user maxzoom (regression guard for the single-pass pipeline)', () => {
    const r = bandClampedMaxzoom(['IENC_PASS_001.000'], 16);
    assert.strictEqual(r.effective, 16);
    assert.strictEqual(r.highestBand, null);
  });
});

describe('buildLayerManifest (newline-delimited NAME:FILE form)', () => {
  it('emits one LAYER:/input/LAYER.geojson line per consolidated layer', () => {
    const layers = [
      { file: '/some/host/path/HRBFAC.geojson', sourceFiles: ['HRBFAC__US5MA1SK.geojson'] },
      { file: '/some/host/path/LNDARE.geojson', sourceFiles: ['LNDARE__US3CO100.geojson'] }
    ];
    assert.strictEqual(
      buildLayerManifest(layers),
      'HRBFAC:/input/HRBFAC.geojson\nLNDARE:/input/LNDARE.geojson\n'
    );
  });

  it('uses the layer name from the merged file basename', () => {
    const layers = [
      { file: '/anywhere/M_COVR.geojson', sourceFiles: ['M_COVR__US5MA1SK.geojson'] }
    ];
    assert.strictEqual(buildLayerManifest(layers), 'M_COVR:/input/M_COVR.geojson\n');
  });

  it('uses a custom inputPrefix for named-volume deployments', () => {
    // signalk-container resolves a named-volume mount: the whole volume is
    // mounted at /input and the consumer must navigate to the merged-GeoJSON
    // dir via its subPath.  buildLayerManifest threads that into each line.
    const layers = [
      { file: '/some/host/path/HRBFAC.geojson', sourceFiles: ['HRBFAC__US5MA1SK.geojson'] }
    ];
    assert.strictEqual(
      buildLayerManifest(layers, '/input/charts/scratch/.merged'),
      'HRBFAC:/input/charts/scratch/.merged/HRBFAC.geojson\n'
    );
  });
});

describe('buildTippecanoeCommand (argv stays small regardless of layer count)', () => {
  it('returns a 3-element bash -c command that reads -L pairs from the manifest', () => {
    const cmd = buildTippecanoeCommand(['-o', '/output/out.mbtiles', '-z', '14'], '/input/.layers');
    assert.strictEqual(cmd.length, 3);
    assert.strictEqual(cmd[0], 'bash');
    assert.strictEqual(cmd[1], '-c');
    // Reads the manifest (quoted), assembles -L args, runs tippecanoe.
    assert.match(cmd[2], /< '\/input\/\.layers'/);
    assert.match(cmd[2], /layers\+=\(-L "\$line"\)/);
    assert.match(cmd[2], /tippecanoe '-o' '\/output\/out\.mbtiles' '-z' '14' "\$\{layers\[@\]\}"/);
  });

  // The toolbox container's fixed UID owns whatever tippecanoe writes; a
  // trailing chmod (run while still that UID) is what lets the host
  // SignalK process — commonly a different UID — write to it afterward
  // (e.g. the post-conversion metadata patch).
  it('chmods the -o output path after tippecanoe runs, not before (no exec)', () => {
    const cmd = buildTippecanoeCommand(['-o', '/output/out.mbtiles', '-z', '14'], '/input/.layers');
    assert.doesNotMatch(cmd[2], /exec tippecanoe/);
    const lines = cmd[2].split('\n');
    const tippecanoeLine = lines.findIndex((l: string) => l.includes('tippecanoe '));
    const chmodLine = lines.findIndex((l: string) => l.includes('chmod 666'));
    assert.ok(tippecanoeLine >= 0 && chmodLine >= 0);
    assert.ok(chmodLine > tippecanoeLine, 'chmod must run after tippecanoe, not before');
    assert.match(lines[chmodLine], /chmod 666 '\/output\/out\.mbtiles'/);
  });

  it('keeps argv length constant whether there are 2 or 200 layers', () => {
    const small = buildTippecanoeCommand(['-o', '/output/out.mbtiles'], '/input/.layers');
    // The manifest path is the only layer-derived input; the command is fixed.
    assert.strictEqual(small.length, 3);
  });

  it('shell-quotes fixed args so paths with spaces survive', () => {
    const cmd = buildTippecanoeCommand(['-o', '/out put/x.mbtiles'], '/input/.layers');
    assert.match(cmd[2], /'\/out put\/x\.mbtiles'/);
  });

  // The actual #151 leak prevention: an explicit `-n NAME` stops tippecanoe
  // from defaulting the `name` metadata row to the `-o` container path.
  it('passes a baked `-n NAME` through (with spaces) so the name is never the /output/ path', () => {
    const cmd = buildTippecanoeCommand(
      ['-o', '/output/0.mbtiles', '-n', 'Waddenzee met Diepte 2026 - Week 18'],
      '/input/.layers'
    );
    assert.match(cmd[2], /'-n' 'Waddenzee met Diepte 2026 - Week 18'/);
  });

  // A hostile chart title must not break out of the single-quoted argv.
  it('single-quote-escapes a name containing a quote and shell metacharacters', () => {
    const cmd = buildTippecanoeCommand(
      ['-o', '/output/0.mbtiles', '-n', `evil'; rm -rf / #`],
      '/input/.layers'
    );
    // The POSIX escape closes the quote, emits an escaped quote, reopens:
    // evil'\''; rm -rf / # — so the metacharacters stay inside one literal arg.
    assert.match(cmd[2], /'-n' 'evil'\\''; rm -rf \/ #'/);
  });

  it('quotes the manifest path so a named-volume subPath with spaces works', () => {
    const cmd = buildTippecanoeCommand(['-o', '/output/out.mbtiles'], '/input/My Charts/.layers');
    assert.match(cmd[2], /done < '\/input\/My Charts\/\.layers'/);
  });

  it('exports TIPPECANOE_LAYER_MANIFEST', () => {
    assert.ok(
      typeof TIPPECANOE_LAYER_MANIFEST === 'string' && TIPPECANOE_LAYER_MANIFEST.length > 0
    );
  });
});

describe('stampMbtilesName (degenerate single-input tile-join path)', () => {
  let tmp: string;

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-charts-stamp-name-'));
  });

  after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  // Build a minimal tippecanoe-shaped metadata table whose `name` row is the
  // leaked container path, then assert stampMbtilesName overwrites it cleanly.
  function makeMbtiles(name: string): string {
    const file = path.join(tmp, `${name.replace(/\W+/g, '_')}.mbtiles`);
    const db = new DatabaseSync(file);
    db.exec('CREATE TABLE metadata (name TEXT, value TEXT)');
    db.prepare('INSERT INTO metadata (name, value) VALUES (?, ?)').run('name', name);
    db.close();
    return file;
  }

  function readName(file: string): string | null {
    const db = new DatabaseSync(file);
    const row = db.prepare("SELECT value FROM metadata WHERE name = 'name'").get() as
      { value: string } | undefined;
    db.close();
    return row ? row.value : null;
  }

  it('overwrites the leaked /output/ name with the wanted name', () => {
    const file = makeMbtiles('/output/Waddenzee.mbtiles');
    stampMbtilesName(file, 'Waddenzee met Diepte 2026 - Week 18');
    assert.strictEqual(readName(file), 'Waddenzee met Diepte 2026 - Week 18');
  });

  it('leaves exactly one name row (no duplicate from append-style writes)', () => {
    const file = makeMbtiles('/output/x.mbtiles');
    stampMbtilesName(file, 'S-57 3');
    const db = new DatabaseSync(file);
    const row = db.prepare("SELECT COUNT(*) AS n FROM metadata WHERE name = 'name'").get() as {
      n: number;
    };
    db.close();
    assert.strictEqual(row.n, 1);
  });

  it('never throws on a missing file (best-effort contract)', () => {
    assert.doesNotThrow(() => {
      stampMbtilesName(path.join(tmp, 'does-not-exist.mbtiles'), 'whatever');
    });
  });
});

describe('per-feature tippecanoe.minzoom stamping (band-aware consolidation)', () => {
  let tmp: string;

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-charts-feat-minzoom-'));
  });

  after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function readFeatures(file: string): GeoJSONFeature[] {
    const fc = JSON.parse(fs.readFileSync(file, 'utf8')) as FeatureCollection;
    return fc.features;
  }

  it('stamps tippecanoe.minzoom = BAND_MIN_ZOOM[5] = 12 on band-5 features', () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'b5-'));
    writeFC(path.join(dir, 'HRBFAC__US5MA1SK.geojson'), [point({ obj: 'harbour' })]);
    const merged = consolidateGeoJSONByLayer(dir, /* userMinzoom */ 9);
    const entry = merged.find((m) => m.file.endsWith('HRBFAC.geojson'));
    assert.ok(entry);
    const fc = readFeatures(entry.file);
    assert.strictEqual(fc.length, 1);
    assert.strictEqual(fc[0]!.tippecanoe?.minzoom, 12);
  });

  it('stamps per-source band, not per-merged-layer max — multi-band layers get mixed minzoom', () => {
    // LNDARE features from a band-3 chart and a band-5 chart end up in the
    // same merged file. Each feature carries the floor for its own source
    // chart, so band-3 features can emit at z9 (= max(user 9, band-3 floor 8))
    // while band-5 features only emit from z12. This is *better* than a
    // layer-wide floor: the band-3 LNDARE outline is visible at z9 while
    // band-5 detail kicks in at z12.
    const dir = fs.mkdtempSync(path.join(tmp, 'mixed-'));
    writeFC(path.join(dir, 'LNDARE__US3CO100.geojson'), [point({ src: 'b3' })]);
    writeFC(path.join(dir, 'LNDARE__US5MA1SK.geojson'), [point({ src: 'b5' })]);
    const merged = consolidateGeoJSONByLayer(dir, /* userMinzoom */ 9);
    const fc = readFeatures(merged[0]!.file);
    assert.strictEqual(fc.length, 2);
    const b3 = fc.find((f) => f.properties.src === 'b3');
    const b5 = fc.find((f) => f.properties.src === 'b5');
    assert.ok(b3);
    assert.ok(b5);
    assert.strictEqual(b3.tippecanoe?.minzoom, 9, 'band-3 floor 8 < user 9 → user wins');
    assert.strictEqual(b5.tippecanoe?.minzoom, 12, 'band-5 floor 12 > user 9 → band wins');
  });

  it('respects userMinzoom as a floor (never goes below user-asked)', () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'user-floor-'));
    writeFC(path.join(dir, 'HRBFAC__US5MA1SK.geojson'), [point({ obj: 'harbour' })]);
    const merged = consolidateGeoJSONByLayer(dir, /* userMinzoom */ 14);
    const fc = readFeatures(merged[0]!.file);
    assert.strictEqual(fc[0]!.tippecanoe?.minzoom, 14, 'user 14 > band-5 floor 12 → user wins');
  });

  it('does NOT stamp tippecanoe.minzoom on features from non-conforming sources', () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'ienc-'));
    writeFC(path.join(dir, 'HRBFAC_IENC_AREA.geojson'), [point({ obj: 'harbour' })]);
    const merged = consolidateGeoJSONByLayer(dir, /* userMinzoom */ 9);
    const fc = readFeatures(merged[0]!.file);
    assert.strictEqual(
      fc[0]!.tippecanoe,
      undefined,
      'IENC features fall back to the global -Z, no per-feature override'
    );
  });

  it('preserves any pre-existing tippecanoe.* extension fields', () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'preserve-'));
    const feat: GeoJSONFeature = {
      ...point({ obj: 'harbour' }),
      tippecanoe: { layer: 'override', maxzoom: 18 }
    };
    fs.writeFileSync(
      path.join(dir, 'HRBFAC__US5MA1SK.geojson'),
      JSON.stringify({ type: 'FeatureCollection', features: [feat] })
    );
    const merged = consolidateGeoJSONByLayer(dir, 9);
    const out = readFeatures(merged[0]!.file)[0]!;
    assert.strictEqual(out.tippecanoe?.minzoom, 12, 'minzoom added');
    assert.strictEqual(out.tippecanoe?.maxzoom, 18, 'pre-existing maxzoom preserved');
    assert.strictEqual(out.tippecanoe?.layer, 'override', 'pre-existing layer preserved');
  });
});

describe('stageCells (the cells a container export sees)', () => {
  let tmp: string;

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-charts-stage-'));
  });

  after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('stages each cell with its update files, flat, and nothing else', () => {
    const a = path.join(tmp, 'src', 'ENC_ROOT', 'US5MA1SK');
    const b = path.join(tmp, 'elsewhere');
    fs.mkdirSync(a, { recursive: true });
    fs.mkdirSync(b, { recursive: true });
    for (const name of ['US5MA1SK.000', 'US5MA1SK.001', 'US5MA1SK.002', 'US5MA1SK.TXT']) {
      fs.writeFileSync(path.join(a, name), name);
    }
    fs.writeFileSync(path.join(a, 'US5MA2SK.001'), 'another cell');
    fs.writeFileSync(path.join(b, 'US4MA1AA.000'), 'base');
    const dest = path.join(tmp, 'staged');
    stageCells([path.join(a, 'US5MA1SK.000'), path.join(b, 'US4MA1AA.000')], dest);
    assert.deepStrictEqual(fs.readdirSync(dest).sort(), [
      'US4MA1AA.000',
      'US5MA1SK.000',
      'US5MA1SK.001',
      'US5MA1SK.002'
    ]);
    assert.strictEqual(fs.readFileSync(path.join(dest, 'US5MA1SK.002'), 'utf8'), 'US5MA1SK.002');
  });

  it("stages an update named in another case under the cell's name", () => {
    const dir = path.join(tmp, 'mixed-case');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'US5MA3SK.000'), 'base');
    fs.writeFileSync(path.join(dir, 'us5ma3sk.001'), 'lower-case update');
    const dest = path.join(tmp, 'staged-mixed');
    stageCells([path.join(dir, 'US5MA3SK.000')], dest);
    assert.deepStrictEqual(fs.readdirSync(dest).sort(), ['US5MA3SK.000', 'US5MA3SK.001']);
    assert.strictEqual(
      fs.readFileSync(path.join(dest, 'US5MA3SK.001'), 'utf8'),
      'lower-case update'
    );
  });

  it('keeps the update named like the cell when another differs only in case', (t) => {
    const dir = path.join(tmp, 'both-cases');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'us5ma4sk.001'), 'lower-case update');
    if (fs.existsSync(path.join(dir, 'US5MA4SK.001'))) {
      t.skip('the file system ignores case');
      return;
    }
    fs.writeFileSync(path.join(dir, 'US5MA4SK.000'), 'base');
    fs.writeFileSync(path.join(dir, 'US5MA4SK.001'), 'exact update');
    fs.writeFileSync(path.join(dir, 'us5ma4sk.002'), 'second');
    fs.writeFileSync(path.join(dir, 'Us5Ma4Sk.002'), 'second, other case');
    const dest = path.join(tmp, 'staged-both');
    stageCells([path.join(dir, 'US5MA4SK.000')], dest);
    assert.deepStrictEqual(fs.readdirSync(dest).sort(), [
      'US5MA4SK.000',
      'US5MA4SK.001',
      'US5MA4SK.002'
    ]);
    assert.strictEqual(fs.readFileSync(path.join(dest, 'US5MA4SK.001'), 'utf8'), 'exact update');
    // Neither is named like the cell: the first in sorted order.
    assert.strictEqual(
      fs.readFileSync(path.join(dest, 'US5MA4SK.002'), 'utf8'),
      'second, other case'
    );
  });
});
