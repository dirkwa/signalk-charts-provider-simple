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
  CacheUpdateCancelled,
  CELL_EXPORT_REVISION,
  CELLS_PER_EXPORT,
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
  updateSetCache,
  type CachedCellInfo,
  type CacheUpdateSteps
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
  const info = (version: string | undefined, rev = CELL_EXPORT_REVISION, image = 'img:1') => ({
    version,
    exportRevision: rev,
    image,
    bytes: 1
  });
  const cached = new Map<string, CachedCellInfo>([
    ['SAME0001', info('SAME0001_ED001_UP002')],
    ['NEWV0001', info('NEWV0001_ED001_UP000')],
    ['OLDREV01', info('OLDREV01_ED001_UP000', CELL_EXPORT_REVISION - 1)],
    ['OLDIMG01', info('OLDIMG01_ED001_UP000', CELL_EXPORT_REVISION, 'img:0')],
    ['NOVER001', info(undefined)]
  ]);

  it('reuses unchanged cells and downloads new or changed ones', () => {
    const plan = planCellCache(
      [
        planned('SAME0001', 'SAME0001_ED001_UP002'),
        planned('NEWV0001', 'NEWV0001_ED001_UP001'),
        planned('OLDREV01', 'OLDREV01_ED001_UP000'),
        planned('OLDIMG01', 'OLDIMG01_ED001_UP000'),
        planned('ABSENT01', 'ABSENT01_ED001_UP000'),
        planned('NOVER001', undefined)
      ],
      cached,
      'img:1'
    );
    assert.deepStrictEqual(
      plan.reuse.map((c) => c.name),
      ['SAME0001']
    );
    assert.deepStrictEqual(
      plan.reexport.map((c) => c.name),
      ['OLDREV01', 'OLDIMG01']
    );
    assert.deepStrictEqual(
      plan.download.map((c) => c.name),
      ['NEWV0001', 'ABSENT01', 'NOVER001']
    );
  });

  it('downloads everything for a set saved before the cache existed', () => {
    const plan = planCellCache([planned('A1B2C3D4', 'A1B2C3D4_ED001_UP000')], new Map(), 'img:1');
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
    fs.writeFileSync(path.join(out, `.complete-${name}`), '');
    return raw;
  }

  it('commits each cell with its raw files, gzipped GDAL output and version', async () => {
    const staging = createStagingDir('Set_A');
    const rawA = stage(staging, 'AA1CELL1', ['DEPARE', 'M_COVR'], true);
    const rawB = stage(staging, 'AA1CELL2', ['DEPARE']);
    const result = await commitCells(
      'Set_A',
      staging,
      path.join(staging, 'export-out'),
      [
        { name: 'AA1CELL1', rawDir: rawA, version: 'AA1CELL1_ED001_UP001' },
        { name: 'AA1CELL2', rawDir: rawB, version: 'AA1CELL2_ED002_UP000' }
      ],
      'img:1'
    );
    assert.deepStrictEqual(result, { committed: ['AA1CELL1', 'AA1CELL2'], incomplete: [] });

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
    assert.strictEqual(cache.get('AA1CELL1')?.version, 'AA1CELL1_ED001_UP001');
    assert.strictEqual(cache.get('AA1CELL1')?.exportRevision, CELL_EXPORT_REVISION);
    assert.strictEqual(cache.get('AA1CELL1')?.image, 'img:1');
    assert.ok((cache.get('AA1CELL1')?.bytes ?? 0) > 0);
    assert.strictEqual(cache.get('AA1CELL2')?.version, 'AA1CELL2_ED002_UP000');
    assert.ok(setCacheBytes('Set_A') > 0);
    fs.rmSync(staging, { recursive: true, force: true });
  });

  it('files GDAL output under cells whose names contain underscores', async () => {
    const staging = createStagingDir('Set_U');
    const waspik = stage(staging, 'IENC_Haven_Waspik_7_', ['DEPARE', 'M_COVR']);
    const cd = stage(staging, 'AB_CD', ['DEPARE']);
    const plain = stage(staging, 'CD', ['LNDARE']);
    const result = await commitCells(
      'Set_U',
      staging,
      path.join(staging, 'export-out'),
      [
        { name: 'IENC_Haven_Waspik_7_', rawDir: waspik, version: undefined },
        { name: 'AB_CD', rawDir: cd, version: undefined },
        { name: 'CD', rawDir: plain, version: undefined }
      ],
      'img:1'
    );
    assert.deepStrictEqual(result.committed, ['IENC_Haven_Waspik_7_', 'AB_CD', 'CD']);
    const files = (cell: string) =>
      fs.readdirSync(path.join(cellsDir('Set_U'), cell, 'geojson')).sort();
    assert.deepStrictEqual(files('IENC_Haven_Waspik_7_'), [
      'DEPARE_IENC_Haven_Waspik_7_.geojson.gz',
      'M_COVR_IENC_Haven_Waspik_7_.geojson.gz'
    ]);
    assert.deepStrictEqual(files('AB_CD'), ['DEPARE_AB_CD.geojson.gz']);
    assert.deepStrictEqual(files('CD'), ['LNDARE_CD.geojson.gz']);
    fs.rmSync(staging, { recursive: true, force: true });
    removeSetCache('Set_U');
  });

  it('replaces a cell only with a complete new copy', async () => {
    const staging = createStagingDir('Set_A');
    const raw = stage(staging, 'AA1CELL1', ['SOUNDG']);
    await commitCells(
      'Set_A',
      staging,
      path.join(staging, 'export-out'),
      [{ name: 'AA1CELL1', rawDir: raw, version: 'AA1CELL1_ED002_UP000' }],
      'img:1'
    );
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

  it('sweeps what an interrupted run left, and caches of sets that are gone', () => {
    const staging = createStagingDir('Set_A');
    fs.writeFileSync(path.join(staging, 'partial.dl'), 'x');
    const incomplete = path.join(cellsDir('Set_A'), 'HALF0001');
    fs.mkdirSync(path.join(incomplete, 'raw'), { recursive: true });
    assert.ok(!readSetCache('Set_A').has('HALF0001'), 'never read without cell.json');

    const gone = path.join(path.dirname(path.dirname(cellsDir('Set_A'))), 'Gone_Set');
    fs.mkdirSync(path.join(gone, 'cells'), { recursive: true });
    sweepChartSetCache(new Set(['Set_A']));
    assert.ok(!fs.existsSync(staging));
    assert.ok(!fs.existsSync(gone), 'the cache of a set that is gone');
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

describe('updateSetCache', () => {
  let dataDir = '';
  const IMAGE = 'toolbox:1';

  before(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chart-set-update-'));
    initChartSetCache(dataDir, () => {});
  });

  after(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  interface Fakes {
    downloaded: string[][];
    exported: string[][];
    beforeExport: number;
    log: string[];
  }

  /** Steps that stage and "export" cells on disk; `bad` cells export partially. */
  function steps(
    fakes: Fakes,
    opts: {
      failDownload?: Set<string>;
      bad?: Set<string>;
      cancelAfterExports?: number;
      throwOnExport?: number;
    } = {}
  ): CacheUpdateSteps {
    return {
      download: (cells, encDir) => {
        fakes.downloaded.push(cells.map((c) => c.name));
        const staged: string[] = [];
        const failed: { chartId: string; error: string }[] = [];
        const versions: Record<string, string> = {};
        for (const cell of cells) {
          if (opts.failDownload?.has(cell.name)) {
            failed.push({ chartId: cell.name, error: 'HTTP 503' });
            continue;
          }
          fs.mkdirSync(path.join(encDir, cell.name), { recursive: true });
          fs.writeFileSync(path.join(encDir, cell.name, `${cell.name}.000`), cell.version ?? '');
          staged.push(cell.name);
          if (cell.version) {
            versions[cell.name] = cell.version;
          }
        }
        return Promise.resolve({ staged, failed, versions });
      },
      beforeExport: () => {
        fakes.beforeExport += 1;
      },
      exportCells: (inDir, outDir) => {
        const names = fs.readdirSync(inDir);
        fakes.exported.push(names);
        if (opts.throwOnExport === fakes.exported.length) {
          return Promise.reject(new Error('gdal-export failed with exit code 137'));
        }
        fs.mkdirSync(outDir, { recursive: true });
        for (const name of names) {
          fs.writeFileSync(path.join(outDir, `DEPARE_${name}.geojson`), `{"cell":"${name}"}`);
          if (opts.bad?.has(name)) {
            fs.appendFileSync(
              path.join(outDir, '.export-errors.log'),
              `ERROR 1: ${name}.000: unexpected end of file\n`
            );
          } else {
            fs.writeFileSync(path.join(outDir, `.complete-${name}`), '');
          }
        }
        return Promise.resolve();
      },
      isCancelled: () =>
        opts.cancelAfterExports !== undefined && fakes.exported.length >= opts.cancelAfterExports,
      log: (line) => fakes.log.push(line)
    };
  }

  const fresh = (): Fakes => ({ downloaded: [], exported: [], beforeExport: 0, log: [] });

  async function run(setId: string, cells: PlannedCell[], fakes: Fakes, opts = {}, image = IMAGE) {
    const staging = createStagingDir(setId);
    try {
      return await updateSetCache(setId, cells, staging, image, steps(fakes, opts));
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  }

  const v = (name: string, ed: number) => `${name}_ED${String(ed).padStart(3, '0')}_UP000`;

  it('downloads and reads every cell of a set saved before the cache existed', async () => {
    const fakes = fresh();
    const cells = [planned('CELLAAA1', v('CELLAAA1', 1)), planned('CELLBBB1', v('CELLBBB1', 1))];
    const result = await run('Upd', cells, fakes);
    assert.deepStrictEqual(fakes.downloaded, [['CELLAAA1', 'CELLBBB1']]);
    assert.deepStrictEqual(result.used, ['CELLAAA1', 'CELLBBB1']);
    assert.deepStrictEqual(result.versions, {
      CELLAAA1: v('CELLAAA1', 1),
      CELLBBB1: v('CELLBBB1', 1)
    });
    assert.strictEqual(result.partial, false);
    assert.strictEqual(result.changed, true);
  });

  it('downloads and reads nothing when no cell changed', async () => {
    const fakes = fresh();
    const cells = [planned('CELLAAA1', v('CELLAAA1', 1)), planned('CELLBBB1', v('CELLBBB1', 1))];
    const result = await run('Upd', cells, fakes);
    assert.deepStrictEqual(fakes.downloaded, []);
    assert.deepStrictEqual(fakes.exported, []);
    assert.strictEqual(fakes.beforeExport, 0);
    assert.strictEqual(result.changed, false);
    assert.ok(fakes.log.some((l) => l.startsWith('2 cell(s) unchanged')));
  });

  it('downloads and reads only the changed cell, and names it', async () => {
    const fakes = fresh();
    const cells = [planned('CELLAAA1', v('CELLAAA1', 2)), planned('CELLBBB1', v('CELLBBB1', 1))];
    const result = await run('Upd', cells, fakes);
    assert.deepStrictEqual(fakes.downloaded, [['CELLAAA1']]);
    assert.deepStrictEqual(fakes.exported, [['CELLAAA1']]);
    assert.ok(fakes.log.includes('Changed since the last download: CELLAAA1'));
    assert.strictEqual(result.versions.CELLAAA1, v('CELLAAA1', 2));
    assert.strictEqual(result.changed, true);
  });

  it('keeps the earlier copy of a cell that fails to download, and flags the set', async () => {
    const fakes = fresh();
    const cells = [planned('CELLAAA1', v('CELLAAA1', 3)), planned('CELLBBB1', v('CELLBBB1', 1))];
    const result = await run('Upd', cells, fakes, { failDownload: new Set(['CELLAAA1']) });
    assert.deepStrictEqual(result.used, ['CELLAAA1', 'CELLBBB1']);
    assert.strictEqual(result.versions.CELLAAA1, v('CELLAAA1', 2), 'the earlier version');
    assert.strictEqual(result.partial, true);
    assert.strictEqual(result.changed, false);
  });

  it('never keeps a cell GDAL did not read completely', async () => {
    const fakes = fresh();
    const cells = [planned('CELLCCC1', v('CELLCCC1', 1))];
    await assert.rejects(
      run('Bad', cells, fakes, { bad: new Set(['CELLCCC1']) }),
      /No cell of this set could be read/
    );
    assert.strictEqual(readSetCache('Bad').size, 0);
    assert.ok(fakes.log.some((l) => l.includes('GDAL could not read all of CELLCCC1')));
    assert.ok(fakes.log.some((l) => l.includes('CELLCCC1.000: unexpected end of file')));
    // Read again on the next run, not reused.
    const again = fresh();
    const result = await run('Bad', cells, again);
    assert.deepStrictEqual(again.downloaded, [['CELLCCC1']]);
    assert.deepStrictEqual(result.used, ['CELLCCC1']);
  });

  it('fails before claiming a conversion slot when every download fails and nothing is kept', async () => {
    const fakes = fresh();
    await assert.rejects(
      run('None', [planned('CELLDDD1', v('CELLDDD1', 1))], fakes, {
        failDownload: new Set(['CELLDDD1'])
      }),
      /All ENC downloads failed/
    );
    assert.strictEqual(fakes.beforeExport, 0);
  });

  it('reads a cached cell again, without downloading it, after a GDAL image change', async () => {
    const fakes = fresh();
    const cells = [planned('CELLAAA1', v('CELLAAA1', 2)), planned('CELLBBB1', v('CELLBBB1', 1))];
    const result = await run('Upd', cells, fakes, {}, 'toolbox:2');
    assert.deepStrictEqual(fakes.downloaded, []);
    assert.deepStrictEqual(fakes.exported.flat().sort(), ['CELLAAA1', 'CELLBBB1']);
    assert.strictEqual(readSetCache('Upd').get('CELLBBB1')?.image, 'toolbox:2');
    assert.strictEqual(result.changed, true);
  });

  it('removes cells the set no longer has', async () => {
    const fakes = fresh();
    const result = await run(
      'Upd',
      [planned('CELLBBB1', v('CELLBBB1', 1))],
      fakes,
      {},
      'toolbox:2'
    );
    assert.deepStrictEqual(result.used, ['CELLBBB1']);
    assert.deepStrictEqual([...readSetCache('Upd').keys()], ['CELLBBB1']);
    assert.strictEqual(result.changed, true);
  });

  it('keeps nothing of a batch cancelled after its export, before it is kept', async () => {
    const fakes = fresh();
    const cells = Array.from({ length: CELLS_PER_EXPORT + 5 }, (_, i) => {
      const name = `CELLE${String(i).padStart(3, '0')}`;
      return planned(name, v(name, 1));
    });
    await assert.rejects(
      run('Batch', cells, fakes, { cancelAfterExports: 1 }),
      CacheUpdateCancelled
    );
    assert.strictEqual(fakes.exported.length, 1);
    assert.strictEqual(fakes.exported[0].length, CELLS_PER_EXPORT);
    // The first batch was cancelled after its export, before its commit;
    // nothing half-read is kept.
    assert.strictEqual(readSetCache('Batch').size, 0);

    const again = fresh();
    const result = await run('Batch', cells, again);
    assert.deepStrictEqual(
      again.exported.map((b) => b.length),
      [CELLS_PER_EXPORT, 5]
    );
    assert.strictEqual(result.used.length, CELLS_PER_EXPORT + 5);
  });

  it('keeps the batches done when a later one fails', async () => {
    const fakes = fresh();
    const cells = Array.from({ length: CELLS_PER_EXPORT + 5 }, (_, i) => {
      const name = `CELLF${String(i).padStart(3, '0')}`;
      return planned(name, v(name, 1));
    });
    await assert.rejects(run('Partway', cells, fakes, { throwOnExport: 2 }), /exit code 137/);
    assert.strictEqual(readSetCache('Partway').size, CELLS_PER_EXPORT);

    const again = fresh();
    const result = await run('Partway', cells, again);
    assert.deepStrictEqual(again.downloaded, [cells.slice(CELLS_PER_EXPORT).map((c) => c.name)]);
    assert.strictEqual(result.used.length, CELLS_PER_EXPORT + 5);
  });
});
