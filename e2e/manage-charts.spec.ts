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

  test('renders a disabled folder and its charts grayed out', async ({ page }) => {
    await page.goto('/plugins/signalk-charts-provider-simple/');
    await setMockState(page, {
      localCharts: {
        basePath: '/tmp/charts',
        folders: ['/', 'Netherlands'],
        folderStates: {
          '/': { enabled: true, effectiveEnabled: true },
          Netherlands: { enabled: false, effectiveEnabled: false }
        },
        charts: [
          {
            relativePath: 'Netherlands/nl.mbtiles',
            name: 'NL Chart',
            folder: 'Netherlands',
            enabled: true,
            folderEnabled: false
          }
        ]
      }
    });
    await page.evaluate(() => {
      (window as unknown as { handleManageTabActive: () => void }).handleManageTabActive();
    });

    await expect(page.locator('.folder-btn.folder-disabled')).toHaveCount(1, { timeout: 5000 });
    await expect(page.locator('.folder-btn.folder-disabled')).toContainText('Netherlands');
    // The initial (pre-seed) empty load auto-selects the root folder, which
    // would hide the Netherlands chart — switch back to the all-folders view.
    await page.getByRole('button', { name: 'All Folders' }).click();
    await expect(page.locator('.chart-card.folder-off')).toHaveCount(1);
    await expect(page.locator('.folder-off-badge')).toContainText('Folder disabled');
    // The root pseudo-folder is never toggleable, so only one toggle renders.
    await expect(page.locator('.folder-toggle')).toHaveCount(1);
  });

  test('folder toggle POSTs to /folders/toggle without selecting the folder', async ({ page }) => {
    await page.goto('/plugins/signalk-charts-provider-simple/');
    await setMockState(page, {
      localCharts: {
        basePath: '/tmp/charts',
        folders: ['/', 'Netherlands'],
        folderStates: {
          '/': { enabled: true, effectiveEnabled: true },
          Netherlands: { enabled: true, effectiveEnabled: true }
        },
        charts: [
          {
            relativePath: 'Netherlands/nl.mbtiles',
            name: 'NL Chart',
            folder: 'Netherlands',
            enabled: true,
            folderEnabled: true
          }
        ]
      }
    });
    await page.evaluate(() => {
      (window as unknown as { handleManageTabActive: () => void }).handleManageTabActive();
    });

    const toggle = page.locator('.folder-toggle');
    await expect(toggle).toBeVisible({ timeout: 5000 });
    // The initial (pre-seed) empty load auto-selects the root folder, which
    // would hide the Netherlands chart — switch back to the all-folders view.
    await page.getByRole('button', { name: 'All Folders' }).click();

    const requestPromise = page.waitForRequest(
      (request) => request.url().includes('/folders/toggle') && request.method() === 'POST'
    );
    await toggle.click();
    const request = await requestPromise;
    expect(request.postDataJSON()).toEqual({ folderPath: 'Netherlands', enabled: false });

    // The UI refetches /local-charts; the mock cascaded the state, so the
    // chart card grays out and the folder button gets the disabled style.
    await expect(page.locator('.chart-card.folder-off')).toHaveCount(1, { timeout: 5000 });
    await expect(page.locator('.folder-btn.folder-disabled')).toHaveCount(1);
    // stopPropagation: clicking the toggle must not select the folder — the
    // "All Folders" pseudo-entry stays the active one.
    await expect(page.locator('.folder-btn.active')).toHaveCount(1);
    await expect(page.locator('.folder-btn.active')).toContainText('All Folders');
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

    // The empty state has its own input id and trigger, so the populated
    // state's coverage says nothing about this one being wired up.
    const clicked = await page.evaluate(() => {
      const input = document.getElementById('chartZipUploadInputEmpty');
      if (!input) {
        return false;
      }
      let sawClick = false;
      input.addEventListener('click', (e) => {
        sawClick = true;
        e.preventDefault();
      });
      (window as unknown as { triggerZipUploadEmpty: () => void }).triggerZipUploadEmpty();
      return sawClick;
    });
    expect(clicked).toBe(true);
  });
});
