import { test, expect, type Page } from '@playwright/test';
import { setMockState } from './helpers.js';

const charts = {
  basePath: '/tmp/charts',
  folders: ['/'],
  folderStates: { '/': { enabled: true, effectiveEnabled: true } },
  charts: [{ relativePath: 'foo.mbtiles', name: 'Foo Chart', folder: '/', enabled: true }]
};

async function openAs(page: Page, loginStatus: Record<string, unknown>): Promise<void> {
  await setMockState(page, { localCharts: charts, loginStatus });
  await page.goto('/plugins/signalk-charts-provider-simple/');
  await expect(page.locator('#manageOutput')).toContainText('Foo Chart', { timeout: 5000 });
}

test.describe('access levels', () => {
  test('a read-only visitor sees everything greyed out and changes nothing', async ({ page }) => {
    await openAs(page, {
      status: 'notLoggedIn',
      authenticationRequired: true,
      readOnlyAccess: true
    });

    await expect(page.locator('.access-banner')).toContainText('Read only');
    await expect(page.locator('body')).toHaveAttribute('data-access', 'readonly');
    const card = page.locator('.chart-card', { hasText: 'Foo Chart' });
    await expect(card).toBeVisible();

    const changes: string[] = [];
    page.on('request', (request) => {
      if (request.method() !== 'GET') {
        changes.push(`${request.method()} ${request.url()}`);
      }
    });
    // force: the controls are aria-disabled, which Playwright would wait out.
    await card.getByRole('button', { name: 'Delete' }).click({ force: true });
    await card.locator('.btn-toggle').click({ force: true });
    await expect(page.locator('.delete-modal')).toHaveCount(0);

    await page.getByRole('button', { name: /Download from URL/i }).click();
    await expect(page.locator('#download')).toHaveClass(/active/);
    const downloadButton = page.getByRole('button', { name: 'Download Chart' });
    await expect(downloadButton).toBeVisible();
    await expect(downloadButton).toHaveCSS('opacity', '0.45');
    await expect(downloadButton).toHaveAttribute('aria-disabled', 'true');
    await downloadButton.click({ force: true });
    expect(changes).toEqual([]);
  });

  test('a readwrite user can add charts but not remove them', async ({ page }) => {
    await openAs(page, {
      status: 'loggedIn',
      userLevel: 'readwrite',
      authenticationRequired: true
    });

    await expect(page.locator('.access-banner')).toContainText('needs an administrator');
    const card = page.locator('.chart-card', { hasText: 'Foo Chart' });
    await card.getByRole('button', { name: 'Delete' }).click({ force: true });
    await expect(page.locator('.delete-modal')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Upload', exact: true })).toHaveCSS(
      'opacity',
      '1'
    );
  });

  test('an administrator, or a server without security, sees no banner', async ({ page }) => {
    await openAs(page, { status: 'notLoggedIn', authenticationRequired: false });

    await expect(page.locator('body')).toHaveAttribute('data-access', 'admin');
    await expect(page.locator('.access-banner')).toHaveCount(0);
    const card = page.locator('.chart-card', { hasText: 'Foo Chart' });
    await card.getByRole('button', { name: 'Delete' }).click();
    await expect(page.locator('.delete-modal')).toContainText('Foo Chart');
  });
});
