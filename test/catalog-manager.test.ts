/**
 * Tests for the catalog manager module
 */

import { describe, it, before, after, afterEach, mock } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  initCatalogManager,
  getCatalogRegistry,
  classifyUrl,
  trackInstall,
  setInstallFilename,
  removeInstall,
  rollbackInstall,
  getInstalledCatalogCharts,
  checkForUpdates,
  getCatalogsWithInstalledCharts,
  getCatalogData,
  getCatalogStatus,
  interpretCatalog,
  pruneStaleInstalls,
  refreshCatalog,
  refreshCatalogIfStale,
  setCatalogChangedListener
} from '../dist/utils/catalog-manager.js';
import type { CatalogInstall } from '../dist/types.js';

// ESM equivalent of CJS `__dirname`.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Test data dir is created on demand; doesn't need to live in the
// shared fixtures tree. Compiled tests resolve __dirname to dist-test/,
// so the data dir ends up at dist-test/fixtures/catalog-test-data —
// gets cleaned in the test's after hook so no commit-time leakage.
const TEST_DATA_DIR = path.join(__dirname, 'fixtures', 'catalog-test-data');

interface TestChart {
  number: string;
  title: string;
  format: string;
  zipfile_location: string;
  zipfile_datetime_iso8601: string;
}

/** A published merged catalog holding the given chartcatalogs catalogs. */
function mergedCatalog(
  catalogs: Record<string, TestChart[]>,
  schemaVersion: unknown = 1,
  overrides: Record<string, Record<string, unknown>> = {}
): unknown {
  return {
    schemaVersion,
    generatedAt: '2026-01-01T00:00:00.000Z',
    contentHash: '0'.repeat(64),
    sources: {
      chartcatalogs: {
        homepage: 'https://chartcatalogs.github.io/',
        issues: 'https://github.com/chartcatalogs/catalogs/issues',
        license: 'CC0-1.0'
      },
      online: {
        homepage: 'https://github.com/owner/repo',
        issues: 'https://github.com/owner/repo/issues'
      }
    },
    chartcatalogs: Object.entries(catalogs).map(([file, charts]) => ({
      id: file.replace('.xml', ''),
      file,
      label: `Label for ${file}`,
      use: 'download',
      category: 'navigation',
      indexed: true,
      format: 'mbtiles',
      regions: ['us'],
      bbox: [-180, -85, 180, 85],
      header: { title: 'Test' },
      charts,
      ...overrides[file]
    })),
    online: []
  };
}

type FetchScript = { status: number; body?: unknown; etag?: string } | { networkError: true };

/**
 * Stub global fetch with scripted responses, one per call (the last one
 * repeats); returns the call log.
 */
function stubFetch(...scripts: FetchScript[]): {
  urls: string[];
  headers: Record<string, string>[];
} {
  const calls = { urls: [] as string[], headers: [] as Record<string, string>[] };
  mock.method(globalThis, 'fetch', (url: string, init?: { headers?: Record<string, string> }) => {
    const script = scripts[Math.min(calls.urls.length, scripts.length - 1)]!;
    calls.urls.push(url);
    calls.headers.push(init?.headers ?? {});
    if ('networkError' in script) {
      return Promise.reject(new TypeError('fetch failed'));
    }
    const headers: Record<string, string> = {};
    if (script.etag) {
      headers.etag = script.etag;
    }
    const body =
      script.body === undefined
        ? null
        : typeof script.body === 'string'
          ? script.body
          : JSON.stringify(script.body);
    return Promise.resolve(new Response(body, { status: script.status, headers }));
  });
  return calls;
}

/** Make the plugin's in-memory (and cached) catalog hold these charts. */
async function seedCatalog(catalogFile: string, charts: TestChart[]): Promise<void> {
  stubFetch({ status: 200, body: mergedCatalog({ [catalogFile]: charts }) });
  await refreshCatalog();
  mock.restoreAll();
}

// Every initCatalogManager() fire-and-forgets refreshCatalog(), so any call
// (suite setup AND each restart simulation) must run under a stub or it
// makes a live network call. The stub fails like an offline boat, so the
// cached catalog on disk is what the restarted manager serves.
async function initCatalogManagerOffline(): Promise<void> {
  stubFetch({ networkError: true });
  initCatalogManager(TEST_DATA_DIR, () => {});
  await refreshCatalog();
  mock.restoreAll();
}

