import { test, expect, type Page } from '@playwright/test';
import { setMockState } from './helpers.js';

async function openOnlineTab(page: Page): Promise<void> {
  await page.locator('#onlineChartsTabBtn').click();
}

async function openSatelliteTab(page: Page): Promise<void> {
  await page.locator('#satelliteTabBtn').click();
}

test.describe('Online Charts tab', () => {
  test('credits the online charts with their issue tracker, never a non-https one', async ({
    page
  }) => {
    await page.goto('/plugins/signalk-charts-provider-simple/');
    await setMockState(page, {});
    await openOnlineTab(page);
    const note = page.locator('#onlineSourceNote');
    await expect(note.locator('a[href*="template=catalog-problem.yml"]')).toBeVisible();

    await setMockState(page, {
      sources: {
        chartcatalogs: { homepage: 'https://chartcatalogs.github.io/', issues: 'https://x.org' },
        online: { homepage: 'https://example.org', issues: 'javascript:alert(1)' }
      }
    });
    await page.reload();
    await openOnlineTab(page);
    await expect(note.locator('a[href^="javascript:"]')).toHaveCount(0);
    await expect(note.locator('a[href*="template=catalog-problem.yml"]')).toBeVisible();
    await setMockState(page, {
      sources: {
        chartcatalogs: { homepage: 'https://chartcatalogs.github.io/', issues: 'https://x.org' },
        online: { homepage: 'https://example.org', issues: 'https://example.org/online-issues' }
      }
    });
    await page.reload();
    await openOnlineTab(page);
    await expect(note.locator('a[href="https://example.org/online-issues"]')).toBeVisible();
  });

  test('lists online charts by category and adds one to a folder', async ({ page }) => {
    await page.goto('/plugins/signalk-charts-provider-simple/');
    await setMockState(page, {
      online: [
        {
          id: 'nws-radar-conus',
          name: 'NWS Radar – Continental US',
          description: 'Rain radar for the lower 48 states.',
          category: 'weather',
          provider: 'NOAA / National Weather Service',
          license: 'Public domain (U.S. Government)',
          licenseUrl: 'https://www.weather.gov/disclaimer',
          chart: { type: 'WMS' },
          temporal: { kind: 'observation' }
        },
        {
          id: 'openwaters-seamap',
          name: 'Open Waters Seamap',
          description: 'Worldwide nautical-style map.',
          category: 'navigation',
          provider: 'Open Waters',
          license: 'CC BY 4.0',
          licenseUrl: 'https://openwaters.io/charts/seamap',
          notForNavigation: true,
          chart: { type: 'mapstyleJSON' }
        },
        {
          id: 'gebco-ocean-depths',
          name: 'GEBCO Ocean Depths',
          description: 'Shaded relief of the ocean floor.',
          category: 'navigation',
          provider: 'GEBCO',
          license: 'Public domain',
          licenseUrl: 'https://www.gebco.net/',
          chart: { type: 'WMS' },
          keptOffline: true
        }
      ],
      onlineAdded: { 'openwaters-seamap': ['Online Charts/openwaters-seamap.onlinechart.json'] }
    });
    await openOnlineTab(page);

    await expect(page.locator('.catalog-section-title')).toHaveText([
      'Navigation Charts',
      'Weather'
    ]);
    const row = page.locator('.online-chart-row', { hasText: 'NWS Radar' });
    await expect(row).toContainText('Needs internet');
    await expect(row).toContainText('Live');

    await expect(row.getByLabel('Save to')).toHaveValue('Online Charts');
    const request = page.waitForRequest('**/online-charts');
    await row.locator('[data-online-add]').click();
    expect((await request).postDataJSON()).toEqual({
      catalogId: 'nws-radar-conus',
      folder: 'Online Charts'
    });
    await expect(row.locator('.installed-badge')).toHaveText('Added');

    // Already-added charts show as added.
    const seamap = page.locator('.online-chart-row', { hasText: 'Open Waters Seamap' });
    await expect(seamap.locator('.installed-badge')).toHaveText('Added');
    await expect(seamap).toContainText('Not for navigation');
    await expect(seamap).toContainText('Needs internet');

    // A chart whose license allows offline copies says so instead.
    const gebco = page.locator('.online-chart-row', { hasText: 'GEBCO Ocean Depths' });
    await expect(gebco).toContainText('Kept offline');
    await expect(gebco).not.toContainText('Needs internet');
  });
  test('reports the HTTP status when adding an online chart gets an error page', async ({
    page
  }) => {
    await page.goto('/plugins/signalk-charts-provider-simple/');
    await setMockState(page, {
      online: [
        {
          id: 'nws-radar-conus',
          name: 'NWS Radar',
          description: 'Rain radar.',
          category: 'weather',
          provider: 'NOAA',
          license: 'Public domain',
          licenseUrl: 'https://www.weather.gov/disclaimer',
          chart: { type: 'WMS' }
        }
      ],
      onlineAddFailStatus: 502
    });
    await openOnlineTab(page);
    // Dismissed as it opens: a click still waiting while the alert is up never returns.
    let message = '';
    page.once('dialog', (alert) => {
      message = alert.message();
      void alert.dismiss();
    });
    await page.locator('[data-online-add]').click();
    await expect.poll(() => message).toContain('HTTP 502');
  });

  test("uses a satellite's useful coverage, not its full disk, for Near me", async ({ page }) => {
    await page.goto('/plugins/signalk-charts-provider-simple/');
    await setMockState(page, {
      online: [
        {
          id: 'meteosat',
          name: 'Meteosat',
          description: 'd',
          category: 'weather',
          provider: 'p',
          license: 'l',
          licenseUrl: 'https://example.com',
          bbox: [-81, -81, 81, 81],
          coverage: [-65, -65, 65, 65],
          chart: { type: 'WMS' }
        }
      ],
      position: { latitude: 24.55, longitude: -81.8 }
    });
    await openOnlineTab(page);
    await expect(page.locator('[data-online-filter="nearMe"]')).toContainText('0');
  });

  test('Near me reaches across the antimeridian', async ({ page }) => {
    await page.goto('/plugins/signalk-charts-provider-simple/');
    await setMockState(page, {
      online: [
        {
          id: 'tonga',
          name: 'Tonga',
          description: 'd',
          category: 'navigation',
          provider: 'p',
          license: 'l',
          licenseUrl: 'https://example.com',
          bbox: [-179.5, -20, -170, -10],
          chart: { type: 'WMS' }
        }
      ],
      position: { latitude: -15, longitude: 179.8 }
    });
    await openOnlineTab(page);
    await expect(page.locator('[data-online-filter="nearMe"]')).toContainText('1');
  });

  test('filters by section and position, and leaves satellite imagery to its own tab', async ({
    page
  }) => {
    await page.goto('/plugins/signalk-charts-provider-simple/');
    const online = (id: string, category: string, bbox: number[]) => ({
      id,
      name: id,
      description: `${id} description`,
      category,
      provider: 'p',
      license: 'l',
      licenseUrl: 'https://example.com',
      bbox,
      chart: { type: 'WMS' }
    });
    await setMockState(page, {
      online: [
        online('eox-cloudless', 'imagery', [-180, -85, 180, 85]),
        online('world-map', 'basemap', [-180, -85, 180, 85]),
        online('us-radar', 'weather', [-130, 20, -60, 55]),
        online('eu-radar', 'weather', [1.5, 45.7, 18.7, 56.2]),
        online('kartverket', 'navigation', [-1, 57, 33, 81])
      ],
      position: { latitude: 24.55, longitude: -81.8 }
    });
    await openOnlineTab(page);
    const rows = page.locator('.online-chart-row');
    await expect(rows).toHaveCount(4);
    await expect(page.locator('.catalog-section-title')).toHaveText([
      'Navigation Charts',
      'Weather',
      'Base Maps'
    ]);
    await expect(page.locator('#onlineList')).not.toContainText('eox-cloudless');

    const btn = (group: string, value: string) =>
      page.locator(`[data-online-filter="${group}"][data-filter-value="${value}"]`);
    await btn('categories', 'weather').click();
    await expect(rows).toHaveCount(2);
    // Counts follow the other active filters.
    await expect(btn('nearMe', '')).toContainText('1');
    await btn('nearMe', '').click();
    await expect(rows).toHaveCount(1);
    await expect(rows).toContainText('us-radar');

    // Filters are remembered.
    await page.reload();
    await openOnlineTab(page);
    await expect(rows).toHaveCount(1);
    await btn('categories', 'navigation').click();
    await btn('categories', 'weather').click();
    await expect(page.locator('#onlineList')).toContainText('No charts match');
    await page.locator('#onlineList [data-online-filter="clear"]').click();
    await expect(rows).toHaveCount(4);

    // The Satellite tab lists the imagery, with nothing to filter but position.
    await openSatelliteTab(page);
    const satellite = page.locator('#satellite');
    await expect(satellite.locator('.online-chart-row')).toHaveCount(1);
    await expect(satellite.locator('.online-chart-row')).toContainText('eox-cloudless');
    await expect(satellite.locator('.catalog-section-title')).toHaveText([
      'Satellite & Aerial Imagery'
    ]);
    await expect(satellite.locator('[data-online-filter="categories"]')).toHaveCount(0);
    await expect(satellite.locator('[data-online-filter="nearMe"]')).toContainText('1');
  });

  test("opens the offline area of added satellite imagery with its provider's limits", async ({
    page
  }) => {
    await page.goto('/plugins/signalk-charts-provider-simple/');
    await setMockState(page, {
      online: [
        {
          id: 'eox-cloudless',
          name: 'EOxCloudless Satellite Imagery',
          description: 'Cloud-free satellite imagery.',
          category: 'imagery',
          provider: 'EOX IT Services GmbH',
          license: 'CC BY-NC-SA 4.0',
          licenseUrl: 'https://cloudless.eox.at/documentation/license',
          bbox: [-180, -85, 180, 85],
          chart: { type: 'tilelayer' },
          keptOffline: true
        }
      ],
      onlineAdded: { 'eox-cloudless': ['eox-cloudless.onlinechart.json'] },
      localCharts: {
        basePath: '/tmp/charts',
        folders: ['/'],
        charts: [
          {
            relativePath: 'eox-cloudless.onlinechart.json',
            name: 'eox-cloudless.onlinechart.json',
            chartName: 'EOxCloudless Satellite Imagery',
            folder: '/',
            enabled: true,
            online: {
              catalogId: 'eox-cloudless',
              available: true,
              catalogLoaded: true,
              type: 'tilelayer',
              keptOffline: true,
              areaDownload: true,
              areaDownloadLimits: { maxTiles: 1, requestsPerSecond: 2 },
              chartId: 'eox-cloudless',
              minzoom: 0,
              maxzoom: 14
            }
          }
        ]
      }
    });
    await openSatelliteTab(page);
    const row = page.locator('#satellite .online-chart-row', { hasText: 'EOxCloudless' });
    await expect(row.locator('.installed-badge')).toHaveText('Added');
    await row.getByRole('button', { name: 'Offline area' }).click();
    const dialog = page.locator('.area-modal');
    await dialog.locator('#areaZoomTo').selectOption('0');
    await expect(dialog.locator('#areaEstimate')).toContainText(
      'go slowly, so it takes about 1 second'
    );
  });

  test('offers kept tiles, not an area, where the provider allows only keeping viewed tiles', async ({
    page
  }) => {
    await page.goto('/plugins/signalk-charts-provider-simple/');
    await setMockState(page, {
      online: [
        {
          id: 'kept',
          name: 'Kept Chart',
          description: 'd',
          category: 'navigation',
          provider: 'p',
          license: 'l',
          licenseUrl: 'https://example.com',
          bbox: [0, 0, 1, 1],
          chart: { type: 'tilelayer' },
          keptOffline: true
        },
        {
          id: 'streamed',
          name: 'Streamed Chart',
          description: 'd',
          category: 'navigation',
          provider: 'p',
          license: 'l',
          licenseUrl: 'https://example.com',
          bbox: [0, 0, 1, 1],
          chart: { type: 'WMS' }
        }
      ],
      onlineAdded: {
        kept: ['Online Charts/kept.onlinechart.json'],
        streamed: ['Online Charts/streamed.onlinechart.json']
      },
      localCharts: {
        basePath: '/tmp/charts',
        folders: ['/', 'Online Charts'],
        charts: [
          {
            relativePath: 'Online Charts/kept.onlinechart.json',
            name: 'kept.onlinechart.json',
            folder: 'Online Charts',
            enabled: true,
            online: {
              catalogId: 'kept',
              available: true,
              catalogLoaded: true,
              type: 'tilelayer',
              keptOffline: true,
              areaDownload: false,
              chartId: 'kept'
            }
          },
          {
            relativePath: 'Online Charts/streamed.onlinechart.json',
            name: 'streamed.onlinechart.json',
            folder: 'Online Charts',
            enabled: true,
            online: { catalogId: 'streamed', available: true, catalogLoaded: true, type: 'WMS' }
          }
        ]
      }
    });
    await openOnlineTab(page);
    const kept = page.locator('.online-chart-row', { hasText: 'Kept Chart' });
    await expect(kept.getByRole('button', { name: 'Kept tiles' })).toBeVisible();
    await expect(kept.getByRole('button', { name: 'Offline area' })).toHaveCount(0);
    const streamed = page.locator('.online-chart-row', { hasText: 'Streamed Chart' });
    await expect(streamed.locator('button')).toHaveCount(0);
  });

  test('offers no offline area for a chart switched off with its folder', async ({ page }) => {
    await page.goto('/plugins/signalk-charts-provider-simple/');
    const chart = {
      id: 'kept',
      name: 'Kept Chart',
      description: 'd',
      category: 'navigation',
      provider: 'p',
      license: 'l',
      licenseUrl: 'https://example.com',
      bbox: [0, 0, 1, 1],
      chart: { type: 'tilelayer' },
      keptOffline: true
    };
    const local = (folder: string, folderEnabled: boolean) => ({
      relativePath: `${folder}/kept.onlinechart.json`,
      name: 'kept.onlinechart.json',
      folder,
      enabled: true,
      folderEnabled,
      online: {
        catalogId: 'kept',
        available: true,
        catalogLoaded: true,
        type: 'tilelayer',
        keptOffline: true,
        areaDownload: true,
        chartId: folderEnabled ? 'kept-2' : 'kept'
      }
    });
    await setMockState(page, {
      online: [chart],
      onlineAdded: { kept: ['Online Charts/kept.onlinechart.json'] },
      localCharts: {
        basePath: '/tmp/charts',
        folders: ['/', 'Online Charts'],
        charts: [local('Online Charts', false)]
      }
    });
    await openOnlineTab(page);
    const row = page.locator('.online-chart-row', { hasText: 'Kept Chart' });
    await expect(row.locator('.installed-badge')).toHaveText('Added');
    await expect(row.locator('button')).toHaveCount(0);

    // A second copy that is switched on is the one the button opens.
    await setMockState(page, {
      online: [chart],
      onlineAdded: { kept: ['Online Charts/kept.onlinechart.json', 'Other/kept.onlinechart.json'] },
      localCharts: {
        basePath: '/tmp/charts',
        folders: ['/', 'Online Charts', 'Other'],
        charts: [local('Online Charts', false), local('Other', true)]
      }
    });
    await page.reload();
    await openOnlineTab(page);
    const request = page.waitForRequest((r) => r.url().includes('/online-charts/kept-2/offline'));
    await row.getByRole('button', { name: 'Offline area' }).click();
    await request;
  });

  test('keeps the folder picked on one row while another is added', async ({ page }) => {
    await page.goto('/plugins/signalk-charts-provider-simple/');
    const chart = (id: string) => ({
      id,
      name: id,
      description: 'd',
      category: 'weather',
      provider: 'p',
      license: 'l',
      licenseUrl: 'https://example.com',
      bbox: [0, 0, 1, 1],
      chart: { type: 'WMS' }
    });
    await setMockState(page, {
      online: [chart('radar-a'), chart('radar-b')],
      localCharts: {
        basePath: '/tmp/charts',
        folders: ['/', 'Weather'],
        charts: []
      }
    });
    await openOnlineTab(page);
    const rowA = page.locator('.online-chart-row', { hasText: 'radar-a' });
    const rowB = page.locator('.online-chart-row', { hasText: 'radar-b' });
    await rowB.getByLabel('Save to').selectOption('Weather');
    await rowA.locator('[data-online-add]').click();
    await expect(rowA.locator('.installed-badge')).toHaveText('Added');
    await expect(rowB.getByLabel('Save to')).toHaveValue('Weather');
  });
});

