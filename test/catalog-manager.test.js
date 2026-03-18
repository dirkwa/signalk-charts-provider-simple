/**
 * Tests for the catalog manager module
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const {
  initCatalogManager,
  getCatalogRegistry,
  classifyUrl,
  trackInstall,
  removeInstall,
  getInstalledCatalogCharts,
  checkForUpdates,
  getCatalogsWithInstalledCharts,
  getCachedCatalog,
  CATALOG_REGISTRY
} = require('../src/utils/catalog-manager');

const TEST_DATA_DIR = path.join(__dirname, 'fixtures', 'catalog-test-data');

describe('CatalogManager', () => {
  before(() => {
    // Clean up any previous test data
    if (fs.existsSync(TEST_DATA_DIR)) {
      fs.rmSync(TEST_DATA_DIR, { recursive: true });
    }
    initCatalogManager(TEST_DATA_DIR, () => {});
  });

  after(() => {
    // Clean up test data
    if (fs.existsSync(TEST_DATA_DIR)) {
      fs.rmSync(TEST_DATA_DIR, { recursive: true });
    }
  });

  describe('getCatalogRegistry()', () => {
    it('should return 27 catalog entries', () => {
      const registry = getCatalogRegistry();
      assert.strictEqual(registry.length, 27);
    });

    it('should have required fields on each entry', () => {
      const registry = getCatalogRegistry();
      for (const entry of registry) {
        assert.ok(entry.file, 'entry should have file');
        assert.ok(entry.label, 'entry should have label');
        assert.ok(entry.category, 'entry should have category');
        assert.ok(
          ['mbtiles', 'general', 'rnc', 'ienc'].includes(entry.category),
          `invalid category: ${entry.category}`
        );
      }
    });

    it('should have exactly one mbtiles catalog', () => {
      const registry = getCatalogRegistry();
      const mbtiles = registry.filter((r) => r.category === 'mbtiles');
      assert.strictEqual(mbtiles.length, 1);
      assert.strictEqual(mbtiles[0].file, 'NOAA_MBTiles_Catalog.xml');
    });

    it('should include chartCount and cachedAt fields', () => {
      const registry = getCatalogRegistry();
      for (const entry of registry) {
        assert.ok('chartCount' in entry, 'entry should have chartCount');
        assert.ok('cachedAt' in entry, 'entry should have cachedAt');
      }
    });
  });

  describe('CATALOG_REGISTRY', () => {
    it('should have unique file names', () => {
      const files = CATALOG_REGISTRY.map((r) => r.file);
      const unique = new Set(files);
      assert.strictEqual(unique.size, files.length, 'duplicate file names found');
    });

    it('all files should end with _Catalog.xml', () => {
      for (const entry of CATALOG_REGISTRY) {
        assert.ok(
          entry.file.endsWith('_Catalog.xml'),
          `${entry.file} should end with _Catalog.xml`
        );
      }
    });
  });

  describe('classifyUrl()', () => {
    it('should classify .mbtiles as supported', () => {
      const result = classifyUrl(
        'https://distribution.charts.noaa.gov/ncds/mbtiles/ncds_01a.mbtiles'
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

      const result2 = classifyUrl('https://example.com/chart.zip');
      assert.strictEqual(result2.supported, false);
    });

    it('should classify .tar.xz as unsupported', () => {
      const result = classifyUrl('https://example.com/chart.tar.xz');
      assert.strictEqual(result.supported, false);
      assert.strictEqual(result.format, 'tar');
    });

    it('should classify .tar.gz as unsupported', () => {
      const result = classifyUrl('https://example.com/chart.tar.gz');
      assert.strictEqual(result.supported, false);
      assert.strictEqual(result.format, 'tar');
    });

    it('should handle null/empty url', () => {
      const result = classifyUrl(null);
      assert.strictEqual(result.supported, false);
      assert.strictEqual(result.format, 'unknown');

      const result2 = classifyUrl('');
      assert.strictEqual(result2.supported, false);
    });

    it('should classify unknown URLs as unsupported', () => {
      const result = classifyUrl('https://example.com/some/path');
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
      const data = JSON.parse(fs.readFileSync(installsPath, 'utf-8'));
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
      assert.strictEqual(updates[0].chartNumber, 'test_chart');
      assert.strictEqual(updates[0].installedDate, '2023-08-02T00:08:00Z');
      assert.strictEqual(updates[0].availableDate, '2024-06-01T00:00:00Z');

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
        charts: [{ number: 'old1', title: 'Old Chart' }]
      };
      fs.writeFileSync(
        path.join(cacheDir, 'OLD_TEST_Catalog.json'),
        JSON.stringify(cacheData),
        'utf-8'
      );

      const result = getCachedCatalog('OLD_TEST_Catalog.xml');
      assert.ok(result);
      assert.strictEqual(result.charts.length, 1);
      assert.strictEqual(result.charts[0].number, 'old1');
    });
  });
});
