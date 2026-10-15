import { test, expect } from '@playwright/test';
import { setMockState } from './helpers';

test.describe('download from URL', () => {
  test('adds an online chart by URL', async ({ page }) => {
    await page.goto('/plugins/signalk-charts-provider-simple/');
    await setMockState(page, {});
    await page.getByRole('button', { name: /Download from URL/i }).click();

    await expect(page.locator('#onlineChartFolder')).toHaveValue('Online Charts');
    await expect(page.locator('#onlineChartLayersGroup')).toBeHidden();
    await page.locator('#onlineChartType').selectOption('WMS');
    await expect(page.locator('#onlineChartLayersGroup')).toBeVisible();

    await page.locator('#onlineChartName').fill('Harbour charts');
    await page.locator('#onlineChartUrl').fill('https://charts.example.org/wms');
    await page.locator('#onlineChartLayers').fill('harbour, depths');
    await page.locator('#onlineChartMaxzoom').fill('16');
    await page.locator('#onlineChartKeep').check();

    const request = page.waitForRequest((r) => r.url().endsWith('/online-charts/custom'));
    await page.getByRole('button', { name: 'Add Online Chart' }).click();
    expect((await request).postDataJSON()).toEqual({
      name: 'Harbour charts',
      folder: 'Online Charts',
      chart: {
        type: 'WMS',
        url: 'https://charts.example.org/wms',
        layers: ['harbour', 'depths'],
        maxzoom: 16,
        keepOffline: true
      }
    });
    await expect(page.locator('#onlineChartStatus')).toContainText('Added Harbour charts');
  });

  test('asks for the layers of a WMS chart before adding it', async ({ page }) => {
    await page.goto('/plugins/signalk-charts-provider-simple/');
    await setMockState(page, {});
    await page.getByRole('button', { name: /Download from URL/i }).click();
    await page.locator('#onlineChartType').selectOption('WMS');
    await page.locator('#onlineChartName').fill('No layers');
    await page.locator('#onlineChartUrl').fill('https://charts.example.org/wms');
    await page.getByRole('button', { name: 'Add Online Chart' }).click();
    await expect(page.locator('#onlineChartStatus')).toContainText('at least one layer');
  });
});
