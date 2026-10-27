import { test, expect } from '@playwright/test';
import { setMockState } from './helpers.js';

test.describe('convert charts already on the server', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/plugins/signalk-charts-provider-simple/');
    await setMockState(page, {});
    await page.getByRole('button', { name: /^Convert$/i }).click();
  });

  test('says which toolchain converts charts', async ({ page }) => {
    const note = page.locator('#convertEngineNote');
    await expect(note).toBeVisible();
    await expect(note).toContainText('the built-in GDAL (WebAssembly, gdal3.js 2.8.1)');
    await expect(note).toContainText('signalk-container');
  });

  test('converts an S-57 folder with the chosen zoom levels', async ({ page }) => {
    await page.locator('#convertS57Maxzoom').selectOption('16');
    await page.locator('#s57LocalPath').fill('/srv/charts/ENC_ROOT');
    const request = page.waitForRequest((r) => r.url().endsWith('/convert-local'));
    await page.locator('button[data-convert-local="s57"]').click();

    expect((await request).postDataJSON()).toEqual({
      type: 's57',
      path: '/srv/charts/ENC_ROOT',
      minzoom: 4,
      maxzoom: 16
    });
    const job = page.locator('.download-job').first();
    await expect(job).toContainText('/srv/charts/ENC_ROOT');
    await expect(job).toContainText('S-57 ENC conversion');
    await expect(job).toContainText(/Converting 2 cells and 1 ZIP file|Exporting/);
    await expect(page.locator('#s57LocalPath')).toHaveValue('');
  });

  test('converts a BSB folder on Enter and shows why a path is refused', async ({ page }) => {
    const input = page.locator('#rncLocalPath');
    await input.fill('/srv/charts/missing');
    const request = page.waitForRequest((r) => r.url().endsWith('/convert-local'));
    await input.press('Enter');

    expect((await request).postDataJSON()).toEqual({
      type: 'rnc',
      path: '/srv/charts/missing'
    });
    const job = page.locator('.download-job.status-failed');
    await expect(job).toContainText('BSB Raster conversion');
    await expect(job).toContainText('/srv/charts/missing does not exist on the Signal K server');
    await expect(input).toHaveValue('/srv/charts/missing');
  });
});
