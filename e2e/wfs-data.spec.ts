import { test, expect, type Page } from '@playwright/test';
import { setMockState } from './helpers.js';
import { PAGE_PATH } from './page-path.js';

async function openWfsTab(page: Page): Promise<void> {
  await page.locator('#wfsDataTabBtn').click();
}

/** The changes the page asks of the server, as method, path and body. */
function recordChanges(page: Page): { method: string; path: string; body?: unknown }[] {
  const seen: { method: string; path: string; body?: unknown }[] = [];
  page.on('request', (req) => {
    const url = new URL(req.url());
    if (req.method() !== 'GET' && url.pathname.includes('/wfs')) {
      const data = req.postData();
      seen.push({
        method: req.method(),
        path: url.pathname.replace(/^.*\/wfs/, '/wfs') + url.search,
        ...(data ? { body: JSON.parse(data) as unknown } : {})
      });
    }
  });
  return seen;
}

const kept = {
  url: 'https://wfs.example.org/geoserver/wfs',
  name: 'Depth areas',
  answersByBox: true,
  answerMargin: 0.12,
  stats: {
    areas: 3,
    staleAreas: 1,
    features: 1234,
    bytes: 5 * 1024 * 1024,
    oldest: Date.parse('2026-10-01T10:00:00Z'),
    newest: Date.parse('2026-11-01T10:00:00Z'),
    layers: [
      {
        typeName: 'DepthArea_A',
        areas: 3,
        staleAreas: 1,
        features: 1234,
        bytes: 5 * 1024 * 1024,
        oldest: null,
        newest: null
      }
    ]
  }
};

test.describe('WFS Data tab', () => {
  test('shows what each server keeps', async ({ page }) => {
    await page.goto(PAGE_PATH);
    await setMockState(page, {
      wfs: {
        enabled: true,
        running: true,
        maxAgeDays: 30,
        limitBytes: 1024 ** 3,
        store: { fileBytes: 6 * 1024 * 1024, usedBytes: 5 * 1024 * 1024 },
        sources: [kept]
      }
    });
    await openWfsTab(page);
    const output = page.locator('#wfsOutput');
    await expect(output.getByText('Depth areas')).toBeVisible();
    await expect(output.getByText(/3 areas \(1 due for download\)/)).toBeVisible();
    await expect(output.getByText('DepthArea_A')).toBeVisible();
  });

  test('adds a server and deletes what one keeps', async ({ page }) => {
    await page.goto(PAGE_PATH);
    await setMockState(page, {
      wfs: {
        enabled: true,
        running: true,
        maxAgeDays: 30,
        limitBytes: 0,
        store: { fileBytes: 0, usedBytes: 0 },
        sources: [kept]
      }
    });
    const changes = recordChanges(page);
    await openWfsTab(page);
    await page.locator('#wfsUrl').fill('https://other.example.org/wfs');
    await page.locator('#wfsByBox').check();
    await page.locator('#wfsMargin').fill('0.2');
    await page.getByRole('button', { name: 'Add WFS server' }).click();
    await expect(
      page.locator('#wfsOutput').getByText('https://other.example.org/wfs')
    ).toBeVisible();

    page.once('dialog', (dialog) => void dialog.accept());
    await page.getByRole('button', { name: 'Delete data' }).first().click();
    await expect(page.locator('#wfsMessage')).toContainText('Deleted');

    expect(changes).toEqual([
      {
        method: 'POST',
        path: '/wfs/sources',
        body: { url: 'https://other.example.org/wfs', answersByBox: true, answerMargin: 0.2 }
      },
      {
        method: 'DELETE',
        path: `/wfs/data?url=${encodeURIComponent(kept.url)}`
      }
    ]);
  });
});
