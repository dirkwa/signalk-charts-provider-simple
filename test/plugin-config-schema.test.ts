import { describe, it } from 'node:test';
import assert from 'node:assert';

import { parsePluginConfig } from '../dist/utils/plugin-config-schema.js';

describe('parsePluginConfig', () => {
  it('accepts a minimal config with just chartPath', () => {
    const config = parsePluginConfig({ chartPath: '/var/charts' });
    assert.strictEqual(config.chartPath, '/var/charts');
    assert.strictEqual(config.cpuBudget, undefined);
  });

  it('accepts an empty config (Signal K passes {} during auto-enable)', () => {
    // The plugin sets `signalk-plugin-enabled-by-default: true`, so on a
    // fresh install Signal K calls start({}) before the user has saved
    // any settings. The validator normalizes the missing field to '' so
    // doStartup's `props.chartPath || defaultChartsPath` fallback fires.
    const config = parsePluginConfig({});
    assert.strictEqual(config.chartPath, '');
  });

  it('accepts an empty-string chartPath (user cleared the field)', () => {
    const config = parsePluginConfig({ chartPath: '' });
    assert.strictEqual(config.chartPath, '');
  });

  it('accepts each cpuBudget preset', () => {
    for (const preset of ['single-core', 'half', 'all'] as const) {
      const config = parsePluginConfig({ chartPath: '/x', cpuBudget: preset });
      assert.strictEqual(config.cpuBudget, preset);
    }
  });

  it('accepts a cache limit in whole megabytes, 0 for none, and nothing negative', () => {
    assert.strictEqual(
      parsePluginConfig({ chartPath: '/x', onlineCacheLimitMB: 0 }).onlineCacheLimitMB,
      0
    );
    assert.throws(
      () => parsePluginConfig({ chartPath: '/x', onlineCacheLimitMB: -1 }),
      /onlineCacheLimitMB/
    );
    assert.throws(
      () => parsePluginConfig({ chartPath: '/x', onlineCacheLimitMB: 1.5 }),
      /onlineCacheLimitMB/
    );
  });

  it('rejects an unknown cpuBudget value', () => {
    assert.throws(() => parsePluginConfig({ chartPath: '/x', cpuBudget: 'turbo' }), /cpuBudget/);
  });

  it('rejects a non-string chartPath', () => {
    assert.throws(() => parsePluginConfig({ chartPath: 42 }), /chartPath/);
  });

  it('rejects null', () => {
    assert.throws(() => parsePluginConfig(null));
  });

  it('rejects a non-object input (string, array, etc.)', () => {
    assert.throws(() => parsePluginConfig('hi'));
    assert.throws(() => parsePluginConfig([]));
  });
});
