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
          file: 'NL_IENC_Catalog.xml',
          label: 'NL Inland ENC',
          category: 'ienc',
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

    await expect(page.locator('#catalogList')).toContainText('NL Inland ENC');
    await expect(page.locator('#catalogList')).toContainText('NOAA MBTiles');
    await expect(page.locator('#catalogList')).toContainText('12 charts');
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

  test('rate-limited empty registry shows warning copy + reset time, not "offline"', async ({
    page
  }) => {
    await page.goto('/plugins/signalk-charts-provider-simple/');
    const resetAt = Date.now() + 42 * 60_000;
    await setMockState(page, {
      registry: [],
      registryStatus: {
        status: 'rate_limited',
        isRateLimited: true,
        remaining: 0,
        resetAt,
        retryAfter: 3600,
        lastAttemptAt: Date.now(),
        lastSuccessAt: null,
        httpStatus: 403
      }
    });
    await page.getByRole('button', { name: /Chart Catalog/i }).click();

    const msg = page.locator('.catalog-error-rate-limit');
    await expect(msg).toBeVisible();
    await expect(msg).toContainText(/GitHub rate limit reached/i);
    await expect(msg).not.toContainText(/offline/i);
    await expect(msg).toContainText(/in about \d+ minutes?/);
  });

  test('a failed (rate-limited) refresh keeps the cached cards, shows a banner', async ({
    page
  }) => {
    await page.goto('/plugins/signalk-charts-provider-simple/');
    // Start populated; script the refresh to come back empty + rate-limited.
    await setMockState(page, {
      registry: [
        {
          file: 'DE_IENC.xml',
          label: 'Germany Inland ENC',
          category: 'ienc',
          chartCount: 3,
          cachedAt: '2026-05-07T10:00:00Z'
        }
      ],
      refreshRegistry: [],
      refreshStatus: {
        status: 'rate_limited',
        isRateLimited: true,
        remaining: 0,
        resetAt: Date.now() + 3_600_000,
        retryAfter: 3600,
        lastAttemptAt: Date.now(),
        lastSuccessAt: null,
        httpStatus: 403
      }
    });
    await page.getByRole('button', { name: /Chart Catalog/i }).click();
    await expect(page.locator('.catalog-card')).toHaveCount(1);

    await page.locator('[data-catalog-refresh]').click();

    // Cards must NOT be blanked; a non-destructive banner explains why,
    // and a GitHub rate-limit blames GitHub (not the Signal K server).
    await expect(page.locator('.catalog-card')).toHaveCount(1);
    const banner = page.locator('#catalogRegistryBanner .catalog-banner-warning');
    await expect(banner).toContainText(/cached catalogs/i);
    await expect(banner).toContainText(/GitHub rate limit/i);
  });

  test('a refresh that cannot reach the Signal K server blames the server, not GitHub', async ({
    page
  }) => {
    await page.goto('/plugins/signalk-charts-provider-simple/');
    await setMockState(page, {
      registry: [
        {
          file: 'DE_IENC.xml',
          label: 'Germany Inland ENC',
          category: 'ienc',
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
    await expect(banner).not.toContainText(/GitHub/i);
    // Cards still present (never blanked on a transport failure).
    await expect(page.locator('.catalog-card')).toHaveCount(1);
  });

  test('a successful refresh populates the list and clears any banner', async ({ page }) => {
    await page.goto('/plugins/signalk-charts-provider-simple/');
    await setMockState(page, {
      registry: [],
      registryStatus: {
        status: 'error',
        isRateLimited: false,
        remaining: null,
        resetAt: null,
        retryAfter: null,
        lastAttemptAt: Date.now(),
        lastSuccessAt: null,
        httpStatus: null
      },
      refreshRegistry: [
        {
          file: 'NL_IENC.xml',
          label: 'Netherlands Inland ENC',
          category: 'ienc',
          chartCount: 5,
          cachedAt: '2026-05-07T10:00:00Z'
        }
      ],
      refreshStatus: {
        status: 'ok',
        isRateLimited: false,
        remaining: 49,
        resetAt: null,
        retryAfter: null,
        lastAttemptAt: Date.now(),
        lastSuccessAt: Date.now(),
        httpStatus: 200
      }
    });
    await page.getByRole('button', { name: /Chart Catalog/i }).click();
    // Empty + error first.
    await expect(page.locator('.catalog-error')).toBeVisible();

    await page.locator('[data-catalog-refresh]').click();

    await expect(page.locator('.catalog-card')).toHaveCount(1);
    await expect(page.locator('#catalogRegistryBanner')).toBeEmpty();
  });
});
