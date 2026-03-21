/**
 * Integration tests for the plugin
 *
 * Verifies the plugin can be loaded and initialized without errors.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Global cleanup after all tests - clean up any lingering event listeners
after(() => {
  try {
    const { downloadManager } = require('../dist/utils/download-manager.js');
    downloadManager.removeAllListeners();
  } catch (_e) {
    // Ignore if module not loaded
  }
});

// Create a mock SignalK app object
function createMockApp(configPath) {
  return {
    config: {
      configPath: configPath,
      ssl: false,
      version: '2.0.0',
      getExternalPort: () => 3000
    },
    debug: () => {},
    error: () => {},
    setPluginStatus: () => {},
    setPluginError: () => {},
    get: () => {},
    registerResourceProvider: () => {},
    handleMessage: () => {}
  };
}

// Helper to close all mbtiles handles in charts object
function closeChartHandles(charts) {
  if (charts) {
    Object.values(charts).forEach((chart) => {
      if (chart._mbtilesHandle && typeof chart._mbtilesHandle.close === 'function') {
        chart._mbtilesHandle.close();
      }
    });
  }
}

describe('Plugin Module', () => {
  let tempDir;

  before(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'signalk-charts-test-'));
  });

  after(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should load the plugin module without errors', () => {
    const pluginFactory = require('../dist/index.js');
    assert.strictEqual(typeof pluginFactory, 'function', 'Plugin should export a function');
  });

  it('should create plugin instance with correct properties', () => {
    const pluginFactory = require('../dist/index.js');
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
    const pluginFactory = require('../dist/index.js');
    const app = createMockApp(tempDir);
    const plugin = pluginFactory(app);

    const schema = plugin.schema();
    assert.ok(schema, 'Schema should be returned');
    assert.strictEqual(schema.type, 'object');
    assert.ok(schema.properties.chartPath, 'Schema should have chartPath property');
  });
});

describe('Charts Loader', () => {
  it('should find charts in directory', async () => {
    const { findCharts } = require('../dist/charts-loader.js');
    const chartsDir = path.join(__dirname, 'fixtures');

    const charts = await findCharts(chartsDir);

    try {
      assert.ok(charts, 'Charts object should be returned');
      assert.ok(charts['test-chart'], 'Test chart should be found');
      assert.strictEqual(charts['test-chart'].name, 'Test Chart');
      assert.strictEqual(charts['test-chart'].format, 'png');
      assert.deepStrictEqual(charts['test-chart'].bounds, [-180, -85, 180, 85]);
      assert.strictEqual(charts['test-chart'].minzoom, 0);
      assert.strictEqual(charts['test-chart'].maxzoom, 4);
    } finally {
      closeChartHandles(charts);
    }
  });

  it('should handle empty directory gracefully', async () => {
    const { findCharts } = require('../dist/charts-loader.js');
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
    const { findCharts } = require('../dist/charts-loader.js');

    const charts = await findCharts('/non/existent/path');
    // Should return undefined or empty object without throwing
    assert.ok(charts === undefined || Object.keys(charts).length === 0);
    closeChartHandles(charts);
  });
});

describe('Tile Serving', () => {
  let charts;
  const chartsDir = path.join(__dirname, 'fixtures');

  before(async () => {
    const { findCharts } = require('../dist/charts-loader.js');
    charts = await findCharts(chartsDir);
  });

  after(() => {
    closeChartHandles(charts);
  });

  it('should serve tiles from loaded chart', () => {
    const chart = charts['test-chart'];
    assert.ok(chart, 'Test chart should exist');
    assert.ok(chart._mbtilesHandle, 'Chart should have mbtiles handle');

    // Get a tile that exists (zoom 0, x 0, y 0)
    const result = chart._mbtilesHandle.getTile(0, 0, 0);
    assert.ok(result, 'Tile should be returned');
    assert.ok(result.data instanceof Uint8Array, 'Tile data should be a Uint8Array');
    assert.strictEqual(result.headers['Content-Type'], 'image/png');
  });

  it('should return null for non-existent tile', () => {
    const chart = charts['test-chart'];
    const result = chart._mbtilesHandle.getTile(10, 999, 999);
    assert.strictEqual(result, null, 'Non-existent tile should return null');
  });
});
