/**
 * Route-level tests for online charts: adding one from the catalog, serving
 * it on the v2 provider (and not on v1), and renaming it through the chart
 * metadata routes. Runs the real plugin against a temporary chart folder
 * with a pre-seeded catalog cache, so no network is needed.
 */

import { describe, it, before, after, mock } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

import type { Plugin } from '@signalk/server-api';
import type { ExtendedServerAPI } from '../dist/types.js';
import pluginFactoryDefault from '../dist/index.js';
import { downloadManager } from '../dist/utils/download-manager.js';

const pluginFactory = pluginFactoryDefault as unknown as (app: ExtendedServerAPI) => Plugin;

type ResourceProvider = Parameters<ExtendedServerAPI['registerResourceProvider']>[0];
type PluginRouter = Parameters<NonNullable<Plugin['registerWithRouter']>>[0];
type RouteHandler = (req: unknown, res: unknown) => void | Promise<void>;

interface FakeRes {
  statusCode: number;
  body: unknown;
  done: boolean;
  status(code: number): FakeRes;
  json(payload: unknown): FakeRes;
  send(payload?: unknown): FakeRes;
}

function makeRes(): FakeRes {
  return {
    statusCode: 200,
    body: undefined,
    done: false,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      this.done = true;
      return this;
    },
    send(payload?: unknown) {
      this.body = payload;
      this.done = true;
      return this;
    }
  };
}

