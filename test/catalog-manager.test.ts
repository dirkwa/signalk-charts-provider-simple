/**
 * Tests for the catalog manager module
 */

import { describe, it, before, after, afterEach, mock } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
// NOTE: the module under test imports from 'https' (not 'node:https'); ESM
// treats those as separate module instances, so we must mock the SAME
// specifier for the stub to intercept the dist module's https.get.
import https from 'https';
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
  getCachedCatalog,
  pruneStaleInstalls,
  fetchCatalogRegistry,
  getRegistryStatus
} from '../dist/utils/catalog-manager.js';
import type { CatalogInstall } from '../dist/types.js';

// ESM equivalent of CJS `__dirname`.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Test data dir is created on demand; doesn't need to live in the
// shared fixtures tree. Compiled tests resolve __dirname to dist-test/,
// so the data dir ends up at dist-test/fixtures/catalog-test-data —
// gets cleaned in the test's after hook so no commit-time leakage.
const TEST_DATA_DIR = path.join(__dirname, 'fixtures', 'catalog-test-data');

// Minimal https.get stub that resolves an empty 200 registry, so any fetch it
// covers never touches the network. Shared by the outer init and the
// rate-limit suite's drain so neither makes a live GitHub call.
function stubHttpsEmpty200(): void {
  mock.method(https, 'get', (...args: unknown[]) => {
    const cb = args[args.length - 1] as (r: unknown) => void;
    const req = {
      on() {
        return req;
      },
      setTimeout() {
        return req;
      },
      destroy() {
        /* no-op */
      }
    };
    process.nextTick(() => {
      const response = {
        statusCode: 200,
        headers: { 'x-ratelimit-remaining': '60' },
        resume() {
          /* drained */
        },
        on(event: string, handler: (chunk?: Buffer) => void) {
          if (event === 'data') {
            handler(Buffer.from('[]'));
          }
          if (event === 'end') {
            handler();
          }
          return response;
        }
      };
      cb(response);
    });
    return req;
  });
}

