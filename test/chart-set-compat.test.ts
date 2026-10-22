/**
 * Chart sets saved by the NOAA Charts tab keep working in the ENC Charts tab.
 *
 * `fixtures/chart-sets/` holds three real sets saved by the NOAA Charts tab
 * (version 1). `fixtures/enc-index-florida.json` is the part of the ENC index
 * published on 2026-10-22 that they select: their NOAA units and those
 * units' archives. The tests run on copies in a temp data dir.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  boxStatesForCatalog,
  evaluateFreshness,
  getCustomCatalog,
  initCustomCatalogManager,
  listCustomCatalogs,
  type CustomCatalog
} from '../dist/utils/custom-catalog-manager.js';
import { resolveChartSet, type EncIndexLookup } from '../dist/utils/enc-chart-set.js';
import { interpretEncIndex } from '../dist/utils/enc-index-manager.js';
import { chooseOutputFilename } from '../dist/utils/s57-converter.js';
import type { EncIndexUnit } from '../dist/catalog/enc-index-schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, '..', 'test', 'fixtures');
const SET_IDS = ['FL-Keys', 'Miami', 'South_FL'];

function readFixtureSet(id: string): Record<string, unknown> {
  return JSON.parse(
    fs.readFileSync(path.join(FIXTURES, 'chart-sets', `${id}.json`), 'utf8')
  ) as Record<string, unknown>;
}

function publishedIndex(): EncIndexLookup & { units: EncIndexUnit[] } {
  const raw: unknown = JSON.parse(
    fs.readFileSync(path.join(FIXTURES, 'enc-index-florida.json'), 'utf8')
  );
  const result = interpretEncIndex(raw);
  assert.ok(result.ok);
  assert.strictEqual(result.skipped, 0);
  return result.index;
}

/**
 * The index as it stood when a set was built: its units bring in the cells
 * the set downloaded, at the versions it recorded. NOAA has since replaced
 * some band-3 cells (US3FL28M and US3FL30M became US3FL1CF and US3FL1CG), so
 * a cell the set has that no unit lists now is given back to its first box.
 */
function indexAtBuild(set: CustomCatalog): EncIndexLookup {
  const current = publishedIndex();
  const included = new Set(set.includedChartIds);
  const listed = new Set(current.units.flatMap((u) => u.cells.map((c) => c.name)));
  const gone = set.includedChartIds.filter((name) => !listed.has(name));
  const firstBox = set.selectedBand4ChartIds[0];
  const units = current.units.map((u) => ({
    ...u,
    cells: [
      ...u.cells.filter((c) => included.has(c.name)),
      ...(u.id === firstBox
        ? gone.map((name) => ({
            name,
            archive: `https://charts.noaa.gov/ENCs/${name}.zip`,
            path: `ENC_ROOT/${name}/${name}.000`
          }))
        : [])
    ].map((c) => ({ ...c, version: set.chartVersions[c.name] })),
    statusCells: u.statusCells.filter((c) => included.has(c))
  }));
  return {
    ...current,
    noaaUnits: new Map(units.map((u) => [u.id, u])),
    otherUnits: new Map()
  };
}