test.describe('add an online chart by URL', () => {
  test('adds an online chart by URL', async ({ page }) => {
    await page.goto('/plugins/signalk-charts-provider-simple/');
    await setMockState(page, {});
    await openOnlineTab(page);

    await expect(page.locator('#onlineChartFolder')).toHaveValue('Online Charts');
    await expect(page.locator('#onlineChartLayersGroup')).toBeHidden();
    await page.locator('#onlineChartType').selectOption('WMS');
    await expect(page.locator('#onlineChartLayersGroup')).toBeVisible();
    await expect(page.locator('#onlineChartUrlHint')).toBeHidden();

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

  test("shows the server's reason when it refuses a chart", async ({ page }) => {
    await page.goto('/plugins/signalk-charts-provider-simple/');
    await setMockState(page, {});
    await openOnlineTab(page);
    await expect(page.locator('#onlineChartUrlHint')).toBeVisible();
    await page.locator('#onlineChartName').fill('Tiles');
    await page.locator('#onlineChartUrl').fill('https://tiles.example.org/map.png');
    await page.getByRole('button', { name: 'Add Online Chart' }).click();
    await expect(page.locator('#onlineChartStatus .error-message')).toContainText(
      'needs {z}, {x} and {y}'
    );
    // A refused chart keeps what was typed, so it can be corrected.
    await expect(page.locator('#onlineChartUrl')).toHaveValue('https://tiles.example.org/map.png');
  });

  test('asks for the layers of a WMS chart before adding it', async ({ page }) => {
    await page.goto('/plugins/signalk-charts-provider-simple/');
    await setMockState(page, {});
    await openOnlineTab(page);
    await page.locator('#onlineChartType').selectOption('WMS');
    await page.locator('#onlineChartName').fill('No layers');
    await page.locator('#onlineChartUrl').fill('https://charts.example.org/wms');
    await page.getByRole('button', { name: 'Add Online Chart' }).click();
    await expect(page.locator('#onlineChartStatus')).toContainText('at least one layer');
  });
});
