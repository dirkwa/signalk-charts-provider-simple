import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';

import {
  waitForContainerManager,
  getContainerManager,
  _resetContainerManagerForTests,
  type ContainerManagerApi,
  type ContainerRuntimeInfo
} from '../dist/utils/container-manager.js';

const GLOBAL_KEY = '__signalk_containerManager';

// Test harness types: tests need to write `globalThis.__signalk_containerManager`
// without an extra `as any` cast on every line.  `var` is required by
// `declare global` for the augmentation to actually attach to globalThis.
declare global {
  var __signalk_containerManager: ContainerManagerApi | undefined;
}

beforeEach(() => {
  _resetContainerManagerForTests();
  delete globalThis[GLOBAL_KEY];
});

afterEach(() => {
  _resetContainerManagerForTests();
  delete globalThis[GLOBAL_KEY];
});

function makeManager(runtime: ContainerRuntimeInfo | null): ContainerManagerApi {
  return {
    getRuntime: () => runtime,
    pullImage: () => Promise.resolve(),
    imageExists: () => Promise.resolve(true),
    runJob: () => Promise.resolve({ status: 'completed', exitCode: 0, log: [] }),
    resolveSignalkDataMount: () => Promise.resolve(null),
    resolveHostPath: () => Promise.resolve(null)
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