/** Call a route and wait for it to answer (several handlers run async). */
async function call(handler: RouteHandler | undefined, req: unknown): Promise<FakeRes> {
  assert.ok(handler, 'route should be registered');
  const res = makeRes();
  await handler(req, res);
  const deadline = Date.now() + 5000;
  while (!res.done && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.ok(res.done, 'route should answer within 5s');
  return res;
}

function createRouterStub(): { router: PluginRouter; handlers: Map<string, RouteHandler> } {
  const handlers = new Map<string, RouteHandler>();
  const record =
    (method: string) =>
    (routePath: string, handler: RouteHandler): PluginRouter => {
      handlers.set(`${method} ${routePath}`, handler);
      return {} as PluginRouter;
    };
  const router = {
    get: record('get'),
    post: record('post'),
    put: record('put'),
    delete: record('delete')
  } as unknown as PluginRouter;
  return { router, handlers };
}

const CATALOG = {
  schemaVersion: 1,
  generatedAt: '2026-01-01T00:00:00.000Z',
  contentHash: '0'.repeat(64),
  sources: {
    chartcatalogs: {
      homepage: 'https://chartcatalogs.github.io/',
      issues: 'https://github.com/chartcatalogs/catalogs/issues',
      license: 'CC0-1.0'
    },
    online: { homepage: 'https://github.com/o/r', issues: 'https://github.com/o/r/issues' }
  },
  chartcatalogs: [],
  online: [
    {
      id: 'nws-radar-conus',
      name: 'NWS Radar – Continental US',
      description: 'Rain radar.',
      category: 'weather',
      regions: ['us-conus'],
      bbox: [-130, 20, -60, 55],
      provider: 'NOAA',
      attribution: 'NOAA',
      license: 'Public domain',
      licenseUrl: 'https://www.weather.gov/disclaimer',
      chart: {
        type: 'WMS',
        url: 'https://opengeo.ncep.noaa.gov/geoserver/conus/conus_bref_qcd/ows',
        layers: ['conus_bref_qcd']
      },
      temporal: { kind: 'observation', refreshInterval: 300000, window: 'PT3H' },
      use: 'stream',
      format: 'wms'
    },
    {
      id: 'test-depths',
      name: 'Test Depths',
      description: 'Depth shading.',
      category: 'navigation',
      regions: ['global'],
      bbox: [-180, -85, 180, 85],
      provider: 'Test',
      attribution: 'Test',
      license: 'Public domain',
      licenseUrl: 'https://example.com/license',
      chart: { type: 'WMS', url: 'https://depths.example.com/ows', layers: ['depth'] },
      offline: {},
      use: 'stream',
      format: 'wms'
    },
    {
      id: 'test-imagery',
      name: 'Test Imagery',
      description: 'Satellite imagery.',
      category: 'basemap',
      regions: ['global'],
      bbox: [-180, -85, 180, 85],
      provider: 'Test',
      attribution: 'Test',
      license: 'CC BY-NC-SA 4.0',
      licenseUrl: 'https://example.com/license',
      chart: { type: 'tilelayer', url: 'https://imagery.example.com/{z}/{y}/{x}.jpg', maxzoom: 14 },
      offline: { areaDownload: false },
      use: 'stream',
      format: 'tiles'
    },
    {
      id: 'test-paced',
      name: 'Test Paced Imagery',
      description: 'Satellite imagery from a rate-limited service.',
      category: 'basemap',
      regions: ['global'],
      bbox: [-180, -85, 180, 85],
      provider: 'Test',
      attribution: 'Test',
      license: 'CC BY-NC-SA 4.0',
      licenseUrl: 'https://example.com/license',
      chart: {
        type: 'tilelayer',
        url: 'https://imagery.example.com/paced/{z}/{y}/{x}.jpg',
        maxzoom: 14
      },
      offline: { areaDownloadLimits: { maxTiles: 10, requestsPerSecond: 50 } },
      use: 'stream',
      format: 'tiles'
    }
  ]
};

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
let depthsOnline = true;
let imageryOnline = true;
const lanRequests: string[] = [];

/** Radar capabilities with three frames ending a few minutes ago. */
function radarCapabilities(): string {
  const t = (minutesAgo: number) =>
    new Date(Date.now() - minutesAgo * 60000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  return `<WMS_Capabilities><Capability><Layer><Layer><Name>conus_bref_qcd</Name>
    <Dimension name="time" units="ISO8601">${t(10)},${t(6)},${t(2)}</Dimension>
  </Layer></Layer></Capability></WMS_Capabilities>`;
}

describe('online chart routes', () => {
  let tempDir: string;
  let chartPath: string;
  let plugin: Plugin;
  let provider: ResourceProvider | undefined;
  const handlers = new Map<string, RouteHandler>();
  const v1Handlers = new Map<string, RouteHandler>();

  before(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'online-routes-'));
    chartPath = path.join(tempDir, 'charts');
    fs.mkdirSync(chartPath, { recursive: true });
    // A directory chart whose id an online chart must not take.
    fs.mkdirSync(path.join(chartPath, 'nws-radar-conus'));
    fs.writeFileSync(path.join(chartPath, 'nws-radar-conus', 'tilemapresource.xml'), '<x/>');

    const pluginDataDir = path.join(
      tempDir,
      'plugin-config-data',
      'signalk-charts-provider-simple'
    );
    fs.mkdirSync(path.join(pluginDataDir, 'catalog-cache'), { recursive: true });
    fs.writeFileSync(
      path.join(pluginDataDir, 'catalog-cache', 'merged-catalog.json'),
      JSON.stringify({ fetchedAt: new Date().toISOString(), etag: null, catalog: CATALOG })
    );
    // The catalog can't be downloaded (the plugin serves its cached copy);
    // the radar's capabilities document can.
    mock.method(globalThis, 'fetch', (url: string) => {
      if (url.includes('GetCapabilities')) {
        return Promise.resolve(new Response(radarCapabilities(), { status: 200 }));
      }
      if (url.startsWith('https://depths.example.com/') && depthsOnline) {
        return Promise.resolve(new Response(PNG, { status: 200 }));
      }
      if (url.startsWith('https://imagery.example.com/') && imageryOnline) {
        return Promise.resolve(new Response(JPEG, { status: 200 }));
      }
      if (url.startsWith('http://charts.lan/')) {
        lanRequests.push(url);
        return Promise.resolve(new Response(PNG, { status: 200 }));
      }
      return Promise.reject(new TypeError('offline'));
    });

    const app = {
      config: { configPath: tempDir, ssl: false, version: '2.0.0', getExternalPort: () => 3000 },
      debug: () => {},
      error: () => {},
      setPluginStatus: () => {},
      setPluginError: () => {},
      getDataDirPath: () => pluginDataDir,
      registerResourceProvider: (p: ResourceProvider) => {
        provider = p;
      },
      handleMessage: () => {},
      getSelfPath: (p: string) =>
        p === 'navigation.position' ? { value: { latitude: 24.55, longitude: -81.8 } } : undefined
    } as unknown as ExtendedServerAPI;

    plugin = pluginFactory(app);
    const stub = createRouterStub();
    plugin.registerWithRouter?.(stub.router);
    for (const [k, v] of stub.handlers) {
      handlers.set(k, v);
    }
    const v1 = createRouterStub();
    (plugin as unknown as { signalKApiRoutes: (r: PluginRouter) => void }).signalKApiRoutes(
      v1.router
    );
    for (const [k, v] of v1.handlers) {
      v1Handlers.set(k, v);
    }
    plugin.start({ chartPath }, () => {});
    const deadline = Date.now() + 5000;
    while (!provider && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(provider, 'resource provider should register');
  });

  after(() => {
    plugin.stop?.();
    mock.restoreAll();
    downloadManager.removeAllListeners();
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const add = (body: unknown) => call(handlers.get('post /online-charts'), { body });
  const addCustom = (body: unknown) => call(handlers.get('post /online-charts/custom'), { body });

  type ServedTile = { status: number; body?: Buffer; type?: string };
  const serveTile = async (identifier: string, z: number, x: number, y: number) => {
    const tile = v1Handlers.get(
      'get /resources/charts/:identifier/:z([0-9]+)/:x([0-9]+)/:y([0-9]+)'
    );
    const out: ServedTile = { status: 0 };
    await new Promise<void>((resolve) => {
      const resStub = {
        writeHead(status: number, headers: Record<string, string>) {
          out.status = status;
          out.type = headers['Content-Type'];
        },
        end(body: Buffer) {
          out.body = body;
          resolve();
        },
        sendStatus(status: number) {
          out.status = status;
          resolve();
        }
      };
      void tile?.({ params: { identifier, z: String(z), x: String(x), y: String(y) } }, resStub);
    });
    return out;
  };

  it('rejects an unknown catalog id', async () => {
    const res = await add({ catalogId: 'nope', folder: '/' });
    assert.strictEqual(res.statusCode, 404);
  });

  it('rejects folders outside the chart path or hidden from scans', async () => {
    for (const folder of ['../escape', '.hidden', 'a/.b']) {
      const res = await add({ catalogId: 'nws-radar-conus', folder });
      assert.strictEqual(res.statusCode, 403, folder);
    }
  });

  it('adds a chart under an id no other chart uses, and serves it on v2 only', async () => {
    const res = await add({ catalogId: 'nws-radar-conus', folder: 'Online Charts' });
    assert.strictEqual(res.statusCode, 200);
    const { relativePath } = res.body as { relativePath: string };
    assert.strictEqual(
      relativePath,
      path.join('Online Charts', 'nws-radar-conus-2.onlinechart.json')
    );
    assert.ok(fs.existsSync(path.join(chartPath, relativePath)));

    const v2 = (await provider!.methods.listResources({})) as Record<string, { type: string }>;
    assert.strictEqual(v2['nws-radar-conus-2']?.type, 'WMS');

    const v1res = await call(v1Handlers.get('get /resources/charts'), {});
    assert.ok(!(v1res.body as Record<string, unknown>)['nws-radar-conus-2']);
  });

  it("serves a time-varying chart's timeline, read from its capabilities", async () => {
    type Served = { refreshInterval?: number; time?: { current: boolean; values?: string[] } };
    let served: Served | undefined;
    const deadline = Date.now() + 5000;
    while (!served?.time && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
      served = ((await provider!.methods.listResources({})) as Record<string, Served>)[
        'nws-radar-conus-2'
      ];
    }
    assert.strictEqual(served?.refreshInterval, 300000);
    assert.strictEqual(served.time?.current, true);
    assert.strictEqual(served.time.values?.length, 3);
  });

  it('serves a chart kept offline through the plugin, and keeps its tiles', async () => {
    const res = await add({ catalogId: 'test-depths', folder: 'Online Charts' });
    assert.strictEqual(res.statusCode, 200);
    const v2 = (await provider!.methods.listResources({})) as Record<
      string,
      { type: string; url: string }
    >;
    assert.strictEqual(v2['test-depths']?.type, 'tilelayer');
    assert.strictEqual(
      v2['test-depths']?.url,
      '/signalk/v1/api/resources/charts/test-depths/{z}/{x}/{y}'
    );

    const getTile = () => serveTile('test-depths', 3, 4, 2);

    const online = await getTile();
    assert.strictEqual(online.status, 200);
    assert.strictEqual(online.type, 'image/png');
    depthsOnline = false;
    try {
      const offline = await getTile();
      assert.strictEqual(offline.status, 200);
      assert.deepStrictEqual(offline.body && [...offline.body], [...PNG]);
    } finally {
      depthsOnline = true;
    }
  });

  it('downloads an area of a chart kept offline, and deletes the kept tiles', async () => {
    depthsOnline = true;
    const start = await call(handlers.get('post /online-charts/:chartId/area-download'), {
      params: { chartId: 'test-depths' },
      body: { bbox: [177, -18.5, 178.5, -17], minzoom: 5, maxzoom: 7 }
    });
    assert.strictEqual(start.statusCode, 202);
    const { job } = start.body as { job: { id: string; total: number } };

    type Job = { id: string; status: string; fetched: number; done: number };
    let done: Job | undefined;
    const deadline = Date.now() + 5000;
    while (done?.status !== 'completed' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
      const list = await call(handlers.get('get /online-area-downloads'), {});
      done = (list.body as { jobs: Job[] }).jobs.find((j) => j.id === job.id);
    }
    assert.strictEqual(done?.status, 'completed');
    assert.strictEqual(done.done, job.total);

    const statsRoute = handlers.get('get /online-charts/:chartId/offline');
    const stats = await call(statsRoute, { params: { chartId: 'test-depths' } });
    assert.ok((stats.body as { tiles: number }).tiles >= job.total);

    const cleared = await call(handlers.get('delete /online-charts/:chartId/offline'), {
      params: { chartId: 'test-depths' }
    });
    assert.strictEqual(cleared.statusCode, 200);
    const after = await call(statsRoute, { params: { chartId: 'test-depths' } });
    assert.deepStrictEqual(after.body, { tiles: 0, bytes: 0 });
  });

  it('downloads areas only of charts kept offline', async () => {
    const res = await call(handlers.get('post /online-charts/:chartId/area-download'), {
      params: { chartId: 'nws-radar-conus-2' },
      body: { bbox: [-80, 25, -79, 26], minzoom: 5, maxzoom: 6 }
    });
    assert.strictEqual(res.statusCode, 404);
  });

  it('keeps the viewed tiles of a chart whose provider allows no area downloads', async () => {
    const res = await add({ catalogId: 'test-imagery', folder: 'Online Charts' });
    assert.strictEqual(res.statusCode, 200);

    imageryOnline = true;
    assert.strictEqual((await serveTile('test-imagery', 3, 4, 2)).status, 200);
    imageryOnline = false;
    try {
      const offline = await serveTile('test-imagery', 3, 4, 2);
      assert.strictEqual(offline.status, 200);
      assert.strictEqual(offline.type, 'image/jpeg');
      assert.deepStrictEqual(offline.body && [...offline.body], [...JPEG]);
    } finally {
      imageryOnline = true;
    }

    const area = await call(handlers.get('post /online-charts/:chartId/area-download'), {
      params: { chartId: 'test-imagery' },
      body: { bbox: [177, -18.5, 178.5, -17], minzoom: 5, maxzoom: 6 }
    });
    assert.strictEqual(area.statusCode, 403);
    const jobs = await call(handlers.get('get /online-area-downloads'), {});
    assert.ok(
      !(jobs.body as { jobs: { catalogId: string }[] }).jobs.some(
        (j) => j.catalogId === 'test-imagery'
      )
    );

    const stats = await call(handlers.get('get /online-charts/:chartId/offline'), {
      params: { chartId: 'test-imagery' }
    });
    assert.strictEqual((stats.body as { tiles: number }).tiles, 1);

    const listed = await call(handlers.get('get /local-charts'), {});
    type Listed = {
      relativePath: string;
      online?: { keptOffline: boolean; areaDownload: boolean };
    };
    const online = (relativePath: string) =>
      (listed.body as { charts: Listed[] }).charts.find((c) => c.relativePath === relativePath)
        ?.online;
    const imagery = online(path.join('Online Charts', 'test-imagery.onlinechart.json'));
    assert.strictEqual(imagery?.keptOffline, true);
    assert.strictEqual(imagery.areaDownload, false);
    const depths = online(path.join('Online Charts', 'test-depths.onlinechart.json'));
    assert.strictEqual(depths?.areaDownload, true);
  });

  it("holds area downloads to the provider's limits", async () => {
    imageryOnline = true;
    const res = await add({ catalogId: 'test-paced', folder: 'Online Charts' });
    assert.strictEqual(res.statusCode, 200);
    const areaRoute = handlers.get('post /online-charts/:chartId/area-download');

    const tooLarge = await call(areaRoute, {
      params: { chartId: 'test-paced' },
      body: { bbox: [177, -18.5, 178.5, -17], minzoom: 5, maxzoom: 9 }
    });
    assert.strictEqual(tooLarge.statusCode, 400);
    assert.match((tooLarge.body as { error: string }).error, /at most 10\b/);

    const start = await call(areaRoute, {
      params: { chartId: 'test-paced' },
      body: { bbox: [177, -18.5, 178.5, -17], minzoom: 5, maxzoom: 6 }
    });
    assert.strictEqual(start.statusCode, 202);
    const { job } = start.body as { job: { id: string; total: number } };
    type Job = { id: string; status: string; done: number };
    let done: Job | undefined;
    const deadline = Date.now() + 5000;
    while (done?.status !== 'completed' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
      const list = await call(handlers.get('get /online-area-downloads'), {});
      done = (list.body as { jobs: Job[] }).jobs.find((j) => j.id === job.id);
    }
    assert.strictEqual(done?.status, 'completed');
    assert.strictEqual(done.done, job.total);

    const listed = await call(handlers.get('get /local-charts'), {});
    type Listed = {
      relativePath: string;
      online?: { areaDownload: boolean; areaDownloadLimits: unknown };
    };
    const paced = (listed.body as { charts: Listed[] }).charts.find(
      (c) => c.relativePath === path.join('Online Charts', 'test-paced.onlinechart.json')
    )?.online;
    assert.strictEqual(paced?.areaDownload, true);
    assert.deepStrictEqual(paced.areaDownloadLimits, { maxTiles: 10, requestsPerSecond: 50 });
  });

  it('refuses a custom chart whose name is only spaces', async () => {
    const res = await addCustom({
      name: '   ',
      folder: 'Online Charts',
      chart: { type: 'WMS', url: 'http://charts.lan/wms', layers: ['harbour'] }
    });
    assert.strictEqual(res.statusCode, 400);
  });

  it('adds a chart by URL and keeps its tiles when the user allows it', async () => {
    const res = await addCustom({
      name: 'Harbour WMS',
      folder: 'Online Charts',
      chart: { type: 'WMS', url: 'http://charts.lan/wms', layers: ['harbour'], keepOffline: true }
    });
    assert.strictEqual(res.statusCode, 200);
    const { relativePath } = res.body as { relativePath: string };
    assert.strictEqual(relativePath, path.join('Online Charts', 'harbour-wms.onlinechart.json'));

    const v2 = (await provider!.methods.listResources({})) as Record<
      string,
      { type: string; url: string; name: string }
    >;
    assert.strictEqual(v2['harbour-wms']?.name, 'Harbour WMS');
    assert.strictEqual(
      v2['harbour-wms']?.url,
      '/signalk/v1/api/resources/charts/harbour-wms/{z}/{x}/{y}'
    );
    const tile = await serveTile('harbour-wms', 2, 1, 1);
    assert.strictEqual(tile.status, 200);
    assert.match(lanRequests.at(-1) ?? '', /^http:\/\/charts\.lan\/wms\?.*LAYERS=harbour/);
    const stats = await call(handlers.get('get /online-charts/:chartId/offline'), {
      params: { chartId: 'harbour-wms' }
    });
    assert.strictEqual((stats.body as { tiles: number }).tiles, 1);
  });

  it('passes tiles through without keeping them when the user does not allow it', async () => {
    const res = await addCustom({
      name: 'Box Chart',
      folder: 'Online Charts',
      chart: {
        type: 'tilelayer',
        url: 'http://charts.lan/map?bbox={bbox_3857}&srs=EPSG:3857'
      }
    });
    assert.strictEqual(res.statusCode, 200);
    const v2 = (await provider!.methods.listResources({})) as Record<string, { url: string }>;
    assert.strictEqual(
      v2['box-chart']?.url,
      '/signalk/v1/api/resources/charts/box-chart/{z}/{x}/{y}'
    );
    const tile = await serveTile('box-chart', 1, 0, 0);
    assert.strictEqual(tile.status, 200);
    assert.strictEqual(
      lanRequests.at(-1),
      'http://charts.lan/map?bbox=-20037508.342789244,0,0,20037508.342789244&srs=EPSG:3857'
    );
    const stats = await call(handlers.get('get /online-charts/:chartId/offline'), {
      params: { chartId: 'box-chart' }
    });
    assert.strictEqual(stats.statusCode, 404);
  });

  it('hands a plain tile URL added by URL straight to the plotter', async () => {
    const url = 'https://tiles.example.org/{z}/{x}/{y}.png';
    const res = await addCustom({
      name: 'Plain Tiles',
      folder: '/',
      chart: { type: 'tilelayer', url, maxzoom: 16 }
    });
    assert.strictEqual(res.statusCode, 200);
    const v2 = (await provider!.methods.listResources({})) as Record<
      string,
      { url: string; maxzoom?: number }
    >;
    assert.strictEqual(v2['plain-tiles']?.url, url);
    assert.strictEqual(v2['plain-tiles']?.maxzoom, 16);
  });

  it('refuses a chart added by URL that cannot be served', async () => {
    const bad = [
      { type: 'WMS', url: 'https://charts.example.org/wms' },
      { type: 'tilelayer', url: 'https://charts.example.org/tiles.png' },
      { type: 'tilelayer', url: 'https://x/{z}/{x}/{y}', minzoom: 9, maxzoom: 3 },
      { type: 'tilelayer', url: 'ftp://x/{z}/{x}/{y}' }
    ];
    for (const chart of bad) {
      const res = await addCustom({ name: 'Bad', folder: '/', chart });
      assert.strictEqual(res.statusCode, 400, JSON.stringify(chart));
    }
  });

  it('reports the chart as added in the catalog registry', async () => {
    const res = await call(handlers.get('get /catalog-registry'), {});
    const body = res.body as {
      online: { id: string; keptOffline: boolean }[];
      onlineAdded: Record<string, string[]>;
      position: { latitude: number; longitude: number } | null;
    };
    assert.deepStrictEqual(body.position, { latitude: 24.55, longitude: -81.8 });
    const kept = Object.fromEntries(body.online.map((c) => [c.id, c.keptOffline]));
    assert.strictEqual(kept['test-depths'], true);
    assert.strictEqual(kept['nws-radar-conus'], false);
    assert.deepStrictEqual(body.onlineAdded['nws-radar-conus'], [
      path.join('Online Charts', 'nws-radar-conus-2.onlinechart.json')
    ]);
  });

  it('refuses to rename an online chart file to .mbtiles', async () => {
    const chartPathParam = path.join('Online Charts', 'nws-radar-conus-2.onlinechart.json');
    const res = await call(handlers.get('post /rename-chart'), {
      body: { chartPath: chartPathParam, newName: 'radar.mbtiles' }
    });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(fs.existsSync(path.join(chartPath, chartPathParam)));
  });

  it('shows catalog details and renames through the metadata routes', async () => {
    const chartPathParam = path.join('Online Charts', 'nws-radar-conus-2.onlinechart.json');
    const meta = await call(handlers.get('get /chart-metadata/:chartPath'), {
      params: { chartPath: chartPathParam }
    });
    assert.strictEqual((meta.body as { provider: string }).provider, 'NOAA');

    const put = await call(handlers.get('put /chart-metadata/:chartPath'), {
      params: { chartPath: chartPathParam },
      body: { name: 'My radar' }
    });
    assert.strictEqual(put.statusCode, 200);
    const v2 = (await provider!.methods.listResources({})) as Record<string, { name: string }>;
    assert.strictEqual(v2['nws-radar-conus-2']?.name, 'My radar');
  });

  it("sets an online chart's starting opacity, and clears it back to the catalog's", async () => {
    const chartPathParam = path.join('Online Charts', 'nws-radar-conus-2.onlinechart.json');
    const put = (body: unknown) =>
      call(handlers.get('put /chart-metadata/:chartPath'), {
        params: { chartPath: chartPathParam },
        body
      });
    const served = async () =>
      ((await provider!.methods.listResources({})) as Record<string, { defaultOpacity?: number }>)[
        'nws-radar-conus-2'
      ]?.defaultOpacity;
    const catalogOpacity = await served();

    assert.strictEqual((await put({ name: 'My radar', defaultOpacity: 0.4 })).statusCode, 200);
    assert.strictEqual(await served(), 0.4);
    const meta = await call(handlers.get('get /chart-metadata/:chartPath'), {
      params: { chartPath: chartPathParam }
    });
    assert.deepStrictEqual(
      [
        (meta.body as { defaultOpacity?: number }).defaultOpacity,
        (meta.body as { catalogOpacity?: number }).catalogOpacity
      ],
      [0.4, catalogOpacity]
    );

    assert.strictEqual((await put({ name: 'My radar', defaultOpacity: 1.5 })).statusCode, 400);
    assert.strictEqual((await put({ name: 'My radar', defaultOpacity: null })).statusCode, 200);
    assert.strictEqual(await served(), catalogOpacity);
    const file = JSON.parse(
      fs.readFileSync(path.join(chartPath, chartPathParam), 'utf-8')
    ) as object;
    assert.ok(!('defaultOpacity' in file));
  });

  it('refuses a default opacity for a chart file that is not an online chart', async () => {
    const chartFile = path.join(chartPath, 'opacity-test.mbtiles');
    fs.copyFileSync(
      path.join(import.meta.dirname, '..', 'test', 'fixtures', 'test-chart.mbtiles'),
      chartFile
    );
    try {
      const put = await call(handlers.get('put /chart-metadata/:chartPath'), {
        params: { chartPath: 'opacity-test.mbtiles' },
        body: { name: 'Renamed', defaultOpacity: 0.5 }
      });
      assert.strictEqual(put.statusCode, 400);
    } finally {
      fs.rmSync(chartFile, { force: true });
    }
  });

  it('lists added charts whose file names an inherited key as its catalog id', async () => {
    for (const id of ['constructor', '__proto__']) {
      fs.writeFileSync(
        path.join(chartPath, `odd-${id}.onlinechart.json`),
        JSON.stringify({ catalogId: id, name: id })
      );
    }
    await call(handlers.get('post /refresh'), {});
    const res = await call(handlers.get('get /catalog-registry'), {});
    assert.strictEqual(res.statusCode, 200);
    const added = (res.body as { onlineAdded: Record<string, string[]> }).onlineAdded;
    assert.deepStrictEqual(added.constructor, ['odd-constructor.onlinechart.json']);
    assert.deepStrictEqual(Object.getOwnPropertyDescriptor(added, '__proto__')?.value, [
      'odd-__proto__.onlinechart.json'
    ]);
  });

  it("deletes a chart's kept tiles with the last chart file that uses them", async () => {
    const cacheFile = path.join(
      tempDir,
      'plugin-config-data',
      'signalk-charts-provider-simple',
      'online-tile-cache',
      'test-depths.mbtiles'
    );
    depthsOnline = true;
    const start = await call(handlers.get('post /online-charts/:chartId/area-download'), {
      params: { chartId: 'test-depths' },
      body: { bbox: [177, -18.5, 178.5, -17], minzoom: 5, maxzoom: 6 }
    });
    assert.strictEqual(start.statusCode, 202);
    const deadline = Date.now() + 5000;
    for (;;) {
      const list = await call(handlers.get('get /online-area-downloads'), {});
      if ((list.body as { jobs: { status: string }[] }).jobs.every((j) => j.status !== 'running')) {
        break;
      }
      assert.ok(Date.now() < deadline, 'area download should finish');
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(fs.existsSync(cacheFile));

    const second = await add({ catalogId: 'test-depths', folder: '/' });
    assert.strictEqual(second.statusCode, 200);
    const deleteChart = (relativePath: string) =>
      call(handlers.get('delete /local-charts/:chartPath'), {
        params: { chartPath: encodeURIComponent(relativePath) }
      });

    assert.strictEqual(
      (await deleteChart(path.join('Online Charts', 'test-depths.onlinechart.json'))).statusCode,
      200
    );
    assert.ok(fs.existsSync(cacheFile), 'another chart file still uses the tiles');

    const { relativePath } = second.body as { relativePath: string };
    assert.strictEqual((await deleteChart(relativePath)).statusCode, 200);
    assert.strictEqual(fs.existsSync(cacheFile), false);
  });
});
