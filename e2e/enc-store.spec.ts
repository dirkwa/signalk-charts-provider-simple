import { test, expect, type Page } from '@playwright/test';
import { setMockState } from './helpers.js';

async function openEncChartsTab(page: Page): Promise<void> {
  await page.locator('#customCatalogsTabBtn').click();
}

const collections = [
  {
    id: 'Gulf_of_Finland',
    name: 'Gulf of Finland',
    kind: 'chart-set',
    source: 'chart-set',
    cellCount: 2,
    bytes: 3 * 1024 * 1024,
    updatedAt: '2026-10-29T10:00:00.000Z',
    dir: '/data/enc-store/Gulf_of_Finland'
  },
  {
    id: 'US5MA1AM',
    name: 'US5MA1AM',
    kind: 'conversion',
    chart: 'US5MA1AM.mbtiles',
    source: 'upload',
    cellCount: 1,
    bytes: 512 * 1024,
    updatedAt: '2026-10-29T11:00:00.000Z',
    dir: '/data/enc-store/US5MA1AM'
  }
];

const file = (name: string, bytes: number) => ({
  name,
  bytes,
  modified: '2026-10-29T10:00:00.000Z'
});

test.describe('ENC Charts tab: shared ENC cells', () => {
  test('lists the shared collections and their cells on request', async ({ page }) => {
    await page.goto('/plugins/signalk-charts-provider-simple/');
    await setMockState(page, {
      encStore: { root: '/data/enc-store', keepEncCells: false, collections },
      encStoreCells: {
        Gulf_of_Finland: [
          {
            name: 'FI5AAAAA',
            version: 'FI5AAAAA_ED003_UP002',
            files: [file('FI5AAAAA.000', 1024 * 1024), file('FI5AAAAA.001', 2048)]
          },
          { name: 'FI4BBBBB', files: [file('FI4BBBBB.000', 2 * 1024 * 1024)] }
        ]
      }
    });
    await openEncChartsTab(page);

    const panel = page.locator('#ccShared');
    await expect(panel.locator('.cc-shared-row')).toHaveCount(2);
    await expect(panel).toContainText('Gulf of Finland');
    await expect(panel).toContainText('2 cell(s) · 3.0 MB · chart set');
    await expect(panel).toContainText('/data/enc-store');
    await expect(panel).toContainText('Keep the ENC cells of converted charts');
    // Only a converted chart's cells can be removed here.
    await expect(panel.locator('[data-cc-action="shared-delete"]')).toHaveCount(1);

    const toggle = panel.locator(
      '[data-cc-action="shared-toggle"][data-cc-collection="Gulf_of_Finland"]'
    );
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    // Opening and closing a collection reads only its cells, not the whole store again.
    const storeReads: string[] = [];
    page.on('request', (r) => {
      if (new URL(r.url()).pathname.endsWith('/enc-store')) {
        storeReads.push(r.url());
      }
    });
    await toggle.click();
    const list = panel.locator('[data-cc-cells="Gulf_of_Finland"]');
    await expect(list.locator('.cc-shared-cell')).toHaveCount(2);
    await expect(list).toContainText('FI5AAAAA_ED003_UP002');
    await expect(list.locator('a', { hasText: '001' })).toHaveAttribute(
      'href',
      '/plugins/signalk-charts-provider-simple/enc-store/Gulf_of_Finland/FI5AAAAA/FI5AAAAA.001'
    );
    await expect(
      panel.locator('[data-cc-action="shared-toggle"][data-cc-collection="Gulf_of_Finland"]')
    ).toHaveAttribute('aria-expanded', 'true');

    // Closing hides the list again.
    await panel
      .locator('[data-cc-action="shared-toggle"][data-cc-collection="Gulf_of_Finland"]')
      .click();
    await expect(panel.locator('[data-cc-cells="Gulf_of_Finland"]')).toBeHidden();
    expect(storeReads).toEqual([]);
  });

  test('removes a converted chart’s cells after confirming', async ({ page }) => {
    await page.goto('/plugins/signalk-charts-provider-simple/');
    await setMockState(page, {
      encStore: { root: '/data/enc-store', keepEncCells: true, collections }
    });
    await openEncChartsTab(page);
    const panel = page.locator('#ccShared');
    await expect(panel).toContainText('Converted ENC charts keep their cells here too.');

    page.once('dialog', (dialog) => void dialog.accept());
    await panel.locator('[data-cc-action="shared-delete"][data-cc-collection="US5MA1AM"]').click();
    await expect(panel.locator('.cc-shared-row')).toHaveCount(1);
    await expect(panel).not.toContainText('US5MA1AM');
  });
});
