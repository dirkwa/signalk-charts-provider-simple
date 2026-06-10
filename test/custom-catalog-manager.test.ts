/**
 * Tests for the custom-catalog manager: safe-id derivation / path-traversal
 * resistance, CRUD persistence under a temp data dir, and freshness/update
 * evaluation. No network — the footprint index is hand-built.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  boxStatesForCatalog,
  catalogMbtilesName,
  createCustomCatalog,
  deleteCustomCatalog,
  evaluateFreshness,
  getCustomCatalog,
  initCustomCatalogManager,
  isValidCatalogId,
  listCustomCatalogs,
  saveCustomCatalog,
  slugifyCatalogName,
  type CustomCatalog
} from '../dist/utils/custom-catalog-manager.js';
import { parseFootprints, type FootprintIndex } from '../dist/utils/noaa-enc-footprints.js';

let dataDir = '';
before(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-mgr-'));
  initCustomCatalogManager(dataDir, () => {});
});
after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('slugifyCatalogName', () => {
  it('replaces whitespace with underscores', () => {
    assert.strictEqual(slugifyCatalogName('FL Keys'), 'FL_Keys');
  });
  it('drops path-unsafe characters', () => {
    assert.strictEqual(slugifyCatalogName('../../etc/passwd'), 'etcpasswd');
  });
  it('falls back to "catalog" when nothing survives', () => {
    assert.strictEqual(slugifyCatalogName('***'), 'catalog');
  });
});

describe('isValidCatalogId', () => {
  it('accepts safe slugs', () => {
    assert.ok(isValidCatalogId('FL_Keys-2'));
  });
  it('rejects traversal and separators', () => {
    assert.ok(!isValidCatalogId('../etc'));
    assert.ok(!isValidCatalogId('a/b'));
    assert.ok(!isValidCatalogId(''));
  });
});

describe('catalogMbtilesName', () => {
  it('derives a sanitized .mbtiles basename from the name', () => {
    assert.strictEqual(catalogMbtilesName({ name: 'FL Keys', id: 'fl-keys' }), 'FL_Keys.mbtiles');
  });
});

describe('CRUD persistence', () => {
  it('creates a catalog with a slug id and empty status', () => {
    const cat = createCustomCatalog('FL Keys');
    assert.strictEqual(cat.id, 'FL_Keys');
    assert.strictEqual(cat.status, 'empty');
    assert.strictEqual(cat.selectedBand4ChartIds.length, 0);
    assert.ok(fs.existsSync(path.join(dataDir, 'custom-catalogs', 'FL_Keys.json')));
  });

  it('disambiguates a duplicate name with a numeric suffix', () => {
    const cat = createCustomCatalog('FL Keys');
    assert.strictEqual(cat.id, 'FL_Keys-2');
  });

  it('round-trips selection through save/get', () => {
    const cat = createCustomCatalog('Round Trip');
    cat.selectedBand4ChartIds = ['US4FL1EP'];
    cat.status = 'out_of_date';
    saveCustomCatalog(cat);
    const reloaded = getCustomCatalog('Round_Trip');
    assert.deepStrictEqual(reloaded?.selectedBand4ChartIds, ['US4FL1EP']);
    assert.strictEqual(reloaded?.status, 'out_of_date');
  });

  it('returns null for a path-traversal id', () => {
    assert.strictEqual(getCustomCatalog('../../etc/passwd'), null);
    assert.strictEqual(getCustomCatalog('a/b'), null);
  });

  it('lists catalogs sorted by name', () => {
    const names = listCustomCatalogs().map((c) => c.name);
    const sorted = [...names].sort((a, b) => a.localeCompare(b));
    assert.deepStrictEqual(names, sorted);
  });

  it('deletes a catalog and reports missing on a second delete', () => {
    createCustomCatalog('Disposable');
    assert.strictEqual(deleteCustomCatalog('Disposable'), true);
    assert.strictEqual(deleteCustomCatalog('Disposable'), false);
  });
});

// ---- Freshness evaluation ----

function square(x: number, y: number, s = 1): number[][] {
  return [
    [x, y],
    [x + s, y],
    [x + s, y + s],
    [x, y + s],
    [x, y]
  ];
}

function makeIndex(
  features: { encEdUp: string; band: number; ring: number[][] }[]
): FootprintIndex {
  const all = parseFootprints({
    type: 'FeatureCollection',
    features: features.map((f) => ({
      type: 'Feature',
      properties: { enc_ed_up: f.encEdUp, scale_band: f.band, title: f.encEdUp },
      geometry: { type: 'Polygon', coordinates: [f.ring] }
    }))
  });
  const byChartId = new Map(all.map((f) => [f.chartId, f]));
  return { fetchedAt: 0, stale: false, all, byChartId };
}

describe('evaluateFreshness', () => {
  const index = makeIndex([
    { encEdUp: 'US4AREAA_ED1_UP1', band: 4, ring: square(0, 0, 2) },
    { encEdUp: 'US3NEAR0_ED1_UP1', band: 3, ring: square(1, 1, 5) }
  ]);

  function convertedCatalog(): CustomCatalog {
    return {
      schemaVersion: 1,
      id: 'fl',
      name: 'FL',
      selectedBand: 4,
      selectedBand4ChartIds: ['US4AREAA'],
      includedChartIds: ['US3NEAR0', 'US4AREAA'],
      chartVersions: { US4AREAA: 'US4AREAA_ED1_UP1', US3NEAR0: 'US3NEAR0_ED1_UP1' },
      downloadedChartIds: ['US3NEAR0', 'US4AREAA'],
      convertedChartPath: 'FL.mbtiles',
      status: 'converted',
      createdAt: '',
      updatedAt: '',
      lastDownloadedAt: null,
      lastConvertedAt: null
    };
  }

  it('reports up to date when nothing changed and the file exists', () => {
    const r = evaluateFreshness(convertedCatalog(), index, () => true);
    assert.strictEqual(r.upToDate, true);
    assert.strictEqual(r.effectiveStatus, 'converted');
    assert.deepStrictEqual(r.reasons, []);
  });

  it('flags out of date when the output file is missing', () => {
    const r = evaluateFreshness(convertedCatalog(), index, () => false);
    assert.strictEqual(r.upToDate, false);
    assert.strictEqual(r.effectiveStatus, 'out_of_date');
    assert.ok(r.reasons.some((x) => x.includes('missing')));
  });

  it('flags out of date when a selected edition changed', () => {
    const bumped = makeIndex([
      { encEdUp: 'US4AREAA_ED2_UP9', band: 4, ring: square(0, 0, 2) },
      { encEdUp: 'US3NEAR0_ED1_UP1', band: 3, ring: square(1, 1, 5) }
    ]);
    const r = evaluateFreshness(convertedCatalog(), bumped, () => true);
    assert.strictEqual(r.upToDate, false);
    assert.ok(r.reasons.some((x) => x.includes('Updated edition')));
  });

  it('flags out of date when a selected area is no longer published', () => {
    const r = evaluateFreshness(
      { ...convertedCatalog(), selectedBand4ChartIds: ['US4AREAA', 'US4GONE00'] },
      index,
      () => true
    );
    assert.ok(r.reasons.some((x) => x.includes('No longer published')));
    assert.strictEqual(r.effectiveStatus, 'out_of_date');
  });

  it('reports empty for a catalog with no selection', () => {
    const r = evaluateFreshness(
      { ...convertedCatalog(), selectedBand4ChartIds: [], status: 'empty' },
      index,
      () => true
    );
    assert.strictEqual(r.effectiveStatus, 'empty');
  });
});

describe('boxStatesForCatalog', () => {
  // Box A (band-4) with one nested band-5 cell inside it.
  function indexWith(b4: string, b5: string): FootprintIndex {
    return makeIndex([
      { encEdUp: `US4BOXA00_${b4}`, band: 4, ring: square(0, 0, 4) },
      { encEdUp: `US5NEST00_${b5}`, band: 5, ring: square(1, 1, 1) }
    ]);
  }

  function builtCatalog(): CustomCatalog {
    return {
      schemaVersion: 1,
      id: 'cs',
      name: 'CS',
      selectedBand: 4,
      selectedBand4ChartIds: ['US4BOXA0'],
      includedChartIds: ['US4BOXA0', 'US5NEST0'],
      chartVersions: { US4BOXA0: 'US4BOXA00_ED1', US5NEST0: 'US5NEST00_ED1' },
      downloadedChartIds: ['US4BOXA0', 'US5NEST0'],
      convertedChartPath: 'CS.mbtiles',
      status: 'converted',
      createdAt: '',
      updatedAt: '',
      lastDownloadedAt: null,
      lastConvertedAt: null
    };
  }

  it('up_to_date when baked editions still match current NOAA', () => {
    const r = boxStatesForCatalog(builtCatalog(), indexWith('ED1', 'ED1'));
    assert.strictEqual(r['US4BOXA0'], 'up_to_date');
  });

  it('needs_refresh when a nested band-5 cell has a newer edition', () => {
    const r = boxStatesForCatalog(builtCatalog(), indexWith('ED1', 'ED2'));
    assert.strictEqual(r['US4BOXA0'], 'needs_refresh');
  });

  it('needs_refresh when the catalog was never built', () => {
    const r = boxStatesForCatalog(
      { ...builtCatalog(), convertedChartPath: null },
      indexWith('ED1', 'ED1')
    );
    assert.strictEqual(r['US4BOXA0'], 'needs_refresh');
  });

  it('needs_refresh when NOAA added a new cell to the box since the build', () => {
    const idx = makeIndex([
      { encEdUp: 'US4BOXA00_ED1', band: 4, ring: square(0, 0, 4) },
      { encEdUp: 'US5NEST00_ED1', band: 5, ring: square(1, 1, 1) },
      { encEdUp: 'US5NEW000_ED1', band: 5, ring: square(2, 2, 1) } // new cell in the box
    ]);
    const r = boxStatesForCatalog(builtCatalog(), idx);
    assert.strictEqual(r['US4BOXA0'], 'needs_refresh');
  });

  // Edition-driven, so it does NOT depend on source files still being on disk
  // (the chartFileExists check used by evaluateFreshness is irrelevant here).
  it('is independent of on-disk source/output files', () => {
    const r = boxStatesForCatalog(builtCatalog(), indexWith('ED1', 'ED1'));
    assert.strictEqual(r['US4BOXA0'], 'up_to_date');
  });
});
