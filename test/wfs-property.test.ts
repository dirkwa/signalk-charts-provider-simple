/**
 * The `chartsProviderWfs` PropertyValue: peer plugins (signalk-underkeel) find
 * the local WFS proxy through it, whatever order the plugins start in.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Plugin } from '@signalk/server-api';
import type { ChartsProviderWfsApi, ExtendedServerAPI } from '../dist/types.js';
import pluginFactoryDefault from '../dist/index.js';
import { downloadManager } from '../dist/utils/download-manager.js';
import { closeParkedWfsProxy } from '../dist/utils/wfs-proxy-service.js';

const pluginFactory = pluginFactoryDefault as unknown as (app: ExtendedServerAPI) => Plugin;

after(() => {
  downloadManager.removeAllListeners();
});

const until = async (done: () => boolean): Promise<void> => {
  const deadline = Date.now() + 5000;
  while (!done()) {
    assert.ok(Date.now() < deadline, 'timed out');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

describe('chartsProviderWfs PropertyValue', () => {
  it('is offered once per server process and answers for the proxy running at each call', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfs-property-'));
    const chartPath = path.join(tempDir, 'charts');
    fs.mkdirSync(chartPath, { recursive: true });
    const dataDir = path.join(tempDir, 'plugin-config-data', 'signalk-charts-provider-simple');
    fs.mkdirSync(dataDir, { recursive: true });
    const upstream = 'https://wfs.example/geoserver/wfs';
    fs.writeFileSync(
      path.join(dataDir, 'wfs-sources.json'),
      JSON.stringify({ sources: [{ url: upstream, answersByBox: true, answerMargin: 0.12 }] })
    );

    const offered: { name: string; value: unknown }[] = [];
    const app = {
      config: { configPath: tempDir, ssl: false, version: '2.0.0', getExternalPort: () => 3000 },
      debug: () => {},
      error: () => {},
      setPluginStatus: () => {},
      setPluginError: () => {},
      getDataDirPath: () => dataDir,
      registerResourceProvider: () => {},
      handleMessage: () => {},
      emitPropertyValue: (name: string, value: unknown) => {
        offered.push({ name, value });
      },
      subscriptionmanager: { subscribe: () => {}, unsubscribe: () => {} }
    } as unknown as ExtendedServerAPI;

    const plugin = pluginFactory(app);
    const offers = () => offered.filter((o) => o.name === 'chartsProviderWfs');
    const wfs = () => offers()[0]?.value as ChartsProviderWfsApi | undefined;

    try {
      plugin.start({ chartPath }, () => {});
      await until(() => wfs()?.stats() !== undefined);
      assert.strictEqual(wfs()?.apiVersion, 1);
      assert.deepStrictEqual(wfs()?.upstreams(), [upstream]);
      const url = wfs()?.proxyUrl(upstream);
      assert.match(url ?? '', /^http:\/\/127\.0\.0\.1:\d+\//);
      assert.strictEqual(wfs()?.proxyUrl('https://other.example/wfs'), undefined);
      assert.strictEqual(
        (globalThis as Record<string, unknown>).__signalk_chartsProviderWfs,
        undefined
      );

      // Stopped, the offer stays but gives no proxy: nothing is withdrawn.
      await plugin.stop?.();
      assert.strictEqual(wfs()?.proxyUrl(upstream), undefined);
      assert.deepStrictEqual(wfs()?.upstreams(), []);
      assert.strictEqual(wfs()?.stats(), undefined);

      // A config save restarts the plugin: the same offer answers again, on the same port.
      plugin.start({ chartPath }, () => {});
      await until(() => wfs()?.stats() !== undefined);
      assert.strictEqual(wfs()?.proxyUrl(upstream), url);
      await plugin.stop?.();

      // With the proxy turned off, the offer gives none.
      plugin.start({ chartPath, wfsProxy: false }, () => {});
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.strictEqual(wfs()?.proxyUrl(upstream), undefined);
      assert.strictEqual(wfs()?.stats(), undefined);
      assert.strictEqual(offers().length, 1);
    } finally {
      await plugin.stop?.();
      // The stopped proxy keeps its store open for the next start: on Windows the folder
      // cannot be removed until it is closed.
      await closeParkedWfsProxy();
      fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});
