import { test, expect, type Page } from '@playwright/test';
import { setMockState } from './helpers.js';
import { PAGE_PATH } from './page-path.js';

const NOUMEA = { latitude: -22.27, longitude: 166.44 };

async function mapCenter(page: Page): Promise<{ lat: number; lng: number }> {
  return page.evaluate(() => {
    const center = (window as unknown as { eval(code: string): L.LatLng }).eval(
      'ccMap.getCenter()'
    );
    return { lat: center.lat, lng: center.lng };
  });
}

test.describe('ENC Charts tab: the boat on the map', () => {
  test('opens at the boat when no set has units, and comes back to it', async ({ page }) => {
    await page.goto(PAGE_PATH);
    await setMockState(page, { position: NOUMEA });
    await page.locator('#customCatalogsTabBtn').click();

    const goTo = page.getByRole('button', { name: 'Go to vessel' });
    await expect(goTo).toBeVisible();
    await expect.poll(async () => (await mapCenter(page)).lat).toBeCloseTo(NOUMEA.latitude, 1);
    expect((await mapCenter(page)).lng).toBeCloseTo(NOUMEA.longitude, 1);

    await page.evaluate(() => {
      (window as unknown as { eval(code: string): void }).eval(
        'ccMap.setView([20, 0], 2, { animate: false })'
      );
    });
    await goTo.click();
    await expect.poll(async () => (await mapCenter(page)).lat).toBeCloseTo(NOUMEA.latitude, 1);

    await page.evaluate(() => {
      (window as unknown as { eval(code: string): void }).eval(
        'ccMap.setView([20, 0], 2, { animate: false })'
      );
    });
    await goTo.focus();
    await page.keyboard.press('Space');
    await expect.poll(async () => (await mapCenter(page)).lat).toBeCloseTo(NOUMEA.latitude, 1);
  });

  test('shows the whole world without a position', async ({ page }) => {
    await page.goto(PAGE_PATH);
    await setMockState(page, { position: null });
    await page.locator('#customCatalogsTabBtn').click();

    await expect(page.locator('#ccMap[data-framed]')).toBeAttached();
    expect((await mapCenter(page)).lat).toBeCloseTo(20, 0);
    expect(
      await page.evaluate(() =>
        (window as unknown as { eval(code: string): number }).eval('ccMap.getZoom()')
      )
    ).toBe(2);
    await expect(page.getByRole('button', { name: 'Go to vessel' })).toHaveCount(0);
  });
});
