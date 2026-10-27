/**
 * Chart conversion never depends on a container runtime: without
 * signalk-container it runs in-process (GDAL compiled to WebAssembly), so
 * startup raises no error even when catalog-installed charts will need
 * converting, and the status route reports conversion as available. With a
 * runtime, the status route reports the container toolchain.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import type { Plugin } from '@signalk/server-api';
import type { ExtendedServerAPI } from '../dist/types.js';
import pluginFactoryDefault from '../dist/index.js';
import { downloadManager } from '../dist/utils/download-manager.js';
import {
  _resetContainerManagerForTests,
  type ContainerManagerApi
} from '../dist/utils/container-manager.js';

declare global {
  var __signalk_containerManager: ContainerManagerApi | undefined;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pluginFactory = pluginFactoryDefault as unknown as (app: ExtendedServerAPI) => Plugin;
const FIXTURES = path.join(__dirname, '..', 'test', 'fixtures');

/** Records setPluginStatus / setPluginError calls. */
interface RecordingApp {
  app: ExtendedServerAPI;
  statuses: string[];
  errors: string[];
}

type PluginRouter = Parameters<NonNullable<Plugin['registerWithRouter']>>[0];
type RouteHandler = (req: unknown, res: unknown) => void | Promise<void>;

function createRecordingApp(configPath: string): RecordingApp {
  const pluginDataDir = path.join(
    configPath,
    'plugin-config-data',
    'signalk-charts-provider-simple'
  );
  fs.mkdirSync(pluginDataDir, { recursive: true });
  const statuses: string[] = [];
  const errors: string[] = [];
  const app = {
    config: {
      configPath,
      ssl: false,
      version: '2.0.0',
      getExternalPort: () => 3000
    },
    debug: () => {},
    error: () => {},
    setPluginStatus: (msg: string) => {
      statuses.push(msg);
    },
    setPluginError: (msg: string) => {
      errors.push(msg);
    },
    getDataDirPath: () => pluginDataDir,
    registerResourceProvider: () => {},
    handleMessage: () => {}
  } as unknown as ExtendedServerAPI;
  return { app, statuses, errors };
}

/** Records registered routes like the Express router would receive them. */
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

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(predicate(), `Timed out waiting for: ${what}`);
}

/**
 * A committed catalog install record (no previousVersion marker), as left
 * behind by a successful catalog download+conversion.
 */
function writeCatalogInstall(dataDir: string, chartNumber: string): void {
  const record = {
    [chartNumber]: {
      catalogFile: 'US_Catalog.xml',
      zipfile_datetime_iso8601: '2024-01-01T00:00:00Z',
      installedAt: '2024-01-01T00:00:00Z',
      zipfile_location: 'https://charts.noaa.gov/example.zip',
      installedFilename: `${chartNumber}.mbtiles`
    }
  };
  fs.writeFileSync(
    path.join(dataDir, 'catalog-installs.json'),
    JSON.stringify(record, null, 2),
    'utf-8'
  );
}

describe('Conversion availability', () => {
  const plugins: Plugin[] = [];
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const plugin of plugins.splice(0)) {
      plugin.stop?.();
    }
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
    downloadManager.removeAllListeners();
    _resetContainerManagerForTests();
    delete globalThis.__signalk_containerManager;
  });

  it('starts without a plugin error when installed catalog charts need conversion', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conversion-status-'));
    tempDirs.push(tempDir);
    const chartPath = path.join(tempDir, 'charts');
    fs.mkdirSync(chartPath, { recursive: true });
    fs.copyFileSync(
      path.join(FIXTURES, 'test-chart.mbtiles'),
      path.join(chartPath, 'US5CA52M.mbtiles')
    );
    const recording = createRecordingApp(tempDir);
    writeCatalogInstall(recording.app.getDataDirPath(), 'US5CA52M');

    const plugin = pluginFactory(recording.app);
    plugins.push(plugin);
    const { router, handlers } = createRouterStub();
    plugin.registerWithRouter?.(router);
    plugin.start({ chartPath }, () => {});
    await waitFor(() => recording.statuses.includes('Started'), 'startup');

    assert.deepStrictEqual(recording.errors, [], 'no plugin error may be raised');

    const status = handlers.get('get /catalog-s57-status');
    assert.ok(status, 'status route should be registered');
    const res = makeRes();
    await status({}, res);
    const body = res.body as {
      conversionAvailable?: boolean;
      conversionEngine?: string;
      wasmConverter?: string;
      containerRuntimeAvailable?: boolean;
      podmanAvailable?: boolean;
    };
    assert.strictEqual(body.conversionAvailable, true);
    assert.strictEqual(body.conversionEngine, 'wasm');
    assert.match(String(body.wasmConverter), /^gdal3\.js/);
    assert.strictEqual(body.containerRuntimeAvailable, false);
    // Older UIs disabled conversion on this; conversion is available.
    assert.strictEqual(body.podmanAvailable, true);
  });

  it('reports the container toolchain once signalk-container has a runtime', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conversion-status-'));
    tempDirs.push(tempDir);
    const chartPath = path.join(tempDir, 'charts');
    fs.mkdirSync(chartPath, { recursive: true });
    let reaps = 0;
    globalThis.__signalk_containerManager = {
      getRuntime: () => ({ runtime: 'podman', version: '5.0.0' }),
      imageExists: () => Promise.resolve(true),
      pullImage: () => Promise.resolve(),
      runJob: () => Promise.resolve({ status: 'completed', exitCode: 0, log: [] }),
      resolveSignalkDataMount: () => Promise.resolve(null),
      resolveHostPath: (p: string) => Promise.resolve({ source: p, subPath: '' }),
      cleanupOrphanedJobs: () => {
        reaps++;
        return Promise.resolve({ reaped: [] });
      }
    };
    const recording = createRecordingApp(tempDir);
    const plugin = pluginFactory(recording.app);
    plugins.push(plugin);
    const { router, handlers } = createRouterStub();
    plugin.registerWithRouter?.(router);
    plugin.start({ chartPath }, () => {});
    await waitFor(() => recording.statuses.includes('Started'), 'startup');

    const status = handlers.get('get /catalog-s57-status');
    assert.ok(status, 'status route should be registered');
    await waitFor(() => {
      const res = makeRes();
      void status({}, res);
      return (res.body as { conversionEngine?: string }).conversionEngine === 'container';
    }, 'container discovery');
    const res = makeRes();
    await status({}, res);
    const body = res.body as { containerRuntimeVersion?: string; conversionAvailable?: boolean };
    assert.strictEqual(body.containerRuntimeVersion, 'podman version 5.0.0');
    assert.strictEqual(body.conversionAvailable, true);
    assert.deepStrictEqual(recording.errors, []);
    // Orphans are reaped at most once per process; an earlier test file may
    // have used the one reap already.
    assert.ok(reaps <= 1);
  });
});
