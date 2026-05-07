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
});
