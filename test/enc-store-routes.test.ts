/**
 * The shared ENC store as the plugin serves it: the in-process
 * `__signalk_chartsProviderEnc` global, the `/enc-store` routes, and the
 * chart sets it shares at start.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

import type { Plugin } from '@signalk/server-api';
import type { ChartsProviderEncGlobal, ExtendedServerAPI } from '../dist/types.js';
import pluginFactoryDefault from '../dist/index.js';
import { downloadManager } from '../dist/utils/download-manager.js';
import { chartOwner, storeCollection } from '../dist/utils/enc-store.js';

const pluginFactory = pluginFactoryDefault as unknown as (app: ExtendedServerAPI) => Plugin;

after(() => {
  downloadManager.removeAllListeners();
});

type PluginRouter = Parameters<NonNullable<Plugin['registerWithRouter']>>[0];
type RouteHandler = (req: unknown, res: unknown) => void | Promise<void>;

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

interface FakeRes {
  statusCode: number;
  body: unknown;
  sent: { file: string; options: Record<string, unknown> } | null;
  done: Promise<void>;
  status(code: number): FakeRes;
  json(payload: unknown): FakeRes;
  sendFile(file: string, options: Record<string, unknown>): void;
}

function makeRes(): FakeRes {
  let finish: () => void = () => {};
  const res: FakeRes = {
    statusCode: 200,
    body: undefined,
    sent: null,
    done: new Promise((resolve) => {
      finish = resolve;
    }),
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(payload) {
      res.body = payload;
      finish();
      return res;
    },
    sendFile(file, options) {
      res.sent = { file, options };
      finish();
    }
  };
  return res;
}

function writeCell(dir: string, name: string): string {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.000`), `base ${name}`);
  return path.join(dir, `${name}.000`);
}

describe('ENC store routes and global', () => {
  it('shares chart sets at start, serves collections and files, and withdraws on stop', async () => {
    const configPath = fs.mkdtempSync(path.join(os.tmpdir(), 'enc-store-routes-'));
    const dataDir = path.join(configPath, 'plugin-config-data', 'signalk-charts-provider-simple');
    const chartPath = path.join(configPath, 'charts');
    fs.mkdirSync(chartPath, { recursive: true });
    // A chart set kept by an earlier version: its definition and its cached cell.
    fs.mkdirSync(path.join(dataDir, 'custom-catalogs'), { recursive: true });
    fs.writeFileSync(
      path.join(dataDir, 'custom-catalogs', 'Gulf.json'),
      JSON.stringify({ name: 'Gulf', status: 'converted', convertedChartPath: 'Gulf.mbtiles' })
    );
    const cellDir = path.join(dataDir, 'chart-set-cache', 'Gulf', 'cells', 'FI5AAAAA');
    writeCell(path.join(cellDir, 'raw'), 'FI5AAAAA');
    fs.writeFileSync(
      path.join(cellDir, 'cell.json'),
      JSON.stringify({ version: 'FI5AAAAA_ED001_UP000', exportRevision: 2, image: 'x', bytes: 1 })
    );

    const app = {
      config: { configPath, ssl: false, version: '2.0.0', getExternalPort: () => 3000 },
      debug: () => {},
      error: () => {},
      setPluginStatus: () => {},
      setPluginError: () => {},
      getDataDirPath: () => dataDir,
      registerResourceProvider: () => {},
      handleMessage: () => {},
      subscriptionmanager: { subscribe: () => {}, unsubscribe: () => {} }
    } as unknown as ExtendedServerAPI;
    const plugin = pluginFactory(app);
    const { router, handlers } = createRouterStub();
    plugin.registerWithRouter?.(router);
    plugin.start({ chartPath }, () => {});
    const g = globalThis as unknown as ChartsProviderEncGlobal;

    try {
      const deadline = Date.now() + 5000;
      while (
        (!g.__signalk_chartsProviderEnc ||
          g.__signalk_chartsProviderEnc.collections().length === 0) &&
        Date.now() < deadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const api = g.__signalk_chartsProviderEnc;
      assert.ok(api, 'the ENC store is published');
      assert.strictEqual(api.apiVersion, 1);
      assert.strictEqual(api.root, path.join(dataDir, 'enc-store'));
      assert.deepStrictEqual(
        api.collections().map((c) => [c.id, c.kind, c.chart, c.cellCount]),
        [['Gulf', 'chart-set', 'Gulf.mbtiles', 1]]
      );
      assert.strictEqual(api.collection('Gulf')?.cells[0]?.version, 'FI5AAAAA_ED001_UP000');

      // A converted chart's cells, as keepCells stores them.
      const base = writeCell(path.join(configPath, 'upload', 'ENC_ROOT'), 'US5MA1AM');
      await storeCollection({
        owner: chartOwner('US5MA1AM.mbtiles'),
        preferredId: 'US5MA1AM.mbtiles',
        name: 'US5MA1AM',
        kind: 'conversion',
        chart: 'US5MA1AM.mbtiles',
        source: 'upload',
        cells: [{ base }],
        mode: 'link'
      });

      const list = makeRes();
      await handlers.get('get /enc-store')?.({}, list);
      const listed = list.body as { keepEncCells: boolean; collections: { id: string }[] };
      assert.strictEqual(listed.keepEncCells, false);
      assert.deepStrictEqual(
        listed.collections.map((c) => c.id),
        ['Gulf', 'US5MA1AM']
      );

      const one = makeRes();
      await handlers.get('get /enc-store/:collection')?.({ params: { collection: 'Gulf' } }, one);
      assert.strictEqual((one.body as { cellCount: number }).cellCount, 1);
      const none = makeRes();
      await handlers.get('get /enc-store/:collection')?.({ params: { collection: 'Nope' } }, none);
      assert.strictEqual(none.statusCode, 404);

      const file = makeRes();
      await handlers.get('get /enc-store/:collection/:cell/:file')?.(
        { params: { collection: 'Gulf', cell: 'FI5AAAAA', file: 'FI5AAAAA.000' } },
        file
      );
      assert.strictEqual(file.sent?.file, path.join(api.root, 'Gulf', 'FI5AAAAA', 'FI5AAAAA.000'));
      // The data dir is normally under ~/.signalk, a dot directory.
      assert.strictEqual(file.sent.options.dotfiles, 'allow');
      const outside = makeRes();
      await handlers.get('get /enc-store/:collection/:cell/:file')?.(
        { params: { collection: 'Gulf', cell: 'FI5AAAAA', file: 'collection.json' } },
        outside
      );
      assert.strictEqual(outside.statusCode, 404);

      // A chart set's cells go with the set; a converted chart's on request.
      const setDelete = makeRes();
      await handlers.get('delete /enc-store/:collection')?.(
        { params: { collection: 'Gulf' } },
        setDelete
      );
      assert.strictEqual(setDelete.statusCode, 409);
      const chartDelete = makeRes();
      await handlers.get('delete /enc-store/:collection')?.(
        { params: { collection: 'US5MA1AM' } },
        chartDelete
      );
      await chartDelete.done;
      assert.deepStrictEqual(chartDelete.body, { success: true });
      assert.deepStrictEqual(
        api.collections().map((c) => c.id),
        ['Gulf']
      );

      // Deleting the set removes its shared cells.
      const setRemoved = makeRes();
      await handlers.get('delete /custom-catalogs/:id')?.({ params: { id: 'Gulf' } }, setRemoved);
      const removedBy = Date.now() + 5000;
      while (api.collections().length > 0 && Date.now() < removedBy) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.deepStrictEqual(api.collections(), []);
    } finally {
      plugin.stop?.();
      assert.strictEqual(g.__signalk_chartsProviderEnc, undefined, 'withdrawn on stop');
      fs.rmSync(configPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});
