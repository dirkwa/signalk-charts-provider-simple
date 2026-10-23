/**
 * Tests for the per-set cell cache (`chart-set-cache.ts`): what a run does
 * with each cell, how a cell is committed, and what is cleaned up.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import {
  CELL_EXPORT_REVISION,
  cachedGeojsonFor,
  cellsDir,
  commitCells,
  createStagingDir,
  initChartSetCache,
  planCellCache,
  pruneSetCache,
  readSetCache,
  removeSetCache,
  setCacheBytes,
  sweepChartSetCache,
  type CachedCellInfo
} from '../dist/utils/chart-set-cache.js';
import type { PlannedCell } from '../dist/utils/enc-chart-set.js';

function planned(name: string, version: string | undefined): PlannedCell {
  return {
    name,
    source: 'S',
    archive: `https://example.org/${name}.zip`,
    archiveKind: 'zip',
    path: `${name}.000`,
    version,
    updates: []
  };
}

describe('planCellCache', () => {
  const cached = new Map<string, CachedCellInfo>([
    ['SAME0001', { version: 'SAME0001_ED001_UP002', exportRevision: CELL_EXPORT_REVISION }],
    ['NEWV0001', { version: 'NEWV0001_ED001_UP000', exportRevision: CELL_EXPORT_REVISION }],
    ['OLDREV01', { version: 'OLDREV01_ED001_UP000', exportRevision: CELL_EXPORT_REVISION - 1 }],
    ['NOVER001', { version: undefined, exportRevision: CELL_EXPORT_REVISION }]
  ]);

  it('reuses unchanged cells and downloads new or changed ones', () => {
    const plan = planCellCache(
      [
        planned('SAME0001', 'SAME0001_ED001_UP002'),
        planned('NEWV0001', 'NEWV0001_ED001_UP001'),
        planned('OLDREV01', 'OLDREV01_ED001_UP000'),
        planned('ABSENT01', 'ABSENT01_ED001_UP000'),
        planned('NOVER001', undefined)
      ],
      cached
    );
    assert.deepStrictEqual(
      plan.reuse.map((c) => c.name),
      ['SAME0001']
    );
    assert.deepStrictEqual(
      plan.reexport.map((c) => c.name),
      ['OLDREV01']
    );
    assert.deepStrictEqual(
      plan.download.map((c) => c.name),
      ['NEWV0001', 'ABSENT01', 'NOVER001']
    );
  });

  it('downloads everything for a set saved before the cache existed', () => {
    const plan = planCellCache([planned('A1B2C3D4', 'A1B2C3D4_ED001_UP000')], new Map());
    assert.strictEqual(plan.download.length, 1);
    assert.strictEqual(plan.reuse.length, 0);
  });
});

describe('the cache on disk', () => {
  let dataDir = '';

  before(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chart-set-cache-'));
    initChartSetCache(dataDir, () => {});
  });

  after(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  /** A staged cell and the GDAL output an export would write for it. */
  function stage(staging: string, name: string, layers: string[], extraUpdate = false): string {
    const raw = path.join(staging, 'enc', name);
    fs.mkdirSync(raw, { recursive: true });
    fs.writeFileSync(path.join(raw, `${name}.000`), `base ${name}`);
    if (extraUpdate) {
      fs.writeFileSync(path.join(raw, `${name}.001`), `update ${name}`);
    }
    const out = path.join(staging, 'export-out');
    fs.mkdirSync(out, { recursive: true });
    for (const layer of layers) {
      fs.writeFileSync(
        path.join(out, `${layer}_${name}.geojson`),
        `{"layer":"${layer}","cell":"${name}"}`
      );
    }
    return raw;
  }

  it('commits each cell with its raw files, gzipped GDAL output and version', async () => {
    const staging = createStagingDir('Set_A');
    const rawA = stage(staging, 'AA1CELL1', ['DEPARE', 'M_COVR'], true);
    const rawB = stage(staging, 'AA1CELL2', ['DEPARE']);
    const committed = await commitCells('Set_A', staging, path.join(staging, 'export-out'), [
      { name: 'AA1CELL1', rawDir: rawA, version: 'AA1CELL1_ED001_UP001' },
      { name: 'AA1CELL2', rawDir: rawB, version: 'AA1CELL2_ED002_UP000' }
    ]);
    assert.deepStrictEqual(committed, ['AA1CELL1', 'AA1CELL2']);

    const cell = path.join(cellsDir('Set_A'), 'AA1CELL1');
    assert.deepStrictEqual(fs.readdirSync(path.join(cell, 'raw')).sort(), [
      'AA1CELL1.000',
      'AA1CELL1.001'
    ]);
    assert.deepStrictEqual(fs.readdirSync(path.join(cell, 'geojson')).sort(), [
      'DEPARE_AA1CELL1.geojson.gz',
      'M_COVR_AA1CELL1.geojson.gz'
    ]);
    const text = zlib
      .gunzipSync(fs.readFileSync(path.join(cell, 'geojson', 'DEPARE_AA1CELL1.geojson.gz')))
      .toString('utf8');
    assert.strictEqual(text, '{"layer":"DEPARE","cell":"AA1CELL1"}');

    const cache = readSetCache('Set_A');
    assert.deepStrictEqual(cache.get('AA1CELL1'), {
      version: 'AA1CELL1_ED001_UP001',
      exportRevision: CELL_EXPORT_REVISION
    });
    assert.strictEqual(cache.get('AA1CELL2')?.version, 'AA1CELL2_ED002_UP000');
    assert.ok(setCacheBytes('Set_A') > 0);
    fs.rmSync(staging, { recursive: true, force: true });
  });

  it('replaces a cell only with a complete new copy', async () => {
    const staging = createStagingDir('Set_A');
    const raw = stage(staging, 'AA1CELL1', ['SOUNDG']);
    await commitCells('Set_A', staging, path.join(staging, 'export-out'), [
      { name: 'AA1CELL1', rawDir: raw, version: 'AA1CELL1_ED002_UP000' }
    ]);
    const cell = path.join(cellsDir('Set_A'), 'AA1CELL1');
    assert.deepStrictEqual(fs.readdirSync(path.join(cell, 'raw')), ['AA1CELL1.000']);
    assert.deepStrictEqual(fs.readdirSync(path.join(cell, 'geojson')), [
      'SOUNDG_AA1CELL1.geojson.gz'
    ]);
    assert.strictEqual(readSetCache('Set_A').get('AA1CELL1')?.version, 'AA1CELL1_ED002_UP000');
    fs.rmSync(staging, { recursive: true, force: true });
  });

  it('hands the converter cached GeoJSON for its own set only', async () => {
    const out = fs.mkdtempSync(path.join(dataDir, 'bucket-'));
    const fill = cachedGeojsonFor('Set_A');
    await fill(
      [
        path.join(cellsDir('Set_A'), 'AA1CELL2', 'raw', 'AA1CELL2.000'),
        path.join(dataDir, 'elsewhere', 'raw', 'X.000')
      ],
      out
    );
    assert.deepStrictEqual(fs.readdirSync(out), ['DEPARE_AA1CELL2.geojson.gz']);
  });

  it('prunes cells the set no longer has', () => {
    assert.deepStrictEqual(pruneSetCache('Set_A', new Set(['AA1CELL1'])), ['AA1CELL2']);
    assert.deepStrictEqual([...readSetCache('Set_A').keys()], ['AA1CELL1']);
  });

  it('sweeps what an interrupted run left: staging dirs and incomplete cells', () => {
    const staging = createStagingDir('Set_A');
    fs.writeFileSync(path.join(staging, 'partial.dl'), 'x');
    const incomplete = path.join(cellsDir('Set_A'), 'HALF0001');
    fs.mkdirSync(path.join(incomplete, 'raw'), { recursive: true });
    assert.ok(!readSetCache('Set_A').has('HALF0001'), 'never read without cell.json');

    sweepChartSetCache();
    assert.ok(!fs.existsSync(staging));
    assert.ok(!fs.existsSync(incomplete));
    assert.ok(readSetCache('Set_A').has('AA1CELL1'), 'complete cells stay');
  });

  it('removes a deleted set’s whole cache', () => {
    removeSetCache('Set_A');
    assert.strictEqual(readSetCache('Set_A').size, 0);
    assert.ok(!fs.existsSync(path.dirname(cellsDir('Set_A'))));
  });

  it('refuses a set id that is not a plain name', () => {
    assert.throws(() => cellsDir('../etc'));
  });
});
