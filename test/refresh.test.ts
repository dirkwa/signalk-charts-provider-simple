/**
 * Tests for the external chart-refresh contract: the POST /refresh
 * route and the in-process `__signalk_chartsProviderRefresh` global.
 *
 * Chart producers (e.g. signalk-corridor-tile-downloader) write
 * .mbtiles files into the charts directory while the server runs.
 * findCharts has no file watcher, so those files stay unregistered
 * until a rescan — these tests pin both trigger paths.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import type { Plugin } from '@signalk/server-api';
import type { ChartsProviderRefreshGlobal, ExtendedServerAPI } from '../dist/types.js';
import pluginFactoryDefault from '../dist/index.js';
import { downloadManager } from '../dist/utils/download-manager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pluginFactory = pluginFactoryDefault as unknown as (app: ExtendedServerAPI) => Plugin;
const FIXTURES = path.join(__dirname, '..', 'test', 'fixtures');

const REFRESH_GLOBAL = '__signalk_chartsProviderRefresh';

after(() => {
  try {
    downloadManager.removeAllListeners();
  } catch {
    // Ignore if module not loaded
  }
});

function createMockApp(configPath: string): ExtendedServerAPI {
  const pluginDataDir = path.join(
    configPath,
    'plugin-config-data',
    'signalk-charts-provider-simple'
  );
  fs.mkdirSync(pluginDataDir, { recursive: true });
  return {
    config: {
      configPath,
      ssl: false,
      version: '2.0.0',
      getExternalPort: () => 3000
    },
    debug: () => {},
    error: () => {},
    setPluginStatus: () => {},
    setPluginError: () => {},
    getDataDirPath: () => pluginDataDir,
    registerResourceProvider: () => {},
    handleMessage: () => {}
  } as unknown as ExtendedServerAPI;
}

type ResourceProvider = Parameters<ExtendedServerAPI['registerResourceProvider']>[0];
type PluginRouter = Parameters<NonNullable<Plugin['registerWithRouter']>>[0];
type RouteHandler = (req: unknown, res: unknown) => void | Promise<void>;

/** Records registered routes like the Express router would receive them. */
function createRouterStub(): {
  router: PluginRouter;
  handlers: Map<string, RouteHandler>;
} {
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

function makeRes(): {
  statusCode: number;
  body: unknown;
  status(code: number): unknown;
  json(payload: unknown): unknown;
} {
  return {
    statusCode: 200,
    body: undefined,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    }
  };
}

/**
 * A directory-based chart (tilemap directory), as produced by gdal2tiles.
 * Unlike an .mbtiles file, it keeps no live DatabaseSync handle, so deleting
 * the charts directory mid-test cannot be blocked by an open file handle
 * (EBUSY/EPERM on Windows).
 */
function writeTilemapChart(parentDir: string, name: string): void {
  const chartDir = path.join(parentDir, name);
  fs.mkdirSync(chartDir, { recursive: true });
  fs.writeFileSync(
    path.join(chartDir, 'tilemapresource.xml'),
    `<?xml version="1.0" encoding="utf-8"?>
<TileMap version="1.0.0" tilemapservice="http://tms.osgeo.org/1.0.0">
  <Title>Test Chart</Title>
  <Abstract>Test Chart</Abstract>
  <SRS>EPSG:3857</SRS>
  <BoundingBox minx="-180" miny="-85" maxx="180" maxy="85"/>
  <TileFormat width="256" height="256" mime-type="image/png" extension="png"/>
  <TileSets profile="global-mercator">
    <TileSet href="0" order="0" units-per-pixel="156543.03392804097"/>
    <TileSet href="1" order="1" units-per-pixel="78271.516964020484"/>
  </TileSets>
</TileMap>
`
  );
}

