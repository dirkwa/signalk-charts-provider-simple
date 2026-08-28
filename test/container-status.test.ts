/**
 * Tests for the plugin-status handling of a missing signalk-container
 * runtime (the "signalk-container plugin required…" error used to be
 * shown unconditionally, even on pure display setups).
 *
 * Contract under test:
 *  - Startup WITHOUT container-dependent chart sources (no catalog
 *    installs, no saved chart sets, nothing converting): no plugin error,
 *    status stays "Started", and a server-log line notes that conversion
 *    is disabled.
 *  - Startup WITH a catalog-installed chart (whose updates are
 *    download+convert and therefore need the runtime): the plugin error
 *    IS raised, while chart display still starts.
 *  - A user-initiated conversion attempt (here: chart-set
 *    download-convert) with no runtime: the route answers 503 AND
 *    surfaces the plugin error on the status line.
 *
 * To keep `waitForContainerManager` from burning its full 30 s budget,
 * each test publishes a manager stub whose `getRuntime()` reports null
 * and whose `whenReady()` resolves immediately — the same fast path a
 * real signalk-container with failed runtime detection takes.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import type { Plugin } from '@signalk/server-api';
import type { ExtendedServerAPI } from '../dist/types.js';
import pluginFactoryDefault from '../dist/index.js';
import { createCustomCatalog, saveCustomCatalog } from '../dist/utils/custom-catalog-manager.js';
import {
  _resetContainerManagerForTests,
  type ContainerManagerApi
} from '../dist/utils/container-manager.js';
import { downloadManager } from '../dist/utils/download-manager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pluginFactory = pluginFactoryDefault as unknown as (app: ExtendedServerAPI) => Plugin;
const FIXTURES = path.join(__dirname, '..', 'test', 'fixtures');

const GLOBAL_KEY = '__signalk_containerManager';
const CONTAINER_REQUIRED_MESSAGE =
  'signalk-container plugin required for chart conversion. Install it from the App Store and restart Signal K. Chart display continues to work without it.';
const CONVERSION_DISABLED_LOG =
  '[charts-provider] signalk-container not available — chart conversion disabled (chart display unaffected)';

declare global {
  var __signalk_containerManager: ContainerManagerApi | undefined;
}

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

/** Manager stub: published, but runtime detection "failed". */
function publishFailedRuntimeManager(): void {
  globalThis[GLOBAL_KEY] = {
    getRuntime: () => null,
    whenReady: () => Promise.resolve(),
    pullImage: () => Promise.resolve(),
    imageExists: () => Promise.resolve(false),
    runJob: () => Promise.resolve({ status: 'failed', log: [] }),
    resolveSignalkDataMount: () => Promise.resolve(null),
    resolveHostPath: () => Promise.resolve(null)
  };
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

interface StartedPlugin {
  plugin: Plugin;
  recording: RecordingApp;
  handlers: Map<string, RouteHandler>;
  tempDir: string;
  logLines: string[];
}

/**
 * Start a full plugin instance against a fresh temp config/chart tree.
 * Captures the plugin's console output so startup progress (and the
 * "conversion disabled" line) can be observed deterministically.
 */
async function startPlugin(opts: { withCatalogInstall?: string } = {}): Promise<StartedPlugin> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'container-status-'));
  const chartPath = path.join(tempDir, 'charts');
  fs.mkdirSync(chartPath, { recursive: true });
  fs.copyFileSync(
    path.join(FIXTURES, 'test-chart.mbtiles'),
    path.join(chartPath, 'test-chart.mbtiles')
  );

  const recording = createRecordingApp(tempDir);
  if (opts.withCatalogInstall) {
    // The install's chart file must exist or pruneStaleInstalls drops the
    // record during chart loading — before the container check runs.
    fs.copyFileSync(
      path.join(FIXTURES, 'test-chart.mbtiles'),
      path.join(chartPath, `${opts.withCatalogInstall}.mbtiles`)
    );
    writeCatalogInstall(recording.app.getDataDirPath(), opts.withCatalogInstall);
  }

  const plugin = pluginFactory(recording.app);
  const { router, handlers } = createRouterStub();
  plugin.registerWithRouter?.(router);

  const logLines: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    logLines.push(args.map(String).join(' '));
  };
  try {
    plugin.start({ chartPath }, () => {});
    // The container wait resolves quickly via whenReady(); wait for the
    // post-wait branch to have run (either the error or the log line).
    await waitFor(
      () =>
        recording.errors.includes(CONTAINER_REQUIRED_MESSAGE) ||
        logLines.includes(CONVERSION_DISABLED_LOG),
      'container-missing branch after startup wait'
    );
  } finally {
    console.log = originalLog;
  }

  return { plugin, recording, handlers, tempDir, logLines };
}

describe('Plugin status without signalk-container runtime', () => {
  let activePlugins: Plugin[];
  let tempDirs: string[];

  beforeEach(() => {
    _resetContainerManagerForTests();
    publishFailedRuntimeManager();
    activePlugins = [];
    tempDirs = [];
  });

  afterEach(() => {
    for (const plugin of activePlugins) {
      plugin.stop?.();
    }
    delete globalThis[GLOBAL_KEY];
    _resetContainerManagerForTests();
    for (const dir of tempDirs) {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
    try {
      downloadManager.removeAllListeners();
    } catch {
      // Ignore if module not loaded
    }
  });

  it('shows no error on a pure display setup; logs that conversion is disabled', async () => {
    const started = await startPlugin();
    activePlugins.push(started.plugin);
    tempDirs.push(started.tempDir);

    assert.ok(
      started.logLines.includes(CONVERSION_DISABLED_LOG),
      'server log must note that conversion is disabled'
    );
    assert.deepStrictEqual(
      started.recording.errors,
      [],
      'no plugin error may be raised when nothing needs the container'
    );
    assert.strictEqual(
      started.recording.statuses.at(-1),
      'Started',
      'plugin status must stay "Started" (display path healthy)'
    );
  });

  it('raises the error when catalog-installed charts need the runtime for updates', async () => {
    const started = await startPlugin({ withCatalogInstall: 'US5CA52M' });
    activePlugins.push(started.plugin);
    tempDirs.push(started.tempDir);

    assert.ok(
      started.recording.errors.includes(CONTAINER_REQUIRED_MESSAGE),
      'container-required error must be raised when catalog charts are installed'
    );
    assert.ok(
      started.recording.statuses.includes('Started'),
      'display path must still report Started alongside the error'
    );
  });

  it('surfaces the plugin error when a conversion operation is attempted', async () => {
    const started = await startPlugin();
    activePlugins.push(started.plugin);
    tempDirs.push(started.tempDir);
    assert.strictEqual(
      started.recording.errors.length,
      0,
      'precondition: no error from startup (pure display setup)'
    );

    // A saved chart set with a selection — the NOAA tab's conversion path.
    const catalog = createCustomCatalog('Test Set');
    catalog.selectedBand4ChartIds = ['US4CA63M'];
    saveCustomCatalog(catalog);

    const downloadConvert = started.handlers.get('post /custom-catalogs/:id/download-convert');
    assert.ok(downloadConvert, 'download-convert route should be registered');

    const res = makeRes();
    await downloadConvert({ params: { id: catalog.id } }, res);

    assert.strictEqual(res.statusCode, 503, 'route must reject with 503');
    assert.match(
      String((res.body as { error?: string }).error),
      /signalk-container plugin not available/
    );
    assert.ok(
      started.recording.errors.includes(CONTAINER_REQUIRED_MESSAGE),
      'failed conversion attempt must surface the plugin error'
    );
  });
});