describe('CatalogManager', () => {
  before(async () => {
    // Clean up any previous test data
    if (fs.existsSync(TEST_DATA_DIR)) {
      fs.rmSync(TEST_DATA_DIR, { recursive: true });
    }
    await initCatalogManagerOffline();
  });

  after(() => {
    // Clean up test data
    if (fs.existsSync(TEST_DATA_DIR)) {
      fs.rmSync(TEST_DATA_DIR, { recursive: true });
    }
  });

  describe('getCatalogRegistry()', () => {
    it('should return an array (may be empty before the catalog downloads)', () => {
      const registry = getCatalogRegistry();
      assert.ok(Array.isArray(registry));
    });

    it('should include chartCount and cachedAt fields on entries', () => {
      const registry = getCatalogRegistry();
      for (const entry of registry) {
        assert.ok('chartCount' in entry, 'entry should have chartCount');
        assert.ok('cachedAt' in entry, 'entry should have cachedAt');
      }
    });
  });

  describe('classifyUrl()', () => {
    it('should classify .mbtiles as supported', () => {
      const result = classifyUrl(
        'https://distribution.charts.noaa.gov/ncds/mbtiles/ncds_01a.mbtiles',
        ''
      );
      assert.strictEqual(result.supported, true);
      assert.strictEqual(result.format, 'mbtiles');
    });

    it('should classify .zip as supported for mbtiles catalogs', () => {
      const result = classifyUrl('https://example.com/chart.zip', 'mbtiles');
      assert.strictEqual(result.supported, true);
      assert.strictEqual(result.format, 'zip');
    });

    it('should classify .zip as s57-zip for ienc catalogs', () => {
      const result = classifyUrl('https://example.com/chart.zip', 'ienc');
      assert.strictEqual(result.supported, true);
      assert.strictEqual(result.format, 's57-zip');
    });

    it('should classify .zip as rnc-zip for rnc catalogs', () => {
      const result = classifyUrl('https://example.com/chart.zip', 'rnc');
      assert.strictEqual(result.supported, true);
      assert.strictEqual(result.format, 'rnc-zip');
    });

    it('should classify .zip as unsupported for general catalogs', () => {
      const result = classifyUrl('https://example.com/chart.zip', 'general');
      assert.strictEqual(result.supported, false);

      const result2 = classifyUrl('https://example.com/chart.zip', '');
      assert.strictEqual(result2.supported, false);
    });

    it('should classify .tar.xz as unsupported', () => {
      const result = classifyUrl('https://example.com/chart.tar.xz', '');
      assert.strictEqual(result.supported, false);
      assert.strictEqual(result.format, 'tar');
    });

    it('should classify .tar.gz as unsupported', () => {
      const result = classifyUrl('https://example.com/chart.tar.gz', '');
      assert.strictEqual(result.supported, false);
      assert.strictEqual(result.format, 'tar');
    });

    it('should handle null/empty url', () => {
      // Defensive runtime check; the function signature is `string`
      // but parsed-JSON callers can still hand it null upstream.
      const result = classifyUrl(null as unknown as string, '');
      assert.strictEqual(result.supported, false);
      assert.strictEqual(result.format, 'unknown');

      const result2 = classifyUrl('', '');
      assert.strictEqual(result2.supported, false);
    });

    it('should classify unknown URLs as unsupported', () => {
      const result = classifyUrl('https://example.com/some/path', '');
      assert.strictEqual(result.supported, false);
      assert.strictEqual(result.format, 'unknown');
    });
  });

  describe('install tracking', () => {
    it('should start with no installs', () => {
      const installed = getInstalledCatalogCharts();
      assert.deepStrictEqual(installed, {});
    });

    it('should track a new install', () => {
      trackInstall(
        'ncds_01a',
        'NOAA_MBTiles_Catalog.xml',
        '2023-08-02T00:08:00Z',
        'https://example.com/ncds_01a.mbtiles'
      );

      const installed = getInstalledCatalogCharts();
      assert.ok(installed['ncds_01a']);
      assert.strictEqual(installed['ncds_01a'].catalogFile, 'NOAA_MBTiles_Catalog.xml');
      assert.strictEqual(installed['ncds_01a'].zipfile_datetime_iso8601, '2023-08-02T00:08:00Z');
      assert.ok(installed['ncds_01a'].installedAt);
      assert.strictEqual(
        installed['ncds_01a'].zipfile_location,
        'https://example.com/ncds_01a.mbtiles'
      );
    });

    it('should track multiple installs', () => {
      trackInstall(
        'ncds_02',
        'NOAA_MBTiles_Catalog.xml',
        '2023-08-02T00:10:00Z',
        'https://example.com/ncds_02.mbtiles'
      );

      const installed = getInstalledCatalogCharts();
      assert.ok(installed['ncds_01a']);
      assert.ok(installed['ncds_02']);
    });

    it('should remove an install', () => {
      removeInstall('ncds_02');
      const installed = getInstalledCatalogCharts();
      assert.ok(installed['ncds_01a']);
      assert.ok(!installed['ncds_02']);
    });

    it('should handle removing non-existent install gracefully', () => {
      assert.doesNotThrow(() => {
        removeInstall('nonexistent');
      });
    });

    it('should persist installs to disk', () => {
      const installsPath = path.join(TEST_DATA_DIR, 'catalog-installs.json');
      assert.ok(fs.existsSync(installsPath));
      const data = JSON.parse(fs.readFileSync(installsPath, 'utf-8')) as Record<string, unknown>;
      assert.ok(data['ncds_01a']);
    });

    // Clean up installs for subsequent tests
    after(() => {
      removeInstall('ncds_01a');
    });
  });

  describe('getCatalogsWithInstalledCharts()', () => {
    it('should return empty array when no installs', () => {
      const catalogs = getCatalogsWithInstalledCharts();
      assert.strictEqual(catalogs.length, 0);
    });

    it('should return unique catalog files for installed charts', () => {
      trackInstall('chart1', 'NOAA_MBTiles_Catalog.xml', '2023-01-01T00:00:00Z', 'url1');
      trackInstall('chart2', 'NOAA_MBTiles_Catalog.xml', '2023-01-01T00:00:00Z', 'url2');
      trackInstall('chart3', 'DE_IENC_Catalog.xml', '2023-01-01T00:00:00Z', 'url3');

      const catalogs = getCatalogsWithInstalledCharts();
      assert.strictEqual(catalogs.length, 2);
      assert.ok(catalogs.includes('NOAA_MBTiles_Catalog.xml'));
      assert.ok(catalogs.includes('DE_IENC_Catalog.xml'));

      // Clean up
      removeInstall('chart1');
      removeInstall('chart2');
      removeInstall('chart3');
    });
  });

  describe('checkForUpdates()', () => {
    it('should return empty array when no installs', () => {
      const updates = checkForUpdates();
      assert.deepStrictEqual(updates, []);
    });

    it('should detect when catalog has newer version', async () => {
      // Write a fake cache with a newer date
      const cacheData = {
        fetchedAt: new Date().toISOString(),
        catalogFile: 'NOAA_MBTiles_Catalog.xml',
        header: { title: 'Test' },
        charts: [
          {
            number: 'test_chart',
            title: 'Test Chart',
            format: 'MBTiles',
            zipfile_location: 'https://example.com/test.mbtiles',
            zipfile_datetime_iso8601: '2024-06-01T00:00:00Z'
          }
        ]
      };
      await seedCatalog(cacheData.catalogFile, cacheData.charts);

      // Track an install with older date
      trackInstall(
        'test_chart',
        'NOAA_MBTiles_Catalog.xml',
        '2023-08-02T00:08:00Z',
        'https://example.com/test.mbtiles'
      );

      const updates = checkForUpdates();
      assert.strictEqual(updates.length, 1);
      assert.strictEqual(updates[0]!.chartNumber, 'test_chart');
      assert.strictEqual(updates[0]!.installedDate, '2023-08-02T00:08:00Z');
      assert.strictEqual(updates[0]!.availableDate, '2024-06-01T00:00:00Z');

      // Clean up
      removeInstall('test_chart');
    });

    it('should not flag charts with same date as updated', async () => {
      const cacheData = {
        fetchedAt: new Date().toISOString(),
        catalogFile: 'NOAA_MBTiles_Catalog.xml',
        header: { title: 'Test' },
        charts: [
          {
            number: 'same_date_chart',
            title: 'Same Date Chart',
            format: 'MBTiles',
            zipfile_location: 'https://example.com/test.mbtiles',
            zipfile_datetime_iso8601: '2023-08-02T00:08:00Z'
          }
        ]
      };
      await seedCatalog(cacheData.catalogFile, cacheData.charts);

      trackInstall(
        'same_date_chart',
        'NOAA_MBTiles_Catalog.xml',
        '2023-08-02T00:08:00Z',
        'https://example.com/test.mbtiles'
      );

      const updates = checkForUpdates();
      assert.strictEqual(updates.length, 0);

      removeInstall('same_date_chart');
    });

    it('reports installedFolder as POSIX, defaulting to root', async () => {
      const cacheData = {
        fetchedAt: new Date().toISOString(),
        catalogFile: 'NOAA_MBTiles_Catalog.xml',
        header: { title: 'Test' },
        charts: [
          {
            number: 'folder_chart',
            title: 'Folder Chart',
            format: 'MBTiles',
            zipfile_location: 'https://example.com/test.mbtiles',
            zipfile_datetime_iso8601: '2024-06-01T00:00:00Z'
          }
        ]
      };
      await seedCatalog(cacheData.catalogFile, cacheData.charts);

      // No installedFilename → folder defaults to root.
      trackInstall(
        'folder_chart',
        'NOAA_MBTiles_Catalog.xml',
        '2023-08-02T00:08:00Z',
        'https://example.com/test.mbtiles'
      );
      assert.strictEqual(checkForUpdates()[0]!.installedFolder, '/');

      // File in the chart-root → still root.
      setInstallFilename('folder_chart', 'folder_chart.mbtiles');
      assert.strictEqual(checkForUpdates()[0]!.installedFolder, '/');

      // File in a nested folder → the folder, normalized to forward
      // slashes. Build the stored relative path with the platform
      // separator so the test exercises the normalization on Windows too.
      setInstallFilename('folder_chart', path.join('Europe', 'NL', 'folder_chart.mbtiles'));
      assert.strictEqual(checkForUpdates()[0]!.installedFolder, 'Europe/NL');

      // A malformed absolute path must collapse to root, never leak a host
      // folder (installedFolder is documented as chart-path-relative).
      setInstallFilename('folder_chart', '/var/charts/folder_chart.mbtiles');
      assert.strictEqual(checkForUpdates()[0]!.installedFolder, '/');

      // An embedded traversal segment must collapse to root.
      setInstallFilename('folder_chart', 'Europe/../../etc/folder_chart.mbtiles');
      assert.strictEqual(checkForUpdates()[0]!.installedFolder, '/');

      // A Windows drive-prefixed path must collapse to root.
      setInstallFilename('folder_chart', 'C:\\charts\\folder_chart.mbtiles');
      assert.strictEqual(checkForUpdates()[0]!.installedFolder, '/');

      removeInstall('folder_chart');
    });
  });

  describe('rollbackInstall() / issue #120', () => {
    const CATALOG = 'NOAA_MBTiles_Catalog.xml';

    // Publish a catalog that advertises `availableDate` for `chartNumber` so
    // checkForUpdates() can compare against the tracked install date.
    async function seedCache(chartNumber: string, availableDate: string): Promise<void> {
      await seedCatalog(CATALOG, [
        {
          number: chartNumber,
          title: 'Test Chart',
          format: 'MBTiles',
          zipfile_location: 'https://example.com/test.mbtiles',
          zipfile_datetime_iso8601: availableDate
        }
      ]);
    }

    it('deletes the record on a failed FRESH install', () => {
      trackInstall('fresh', CATALOG, '2024-01-01T00:00:00Z', 'https://example.com/a.mbtiles');
      rollbackInstall('fresh');
      assert.strictEqual(getInstalledCatalogCharts()['fresh'], undefined);
    });

    it('restores the prior record on a failed UPDATE', () => {
      trackInstall('upd', CATALOG, '2024-01-01T00:00:00Z', 'https://example.com/old.mbtiles');
      setInstallFilename('upd', 'Rotterdam.mbtiles');
      // The update attempt overwrites with a newer date/url...
      trackInstall('upd', CATALOG, '2024-06-10T00:00:00Z', 'https://example.com/new.mbtiles');
      // ...then fails:
      rollbackInstall('upd');

      const rec = getInstalledCatalogCharts()['upd'];
      assert.ok(rec, 'record must survive a failed update');
      assert.strictEqual(rec.zipfile_datetime_iso8601, '2024-01-01T00:00:00Z');
      assert.strictEqual(rec.zipfile_location, 'https://example.com/old.mbtiles');
      assert.strictEqual(rec.installedFilename, 'Rotterdam.mbtiles');
      removeInstall('upd');
    });

    it('keeps flagging the update after a failed update (the #120 symptom)', async () => {
      await seedCache('enc1', '2024-06-10T00:00:00Z');
      trackInstall('enc1', CATALOG, '2024-01-01T00:00:00Z', 'https://example.com/old.mbtiles');
      setInstallFilename('enc1', 'enc1.mbtiles');
      trackInstall('enc1', CATALOG, '2024-06-10T00:00:00Z', 'https://example.com/new.mbtiles');
      rollbackInstall('enc1');

      const updates = checkForUpdates();
      const u = updates.find((x) => x.chartNumber === 'enc1');
      assert.ok(u, 'a failed update must still appear as available');
      assert.strictEqual(u.installedDate, '2024-01-01T00:00:00Z');
      assert.strictEqual(u.availableDate, '2024-06-10T00:00:00Z');
      removeInstall('enc1');
    });

    it('does not resurrect the old record after a successful update', () => {
      trackInstall('s', CATALOG, '2024-01-01T00:00:00Z', 'https://example.com/v1.mbtiles');
      setInstallFilename('s', 'v1.mbtiles');
      trackInstall('s', CATALOG, '2024-06-10T00:00:00Z', 'https://example.com/v2.mbtiles');
      setInstallFilename('s', 'v2.mbtiles'); // success commits, clears the marker
      // A stray rollback on a committed record is a no-op — it must neither
      // restore v1 nor delete the settled install.
      rollbackInstall('s');
      const rec = getInstalledCatalogCharts()['s'];
      assert.ok(rec, 'a committed record must survive a stray rollback');
      assert.strictEqual(rec.zipfile_datetime_iso8601, '2024-06-10T00:00:00Z');
      assert.strictEqual(rec.installedFilename, 'v2.mbtiles');
      assert.ok(!('previousVersion' in rec), 'commit must clear the snapshot marker');
      removeInstall('s');
    });

    it('restores the original across sequential failed updates', () => {
      trackInstall('seq', CATALOG, '2024-01-01T00:00:00Z', 'https://example.com/v1.mbtiles');
      setInstallFilename('seq', 'v1.mbtiles');
      for (const attempt of ['2024-03-01T00:00:00Z', '2024-06-10T00:00:00Z']) {
        trackInstall('seq', CATALOG, attempt, 'https://example.com/x.mbtiles');
        rollbackInstall('seq');
        const rec = getInstalledCatalogCharts()['seq'];
        assert.ok(rec);
        assert.strictEqual(rec.zipfile_datetime_iso8601, '2024-01-01T00:00:00Z');
      }
      removeInstall('seq');
    });

    it('is a no-op for a chart that was never tracked', () => {
      assert.doesNotThrow(() => {
        rollbackInstall('never-tracked');
      });
      assert.strictEqual(getInstalledCatalogCharts()['never-tracked'], undefined);
    });

    it('is keyed exactly and does not fuzzy-match other charts', () => {
      trackInstall('2', CATALOG, '2024-01-01T00:00:00Z', 'https://example.com/2.mbtiles');
      trackInstall('20', CATALOG, '2024-01-01T00:00:00Z', 'https://example.com/20.mbtiles');
      rollbackInstall('20'); // fresh → deletes '20' only
      assert.ok(getInstalledCatalogCharts()['2'], "'2' must be untouched by rollback of '20'");
      assert.strictEqual(getInstalledCatalogCharts()['20'], undefined);
      removeInstall('2');
    });

    it('removeInstall drops the whole record (incl. snapshot) so a later rollback cannot resurrect it', () => {
      trackInstall('d', CATALOG, '2024-01-01T00:00:00Z', 'https://example.com/old.mbtiles');
      setInstallFilename('d', 'd.mbtiles');
      trackInstall('d', CATALOG, '2024-06-10T00:00:00Z', 'https://example.com/new.mbtiles'); // previousVersion = old
      removeInstall('d'); // deletes the whole record, snapshot and all
      trackInstall('d', CATALOG, '2024-09-01T00:00:00Z', 'https://example.com/newer.mbtiles'); // fresh → previousVersion null
      rollbackInstall('d'); // fresh pending → deletes
      assert.strictEqual(getInstalledCatalogCharts()['d'], undefined);
    });

    it('persists the prior version inside the on-disk record (restart-safe)', () => {
      trackInstall('p', CATALOG, '2024-01-01T00:00:00Z', 'https://example.com/v1.mbtiles');
      setInstallFilename('p', 'v1.mbtiles'); // committed v1
      trackInstall('p', CATALOG, '2024-06-10T00:00:00Z', 'https://example.com/v2.mbtiles'); // begin update
      const raw = JSON.parse(
        fs.readFileSync(path.join(TEST_DATA_DIR, 'catalog-installs.json'), 'utf-8')
      ) as Record<string, CatalogInstall>;
      assert.strictEqual(raw['p']!.zipfile_datetime_iso8601, '2024-06-10T00:00:00Z');
      const snap = raw['p']!.previousVersion;
      assert.ok(snap, 'snapshot must be persisted on disk');
      assert.strictEqual(snap.zipfile_datetime_iso8601, '2024-01-01T00:00:00Z');
      assert.strictEqual(snap.installedFilename, 'v1.mbtiles');
      assert.ok(!('previousVersion' in snap), 'snapshot must not nest');
      removeInstall('p');
    });

    it('survives a restart mid-update: load auto-rolls-back to prior (no reap needed)', async () => {
      await seedCache('rst', '2024-06-10T00:00:00Z');
      trackInstall('rst', CATALOG, '2024-01-01T00:00:00Z', 'https://example.com/old.mbtiles');
      setInstallFilename('rst', 'rst.mbtiles'); // committed old
      trackInstall('rst', CATALOG, '2024-06-10T00:00:00Z', 'https://example.com/new.mbtiles'); // begin update, NOT committed

      // Simulate a Signal K restart: drop module memory, reload from disk.
      // Recovery is automatic in loadInstalls() — NO manual rollbackInstall,
      // because orphan-reap does not fire for a download-phase restart.
      await initCatalogManagerOffline();

      const rec = getInstalledCatalogCharts()['rst'];
      assert.ok(rec, 'prior version must survive the restart');
      assert.strictEqual(rec.zipfile_datetime_iso8601, '2024-01-01T00:00:00Z');
      assert.strictEqual(rec.zipfile_location, 'https://example.com/old.mbtiles');
      assert.strictEqual(rec.installedFilename, 'rst.mbtiles');
      assert.ok(!('previousVersion' in rec), 'recovery must clear the snapshot marker');

      const u = checkForUpdates().find((x) => x.chartNumber === 'rst');
      assert.ok(u, 'the still-pending update must keep surfacing after a restart');
      assert.strictEqual(u.installedDate, '2024-01-01T00:00:00Z');
      assert.strictEqual(u.availableDate, '2024-06-10T00:00:00Z');
      removeInstall('rst');
    });

    it('survives a restart mid-update even when pruneStaleInstalls runs', async () => {
      // Reproduces the live finding: prune runs at startup before any reap and
      // must NOT delete an in-flight record (the new file isn't on disk yet, so
      // its chartId is absent from the scanned set). With load-time recovery the
      // record is already rolled back to the prior version by the time prune
      // runs; prune must leave that prior record intact.
      await seedCache('prn', '2024-06-10T00:00:00Z');
      trackInstall('prn', CATALOG, '2024-01-01T00:00:00Z', 'https://example.com/old.mbtiles');
      setInstallFilename('prn', 'old-prn.mbtiles'); // committed old → chartId 'old-prn'
      trackInstall('prn', CATALOG, '2024-06-10T00:00:00Z', 'https://example.com/new.mbtiles'); // begin update

      await initCatalogManagerOffline(); // restart → load auto-rolls-back to old-prn
      // Startup then scans charts and prunes. The old file IS on disk, so its
      // chartId is present; pass it so prune keeps the recovered record.
      pruneStaleInstalls(['old-prn']);

      const rec = getInstalledCatalogCharts()['prn'];
      assert.ok(rec, 'recovered prior record must survive prune');
      assert.strictEqual(rec.zipfile_datetime_iso8601, '2024-01-01T00:00:00Z');
      assert.strictEqual(rec.installedFilename, 'old-prn.mbtiles');
      removeInstall('prn');
    });

    it('survives a restart mid-fresh-install: pending record dropped on load', async () => {
      trackInstall('frsh', CATALOG, '2024-01-01T00:00:00Z', 'https://example.com/a.mbtiles');
      await initCatalogManagerOffline(); // restart → load drops the never-committed fresh record
      assert.strictEqual(getInstalledCatalogCharts()['frsh'], undefined);
    });

    it('does not delete a committed record that has no snapshot marker', () => {
      trackInstall('cm', CATALOG, '2024-01-01T00:00:00Z', 'https://example.com/v1.mbtiles');
      setInstallFilename('cm', 'v1.mbtiles'); // committed, marker cleared
      rollbackInstall('cm'); // spurious reap
      assert.ok(getInstalledCatalogCharts()['cm'], 'committed record must not be deleted');
      removeInstall('cm');
    });
  });

  describe('getCatalogData()', () => {
    it('returns null for a catalog the merged catalog does not list', () => {
      assert.strictEqual(getCatalogData('NONEXISTENT_Catalog.xml'), null);
    });

    it('returns a listed catalog in the shape the tab and downloads use', async () => {
      const chart = {
        number: 'c1',
        title: 'Chart One',
        format: 'MBTiles',
        zipfile_location: 'https://example.com/c1.mbtiles',
        zipfile_datetime_iso8601: '2024-01-01T00:00:00Z'
      };
      await seedCatalog('DATA_TEST_Catalog.xml', [chart]);
      const data = getCatalogData('DATA_TEST_Catalog.xml');
      assert.ok(data);
      assert.strictEqual(data.catalogFile, 'DATA_TEST_Catalog.xml');
      assert.deepStrictEqual(data.charts, [chart]);
      const entry = getCatalogRegistry().find((r) => r.file === 'DATA_TEST_Catalog.xml');
      assert.strictEqual(entry?.label, 'Label for DATA_TEST_Catalog.xml');
      assert.strictEqual(entry.category, 'mbtiles');
      assert.strictEqual(entry.chartCount, 1);
    });
  });

  describe('interpretCatalog()', () => {
    const chart = (n: string, url = `https://example.com/${n}.zip`) => ({
      number: n,
      title: n,
      format: '',
      zipfile_location: url,
      zipfile_datetime_iso8601: '2024-01-01T00:00:00Z'
    });

    it('rejects a catalog from a newer, breaking schema version', () => {
      const result = interpretCatalog(mergedCatalog({}, 2));
      assert.ok(!result.ok);
      assert.strictEqual(result.reason, 'incompatible');
      assert.match(result.message, /Update the plugin/);
    });

    it('calls a missing, non-numeric or older schemaVersion damaged, not newer', () => {
      for (const version of [null, '1', 0]) {
        const raw = mergedCatalog({}) as Record<string, unknown>;
        if (version === null) {
          delete raw.schemaVersion;
        } else {
          raw.schemaVersion = version;
        }
        const result = interpretCatalog(raw);
        assert.ok(!result.ok);
        assert.strictEqual(result.reason, 'invalid', String(version));
      }
    });

    it('rejects garbage as damaged', () => {
      for (const raw of ['nope', [], null, { schemaVersion: 1 }]) {
        const result = interpretCatalog(raw);
        assert.ok(!result.ok);
        assert.strictEqual(result.reason, 'invalid');
      }
    });

    it('keeps an entry whose facets use values this version does not know', () => {
      const raw = mergedCatalog({ 'NEW_Catalog.xml': [chart('a')] }, 1, {
        'NEW_Catalog.xml': { format: 'pmtiles', category: 'inland', regions: 'not-a-list' }
      });
      const result = interpretCatalog(raw);
      assert.ok(result.ok);
      assert.strictEqual(result.catalog.chartcatalogs.get('NEW_Catalog.xml')?.charts.length, 1);
      assert.strictEqual(result.skippedEntries, 0);
    });

    it('drops only the charts it cannot read, not their catalog', () => {
      const raw = mergedCatalog({
        'MIXED_Catalog.xml': [chart('ok1'), chart('ftp', 'ftp://example.com/x.zip'), chart('ok2')]
      });
      const result = interpretCatalog(raw);
      assert.ok(result.ok);
      assert.deepStrictEqual(
        result.catalog.chartcatalogs.get('MIXED_Catalog.xml')?.charts.map((c) => c.number),
        ['ok1', 'ok2']
      );
      assert.strictEqual(result.skippedCharts, 1);
    });

    it('skips an entry missing what the plugin needs', () => {
      const raw = mergedCatalog({ 'GOOD_Catalog.xml': [], 'BAD_Catalog.xml': [] }, 1, {
        'BAD_Catalog.xml': { label: undefined }
      }) as { online: unknown[] };
      raw.online.push({ id: 'future-chart', chart: { type: 'Hologram' } });
      const result = interpretCatalog(raw);
      assert.ok(result.ok);
      assert.deepStrictEqual([...result.catalog.chartcatalogs.keys()], ['GOOD_Catalog.xml']);
      assert.strictEqual(result.skippedEntries, 2);
    });

    it('keeps an online chart in an unknown category, skips one of an unknown type', () => {
      const online = (overrides: Record<string, unknown>) => ({
        id: 'x',
        name: 'X',
        description: 'd',
        category: 'weather',
        regions: ['global'],
        bbox: [-180, -85, 180, 85],
        provider: 'p',
        attribution: 'a',
        license: 'l',
        licenseUrl: 'https://example.com',
        chart: { type: 'WMS', url: 'https://example.com/ows', layers: ['a'] },
        use: 'stream',
        format: 'wms',
        ...overrides
      });
      const raw = mergedCatalog({}) as { online: unknown[] };
      raw.online.push(
        online({ id: 'tides', category: 'tides', regions: 'not-a-list' }),
        online({ id: 'holo', chart: { type: 'Hologram', url: 'https://example.com' } })
      );
      const result = interpretCatalog(raw);
      assert.ok(result.ok);
      assert.deepStrictEqual(
        result.catalog.online.map((c) => c.id),
        ['tides']
      );
      assert.strictEqual(result.skippedEntries, 1);
    });

    it('ignores unknown fields', () => {
      const raw = mergedCatalog({ 'X_Catalog.xml': [] }, 1, {
        'X_Catalog.xml': { futureField: { anything: 1 } }
      }) as Record<string, unknown>;
      raw.futureTopLevel = true;
      const result = interpretCatalog(raw);
      assert.ok(result.ok);
      assert.strictEqual(result.skippedEntries, 0);
    });

    it('drops malformed or non-https source links but keeps the catalog', () => {
      for (const bad of [
        { chartcatalogs: { homepage: 42 }, online: {} },
        {
          chartcatalogs: {
            homepage: 'https://chartcatalogs.github.io/',
            issues: 'https://github.com/chartcatalogs/catalogs/issues',
            license: 'CC0-1.0'
          },
          online: { homepage: 'https://x.test', issues: 'javascript:alert(1)' }
        }
      ]) {
        const raw = mergedCatalog({ 'X_Catalog.xml': [] }) as Record<string, unknown>;
        raw.sources = bad;
        const result = interpretCatalog(raw);
        assert.ok(result.ok);
        assert.strictEqual(result.catalog.sources, null);
      }
    });
  });

  describe('getCatalogRegistry() download categories', () => {
    it('maps format facets, and file names when a catalog is unindexed', async () => {
      stubFetch({
        status: 200,
        body: mergedCatalog(
          {
            'A_Catalog.xml': [],
            'B_Catalog.xml': [],
            'C_Catalog.xml': [],
            'D_Catalog.xml': [],
            'XX_IENC_Catalog.xml': [],
            'YY_RNC_Catalog.xml': [],
            'ZZ_Other_Catalog.xml': []
          },
          1,
          {
            'A_Catalog.xml': { format: 'enc' },
            'B_Catalog.xml': { format: 'rnc' },
            'C_Catalog.xml': { format: 'shapefile' },
            'D_Catalog.xml': { format: 'pmtiles' },
            'XX_IENC_Catalog.xml': { format: undefined, indexed: false },
            'YY_RNC_Catalog.xml': { format: undefined, indexed: false },
            'ZZ_Other_Catalog.xml': { format: undefined, indexed: false }
          }
        )
      });
      await refreshCatalog();
      mock.restoreAll();
      const categories = Object.fromEntries(getCatalogRegistry().map((r) => [r.file, r.category]));
      assert.deepStrictEqual(categories, {
        'A_Catalog.xml': 'ienc',
        'B_Catalog.xml': 'rnc',
        'C_Catalog.xml': 'general',
        'D_Catalog.xml': 'general',
        'XX_IENC_Catalog.xml': 'ienc',
        'YY_RNC_Catalog.xml': 'rnc',
        'ZZ_Other_Catalog.xml': 'general'
      });
    });
  });

  describe('refreshCatalog()', () => {
    const CHART = {
      number: 'r1',
      title: 'Refresh Chart',
      format: 'MBTiles',
      zipfile_location: 'https://example.com/r1.mbtiles',
      zipfile_datetime_iso8601: '2024-01-01T00:00:00Z'
    };

    afterEach(() => {
      mock.restoreAll();
    });

    it('loads and caches a downloaded catalog', async () => {
      stubFetch({ status: 200, body: mergedCatalog({ 'R_Catalog.xml': [CHART] }), etag: '"e1"' });
      await refreshCatalog();
      assert.strictEqual(getCatalogStatus().status, 'ok');
      assert.ok(getCatalogData('R_Catalog.xml'));
      const cache = JSON.parse(
        fs.readFileSync(path.join(TEST_DATA_DIR, 'catalog-cache', 'merged-catalog.json'), 'utf-8')
      ) as { etag: string };
      assert.strictEqual(cache.etag, '"e1"');
    });

    it('revalidates with the stored ETag and keeps the catalog on 304', async () => {
      stubFetch({ status: 200, body: mergedCatalog({ 'R_Catalog.xml': [CHART] }), etag: '"e2"' });
      await refreshCatalog();
      mock.restoreAll();
      const calls = stubFetch({ status: 304 });
      await refreshCatalog();
      assert.strictEqual(calls.headers[0]?.['If-None-Match'], '"e2"');
      assert.strictEqual(getCatalogStatus().status, 'ok');
      assert.ok(getCatalogData('R_Catalog.xml'));
    });

    it('keeps the last good catalog when offline', async () => {
      stubFetch({ status: 200, body: mergedCatalog({ 'R_Catalog.xml': [CHART] }) });
      await refreshCatalog();
      mock.restoreAll();
      stubFetch({ networkError: true });
      await refreshCatalog();
      const status = getCatalogStatus();
      assert.strictEqual(status.status, 'error');
      assert.strictEqual(status.httpStatus, null);
      assert.ok(getCatalogData('R_Catalog.xml'), 'last good catalog must survive');
    });

    it('keeps the last good catalog when the published one is incompatible', async () => {
      stubFetch({ status: 200, body: mergedCatalog({ 'R_Catalog.xml': [CHART] }) });
      await refreshCatalog();
      mock.restoreAll();
      stubFetch({ status: 200, body: mergedCatalog({}, 2) });
      await refreshCatalog();
      assert.strictEqual(getCatalogStatus().status, 'incompatible');
      assert.ok(getCatalogData('R_Catalog.xml'));
    });

    it('reports an HTTP error without discarding the catalog', async () => {
      stubFetch({ status: 200, body: mergedCatalog({ 'R_Catalog.xml': [CHART] }) });
      await refreshCatalog();
      mock.restoreAll();
      stubFetch({ status: 503 });
      await refreshCatalog();
      assert.strictEqual(getCatalogStatus().status, 'error');
      assert.strictEqual(getCatalogStatus().httpStatus, 503);
      assert.ok(getCatalogData('R_Catalog.xml'));
    });

    it('serves the cached catalog after a restart with no network', async () => {
      stubFetch({ status: 200, body: mergedCatalog({ 'R_Catalog.xml': [CHART] }) });
      await refreshCatalog();
      mock.restoreAll();
      await initCatalogManagerOffline();
      assert.ok(getCatalogData('R_Catalog.xml'));
    });

    it('single-flight: concurrent refreshes issue one download', async () => {
      const calls = stubFetch({ status: 200, body: mergedCatalog({}) });
      await Promise.all([refreshCatalog(), refreshCatalog()]);
      assert.strictEqual(calls.urls.length, 1);
    });

    it('downloads from CHARTS_CATALOG_URL when set', async () => {
      process.env.CHARTS_CATALOG_URL = 'https://example.org/fork/catalog.json';
      try {
        await initCatalogManagerOffline();
        const calls = stubFetch({ status: 304 });
        await refreshCatalog();
        assert.strictEqual(calls.urls[0], 'https://example.org/fork/catalog.json');
      } finally {
        delete process.env.CHARTS_CATALOG_URL;
        mock.restoreAll();
        await initCatalogManagerOffline();
      }
    });

    it('fetches the whole file when a 304 answers an ETag this start no longer holds', async () => {
      const calls = stubFetch(
        { status: 304 },
        { status: 200, body: mergedCatalog({ 'R_Catalog.xml': [CHART] }) }
      );
      initCatalogManager(path.join(TEST_DATA_DIR, 'no-cache'), () => {});
      await refreshCatalog();
      mock.restoreAll();
      assert.ok(getCatalogData('R_Catalog.xml'));
      assert.strictEqual(getCatalogStatus().status, 'ok');
      assert.ok(calls.urls.length >= 1);
      await initCatalogManagerOffline();
    });

    it('records a 304 in the cache so the catalog age survives a restart', async () => {
      stubFetch({ status: 200, body: mergedCatalog({ 'R_Catalog.xml': [CHART] }), etag: '"e3"' });
      await refreshCatalog();
      mock.restoreAll();
      const cachePath = path.join(TEST_DATA_DIR, 'catalog-cache', 'merged-catalog.json');
      const before = (JSON.parse(fs.readFileSync(cachePath, 'utf-8')) as { fetchedAt: string })
        .fetchedAt;
      await new Promise((r) => setTimeout(r, 5));
      stubFetch({ status: 304 });
      await refreshCatalog();
      const after = JSON.parse(fs.readFileSync(cachePath, 'utf-8')) as {
        fetchedAt: string;
        catalog: unknown;
      };
      assert.ok(after.fetchedAt > before);
      assert.ok(after.catalog, 'the catalog itself must still be cached');
    });

    it('reports a damaged download without losing the last good catalog', async () => {
      stubFetch({ status: 200, body: mergedCatalog({ 'R_Catalog.xml': [CHART] }) });
      await refreshCatalog();
      mock.restoreAll();
      stubFetch({ status: 200, body: '{"truncated": ' });
      await refreshCatalog();
      const status = getCatalogStatus();
      assert.strictEqual(status.status, 'error');
      assert.match(status.message ?? '', /damaged/);
      assert.ok(getCatalogData('R_Catalog.xml'));
    });

    it('does not re-download a fresh catalog when the tab opens', async () => {
      stubFetch({ status: 200, body: mergedCatalog({ 'R_Catalog.xml': [CHART] }) });
      await refreshCatalog();
      mock.restoreAll();
      const calls = stubFetch({ status: 304 });
      refreshCatalogIfStale();
      await refreshCatalog(); // settle anything it started
      assert.strictEqual(calls.urls.length, 1, 'only the explicit refresh may fetch');
    });

    it('starts empty, without crashing, from a corrupt cache', async () => {
      const dir = path.join(TEST_DATA_DIR, 'corrupt');
      fs.mkdirSync(path.join(dir, 'catalog-cache'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'catalog-cache', 'merged-catalog.json'),
        '{"fetchedAt": "x", '
      );
      stubFetch({ networkError: true });
      initCatalogManager(dir, () => {});
      await refreshCatalog();
      mock.restoreAll();
      assert.deepStrictEqual(getCatalogRegistry(), []);
      assert.strictEqual(getCatalogStatus().status, 'error');
      await initCatalogManagerOffline();
    });

    it('keeps the old per-file caches until a merged catalog has loaded', async () => {
      const dir = path.join(TEST_DATA_DIR, 'first-run');
      const cacheDir = path.join(dir, 'catalog-cache');
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(path.join(cacheDir, '_registry.json'), '[]');
      stubFetch({ networkError: true });
      initCatalogManager(dir, () => {});
      await refreshCatalog();
      mock.restoreAll();
      assert.ok(fs.existsSync(path.join(cacheDir, '_registry.json')));
      stubFetch({ status: 200, body: mergedCatalog({ 'R_Catalog.xml': [CHART] }) });
      await refreshCatalog();
      mock.restoreAll();
      assert.ok(!fs.existsSync(path.join(cacheDir, '_registry.json')));
      await initCatalogManagerOffline();
    });

    it('tells the listener when downloaded content changes, and only then', async () => {
      const withHash = (hash: string) => {
        const raw = mergedCatalog({ 'R_Catalog.xml': [CHART] }) as Record<string, unknown>;
        raw.contentHash = hash.repeat(64);
        return raw;
      };
      stubFetch({ status: 200, body: withHash('a'), etag: '"a"' });
      await refreshCatalog();
      mock.restoreAll();

      let calls = 0;
      setCatalogChangedListener(() => {
        calls++;
      });
      try {
        stubFetch({ status: 304 });
        await refreshCatalog();
        mock.restoreAll();
        stubFetch({ status: 200, body: withHash('a') });
        await refreshCatalog();
        mock.restoreAll();
        assert.strictEqual(calls, 0, 'unchanged content must not notify');

        stubFetch({ status: 200, body: withHash('b') });
        await refreshCatalog();
        mock.restoreAll();
        assert.strictEqual(calls, 1);

        setCatalogChangedListener(null);
        stubFetch({ status: 200, body: withHash('c') });
        await refreshCatalog();
        assert.strictEqual(calls, 1, 'a removed listener is not called');
      } finally {
        setCatalogChangedListener(null);
        mock.restoreAll();
      }
    });

    it('removes the per-file caches the GitHub-based catalog left behind', async () => {
      const cacheDir = path.join(TEST_DATA_DIR, 'catalog-cache');
      fs.writeFileSync(path.join(cacheDir, '_registry.json'), '[]');
      fs.writeFileSync(path.join(cacheDir, 'NOAA_MBTiles_Catalog.json'), '{}');
      await initCatalogManagerOffline();
      assert.ok(!fs.existsSync(path.join(cacheDir, '_registry.json')));
      assert.ok(!fs.existsSync(path.join(cacheDir, 'NOAA_MBTiles_Catalog.json')));
    });
  });
});