describe('External chart refresh', () => {
  it('registers new .mbtiles via the global hook, the route, and withdraws on stop', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'refresh-test-'));
    const chartPath = path.join(tempDir, 'charts');
    fs.mkdirSync(chartPath, { recursive: true });
    fs.copyFileSync(
      path.join(FIXTURES, 'test-chart.mbtiles'),
      path.join(chartPath, 'test-chart.mbtiles')
    );

    const app = createMockApp(tempDir);
    let provider: ResourceProvider | undefined;
    app.registerResourceProvider = (p) => {
      provider = p;
    };

    const plugin = pluginFactory(app);
    const { router, handlers } = createRouterStub();
    plugin.registerWithRouter?.(router);
    const refreshRoute = handlers.get('post /refresh');
    assert.ok(refreshRoute, 'POST /refresh route should be registered');

    plugin.start({ chartPath }, () => {});

    const deadline = Date.now() + 5000;
    while (!provider && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(provider, 'Resource provider should be registered within 5s');

    try {
      // A chart written after startup is invisible until a refresh
      fs.copyFileSync(
        path.join(FIXTURES, 'test-chart.mbtiles'),
        path.join(chartPath, 'late-chart.mbtiles')
      );
      const before = (await provider.methods.listResources({})) as Record<string, unknown>;
      assert.ok(before['test-chart'], 'startup chart is listed');
      assert.ok(!before['late-chart'], 'late chart is not listed before refresh');

      // In-process hook (peer-plugin path): refreshes and reports count
      const refreshGlobal = globalThis as unknown as ChartsProviderRefreshGlobal;
      const hook = refreshGlobal[REFRESH_GLOBAL];
      assert.strictEqual(typeof hook, 'function', 'refresh hook should be published');
      const count = await hook!();
      assert.strictEqual(count, 2, 'both charts enabled after hook refresh');

      const afterHook = (await provider.methods.listResources({})) as Record<string, unknown>;
      assert.ok(afterHook['late-chart'], 'late chart is listed after hook refresh');

      // REST route returns the refreshed chart count too
      const res = makeRes();
      await refreshRoute({}, res);
      assert.strictEqual(res.statusCode, 200);
      assert.deepStrictEqual(res.body, { status: 'ok', charts: 2 });
    } finally {
      plugin.stop?.();
      // The hook must be withdrawn with the plugin
      assert.strictEqual(
        (globalThis as unknown as ChartsProviderRefreshGlobal)[REFRESH_GLOBAL],
        undefined,
        'refresh hook should be removed on stop'
      );
      fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it('preserves served charts and reports failure when the scan fails', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'refresh-fail-'));
    const chartPath = path.join(tempDir, 'charts');
    fs.mkdirSync(chartPath, { recursive: true });
    // Directory-based chart: no retained DatabaseSync handle, so the
    // chartPath removal below succeeds on every platform.
    writeTilemapChart(chartPath, 'test-chart');

    const app = createMockApp(tempDir);
    let provider: ResourceProvider | undefined;
    app.registerResourceProvider = (p) => {
      provider = p;
    };

    const plugin = pluginFactory(app);
    const { router, handlers } = createRouterStub();
    plugin.registerWithRouter?.(router);
    const refreshRoute = handlers.get('post /refresh');
    assert.ok(refreshRoute, 'POST /refresh route should be registered');

    plugin.start({ chartPath }, () => {});

    const deadline = Date.now() + 5000;
    while (!provider && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(provider, 'Resource provider should be registered within 5s');

    try {
      const before = (await provider.methods.listResources({})) as Record<string, unknown>;
      assert.ok(before['test-chart'], 'chart is served after startup');

      // Make the scan fail deterministically (deleting the directory works
      // regardless of the user the tests run as — chmod 000 does not stop
      // root).
      fs.rmSync(chartPath, { recursive: true, force: true });

      // The hook rejects instead of resolving with the stale chart count
      const hook = (globalThis as unknown as ChartsProviderRefreshGlobal)[REFRESH_GLOBAL];
      assert.strictEqual(typeof hook, 'function', 'refresh hook should be published');
      await assert.rejects(hook!());

      // The route reports 500 rather than { status: 'ok', charts: 0 }
      const res = makeRes();
      await refreshRoute({}, res);
      assert.strictEqual(res.statusCode, 500);
      assert.deepStrictEqual(res.body, { error: 'Chart refresh failed' });

      // The failed scan must not have replaced the provider map with an
      // empty one — already-served charts stay served.
      const after = (await provider.methods.listResources({})) as Record<string, unknown>;
      assert.ok(after['test-chart'], 'existing chart stays served after failed refresh');
    } finally {
      plugin.stop?.();
      fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});
