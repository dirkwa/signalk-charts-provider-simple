import { test, expect } from '@playwright/test';
import { setMockState } from './helpers.js';

test.describe('Manage Charts tab', () => {
  test('renders the configured charts from /local-charts', async ({ page }) => {
    await page.goto('/plugins/signalk-charts-provider-simple/');
    await setMockState(page, {
      localCharts: {
        basePath: '/tmp/charts',
        folders: ['/'],
        charts: [
          {
            relativePath: 'foo.mbtiles',
            name: 'Foo Chart',
            folder: '/',
            enabled: true
          },
          {
            relativePath: 'bar.mbtiles',
            name: 'Bar Chart',
            folder: '/',
            enabled: true
          }
        ]
      }
    });

    // Re-trigger the load for the manage tab (it reads /local-charts on
    // tab activation; we already loaded the page before mock state was
    // set, so the first fetch returned an empty list).
    await page.evaluate(() => {
      const handler = (window as unknown as { handleManageTabActive?: () => void })
        .handleManageTabActive;
      if (typeof handler !== 'function') {
        // Fail loudly: a silent skip would let the test pass on the
        // initial empty load even after the production global was
        // renamed, masking a real regression.
        throw new Error(
          'window.handleManageTabActive is not a function — did the production API change?'
        );
      }
      handler();
    });

    // Both chart cards eventually appear.  Same timeout on both: same
    // async fetch, so the second shouldn't fall back to a shorter
    // default and cause inconsistent flake.
    await expect(page.locator('#manageOutput')).toContainText('Foo Chart', { timeout: 5000 });
    await expect(page.locator('#manageOutput')).toContainText('Bar Chart', { timeout: 5000 });
  });

  test('renders empty state when /local-charts returns no charts', async ({ page }) => {
    await page.goto('/plugins/signalk-charts-provider-simple/');
    await setMockState(page, {
      localCharts: {
        basePath: '/tmp/charts',
        folders: ['/'],
        charts: []
      }
    });
    await page.evaluate(() => {
      const handler = (window as unknown as { handleManageTabActive?: () => void })
        .handleManageTabActive;
      if (typeof handler !== 'function') {
        // Fail loudly: a silent skip would let the test pass on the
        // initial empty load even after the production global was
        // renamed, masking a real regression.
        throw new Error(
          'window.handleManageTabActive is not a function — did the production API change?'
        );
      }
      handler();
    });

    // Empty state shows the "Welcome..." onboarding card; text varies
    // by version, so match a stable sentence fragment from the body.
    await expect(page.locator('#manageOutput')).toContainText(
      /Welcome to Charts Provider Simple/i,
      { timeout: 5000 }
    );
  });

  test('offers a ZIP upload control wired to a .zip file input', async ({ page }) => {
    await page.goto('/plugins/signalk-charts-provider-simple/');
    await setMockState(page, {
      localCharts: {
        basePath: '/tmp/charts',
        folders: ['/'],
        charts: [{ relativePath: 'foo.mbtiles', name: 'Foo Chart', folder: '/', enabled: true }]
      }
    });
    await page.evaluate(() => {
      (window as unknown as { handleManageTabActive: () => void }).handleManageTabActive();
    });

    const zipButton = page.getByRole('button', { name: 'Upload ZIP' });
    await expect(zipButton).toBeVisible({ timeout: 5000 });

    // The hidden input is what actually carries the archive; if its accept
    // filter drifts away from .zip the picker starts offering the wrong
    // files, which no assertion on the button alone would catch.
    const zipInput = page.locator('#chartZipUploadInput');
    await expect(zipInput).toHaveAttribute('accept', '.zip');
    // Single archive per upload — the route takes only the first file.
    await expect(zipInput).not.toHaveAttribute('multiple', /.*/);

    // Clicking the button must reach that input. Intercept the click
    // rather than let it open a native file dialog Playwright can't close.
    const clicked = await page.evaluate(() => {
      const input = document.getElementById('chartZipUploadInput');
      if (!input) {
        return false;
      }
      let sawClick = false;
      input.addEventListener('click', (e) => {
        sawClick = true;
        e.preventDefault();
      });
      (window as unknown as { triggerZipUpload: () => void }).triggerZipUpload();
      return sawClick;
    });
    expect(clicked).toBe(true);
  });

  test('offers ZIP upload from the empty state too', async ({ page }) => {
    await page.goto('/plugins/signalk-charts-provider-simple/');
    await setMockState(page, {
      localCharts: { basePath: '/tmp/charts', folders: ['/'], charts: [] }
    });
    await page.evaluate(() => {
      (window as unknown as { handleManageTabActive: () => void }).handleManageTabActive();
    });

    await expect(page.getByRole('button', { name: 'Upload ZIP' })).toBeVisible({ timeout: 5000 });
    await expect(page.locator('#chartZipUploadInputEmpty')).toHaveAttribute('accept', '.zip');
  });
});
