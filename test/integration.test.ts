/**
 * Integration tests for the plugin
 *
 * Verifies the plugin can be loaded and initialized without errors.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import type { Plugin } from '@signalk/server-api';
import type { ExtendedServerAPI, ChartProvider } from '../dist/types.js';
import { findCharts } from '../dist/charts-loader.js';
import pluginFactoryDefault from '../dist/index.js';
import { downloadManager } from '../dist/utils/download-manager.js';

// ESM equivalent of CJS `__dirname`.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const pluginFactory = pluginFactoryDefault as unknown as (app: ExtendedServerAPI) => Plugin;

// Global cleanup after all tests - clean up any lingering event listeners
after(() => {
  try {
    downloadManager.removeAllListeners();
  } catch {
    // Ignore if module not loaded
  }
});

// Create a mock SignalK app object.  Only fields the plugin actually
// touches in its `start()` codepath need to be real; everything else
// is ignored.  Casting through `unknown` keeps the mock terse without
// dragging the full @signalk/server-api shape into the test.
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

// Helper to close all mbtiles handles in charts object.
function closeChartHandles(charts: Record<string, ChartProvider> | undefined): void {
  if (!charts) {
    return;
  }
  for (const chart of Object.values(charts)) {
    const handle = (chart as { _mbtilesHandle?: { close?: () => void } })._mbtilesHandle;
    if (handle && typeof handle.close === 'function') {
      handle.close();
    }
  }
}

describe('Plugin Module', () => {
  let tempDir: string;

  before(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'signalk-charts-test-'));
  });

  after(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should load the plugin module without errors', () => {
    assert.strictEqual(typeof pluginFactory, 'function', 'Plugin should export a function');
  });

  it('should create plugin instance with correct properties', () => {
    const app = createMockApp(tempDir);
    const plugin = pluginFactory(app);

    assert.ok(plugin, 'Plugin should be created');
    assert.strictEqual(plugin.id, 'signalk-charts-provider-simple');
    assert.strictEqual(plugin.name, 'Charts Provider Simple');
    assert.strictEqual(typeof plugin.start, 'function');
    assert.strictEqual(typeof plugin.stop, 'function');
    assert.strictEqual(typeof plugin.schema, 'function');
  });

  it('should generate valid schema', () => {
    const app = createMockApp(tempDir);
    const plugin = pluginFactory(app);

    // Plugin.schema is typed as `object | (() => object)` upstream.  This
    // plugin uses the function form; call it accordingly.
    assert.strictEqual(typeof plugin.schema, 'function');
    const schemaFn = plugin.schema as () => object;
    const schema = schemaFn() as { type?: string; properties?: { chartPath?: unknown } };
    assert.ok(schema, 'Schema should be returned');
    assert.strictEqual(schema.type, 'object');
    assert.ok(schema.properties?.chartPath, 'Schema should have chartPath property');
  });
});

// Tests compile to `dist-test/`; fixtures live in `test/fixtures/`.
const FIXTURES = path.join(__dirname, '..', 'test', 'fixtures');

describe('Charts Loader', () => {
  it('should find charts in directory', async () => {
    const chartsDir = FIXTURES;

    const charts = await findCharts(chartsDir);

    try {
      assert.ok(charts, 'Charts object should be returned');
      const testChart = charts['test-chart'];
      assert.ok(testChart, 'Test chart should be found');
      assert.strictEqual(testChart.name, 'Test Chart');
      assert.strictEqual(testChart.format, 'png');
      assert.deepStrictEqual(testChart.bounds, [-180, -85, 180, 85]);
      assert.strictEqual(testChart.minzoom, 0);
      assert.strictEqual(testChart.maxzoom, 4);
    } finally {
      closeChartHandles(charts);
    }
  });

  it('should handle empty directory gracefully', async () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'empty-charts-'));

    try {
      const charts = await findCharts(emptyDir);
      assert.ok(charts, 'Charts object should be returned');
      assert.strictEqual(Object.keys(charts).length, 0, 'No charts should be found');
      closeChartHandles(charts);
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it('should handle non-existent directory gracefully', async () => {
    const charts = await findCharts('/non/existent/path');
    // Should return undefined or empty object without throwing
    assert.ok(charts === undefined || Object.keys(charts).length === 0);
    closeChartHandles(charts);
  });
});

describe('Tile Serving', () => {
  let charts: Record<string, ChartProvider> | undefined;
  const chartsDir = FIXTURES;

  before(async () => {
    charts = await findCharts(chartsDir);
  });

  after(() => {
    closeChartHandles(charts);
  });

  it('should serve tiles from loaded chart', () => {
    assert.ok(charts);
    const chart = charts['test-chart'] as
      | (ChartProvider & {
          _mbtilesHandle?: {
            getTile: (
              z: number,
              x: number,
              y: number
            ) => { data: Uint8Array; headers: Record<string, string> } | null;
          };
        })
      | undefined;
    assert.ok(chart, 'Test chart should exist');
    assert.ok(chart._mbtilesHandle, 'Chart should have mbtiles handle');

    // Get a tile that exists (zoom 0, x 0, y 0)
    const result = chart._mbtilesHandle.getTile(0, 0, 0);
    assert.ok(result, 'Tile should be returned');
    assert.ok(result.data instanceof Uint8Array, 'Tile data should be a Uint8Array');
    assert.strictEqual(result.headers['Content-Type'], 'image/png');
  });

  it('should return null for non-existent tile', () => {
    assert.ok(charts);
    const chart = charts['test-chart'] as
      | (ChartProvider & {
          _mbtilesHandle?: {
            getTile: (z: number, x: number, y: number) => unknown;
          };
        })
      | undefined;
    assert.ok(chart);
    assert.ok(chart._mbtilesHandle);
    const result = chart._mbtilesHandle.getTile(10, 999, 999);
    assert.strictEqual(result, null, 'Non-existent tile should return null');
  });
});
