const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');

const {
  waitForContainerManager,
  getContainerManager,
  _resetContainerManagerForTests
} = require('../dist/utils/container-manager');

const GLOBAL_KEY = '__signalk_containerManager';

beforeEach(() => {
  _resetContainerManagerForTests();
  delete globalThis[GLOBAL_KEY];
});

afterEach(() => {
  _resetContainerManagerForTests();
  delete globalThis[GLOBAL_KEY];
});

function makeManager(runtime) {
  return {
    getRuntime: () => runtime,
    pullImage: async () => {},
    imageExists: async () => true,
    runJob: async () => ({ status: 'completed', exitCode: 0, log: [] }),
    resolveSignalkDataMount: async () => null
  };
}

describe('waitForContainerManager', () => {
  it('resolves immediately when the manager is already published', async () => {
    const manager = makeManager({ runtime: 'podman', version: '5.4' });
    globalThis[GLOBAL_KEY] = manager;

    let waitingFired = false;
    const resolved = await waitForContainerManager({
      budgetMs: 500,
      pollIntervalMs: 50,
      onWaitingStatus: () => {
        waitingFired = true;
      }
    });

    assert.strictEqual(resolved, manager);
    assert.strictEqual(getContainerManager(), manager);
    assert.strictEqual(
      waitingFired,
      false,
      'onWaitingStatus must NOT fire when manager is found on first poll'
    );
  });

  it('returns null when the manager never appears within budget', async () => {
    let waitingFired = false;
    const resolved = await waitForContainerManager({
      budgetMs: 200,
      pollIntervalMs: 50,
      onWaitingStatus: () => {
        waitingFired = true;
      }
    });

    assert.strictEqual(resolved, null);
    assert.strictEqual(getContainerManager(), null);
    assert.strictEqual(waitingFired, true, 'onWaitingStatus must fire while waiting');
  });

  it('returns null when manager is published but getRuntime() returns null', async () => {
    // signalk-container publishes the API early but defers runtime detection;
    // we should keep waiting until the runtime is actually ready.
    globalThis[GLOBAL_KEY] = makeManager(null);

    const resolved = await waitForContainerManager({
      budgetMs: 200,
      pollIntervalMs: 50
    });

    assert.strictEqual(resolved, null);
    assert.strictEqual(getContainerManager(), null);
  });

  it('picks up the manager when it appears mid-wait', async () => {
    const manager = makeManager({ runtime: 'docker', version: '28.0' });
    setTimeout(() => {
      globalThis[GLOBAL_KEY] = manager;
    }, 150);

    const resolved = await waitForContainerManager({
      budgetMs: 1000,
      pollIntervalMs: 50
    });

    assert.strictEqual(resolved, manager);
    assert.strictEqual(getContainerManager(), manager);
  });
});
