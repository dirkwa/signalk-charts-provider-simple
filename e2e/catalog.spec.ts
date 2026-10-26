import { test, expect } from '@playwright/test';
import { setMockState, patchMockState } from './helpers.js';

test.describe('Chart Catalog tab', () => {
  test('shows "No catalogs in this category" on an empty registry', async ({ page }) => {
    await page.goto('/plugins/signalk-charts-provider-simple/');
    await setMockState(page, { registry: [] });
    await page.getByRole('button', { name: /Chart Catalog/i }).click();
    await expect(page.locator('#catalogList')).toContainText(/No catalogs/i);
  });

  test('renders catalog cards from the registry', async ({ page }) => {
    await page.goto('/plugins/signalk-charts-provider-simple/');
    await setMockState(page, {
      registry: [
        {
          file: 'NZ_RNC.xml',
          label: 'New Zealand Raster Charts',
          category: 'rnc',
          chartCount: 12,
          cachedAt: '2026-05-07T10:00:00Z'
        },
        {
          file: 'NOAA_MBTiles_Catalog.xml',
          label: 'NOAA MBTiles',
          category: 'mbtiles',
          chartCount: 1234,
          cachedAt: '2026-05-07T10:00:00Z'
        }
      ]
    });
    await page.getByRole('button', { name: /Chart Catalog/i }).click();

    await expect(page.locator('#catalogList')).toContainText('New Zealand Raster Charts');
    await expect(page.locator('#catalogList')).toContainText('NOAA MBTiles');
    await expect(page.locator('#catalogList')).toContainText('12 charts');
  });

  test('lists an ENC source only when a chart was installed from it', async ({ page }) => {
    await page.goto('/plugins/signalk-charts-provider-simple/');
    await setMockState(page, {
      registry: [
        {
          file: 'NL_IENC_Catalog.xml',
          label: 'NL Inland ENC',
          category: 'ienc',
          chartCount: 12,
          cachedAt: '2026-05-07T10:00:00Z',
          facets: { category: 'navigation', format: 'enc' }
        },
        {
          file: 'DE_IENC_Catalog.xml',
          label: 'Germany Inland ENC',
          category: 'ienc',
          chartCount: 42,
          cachedAt: '2026-05-07T10:00:00Z',
          facets: { category: 'navigation', format: 'enc' }
        },
        {
          file: 'NOAA_MBTiles_Catalog.xml',
          label: 'NOAA MBTiles',
          category: 'mbtiles',
          chartCount: 1234,
          cachedAt: '2026-05-07T10:00:00Z',
          facets: { category: 'navigation', format: 'mbtiles' }
        }
      ],
      installed: {
        '1R7WAD01': {
          catalogFile: 'NL_IENC_Catalog.xml',
          zipfile_datetime_iso8601: '2026-04-01T00:00:00Z',
          installedAt: '2026-04-02T00:00:00Z'
        }
      }
    });
    await page.getByRole('button', { name: /Chart Catalog/i }).click();

    await expect(page.locator('.catalog-card-title')).toHaveText(['NL Inland ENC', 'NOAA MBTiles']);
    await expect(
      page.locator(
        '[data-filter-group="categories"][data-filter-value="navigation"] .category-count'
      )
    ).toHaveText('2');

    await page.locator('#catalogSourceNote').getByRole('link', { name: 'ENC Charts' }).click();
    await expect(page.locator('#customCatalogs')).toHaveClass(/active/);
  });

  test('points to ENC Charts when the catalog lists only ENC sources', async ({ page }) => {
    await page.goto('/plugins/signalk-charts-provider-simple/');
    await setMockState(page, {
      registry: [
        {
          file: 'DE_IENC_Catalog.xml',
          label: 'Germany Inland ENC',
          category: 'ienc',
          chartCount: 42,
          cachedAt: '2026-05-07T10:00:00Z',
          facets: { category: 'navigation', format: 'enc' }
        }
      ]
    });
    await page.getByRole('button', { name: /Chart Catalog/i }).click();

    const list = page.locator('#catalogList');
    await expect(page.locator('.catalog-card')).toHaveCount(0);
    await expect(list).not.toContainText('Clear filters');
    await list.getByRole('link', { name: 'ENC Charts' }).click();
    await expect(page.locator('#customCatalogs')).toHaveClass(/active/);
  });

  test('a finished install from an ENC source lists it and updates the filter counts', async ({
    page
  }) => {
    await page.goto('/plugins/signalk-charts-provider-simple/');
    await setMockState(page, {
      registry: [
        {
          file: 'NL_IENC_Catalog.xml',
          label: 'NL Inland ENC',
          category: 'ienc',
          chartCount: 12,
          cachedAt: '2026-05-07T10:00:00Z',
          facets: { category: 'navigation', format: 'enc' }
        },
        {
          file: 'NOAA_MBTiles_Catalog.xml',
          label: 'NOAA MBTiles',
          category: 'mbtiles',
          chartCount: 1234,
          cachedAt: '2026-05-07T10:00:00Z',
          facets: { category: 'navigation', format: 'mbtiles' }
        }
      ],
      converting: { '1R7WAD01': true }
    });
    await page.getByRole('button', { name: /Chart Catalog/i }).click();

    const navigation = page.locator(
      '[data-filter-group="categories"][data-filter-value="navigation"]'
    );
    await expect(page.locator('.catalog-card-title')).toHaveText(['NOAA MBTiles']);
    await expect(navigation.locator('.category-count')).toHaveText('1');

    await patchMockState(page, {
      converting: {},
      installed: {
        '1R7WAD01': {
          catalogFile: 'NL_IENC_Catalog.xml',
          zipfile_datetime_iso8601: '2026-04-01T00:00:00Z',
          installedAt: '2026-05-08T00:00:00Z'
        }
      }
    });

    await expect(page.locator('.catalog-card-title')).toHaveText(
      ['NL Inland ENC', 'NOAA MBTiles'],
      {
        timeout: 10_000
      }
    );
    await expect(navigation.locator('.category-count')).toHaveText('2');
  });

  test('an install recorded with no conversion running lists its ENC source', async ({ page }) => {
    await page.goto('/plugins/signalk-charts-provider-simple/');
    await setMockState(page, {
      registry: [
        {
          file: 'NL_IENC_Catalog.xml',
          label: 'NL Inland ENC',
          category: 'ienc',
          chartCount: 12,
          cachedAt: '2026-05-07T10:00:00Z',
          facets: { category: 'navigation', format: 'enc' }
        },
        {
          file: 'NOAA_MBTiles_Catalog.xml',
          label: 'NOAA MBTiles',
          category: 'mbtiles',
          chartCount: 1234,
          cachedAt: '2026-05-07T10:00:00Z',
          facets: { category: 'navigation', format: 'mbtiles' }
        }
      ]
    });
    await page.getByRole('button', { name: /Chart Catalog/i }).click();
    await expect(page.locator('.catalog-card-title')).toHaveText(['NOAA MBTiles']);

    await patchMockState(page, {
      installed: {
        '1R7WAD01': {
          catalogFile: 'NL_IENC_Catalog.xml',
          zipfile_datetime_iso8601: '2026-04-01T00:00:00Z',
          installedAt: '2026-05-08T00:00:00Z'
        }
      }
    });

    await expect(page.locator('.catalog-card-title')).toHaveText(
      ['NL Inland ENC', 'NOAA MBTiles'],
      { timeout: 10_000 }
    );
    await expect(
      page.locator(
        '[data-filter-group="categories"][data-filter-value="navigation"] .category-count'
      )
    ).toHaveText('2');
  });

  test('an install made by another client shows as installed in an expanded catalog', async ({
    page
  }) => {
    const chart = {
      number: 'US5MA1AA',
      title: 'Boston Harbor',
      format: 'MBTiles',
      zipfile_location: 'https://example.com/boston.mbtiles',
      zipfile_datetime_iso8601: '2026-05-01T00:00:00Z',
      urlClassification: { supported: true, format: 'mbtiles', label: 'MBTiles' }
    };
    const catalogWith = (installed: boolean) => ({
      fetchedAt: '2026-05-07T10:00:00Z',
      catalogFile: 'NOAA_MBTiles_Catalog.xml',
      header: { title: 'NOAA MBTiles' },
      charts: [{ ...chart, installed }]
    });
    await page.goto('/plugins/signalk-charts-provider-simple/');
    await setMockState(page, {
      registry: [
        {
          file: 'NOAA_MBTiles_Catalog.xml',
          label: 'NOAA MBTiles',
          category: 'mbtiles',
          chartCount: 1,
          cachedAt: '2026-05-07T10:00:00Z'
        }
      ],
      catalogs: { 'NOAA_MBTiles_Catalog.xml': catalogWith(false) }
    });
    await page.getByRole('button', { name: /Chart Catalog/i }).click();
    await page.getByText('NOAA MBTiles').click();
    await expect(page.locator('.btn-catalog-download')).toBeVisible();

    await patchMockState(page, {
      catalogs: { 'NOAA_MBTiles_Catalog.xml': catalogWith(true) },
      installed: {
        US5MA1AA: {
          catalogFile: 'NOAA_MBTiles_Catalog.xml',
          zipfile_datetime_iso8601: '2026-05-01T00:00:00Z',
          installedAt: '2026-05-08T00:00:00Z'
        }
      }
    });

    await expect(page.locator('.installed-badge')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('.btn-catalog-download')).toHaveCount(0);
  });

  test('pollConversions updates the in-flight message without recreating the row (regression for shimmer/scrollbar/progress reset bugs)', async ({
    page
  }) => {
    await page.goto('/plugins/signalk-charts-provider-simple/');

    // Set up: one expanded catalog with a single chart that is
    // currently being converted.  The conversion pill carries a
    // stable id (`catalog-conversion-<chartNumber>`) so the poll
    // can patch its <span>.textContent without rerendering the row.
    await setMockState(page, {
      registry: [
        {
          file: 'NL_IENC.xml',
          label: 'NL IENC',
          category: 'ienc',
          chartCount: 1,
          cachedAt: '2026-05-07T10:00:00Z'
        }
      ],
      catalogs: {
        'NL_IENC.xml': {
          fetchedAt: '2026-05-07T10:00:00Z',
          catalogFile: 'NL_IENC.xml',
          header: { title: 'NL IENC' },
          charts: [
            {
              number: '1',
              title: 'Waddenzee',
              format: 'S-57',
              zipfile_location: 'https://example.com/wadd.zip',
              zipfile_datetime_iso8601: '2026-05-01T00:00:00Z',
              urlClassification: { supported: true, format: 's57-zip', label: 'S-57 ZIP' }
            }
          ]
        }
      },
      // An ENC source stays listed only for a chart installed from it.
      installed: {
        '1': {
          catalogFile: 'NL_IENC.xml',
          zipfile_datetime_iso8601: '2026-04-01T00:00:00Z',
          installedAt: '2026-04-02T00:00:00Z'
        }
      },
      converting: { '1': true },
      conversions: {
        '1': { status: 'converting', message: 'Generating tiles: 12%', log: [] }
      }
    });

    await page.getByRole('button', { name: /Chart Catalog/i }).click();
    // Expand the catalog so the chart row + conversion pill render.
    await page.getByText('NL IENC').click();

    const pill = page.locator('#catalog-conversion-1');
    await expect(pill).toBeVisible();
    await expect(pill).toContainText('Generating tiles: 12%');

    // Sentinel: tag the pill DOM node with a custom attribute we control.
    // If `renderCatalogList()` later replaces the row's HTML wholesale,
    // the new node won't carry our attribute — that's the regression
    // PR #62 fixed.  In-place text updates keep the attribute.
    await pill.evaluate((el) => {
      el.setAttribute('data-e2e-sentinel', 'pre-poll');
    });

    // Patch the mock state so the next poll sees a different message
    // for the same chart.  pollConversions runs every 3s.
    await patchMockState(page, {
      conversions: {
        '1': { status: 'converting', message: 'Generating tiles: 78%', log: [] }
      }
    });

    // Wait for the poll cycle to pick the new message up.  pollConversions
    // fires every 3s, so a 10s window covers ~3 cycles — tolerates one
    // GC pause / slow-CI hiccup without flakiness.
    await expect(pill).toContainText('Generating tiles: 78%', { timeout: 10_000 });

    // The sentinel must still be attached.  If the row was destroyed
    // and recreated, this attribute would be gone.
    const sentinel = await pill.getAttribute('data-e2e-sentinel');
    expect(sentinel).toBe('pre-poll');
  });

  test('a failed update surfaces an error in the updates panel (not a silent skip)', async ({
    page
  }) => {
    // Regression for the queue silently skipping a chart whose download
    // POST failed: downloadUpdateChart must record catalogConversionErrors
    // so the failure shows in the panel (and the queue stops on it) rather
    // than the chart vanishing with no trace.
    await page.goto('/plugins/signalk-charts-provider-simple/');
    await setMockState(page, {
      registry: [
        {
          file: 'NOAA_MBTiles_Catalog.xml',
          label: 'NOAA MBTiles',
          category: 'mbtiles',
          chartCount: 1,
          cachedAt: '2026-05-07T10:00:00Z'
        }
      ],
      catalogUpdates: [
        {
          chartNumber: '1',
          catalogFile: 'NOAA_MBTiles_Catalog.xml',
          title: 'Boston Harbor',
          installedDate: '2024-01-01T00:00:00Z',
          availableDate: '2026-05-01T00:00:00Z',
          downloadUrl: 'https://example.com/boston.mbtiles',
          installedFolder: '/'
        }
      ],
      // The next /catalog/download POST returns HTTP 500.
      downloadFailStatus: 500
    });

    await page.getByRole('button', { name: /Chart Catalog/i }).click();

    const row = page.locator('.catalog-update-row[data-chart-number="1"]');
    await expect(row).toContainText('Boston Harbor');

    // Click the per-chart Update button; the mocked POST fails.
    await row.locator('[data-catalog-update="1"]').click();

    // The failure must surface as a visible error with a Dismiss button,
    // not disappear silently.
    const errorText = row.locator('.conversion-error-text');
    await expect(errorText).toBeVisible();
    await expect(errorText).toContainText(/mock download failure/i);

    // Dismiss must clear the error from the panel — the row itself stays in
    // the DOM, only the error message is removed. The Dismiss button under
    // #catalogUpdatesSection is wired and re-renders the section.
    await row.locator('[data-catalog-dismiss="1"]').click();
    await expect(row.locator('.conversion-error-text')).toHaveCount(0);
  });

  test('a completed update drops out of the panel without re-opening the tab (issue #121)', async ({
    page
  }) => {
    // Regression for #121: after a conversion finishes, the in-memory
    // catalogUpdates was never re-fetched, so the row kept showing
    // "update available" until the user left and re-entered the tab.
    // pollConversions must call refreshUpdateBadge() on a just-finished
    // conversion so the row clears live.
    await page.goto('/plugins/signalk-charts-provider-simple/');
    await setMockState(page, {
      registry: [
        {
          file: 'NL_IENC.xml',
          label: 'NL IENC',
          category: 'ienc',
          chartCount: 1,
          cachedAt: '2026-05-07T10:00:00Z'
        }
      ],
      catalogUpdates: [
        {
          chartNumber: '1',
          catalogFile: 'NL_IENC.xml',
          title: 'Waddenzee',
          installedDate: '2024-01-01T00:00:00Z',
          availableDate: '2026-05-01T00:00:00Z',
          downloadUrl: 'https://example.com/wadd.zip',
          installedFolder: '/'
        }
      ],
      // The chart is mid-conversion: the panel shows it as updating.
      converting: { '1': true }
    });

    await page.getByRole('button', { name: /Chart Catalog/i }).click();

    const row = page.locator('.catalog-update-row[data-chart-number="1"]');
    await expect(row).toBeVisible();
    await expect(row).toHaveClass(/updating/);

    // The conversion finishes: no longer converting, and the backend no
    // longer reports it as an available update (its install date caught up).
    await patchMockState(page, { converting: {}, catalogUpdates: [] });

    // pollConversions (every 3s) must detect the just-finished conversion
    // and refresh the updates list, removing the row live — no tab reload.
    await expect(row).toHaveCount(0, { timeout: 10_000 });
  });

  test('shows a Refresh button in the catalog toolbar', async ({ page }) => {
    await page.goto('/plugins/signalk-charts-provider-simple/');
    await setMockState(page, { registry: [] });
    await page.getByRole('button', { name: /Chart Catalog/i }).click();
    await expect(page.locator('[data-catalog-refresh]')).toBeVisible();
  });

  test('an empty catalog that failed to download shows a connectivity message', async ({
    page
  }) => {
    await page.goto('/plugins/signalk-charts-provider-simple/');
    await setMockState(page, {
      registry: [],
      catalogStatus: {
        status: 'error',
        lastAttemptAt: Date.now(),
        lastSuccessAt: null,
        httpStatus: null,
        message:
          "Could not reach the chart catalog. Check this device's internet connection, then click Refresh."
      }
    });
    await page.getByRole('button', { name: /Chart Catalog/i }).click();
    await expect(page.locator('.catalog-error')).toContainText(/internet connection/i);
  });

  test('an incompatible catalog tells the user to update the plugin', async ({ page }) => {
    await page.goto('/plugins/signalk-charts-provider-simple/');
    await setMockState(page, {
      registry: [],
      catalogStatus: {
        status: 'incompatible',
        lastAttemptAt: Date.now(),
        lastSuccessAt: null,
        httpStatus: 200,
        message:
          'The chart catalog uses a newer format than this version of the plugin. Update the plugin to see it.'
      }
    });
    await page.getByRole('button', { name: /Chart Catalog/i }).click();
    await expect(page.locator('.catalog-error')).toContainText(/Update the plugin/i);
  });

  test('a failed refresh keeps the cached cards and shows a banner', async ({ page }) => {
    await page.goto('/plugins/signalk-charts-provider-simple/');
    // The server keeps serving the last good catalog when a download fails.
    await setMockState(page, {
      registry: [
        {
          file: 'NZ_RNC.xml',
          label: 'New Zealand Raster Charts',
          category: 'rnc',
          chartCount: 3,
          cachedAt: '2026-05-07T10:00:00Z'
        }
      ],
      refreshStatus: {
        status: 'error',
        lastAttemptAt: Date.now(),
        lastSuccessAt: null,
        httpStatus: null,
        message:
          "Could not reach the chart catalog. Check this device's internet connection, then click Refresh."
      }
    });
    await page.getByRole('button', { name: /Chart Catalog/i }).click();
    await expect(page.locator('.catalog-card')).toHaveCount(1);

    await page.locator('[data-catalog-refresh]').click();

    await expect(page.locator('.catalog-card')).toHaveCount(1);
    const banner = page.locator('#catalogRegistryBanner .catalog-banner-warning');
    await expect(banner).toContainText(/last downloaded catalog/i);
    await expect(banner).toContainText(/internet connection/i);
  });

  test('a refresh that cannot reach the Signal K server blames the server', async ({ page }) => {
    await page.goto('/plugins/signalk-charts-provider-simple/');
    await setMockState(page, {
      registry: [
        {
          file: 'NZ_RNC.xml',
          label: 'New Zealand Raster Charts',
          category: 'rnc',
          chartCount: 3,
          cachedAt: '2026-05-07T10:00:00Z'
        }
      ]
    });
    await page.getByRole('button', { name: /Chart Catalog/i }).click();
    await expect(page.locator('.catalog-card')).toHaveCount(1);

    // Make the refresh request to OUR endpoint fail at the transport level.
    await page.route('**/catalog-registry/refresh', (r) => r.abort());
    await page.locator('[data-catalog-refresh]').click();

    const banner = page.locator('#catalogRegistryBanner .catalog-banner-warning');
    await expect(banner).toContainText(/Signal K server/i);
    // Cards still present (never blanked on a transport failure).
    await expect(page.locator('.catalog-card')).toHaveCount(1);
  });

  test('a successful refresh populates the list and clears any banner', async ({ page }) => {
    await page.goto('/plugins/signalk-charts-provider-simple/');
    await setMockState(page, {
      registry: [],
      catalogStatus: {
        status: 'error',
        lastAttemptAt: Date.now(),
        lastSuccessAt: null,
        httpStatus: null,
        message:
          "Could not reach the chart catalog. Check this device's internet connection, then click Refresh."
      },
      refreshRegistry: [
        {
          file: 'NZ_RNC.xml',
          label: 'New Zealand Raster Charts',
          category: 'rnc',
          chartCount: 5,
          cachedAt: '2026-05-07T10:00:00Z'
        }
      ],
      refreshStatus: {
        status: 'ok',
        lastAttemptAt: Date.now(),
        lastSuccessAt: Date.now(),
        httpStatus: 200,
        message: null
      }
    });
    await page.getByRole('button', { name: /Chart Catalog/i }).click();
    // Empty + error first.
    await expect(page.locator('.catalog-error')).toBeVisible();

    await page.locator('[data-catalog-refresh]').click();

    await expect(page.locator('.catalog-card')).toHaveCount(1);
    await expect(page.locator('#catalogRegistryBanner')).toBeEmpty();
  });

  test('credits chartcatalogs with its issue tracker', async ({ page }) => {
    await page.goto('/plugins/signalk-charts-provider-simple/');
    await setMockState(page, { registry: [] });
    await page.getByRole('button', { name: /Chart Catalog/i }).click();
    const note = page.locator('#catalogSourceNote');
    await expect(
      note.locator('a[href="https://github.com/chartcatalogs/catalogs/issues"]')
    ).toBeVisible();
  });
  test('uses catalog-provided source links, but never a non-https one', async ({ page }) => {
    await page.goto('/plugins/signalk-charts-provider-simple/');
    await setMockState(page, {
      registry: [],
      sources: {
        chartcatalogs: {
          homepage: 'https://chartcatalogs.github.io/',
          issues: 'https://example.org/cc-issues',
          license: 'CC0-1.0'
        },
        online: { homepage: 'https://example.org', issues: 'javascript:alert(1)' }
      }
    });
    await page.getByRole('button', { name: /Chart Catalog/i }).click();
    const note = page.locator('#catalogSourceNote');
    await expect(note.locator('a[href="https://example.org/cc-issues"]')).toBeVisible();
    await expect(note.locator('a[href^="javascript:"]')).toHaveCount(0);
  });

  test('an incompatible catalog over a populated list shows a banner', async ({ page }) => {
    await page.goto('/plugins/signalk-charts-provider-simple/');
    await setMockState(page, {
      registry: [
        {
          file: 'NZ_RNC.xml',
          label: 'New Zealand Raster Charts',
          category: 'rnc',
          chartCount: 3,
          cachedAt: '2026-05-07T10:00:00Z'
        }
      ],
      catalogStatus: {
        status: 'incompatible',
        lastAttemptAt: Date.now(),
        lastSuccessAt: null,
        httpStatus: 200,
        message:
          'The chart catalog uses a newer format than this version of the plugin. Update the plugin to see it.'
      }
    });
    await page.getByRole('button', { name: /Chart Catalog/i }).click();
    await expect(page.locator('.catalog-card')).toHaveCount(1);
    const banner = page.locator('#catalogRegistryBanner .catalog-banner-warning');
    await expect(banner).toContainText(/Update the plugin/i);
  });
  test('two catalogs listing the same chart number keep their own folders', async ({ page }) => {
    await page.goto('/plugins/signalk-charts-provider-simple/');
    const catalog = (file: string) => ({
      fetchedAt: '2026-05-07T10:00:00Z',
      catalogFile: file,
      header: { title: file },
      charts: [
        {
          number: '11451',
          title: 'Miami to Marathon',
          format: 'MBTiles',
          zipfile_location: `https://example.com/${file}/11451.mbtiles`,
          zipfile_datetime_iso8601: '2026-05-01T00:00:00Z',
          urlClassification: { supported: true, format: 'mbtiles', label: 'MBTiles' }
        }
      ]
    });
    const entry = (file: string, label: string) => ({
      file,
      label,
      category: 'mbtiles',
      chartCount: 1,
      cachedAt: '2026-05-07T10:00:00Z'
    });
    await setMockState(page, {
      registry: [entry('A.xml', 'Alpha Charts'), entry('B.xml', 'Beta Charts')],
      catalogs: { 'A.xml': catalog('A.xml'), 'B.xml': catalog('B.xml') }
    });
    await page.getByRole('button', { name: /Chart Catalog/i }).click();
    await page.getByText('Alpha Charts').click();
    await page.getByText('Beta Charts').click();

    const beta = page.locator('#catalog-card-B\\.xml .catalog-chart-row');
    await expect(beta.getByLabel('Save to')).toHaveValue('Beta Charts');
    const request = page.waitForRequest('**/catalog/download');
    await beta.locator('[data-catalog-download]').click();
    expect((await request).postDataJSON()).toMatchObject({
      catalogFile: 'B.xml',
      targetFolder: 'Beta Charts'
    });
  });

  test('filters by category, type and position, and lists no online charts', async ({ page }) => {
    await page.goto('/plugins/signalk-charts-provider-simple/');
    await setMockState(page, {
      registry: [
        {
          file: 'NOAA_MBTiles_Catalog.xml',
          label: 'NOAA Vector Charts',
          category: 'mbtiles',
          chartCount: 46,
          cachedAt: '2026-05-07T10:00:00Z',
          // Crosses the antimeridian: Guam eastward to the US east coast.
          facets: { category: 'navigation', format: 'mbtiles', bbox: [144, -15, -64, 72] }
        },
        {
          file: 'DE_RNC_Catalog.xml',
          label: 'German Raster Charts',
          category: 'rnc',
          chartCount: 42,
          cachedAt: '2026-05-07T10:00:00Z',
          facets: { category: 'navigation', format: 'rnc', bbox: [5.8, 47.2, 15.1, 55.1] }
        },
        {
          file: 'World_Shapefile_Catalog.xml',
          label: 'World Coastlines',
          category: 'general',
          chartCount: 1,
          cachedAt: '2026-05-07T10:00:00Z',
          facets: { category: 'basemap', format: 'shapefile', bbox: [-180, -85, 180, 85] }
        }
      ],
      // The Online Charts tab lists these, not this one.
      online: [
        {
          id: 'us-radar',
          name: 'us-radar',
          description: 'd',
          category: 'weather',
          provider: 'p',
          license: 'l',
          licenseUrl: 'https://example.com',
          bbox: [-130, 20, -60, 55],
          chart: { type: 'WMS' }
        }
      ],
      position: { latitude: 24.55, longitude: -81.8 }
    });
    await page.getByRole('button', { name: /Chart Catalog/i }).click();
    const cards = page.locator('.catalog-card');
    await expect(cards).toHaveCount(3);
    await expect(page.locator('.online-chart-row')).toHaveCount(0);
    await expect(page.locator('[data-filter-group="use"]')).toHaveCount(0);
    await expect(
      page.locator('[data-filter-group="categories"][data-filter-value="weather"]')
    ).toHaveCount(0);
    // Sectioned by category, in a fixed order; downloads sorted by name.
    await expect(page.locator('.catalog-section-title')).toHaveText([
      'Navigation Charts',
      'Base Maps'
    ]);
    await expect(
      page.locator('.catalog-section').first().locator('.catalog-card-title')
    ).toHaveText(['German Raster Charts', 'NOAA Vector Charts']);

    const btn = (group: string, value: string) =>
      page.locator(`[data-filter-group="${group}"][data-filter-value="${value}"]`);

    // Navigation: counts reflect the other active filters.
    await btn('categories', 'navigation').click();
    await expect(cards).toHaveCount(2);
    await expect(btn('nearMe', '')).toContainText('1');

    // Near Key West: the antimeridian-crossing NOAA box, not Germany.
    await btn('nearMe', '').click();
    await expect(cards).toHaveCount(1);
    await expect(cards).toContainText('NOAA Vector Charts');

    // Type filters live behind "More filters".
    await btn('categories', 'navigation').click();
    await btn('nearMe', '').click();
    await expect(btn('formats', 'rnc')).toHaveCount(0);
    await btn('showTypes', '').click();
    await btn('formats', 'shapefile').click();
    await expect(cards).toHaveCount(1);
    await expect(page.locator('.catalog-section-title')).toHaveText(['Base Maps']);
  });

  test('points to the Online Charts tab', async ({ page }) => {
    await page.goto('/plugins/signalk-charts-provider-simple/');
    await setMockState(page, { registry: [] });
    await page.getByRole('button', { name: /Chart Catalog/i }).click();
    await page.locator('#catalogSourceNote').getByRole('link', { name: 'Online Charts' }).click();
    await expect(page.locator('#onlineCharts')).toHaveClass(/active/);
    await expect(page.locator('#onlineChartsTabBtn')).toHaveClass(/active/);
  });

  test('ignores a saved Stream filter from before online charts moved', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('chartCatalogFilters', JSON.stringify({ use: 'stream' }));
    });
    await page.goto('/plugins/signalk-charts-provider-simple/');
    await setMockState(page, {
      registry: [
        {
          file: 'X_Catalog.xml',
          label: 'Some Charts',
          category: 'rnc',
          chartCount: 1,
          cachedAt: '2026-05-07T10:00:00Z',
          facets: { category: 'navigation', format: 'rnc', bbox: [0, 0, 1, 1] }
        }
      ]
    });
    await page.getByRole('button', { name: /Chart Catalog/i }).click();
    await expect(page.locator('.catalog-card')).toHaveCount(1);
  });

  test('disables Near me when the server has no position', async ({ page }) => {
    await page.goto('/plugins/signalk-charts-provider-simple/');
    await setMockState(page, {
      registry: [
        {
          file: 'X_Catalog.xml',
          label: 'X',
          category: 'rnc',
          chartCount: 1,
          cachedAt: '2026-05-07T10:00:00Z',
          facets: { category: 'navigation', format: 'rnc', bbox: [0, 0, 1, 1] }
        }
      ]
    });
    await page.getByRole('button', { name: /Chart Catalog/i }).click();
    await expect(page.locator('[data-filter-group="nearMe"]')).toBeDisabled();
  });
  test('a saved Near me without a position hides nothing', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('chartCatalogFilters', JSON.stringify({ nearMe: true }));
    });
    await page.goto('/plugins/signalk-charts-provider-simple/');
    await setMockState(page, {
      registry: [
        {
          file: 'X_Catalog.xml',
          label: 'Some Charts',
          category: 'rnc',
          chartCount: 1,
          cachedAt: '2026-05-07T10:00:00Z',
          facets: { category: 'navigation', format: 'rnc', bbox: [0, 0, 1, 1] }
        }
      ]
    });
    await page.getByRole('button', { name: /Chart Catalog/i }).click();
    await expect(page.locator('.catalog-card')).toHaveCount(1);
    await expect(page.locator('[data-filter-group="nearMe"]')).toContainText('no position yet');
  });

  test('survives corrupt saved filters', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem(
        'chartCatalogFilters',
        JSON.stringify({ categories: null, use: 'bogus', formats: 'enc' })
      );
    });
    await page.goto('/plugins/signalk-charts-provider-simple/');
    const registry = [
      {
        file: 'X_Catalog.xml',
        label: 'Some Charts',
        category: 'rnc',
        chartCount: 1,
        cachedAt: '2026-05-07T10:00:00Z',
        facets: { category: 'navigation', format: 'rnc', bbox: [0, 0, 1, 1] }
      }
    ];
    await setMockState(page, { registry });
    await page.getByRole('button', { name: /Chart Catalog/i }).click();
    await expect(page.locator('.catalog-card')).toHaveCount(1);
  });

  test('keeps a saved filter the catalog no longer uses visible and clearable', async ({
    page
  }) => {
    await page.addInitScript(() => {
      localStorage.setItem('chartCatalogFilters', JSON.stringify({ categories: ['depth'] }));
    });
    await page.goto('/plugins/signalk-charts-provider-simple/');
    await setMockState(page, {
      registry: [
        {
          file: 'X_Catalog.xml',
          label: 'Some Charts',
          category: 'rnc',
          chartCount: 1,
          cachedAt: '2026-05-07T10:00:00Z',
          facets: { category: 'navigation', format: 'rnc', bbox: [0, 0, 1, 1] }
        }
      ]
    });
    await page.getByRole('button', { name: /Chart Catalog/i }).click();
    await expect(page.locator('#catalogList')).toContainText('No charts match');
    await expect(
      page.locator('[data-filter-group="categories"][data-filter-value="depth"]')
    ).toHaveAttribute('aria-pressed', 'true');
    await page.locator('#catalogList [data-filter-group="clear"]').click();
    await expect(page.locator('.catalog-card')).toHaveCount(1);
  });
});
