import { test, expect } from '@playwright/test';

test.describe('tabs', () => {
  test('app loads with Manage Charts tab active by default', async ({ page }) => {
    await page.goto('/plugins/signalk-charts-provider-simple/');

    await expect(page.getByRole('button', { name: /Manage Charts/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /Download from URL/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /Convert/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /Chart Catalog/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /NOAA Charts/i })).toBeVisible();

    // Manage tab content area should be the active one on first load.
    await expect(page.locator('#manage')).toHaveClass(/active/);
    await expect(page.locator('#catalog')).not.toHaveClass(/active/);
  });

  test('clicking the Chart Catalog tab activates it', async ({ page }) => {
    await page.goto('/plugins/signalk-charts-provider-simple/');

    await page.getByRole('button', { name: /Chart Catalog/i }).click();

    await expect(page.locator('#catalog')).toHaveClass(/active/);
    await expect(page.locator('#manage')).not.toHaveClass(/active/);
  });
});
