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

const keptToo = { ...kept, url: 'https://second.example.org/wfs', name: 'Second' };

const sourceRow = (page: Page, name: string) =>
  page.locator('#wfsOutput .wfs-source').filter({ hasText: name });

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

  test('keeps the view when it cannot be read again, and retries a first read', async ({
    page
  }) => {
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
    let failing = true;
    await page.route(
      (url) => url.pathname.endsWith('/wfs'),
      (route) =>
        failing && route.request().method() === 'GET'
          ? route.fulfill({ status: 503, body: 'busy' })
          : route.fallback()
    );
    await openWfsTab(page);
    const output = page.locator('#wfsOutput');
    await expect(output).toContainText('Could not read the WFS data: HTTP 503');
    failing = false;
    await output.getByRole('button', { name: 'Retry' }).click();
    await expect(sourceRow(page, 'Depth areas')).toContainText('3 areas');

    failing = true;
    await output.getByRole('button', { name: 'Refresh' }).click();
    await expect(page.locator('#wfsMessage')).toContainText(
      'Could not read the WFS data: HTTP 503'
    );
    await expect(sourceRow(page, 'Depth areas')).toContainText('3 areas');
    failing = false;
    await output.getByRole('button', { name: 'Refresh' }).click();
    await expect(page.locator('#wfsMessage')).toBeEmpty();
  });

  test('an edit saved while the list cannot be read again is still an edit', async ({ page }) => {
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
    let failing = false;
    await page.route(
      (url) => url.pathname.endsWith('/wfs'),
      (route) =>
        failing && route.request().method() === 'GET'
          ? route.fulfill({ status: 503, body: 'busy' })
          : route.fallback()
    );
    await openWfsTab(page);
    await page.getByRole('button', { name: 'Edit' }).click();
    await page.locator('#wfsName').fill('Depth contours');
    failing = true;
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.locator('#wfsMessage')).toContainText(
      'Saved. Could not read the WFS data: HTTP 503'
    );
    failing = false;
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.locator('#wfsMessage')).toHaveText('Saved.');
    await expect(sourceRow(page, 'Depth contours')).toContainText('3 areas');
    expect(changes.map((c) => c.method)).toEqual(['PUT', 'PUT']);
  });

  test('a form drawn by another refresh while a save waits keeps its own state', async ({
    page
  }) => {
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
    let hold = false;
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let heldGet: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      heldGet = resolve;
    });
    await page.route(
      (url) => url.pathname.endsWith('/wfs'),
      async (route) => {
        if (hold && route.request().method() === 'GET') {
          hold = false;
          heldGet();
          await released;
          await route.fulfill({ status: 503, body: 'busy' });
          return;
        }
        await route.fallback();
      }
    );
    await openWfsTab(page);
    await page.getByRole('button', { name: 'Edit' }).click();
    await page.locator('#wfsName').fill('Depth contours');
    hold = true;
    await page.getByRole('button', { name: 'Save' }).click();
    // While the save's refresh waits, leaving the tab and coming back draws the add form.
    await held;
    await page.locator('#catalogTabBtn').click();
    await openWfsTab(page);
    await expect(page.getByRole('button', { name: 'Add WFS server' })).toBeVisible();
    const heldRead = page.waitForResponse(
      (r) => r.url().endsWith('/wfs') && r.request().method() === 'GET' && r.status() === 503
    );
    release();
    await heldRead;
    // The save's read, overtaken by the tab's, which worked, says nothing over it.
    await page.waitForTimeout(200);
    await expect(page.locator('#wfsMessage')).toHaveText('Saved.');
    await page.locator('#wfsUrl').fill('https://third.example.org/wfs');
    await page.getByRole('button', { name: 'Add WFS server' }).click();
    await expect(
      page.locator('#wfsOutput').getByText('https://third.example.org/wfs')
    ).toBeVisible();
    expect(changes.map((c) => c.method)).toEqual(['PUT', 'POST']);
  });

  test('an edit form left by a failed refresh while a save waits is still an edit', async ({
    page
  }) => {
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
    let gets: number | undefined;
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let heldGet: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      heldGet = resolve;
    });
    await page.route(
      (url) => url.pathname.endsWith('/wfs'),
      async (route) => {
        if (gets !== undefined && route.request().method() === 'GET') {
          gets++;
          // The save's refresh waits and then works; the one asked meanwhile fails.
          if (gets === 1) {
            heldGet();
            await released;
          } else if (gets === 2) {
            await route.fulfill({ status: 503, body: 'busy' });
            return;
          }
        }
        await route.fallback();
      }
    );
    await openWfsTab(page);
    await page.getByRole('button', { name: 'Edit' }).click();
    await page.locator('#wfsName').fill('Depth contours');
    gets = 0;
    await page.getByRole('button', { name: 'Save' }).click();
    // The save's refresh is the one held before the tab asks for another.
    await held;
    await page.locator('#catalogTabBtn').click();
    await openWfsTab(page);
    await expect(page.locator('#wfsMessage')).toContainText(
      'Could not read the WFS data: HTTP 503'
    );
    const heldRead = page.waitForResponse(
      (r) => r.url().endsWith('/wfs') && r.request().method() === 'GET' && r.status() === 200
    );
    release();
    await heldRead;
    // The save's read, overtaken by the tab's, which failed, says nothing over it.
    await page.waitForTimeout(200);
    await expect(page.locator('#wfsMessage')).toContainText(
      'Saved. Could not read the WFS data: HTTP 503'
    );
    // The superseded refresh drew nothing: the edit form is still shown, and saves an edit.
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(sourceRow(page, 'Depth contours')).toContainText('3 areas');
    expect(changes.map((c) => c.method)).toEqual(['PUT', 'PUT']);
  });

  test("an action's status says how the latest read of the list ended", async ({ page }) => {
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
    let gets: number | undefined;
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let heldGet: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      heldGet = resolve;
    });
    await page.route(
      (url) => url.pathname.endsWith('/wfs'),
      async (route) => {
        if (gets !== undefined && route.request().method() === 'GET') {
          gets++;
          // The action's read waits and then works; the one asked meanwhile, the latest, fails.
          if (gets === 1) {
            heldGet();
            await released;
          } else if (gets === 2) {
            await route.fulfill({ status: 503, body: 'busy' });
            return;
          }
        }
        await route.fallback();
      }
    );
    await openWfsTab(page);
    gets = 0;
    page.once('dialog', (dialog) => void dialog.accept());
    await page.getByRole('button', { name: 'Delete data' }).click();
    await held;
    await page.locator('#catalogTabBtn').click();
    await openWfsTab(page);
    const message = page.locator('#wfsMessage');
    await expect(message).toContainText(
      'Deleted. Its areas are downloaded again when next read. Could not read the WFS data: HTTP 503'
    );
    const firstRead = page.waitForResponse(
      (r) => r.url().endsWith('/wfs') && r.request().method() === 'GET' && r.status() === 200
    );
    release();
    await firstRead;
    // The older read, overtaken, says nothing over the latest one.
    await page.waitForTimeout(200);
    await expect(message).toContainText('Could not read the WFS data: HTTP 503');
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
        sources: [kept, keptToo]
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
    await expect(sourceRow(page, 'Depth areas')).toContainText('Nothing kept yet.');
    await expect(sourceRow(page, 'Second')).toContainText('3 areas');

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

  test('edits a server', async ({ page }) => {
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
    await page.getByRole('button', { name: 'Edit' }).click();
    await page.locator('#wfsName').fill('Depth contours');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.locator('#wfsMessage')).toContainText('Saved');
    await expect(sourceRow(page, 'Depth contours')).toContainText('3 areas');
    await expect(page.getByRole('button', { name: 'Add WFS server' })).toBeEnabled();

    await sourceRow(page, 'Depth contours').getByRole('button', { name: 'Edit' }).click();
    await page.locator('#wfsMargin').fill('0.05');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(sourceRow(page, 'Depth contours')).toContainText('Nothing kept yet.');
    await expect(page.getByRole('button', { name: 'Add WFS server' })).toBeEnabled();

    expect(changes).toEqual([
      {
        method: 'PUT',
        path: '/wfs/sources',
        body: { url: kept.url, name: 'Depth contours', answersByBox: true, answerMargin: 0.12 }
      },
      {
        method: 'PUT',
        path: '/wfs/sources',
        body: { url: kept.url, name: 'Depth contours', answersByBox: true, answerMargin: 0.05 }
      }
    ]);
  });
});
