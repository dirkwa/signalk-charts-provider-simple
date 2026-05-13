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

function makeManager(
  runtime: ContainerRuntimeInfo | null,
  opts: { whenReady?: () => Promise<void> } = {}
): ContainerManagerApi {
  const manager: ContainerManagerApi = {
    getRuntime: () => runtime,
    pullImage: () => Promise.resolve(),
    imageExists: () => Promise.resolve(true),
    runJob: () => Promise.resolve({ status: 'completed', exitCode: 0, log: [] }),
    resolveSignalkDataMount: () => Promise.resolve(null),
    resolveHostPath: () => Promise.resolve(null)
  };
  if (opts.whenReady) {
    manager.whenReady = opts.whenReady;
  }
  return manager;
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

  it('uses whenReady() when the manager exposes it (signalk-container >= 1.6.0)', async () => {
    // Manager is published with whenReady. getRuntime() starts null and
    // flips to non-null only after whenReady() resolves — the
    // 1.6.0 contract (detection is settled when whenReady() resolves).
    let detected: ContainerRuntimeInfo | null = null;
    const manager: ContainerManagerApi = {
      getRuntime: () => detected,
      whenReady: () =>
        new Promise((resolve) =>
          setTimeout(() => {
            detected = { runtime: 'podman', version: '5.4' };
            resolve();
          }, 100)
        ),
      pullImage: () => Promise.resolve(),
      imageExists: () => Promise.resolve(true),
      runJob: () => Promise.resolve({ status: 'completed', exitCode: 0, log: [] }),
      resolveSignalkDataMount: () => Promise.resolve(null),
      resolveHostPath: () => Promise.resolve(null)
    };
    globalThis[GLOBAL_KEY] = manager;

    const resolved = await waitForContainerManager({
      budgetMs: 2000,
      pollIntervalMs: 50
    });

    assert.strictEqual(resolved, manager);
    assert.strictEqual(getContainerManager(), manager);
  });

  it('returns null when whenReady() resolves but runtime detection failed', async () => {
    const manager = makeManager(null, {
      whenReady: () => Promise.resolve()
    });
    globalThis[GLOBAL_KEY] = manager;

    const resolved = await waitForContainerManager({
      budgetMs: 2000,
      pollIntervalMs: 50
    });

    assert.strictEqual(resolved, null);
    assert.strictEqual(getContainerManager(), null);
  });

  it('returns immediately without awaiting whenReady when getRuntime() already non-null', async () => {
    // Belt-and-braces: even though whenReady is published, an already-ready
    // manager should short-circuit and not fire onWaitingStatus.
    let whenReadyCalled = false;
    const manager: ContainerManagerApi = {
      getRuntime: () => ({ runtime: 'docker', version: '28.0' }),
      whenReady: () => {
        whenReadyCalled = true;
        return new Promise(() => undefined);
      },
      pullImage: () => Promise.resolve(),
      imageExists: () => Promise.resolve(true),
      runJob: () => Promise.resolve({ status: 'completed', exitCode: 0, log: [] }),
      resolveSignalkDataMount: () => Promise.resolve(null),
      resolveHostPath: () => Promise.resolve(null)
    };
    globalThis[GLOBAL_KEY] = manager;

    let waitingFired = false;
    const resolved = await waitForContainerManager({
      budgetMs: 2000,
      pollIntervalMs: 50,
      onWaitingStatus: () => {
        waitingFired = true;
      }
    });

    assert.strictEqual(resolved, manager);
    assert.strictEqual(whenReadyCalled, false, 'must not call whenReady when already ready');
    assert.strictEqual(waitingFired, false, 'must not signal waiting when already ready');
  });

  it('swallows whenReady() rejections and returns null without throwing', async () => {
    // Contract: waitForContainerManager never rejects, so a misbehaving shim
    // that returns a rejected promise from whenReady() must not crash startup.
    const manager = makeManager(null, {
      whenReady: () => Promise.reject(new Error('detection blew up'))
    });
    globalThis[GLOBAL_KEY] = manager;

    const resolved = await waitForContainerManager({
      budgetMs: 2000,
      pollIntervalMs: 50
    });

    assert.strictEqual(resolved, null);
    assert.strictEqual(getContainerManager(), null);
  });

  it('returns null when whenReady() never settles and budget expires', async () => {
    // Regression guard for the Promise.race against the remaining budget:
    // a permanently pending whenReady() must not hang waitForContainerManager
    // past its budgetMs. The outer race against a longer wall-clock timeout
    // proves the call returned within budget rather than hanging forever.
    const manager = makeManager(null, {
      whenReady: () => new Promise(() => undefined)
    });
    globalThis[GLOBAL_KEY] = manager;

    const TIMEOUT_SENTINEL: unique symbol = Symbol('timeout');
    const resolved = await Promise.race<
      Awaited<ReturnType<typeof waitForContainerManager>> | typeof TIMEOUT_SENTINEL
    >([
      waitForContainerManager({
        budgetMs: 100,
        pollIntervalMs: 20
      }),
      new Promise((resolve) => {
        setTimeout(() => {
          resolve(TIMEOUT_SENTINEL);
        }, 1000);
      })
    ]);

    assert.notStrictEqual(
      resolved,
      TIMEOUT_SENTINEL,
      'waitForContainerManager must return within budget, not hang on whenReady'
    );
    assert.strictEqual(resolved, null);
    assert.strictEqual(getContainerManager(), null);
  });

  it('swallows synchronous throws from whenReady() and returns null', async () => {
    // Even a shim that throws synchronously (before returning a Promise) must
    // not break the non-throwing contract of waitForContainerManager.
    const manager = makeManager(null, {
      whenReady: () => {
        throw new Error('synchronous detection failure');
      }
    });
    globalThis[GLOBAL_KEY] = manager;

    const resolved = await waitForContainerManager({
      budgetMs: 2000,
      pollIntervalMs: 50
    });

    assert.strictEqual(resolved, null);
    assert.strictEqual(getContainerManager(), null);
  });
});
