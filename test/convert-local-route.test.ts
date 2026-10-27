/**
 * Route-level tests for converting charts already on the server
 * (POST /convert-local): what it refuses, and that a conversion that fails
 * leaves the source as it was, adds no chart and removes its work folder.
 * Runs the real plugin against a temporary chart folder.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

import type { Plugin } from '@signalk/server-api';
import type { ExtendedServerAPI } from '../dist/types.js';
import pluginFactoryDefault from '../dist/index.js';
import { downloadManager } from '../dist/utils/download-manager.js';
import { getConvertingCount, setConvertingState } from '../dist/utils/catalog-manager.js';
import { getConversionProgress } from '../dist/utils/rnc-converter.js';

const pluginFactory = pluginFactoryDefault as unknown as (app: ExtendedServerAPI) => Plugin;

type PluginRouter = Parameters<NonNullable<Plugin['registerWithRouter']>>[0];
type RouteHandler = (req: unknown, res: unknown) => void | Promise<void>;

interface FakeRes {
  statusCode: number;
  body: unknown;
  done: boolean;
  status(code: number): FakeRes;
  json(payload: unknown): FakeRes;
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
    }
  };
}

async function waitFor(check: () => boolean, what: string, ms = 10000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.ok(check(), what);
}

describe('POST /convert-local', () => {
  let tempDir: string;
  let chartPath: string;
  let dataDir: string;
  let plugin: Plugin;
  const handlers = new Map<string, RouteHandler>();

  const convert = async (body: unknown): Promise<FakeRes> => {
    const handler = handlers.get('post /convert-local');
    assert.ok(handler, 'route should be registered');
    const res = makeRes();
    await handler({ body }, res);
    await waitFor(() => res.done, 'route should answer');
    return res;
  };

  before(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'convert-local-'));
    chartPath = path.join(tempDir, 'charts');
    fs.mkdirSync(chartPath, { recursive: true });
    dataDir = path.join(tempDir, 'plugin-config-data', 'signalk-charts-provider-simple');
    fs.mkdirSync(dataDir, { recursive: true });

    let started = false;
    const app = {
      config: { configPath: tempDir, ssl: false, version: '2.0.0', getExternalPort: () => 3000 },
      debug: () => {},
      error: () => {},
      setPluginStatus: () => {},
      setPluginError: () => {},
      getDataDirPath: () => dataDir,
      registerResourceProvider: () => {
        started = true;
      },
      handleMessage: () => {},
      // No signalk-container: conversions take the WebAssembly toolchain
      // without waiting for its discovery.
      getPluginsList: () => Promise.resolve([]),
      getSelfPath: () => undefined
    } as unknown as ExtendedServerAPI;

    plugin = pluginFactory(app);
    const router = {
      get: () => router,
      put: () => router,
      delete: () => router,
      post: (routePath: string, handler: RouteHandler) => {
        handlers.set(`post ${routePath}`, handler);
        return router;
      }
    } as unknown as PluginRouter;
    plugin.registerWithRouter?.(router);
    plugin.start({ chartPath }, () => {});
    await waitFor(() => started, 'resource provider should register');
  });

  after(() => {
    plugin.stop?.();
    downloadManager.removeAllListeners();
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('refuses a path it cannot convert, saying why', async () => {
    const empty = path.join(tempDir, 'empty');
    fs.mkdirSync(empty);
    const cases: [unknown, RegExp][] = [
      [{ type: 's57', path: 'charts/ENC_ROOT' }, /full path/],
      [{ type: 's57', path: path.join(tempDir, 'missing') }, /does not exist/],
      [{ type: 'rnc', path: empty }, /holds no BSB charts/],
      [{ type: 's57', path: empty, minzoom: 12, maxzoom: 10 }, /minzoom must be/],
      [{ type: 'pdf', path: empty }, /Invalid request body/]
    ];
    for (const [body, error] of cases) {
      const res = await convert(body);
      assert.strictEqual(res.statusCode, 400, JSON.stringify(body));
      assert.match((res.body as { error: string }).error, error);
    }
    assert.strictEqual(getConvertingCount(), 0);
  });

  it('refuses a folder whose name is already converting', async () => {
    const source = path.join(tempDir, 'Busy');
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, 'busy_1.kap'), 'not a chart');
    setConvertingState('Busy', true);
    try {
      const res = await convert({ type: 'rnc', path: source });
      assert.strictEqual(res.statusCode, 409);
      assert.match((res.body as { error: string }).error, /already being converted/);
    } finally {
      setConvertingState('Busy', false);
    }
    assert.ok(!fs.readdirSync(dataDir).some((f) => f.startsWith('convert-local-')));
  });

  it('leaves the source as it was when its charts fail to convert', async () => {
    const source = path.join(tempDir, 'Broken BSB');
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, 'broken_1.kap'), 'not a chart');
    const before = fs.readdirSync(source);

    const res = await convert({ type: 'rnc', path: source });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, {
      success: true,
      chartNumber: 'Broken_BSB',
      looseFiles: 1,
      zips: 0,
      unreadableZips: 0,
      message: 'Conversion started'
    });

    await waitFor(() => getConvertingCount() === 0, 'conversion should end', 30000);
    assert.strictEqual(getConversionProgress('Broken_BSB')?.status, 'failed');
    assert.deepStrictEqual(fs.readdirSync(source), before);
    assert.ok(!fs.readdirSync(chartPath).some((f) => f.endsWith('.mbtiles')));
    assert.ok(!fs.readdirSync(dataDir).some((f) => f.startsWith('convert-local-')));
  });
});