// Every initCatalogManager() fire-and-forgets fetchCatalogRegistry(), so any
// call (suite setup AND each restart simulation) must run under a stub or it
// makes a live GitHub call and leaks an in-flight request into later
// assertions. This wraps init: stub https.get, init (its synchronous
// loadInstalls/recovery runs here, before the await), drain the pending
// fetch, restore.
async function initCatalogManagerOffline(): Promise<void> {
  stubHttpsEmpty200();
  initCatalogManager(TEST_DATA_DIR, () => {});
  await fetchCatalogRegistry().catch(() => undefined);
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
    it('should return an array (may be empty before GitHub fetch)', () => {
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

    it('should detect when catalog has newer version', () => {
      // Write a fake cache with a newer date
      const cacheDir = path.join(TEST_DATA_DIR, 'catalog-cache');
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
      fs.writeFileSync(
        path.join(cacheDir, 'NOAA_MBTiles_Catalog.json'),
        JSON.stringify(cacheData),
        'utf-8'
      );

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

    it('should not flag charts with same date as updated', () => {
      const cacheDir = path.join(TEST_DATA_DIR, 'catalog-cache');
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
      fs.writeFileSync(
        path.join(cacheDir, 'NOAA_MBTiles_Catalog.json'),
        JSON.stringify(cacheData),
        'utf-8'
      );

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

    it('reports installedFolder as POSIX, defaulting to root', () => {
      const cacheDir = path.join(TEST_DATA_DIR, 'catalog-cache');
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
      fs.writeFileSync(
        path.join(cacheDir, 'NOAA_MBTiles_Catalog.json'),
        JSON.stringify(cacheData),
        'utf-8'
      );

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
    const CACHE_FILE = 'NOAA_MBTiles_Catalog.json';
    const CATALOG = 'NOAA_MBTiles_Catalog.xml';

    // Write a cache that advertises `availableDate` for `chartNumber` so
    // checkForUpdates() can compare against the tracked install date.
    function seedCache(chartNumber: string, availableDate: string): void {
      const cacheDir = path.join(TEST_DATA_DIR, 'catalog-cache');
      fs.writeFileSync(
        path.join(cacheDir, CACHE_FILE),
        JSON.stringify({
          fetchedAt: new Date().toISOString(),
          catalogFile: CATALOG,
          header: { title: 'Test' },
          charts: [
            {
              number: chartNumber,
              title: 'Test Chart',
              format: 'MBTiles',
              zipfile_location: 'https://example.com/test.mbtiles',
              zipfile_datetime_iso8601: availableDate
            }
          ]
        }),
        'utf-8'
      );
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

    it('keeps flagging the update after a failed update (the #120 symptom)', () => {
      seedCache('enc1', '2024-06-10T00:00:00Z');
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
      seedCache('rst', '2024-06-10T00:00:00Z');
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
      seedCache('prn', '2024-06-10T00:00:00Z');
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

  describe('getCachedCatalog()', () => {
    it('should return null for non-existent cache', () => {
      const result = getCachedCatalog('NONEXISTENT_Catalog.xml');
      assert.strictEqual(result, null);
    });

    it('should return cached data regardless of age', () => {
      const cacheDir = path.join(TEST_DATA_DIR, 'catalog-cache');
      const cacheData = {
        fetchedAt: '2020-01-01T00:00:00Z', // very old
        catalogFile: 'OLD_TEST_Catalog.xml',
        header: { title: 'Old Test' },
        charts: [
          {
            number: 'old1',
            title: 'Old Chart',
            format: '',
            zipfile_location: '',
            zipfile_datetime_iso8601: ''
          }
        ]
      };
      fs.writeFileSync(
        path.join(cacheDir, 'OLD_TEST_Catalog.json'),
        JSON.stringify(cacheData),
        'utf-8'
      );

      const result = getCachedCatalog('OLD_TEST_Catalog.xml');
      assert.ok(result);
      assert.strictEqual(result.charts.length, 1);
      assert.strictEqual(result.charts[0]!.number, 'old1');
    });
  });

  describe('fetchCatalogRegistry() rate-limit status', () => {
    // Build a fake https.IncomingMessage and a fake ClientRequest, and stub
    // https.get so fetchCatalogRegistry sees our scripted response.
    interface FakeRes {
      statusCode: number;
      headers: Record<string, string>;
      body?: string;
    }
    function stubHttps(res: FakeRes | { networkError: true }): void {
      mock.method(https, 'get', (...args: unknown[]) => {
        const cb = args[args.length - 1] as (r: unknown) => void;
        const req = {
          on(event: string, handler: (err: Error) => void) {
            if ('networkError' in res && event === 'error') {
              process.nextTick(() => handler(new Error('ENOTFOUND')));
            }
            return req;
          },
          setTimeout() {
            return req;
          },
          destroy() {
            /* no-op */
          }
        };
        if (!('networkError' in res)) {
          process.nextTick(() => {
            const response = {
              statusCode: res.statusCode,
              headers: res.headers,
              resume() {
                /* drained */
              },
              on(event: string, handler: (chunk?: Buffer) => void) {
                if (res.statusCode === 200) {
                  if (event === 'data') {
                    handler(Buffer.from(res.body ?? '[]'));
                  }
                  if (event === 'end') {
                    handler();
                  }
                }
                return response;
              }
            };
            cb(response);
          });
        }
        return req;
      });
    }

    before(async () => {
      // The outer before already drained the init fetch under a stub; this is
      // belt-and-suspenders in case any prior fetch is still in flight. Stubbed
      // so it can never make a live GitHub call.
      stubHttpsEmpty200();
      await fetchCatalogRegistry().catch(() => undefined);
      mock.restoreAll();
    });

    afterEach(() => {
      mock.restoreAll();
    });

    it('flags rate_limited and captures resetAt on a 403 with remaining 0', async () => {
      stubHttps({
        statusCode: 403,
        headers: {
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': '1749532800',
          'retry-after': '3600'
        }
      });
      await assert.rejects(fetchCatalogRegistry(), /GitHub API returned 403/);
      const s = getRegistryStatus();
      assert.strictEqual(s.status, 'rate_limited');
      assert.strictEqual(s.isRateLimited, true);
      assert.strictEqual(s.remaining, 0);
      assert.strictEqual(s.resetAt, 1749532800 * 1000);
      assert.strictEqual(s.retryAfter, 3600);
      assert.strictEqual(s.httpStatus, 403);
    });

    it('a 403 WITHOUT remaining 0 is a generic error, not rate-limited', async () => {
      stubHttps({ statusCode: 403, headers: { 'x-ratelimit-remaining': '12' } });
      await assert.rejects(fetchCatalogRegistry());
      const s = getRegistryStatus();
      assert.strictEqual(s.isRateLimited, false);
      assert.strictEqual(s.status, 'error');
    });

    it('a 200 clears the rate-limit flag, metadata, and records remaining', async () => {
      // First a 403 that sets isRateLimited + resetAt + retryAfter...
      stubHttps({
        statusCode: 403,
        headers: {
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': '1749532800',
          'retry-after': '3600'
        }
      });
      await assert.rejects(fetchCatalogRegistry());
      assert.strictEqual(getRegistryStatus().isRateLimited, true);
      assert.strictEqual(getRegistryStatus().resetAt, 1749532800 * 1000);
      mock.restoreAll();

      // ...then a 200 must clear all of it, not just the flag, so a stale
      // rate-limit banner can't slip through while status === 'ok'.
      stubHttps({ statusCode: 200, headers: { 'x-ratelimit-remaining': '57' }, body: '[]' });
      await fetchCatalogRegistry();
      const s = getRegistryStatus();
      assert.strictEqual(s.status, 'ok');
      assert.strictEqual(s.isRateLimited, false);
      assert.strictEqual(s.remaining, 57);
      assert.strictEqual(s.resetAt, null, 'a success must clear the stale reset time');
      assert.strictEqual(s.retryAfter, null, 'a success must clear the stale retry-after');
    });

    it('a network error is status error with null httpStatus (not rate-limited)', async () => {
      stubHttps({ networkError: true });
      await assert.rejects(fetchCatalogRegistry());
      const s = getRegistryStatus();
      assert.strictEqual(s.status, 'error');
      assert.strictEqual(s.isRateLimited, false);
      assert.strictEqual(s.httpStatus, null);
    });

    it('single-flight: two concurrent calls issue one https.get', async () => {
      const getMock = mock.method(https, 'get', (...args: unknown[]) => {
        const cb = args[args.length - 1] as (r: unknown) => void;
        const req = {
          on() {
            return req;
          },
          setTimeout() {
            return req;
          },
          destroy() {
            /* no-op */
          }
        };
        setTimeout(() => {
          const response = {
            statusCode: 200,
            headers: {},
            resume() {
              /* drained */
            },
            on(event: string, handler: (chunk?: Buffer) => void) {
              if (event === 'data') {
                handler(Buffer.from('[]'));
              }
              if (event === 'end') {
                handler();
              }
              return response;
            }
          };
          cb(response);
        }, 20);
        return req;
      });
      await Promise.all([fetchCatalogRegistry(), fetchCatalogRegistry()]);
      assert.strictEqual(getMock.mock.callCount(), 1);
    });
  });
});