let dataDir = '';
let setsDir = '';
before(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chart-set-compat-'));
  setsDir = path.join(dataDir, 'custom-catalogs');
  fs.mkdirSync(setsDir, { recursive: true });
  for (const id of SET_IDS) {
    fs.copyFileSync(
      path.join(FIXTURES, 'chart-sets', `${id}.json`),
      path.join(setsDir, `${id}.json`)
    );
  }
  initCustomCatalogManager(dataDir, () => {});
});
after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('migrating NOAA Charts sets', () => {
  it('rewrites each set as version 2 on first read, keeping every field', () => {
    for (const id of SET_IDS) {
      const original = readFixtureSet(id);
      assert.strictEqual(original.schemaVersion, 1);
      const set = getCustomCatalog(id);
      assert.ok(set, id);
      const onDisk = JSON.parse(
        fs.readFileSync(path.join(setsDir, `${id}.json`), 'utf8')
      ) as Record<string, unknown>;
      assert.strictEqual(onDisk.schemaVersion, 2, id);
      assert.deepStrictEqual(onDisk.selectedUnitIds, [], id);
      for (const [key, value] of Object.entries(original)) {
        if (key !== 'schemaVersion') {
          assert.deepStrictEqual(onDisk[key], value, `${id}.${key}`);
        }
      }
    }
  });

  it('leaves a migrated set alone on later reads', () => {
    const file = path.join(setsDir, 'Miami.json');
    const before = fs.readFileSync(file, 'utf8');
    const mtime = fs.statSync(file).mtimeMs;
    listCustomCatalogs();
    getCustomCatalog('Miami');
    assert.strictEqual(fs.readFileSync(file, 'utf8'), before);
    assert.strictEqual(fs.statSync(file).mtimeMs, mtime);
  });

  it('keeps each set’s output file name, so the plotter keeps its layer', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'chart-set-out-'));
    try {
      for (const id of SET_IDS) {
        const set = getCustomCatalog(id);
        assert.ok(set);
        const name = chooseOutputFilename({
          chartsDir: empty,
          displayName: set.name,
          chartNumber: set.id
        });
        assert.strictEqual(name, set.convertedChartPath, id);
      }
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe('NOAA Charts sets against the ENC index', () => {
  it('finds every selected box as a unit, with the cells and versions the set recorded', () => {
    for (const id of SET_IDS) {
      const set = getCustomCatalog(id);
      assert.ok(set);
      const resolution = resolveChartSet(indexAtBuild(set), set);
      assert.deepStrictEqual(resolution.missingSelected, [], id);
      assert.deepStrictEqual(resolution.includedChartIds, [...set.includedChartIds].sort(), id);
      assert.deepStrictEqual(resolution.chartVersions, set.chartVersions, id);
    }
  });

  it('shows a set that was current as current, never as needing an update', () => {
    for (const id of ['Miami', 'South_FL']) {
      const set = getCustomCatalog(id);
      assert.ok(set);
      assert.strictEqual(set.status, 'converted');
      const resolution = resolveChartSet(indexAtBuild(set), set);
      const freshness = evaluateFreshness(set, resolution, () => true);
      assert.deepStrictEqual(freshness.reasons, [], id);
      assert.strictEqual(freshness.effectiveStatus, 'converted', id);
      const states = boxStatesForCatalog(set, resolution, true);
      assert.deepStrictEqual(
        Object.values(states).filter((s) => s !== 'up_to_date'),
        [],
        id
      );
    }
  });

  it('keeps a set whose last build failed flagged for a rebuild', () => {
    const set = getCustomCatalog('FL-Keys');
    assert.ok(set);
    assert.strictEqual(set.status, 'out_of_date');
    const freshness = evaluateFreshness(set, resolveChartSet(indexAtBuild(set), set), () => true);
    assert.strictEqual(freshness.effectiveStatus, 'out_of_date');
  });

  it('names the cells NOAA has updated since the set was built', () => {
    const index = publishedIndex();
    for (const id of SET_IDS) {
      const set = getCustomCatalog(id);
      assert.ok(set);
      const resolution = resolveChartSet(index, set);
      assert.deepStrictEqual(resolution.missingSelected, [], id);
      const changed = resolution.includedChartIds.filter(
        (cell) =>
          set.chartVersions[cell] !== undefined &&
          set.chartVersions[cell] !== resolution.chartVersions[cell]
      );
      const freshness = evaluateFreshness(set, resolution, () => true);
      assert.deepStrictEqual(
        freshness.reasons.filter((r) => r.startsWith('Updated edition: ')),
        changed.map((cell) => `Updated edition: ${cell}`),
        id
      );
      assert.ok(changed.length > 0, `${id}: NOAA updated cells since June`);
      assert.strictEqual(freshness.effectiveStatus, 'out_of_date', id);
    }
  });
});
