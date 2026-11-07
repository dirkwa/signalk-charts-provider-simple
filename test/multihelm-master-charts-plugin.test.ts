/**
 * The plugin with the master's charts: a chart disabled here is announced
 * as the master's, not as gone, while the master still serves it.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import type { Plugin } from '@signalk/server-api';
import type { ExtendedServerAPI } from '../dist/types.js';
import pluginFactoryDefault from '../dist/index.js';
import { downloadManager } from '../dist/utils/download-manager.js';
import { MASTER_TILES_PREFIX } from '../dist/utils/multihelm/master-charts.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pluginFactory = pluginFactoryDefault as unknown as (app: ExtendedServerAPI) => Plugin;
const FIXTURES = path.join(__dirname, '..', 'test', 'fixtures');

after(() => {
  downloadManager.removeAllListeners();
});

type RouteHandler = (req: unknown, res: unknown) => void | Promise<void>;
type PluginRouter = Parameters<NonNullable<Plugin['registerWithRouter']>>[0];
type ResourceProvider = Parameters<ExtendedServerAPI['registerResourceProvider']>[0];

interface Delta {
  updates: { values: { path: string; value: unknown }[] }[];
}

const waitFor = async (check: () => boolean): Promise<void> => {
  const deadline = Date.now() + 5000;
  while (!check() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(check(), 'condition not met within 5 s');
};

interface Started {
  provider: ResourceProvider;
  deltas: Delta[];
  handlers: Map<string, RouteHandler>;
  /** What the master lists; a role change makes the plugin read it again. */
  masterList: { current: Record<string, unknown> };
  roleChanged: () => Promise<void>;
  stop: () => Promise<void>;
}

const settle = async (): Promise<void> => {
  // fetchMaster resolves at once; let MasterCharts take the list in.
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
};

const masterChart = (id: string): Record<string, unknown> => ({
  identifier: id,
  name: 'Master copy',
  type: 'tilelayer',
  url: `${MASTER_TILES_PREFIX}${id}/{z}/{x}/{y}`
});

/** The plugin with `test-chart.mbtiles` in its folder, on a member whose master lists `masterList`. */
async function startWithMaster(masterList: Record<string, unknown>): Promise<Started> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'master-charts-plugin-'));
  const chartPath = path.join(tempDir, 'charts');
  fs.mkdirSync(chartPath, { recursive: true });
  fs.copyFileSync(
    path.join(FIXTURES, 'test-chart.mbtiles'),
    path.join(chartPath, 'test-chart.mbtiles')
  );
  const dataDir = path.join(tempDir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });

  const deltas: Delta[] = [];
  const registered: { provider?: ResourceProvider } = {};
  const multihelm: {
    listener: ((values: ({ value: unknown } | undefined)[]) => void) | null;
    roleListener: (() => void) | null;
  } = { listener: null, roleListener: null };
  const app = {
    config: { configPath: tempDir, ssl: false, version: '2.31.0', getExternalPort: () => 3000 },
    debug: () => {},
    error: () => {},
    setPluginStatus: () => {},
    setPluginError: () => {},
    getDataDirPath: () => dataDir,
    registerResourceProvider: (p: ResourceProvider) => {
      registered.provider = p;
    },
    handleMessage: (_id: string, delta: Delta) => {
      deltas.push(delta);
    },
    subscriptionmanager: { subscribe: () => {}, unsubscribe: () => {} },
    onPropertyValues: (name: string, cb: (values: ({ value: unknown } | undefined)[]) => void) => {
      if (name === 'multihelm') {
        multihelm.listener = cb;
      }
      return () => {};
    }
  } as unknown as ExtendedServerAPI;

  const plugin = pluginFactory(app);
  const handlers = new Map<string, RouteHandler>();
  const record =
    (method: string) =>
    (routePath: string, handler: RouteHandler): PluginRouter => {
      handlers.set(`${method} ${routePath}`, handler);
      return {} as PluginRouter;
    };
  plugin.registerWithRouter?.({
    get: record('get'),
    post: record('post'),
    put: record('put'),
    delete: record('delete')
  } as unknown as PluginRouter);

  const stop = async (): Promise<void> => {
    await plugin.stop();
    fs.rmSync(tempDir, { recursive: true, force: true });
  };
  plugin.start({ chartPath }, () => {});
  try {
    await waitFor(() => registered.provider !== undefined && multihelm.listener !== null);
  } catch (error) {
    await stop();
    throw error;
  }
  const list = { current: masterList };
  multihelm.listener?.([
    {
      value: {
        apiVersion: 1,
        role: () => 'member',
        master: () => ({ id: 'm' }),
        onRoleChanged: (cb: () => void) => {
          multihelm.roleListener = cb;
          return () => {};
        },
        registerMasterRoute: () => ({ unregister: () => {} }),
        masterPath: (p: string) => `/plugins/signalk-multihelm/master${p}`,
        fetchMaster: () =>
          Promise.resolve({
            status: 200,
            headers: {},
            body: Buffer.from(JSON.stringify(list.current))
          })
      }
    }
  ]);
  await settle();
  return {
    provider: registered.provider as ResourceProvider,
    deltas,
    handlers,
    masterList: list,
    roleChanged: async () => {
      multihelm.roleListener?.();
      await settle();
    },
    stop
  };
}

const announcedFor = (deltas: Delta[], id: string): unknown[] =>
  deltas
    .flatMap((d) => d.updates.flatMap((u) => u.values))
    .filter((v) => v.path === `resources.charts.${id}`)
    .map((v) => v.value);

describe('the master’s charts in the plugin', () => {
  it('announces the master’s copy when the chart is disabled here', async () => {
    const started = await startWithMaster({ 'test-chart': masterChart('test-chart') });
    try {
      const toggle = started.handlers.get('post /charts/:chartPath/toggle');
      assert.ok(toggle);
      started.deltas.length = 0;
      await toggle(
        { params: { chartPath: 'test-chart.mbtiles' }, body: { enabled: false } },
        {
          status() {
            return this;
          },
          json() {
            return this;
          },
          send() {
            return this;
          }
        }
      );

      const announced = announcedFor(started.deltas, 'test-chart');
      assert.strictEqual(announced.length, 1);
      assert.strictEqual((announced[0] as { name?: string } | null)?.name, 'Master copy');
      const served = (await started.provider.methods.getResource('test-chart', undefined)) as {
        url?: string;
      };
      assert.ok(served.url?.startsWith('/plugins/signalk-multihelm/master/'));
    } finally {
      await started.stop();
    }
  });

  it('treats chart ids such as constructor as plain ids', async () => {
    const started = await startWithMaster({
      constructor: masterChart('constructor'),
      toString: masterChart('toString')
    });
    try {
      const served = (await started.provider.methods.getResource('constructor', undefined)) as {
        name?: string;
      };
      assert.strictEqual(served.name, 'Master copy');

      started.deltas.length = 0;
      started.masterList.current = { constructor: masterChart('constructor') };
      await started.roleChanged();
      assert.deepStrictEqual(announcedFor(started.deltas, 'toString'), [null]);
    } finally {
      await started.stop();
    }
  });
});
