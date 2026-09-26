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
      use: 'stream',
      format: 'wms'
    }
  ]
};

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
    // Offline: the plugin serves the cached catalog.
    mock.method(globalThis, 'fetch', () => Promise.reject(new TypeError('offline')));

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
      handleMessage: () => {}
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

  it('reports the chart as added in the catalog registry', async () => {
    const res = await call(handlers.get('get /catalog-registry'), {});
    const body = res.body as { onlineAdded: Record<string, string[]> };
    assert.deepStrictEqual(body.onlineAdded['nws-radar-conus'], [
      path.join('Online Charts', 'nws-radar-conus-2.onlinechart.json')
    ]);
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
});
