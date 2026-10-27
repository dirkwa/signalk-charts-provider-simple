import { describe, it, mock } from 'node:test';
import assert from 'node:assert';
import type { ServerAPI } from '@signalk/server-api';

import {
  FIRST_STATE_WAIT_MS,
  INTERNET_STATE_PATH,
  InternetGate,
  subscribeInternetState,
  type PluginListEntry
} from '../dist/utils/internet-state.js';

interface Setup {
  state?: unknown;
  plugins?: PluginListEntry[] | null;
  allowMetered?: boolean;
}

function setup(initial: Setup = {}) {
  const world = {
    state: initial.state,
    plugins: initial.plugins === undefined ? [] : initial.plugins,
    allowMetered: initial.allowMetered ?? false,
    listCalls: 0,
    listeners: new Set<(value: unknown) => void>()
  };
  const gate = new InternetGate({
    getPluginsList:
      world.plugins === null
        ? undefined
        : () => {
            world.listCalls++;
            return Promise.resolve(world.plugins ?? []);
          },
    allowMeteredCharts: () => world.allowMetered,
    // As the server's subscription manager does: the last value at once, then each new one.
    subscribeState: (onState) => {
      world.listeners.add(onState);
      if (world.state !== undefined) {
        onState(world.state);
      }
      return () => world.listeners.delete(onState);
    }
  });
  const publish = (value: unknown): void => {
    world.state = value;
    for (const listener of [...world.listeners]) {
      listener(value);
    }
  };
  return { world, gate, publish };
}

const enabled: PluginListEntry[] = [{ id: 'signalk-internet', enabled: true }];
const disabled: PluginListEntry[] = [{ id: 'signalk-internet', enabled: false }];
const settle = () => new Promise((r) => setImmediate(r));

async function isSettled(promise: Promise<void>): Promise<boolean> {
  let done = false;
  void promise.then(() => (done = true));
  for (let i = 0; i < 5; i++) {
    await settle();
  }
  return done;
}

describe('InternetGate', () => {
  it('allows everything without a published state', () => {
    const { gate } = setup({ plugins: null });
    assert.strictEqual(gate.state(), undefined);
    assert.strictEqual(gate.mayRunBackground(), true);
    assert.strictEqual(gate.mayFetchCharts(), true);
  });

  for (const state of ['online', 'something-new']) {
    it(`allows everything while the state is ${state}`, () => {
      const { gate } = setup({ state, plugins: enabled });
      assert.strictEqual(gate.mayRunBackground(), true);
      assert.strictEqual(gate.mayFetchCharts(), true);
    });
  }

  for (const state of ['offline', 'captive']) {
    it(`holds everything while the state is ${state}, whatever the metered setting`, () => {
      const { gate } = setup({ state, plugins: enabled, allowMetered: true });
      assert.strictEqual(gate.mayRunBackground(), false);
      assert.strictEqual(gate.mayFetchCharts(), false);
    });
  }

  it('holds background work on a metered link, and chart tiles unless the user allowed them', () => {
    const { world, gate } = setup({ state: 'metered', plugins: enabled });
    assert.strictEqual(gate.mayRunBackground(), false);
    assert.strictEqual(gate.mayFetchCharts(), false);
    world.allowMetered = true;
    assert.strictEqual(gate.mayRunBackground(), false);
    assert.strictEqual(gate.mayFetchCharts(), true);
  });

  it('follows each new state without asking the server', async () => {
    const { world, gate, publish } = setup({ state: 'online', plugins: enabled });
    publish('metered');
    assert.strictEqual(gate.mayRunBackground(), false);
    publish('online');
    assert.strictEqual(gate.mayRunBackground(), true);
    await gate.firstStateKnown();
    assert.strictEqual(world.listCalls, 0);
  });

  it('does not wait at startup when signalk-internet is not installed or disabled', async () => {
    for (const plugins of [[], disabled, null]) {
      const { gate } = setup({ plugins });
      assert.strictEqual(await isSettled(gate.firstStateKnown()), true);
    }
  });

  it('does not wait at startup when a state is already published', async () => {
    const { world, gate } = setup({ state: 'online', plugins: enabled });
    assert.strictEqual(await isSettled(gate.firstStateKnown()), true);
    assert.strictEqual(world.listCalls, 0);
  });

  it('asks the plugin list when the wait starts, not when the gate is made', async () => {
    const { world, gate } = setup({ plugins: [] });
    // signalk-internet registered after this plugin started
    world.plugins = enabled;
    assert.strictEqual(await isSettled(gate.firstStateKnown()), false);
    gate.stop();
  });

  it('runs work at once while background work may run', async () => {
    const { gate } = setup({ state: 'online', plugins: enabled });
    await gate.firstStateKnown();
    let runs = 0;
    gate.runWhenBackgroundAllowed(() => runs++);
    assert.strictEqual(runs, 1);
  });

  it('holds work while restricted and runs it once a usable state arrives', async () => {
    const { gate, publish } = setup({ state: 'metered', plugins: enabled });
    await gate.firstStateKnown();
    let runs = 0;
    let sawState: boolean | undefined;
    gate.runWhenBackgroundAllowed(() => {
      runs++;
      sawState = gate.mayRunBackground();
    });
    assert.strictEqual(runs, 0);
    publish('offline');
    await settle();
    assert.strictEqual(runs, 0);
    publish('online');
    await settle();
    assert.strictEqual(runs, 1);
    assert.strictEqual(sawState, true, 'the work sees the new state');
    publish('metered');
    publish('online');
    await settle();
    assert.strictEqual(runs, 1, 'ran once');
  });

  it('runs held work once a disabled signalk-internet clears its state', async () => {
    const { world, gate, publish } = setup({ state: 'metered', plugins: enabled });
    await gate.firstStateKnown();
    let runs = 0;
    gate.runWhenBackgroundAllowed(() => runs++);
    world.plugins = disabled;
    publish(null);
    await settle();
    assert.strictEqual(runs, 1);
  });

  it('keeps work held while a restarted signalk-internet works out the link', async () => {
    const { gate, publish } = setup({ state: 'metered', plugins: enabled });
    await gate.firstStateKnown();
    let runs = 0;
    gate.runWhenBackgroundAllowed(() => runs++);
    publish(null);
    assert.strictEqual(await isSettled(gate.firstStateKnown()), false, 'waits again');
    assert.strictEqual(runs, 0);
    publish('metered');
    await settle();
    assert.strictEqual(runs, 0);
    publish('online');
    await settle();
    assert.strictEqual(runs, 1);
  });

  it('releases held work after a bounded wait when a restarted signalk-internet stays silent', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const { gate, publish } = setup({ state: 'metered', plugins: enabled });
      await gate.firstStateKnown();
      let runs = 0;
      gate.runWhenBackgroundAllowed(() => runs++);
      publish(null);
      await settle();
      mock.timers.tick(FIRST_STATE_WAIT_MS - 1);
      await settle();
      assert.strictEqual(runs, 0);
      mock.timers.tick(1);
      await settle();
      assert.strictEqual(runs, 1);
    } finally {
      mock.timers.reset();
    }
  });

  it('keeps one wait when signalk-internet restarts while the plugin list is asked', async () => {
    let answer: (plugins: PluginListEntry[]) => void = () => undefined;
    let onState: (value: unknown) => void = () => undefined;
    const gate = new InternetGate({
      getPluginsList: () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
      allowMeteredCharts: () => false,
      subscribeState: (listener) => {
        onState = listener;
        return () => undefined;
      }
    });
    const startup = gate.firstStateKnown();
    await settle();
    onState(null);
    await settle();
    answer(enabled);
    await settle();
    onState('online');
    assert.strictEqual(await isSettled(startup), true, 'the state ends the startup wait');
    gate.stop();
  });

  it('drops held work and unsubscribes when stopped', async () => {
    const { world, gate, publish } = setup({ state: 'metered', plugins: enabled });
    await gate.firstStateKnown();
    let runs = 0;
    gate.runWhenBackgroundAllowed(() => runs++);
    gate.stop();
    assert.strictEqual(world.listeners.size, 0);
    publish('online');
    await settle();
    gate.runWhenBackgroundAllowed(() => runs++);
    assert.strictEqual(runs, 0);
  });

  it('waits at startup for an enabled signalk-internet to publish its first state', async () => {
    const { gate, publish } = setup({ plugins: enabled });
    const waiting = gate.firstStateKnown();
    assert.strictEqual(await isSettled(waiting), false);
    publish('metered');
    assert.strictEqual(await isSettled(waiting), true);
    assert.strictEqual(gate.mayRunBackground(), false);
  });

  it('gives up waiting for a first state after a bounded time', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const { gate } = setup({ plugins: enabled });
      const waiting = gate.firstStateKnown();
      await settle();
      mock.timers.tick(FIRST_STATE_WAIT_MS - 1);
      assert.strictEqual(await isSettled(waiting), false);
      mock.timers.tick(1);
      assert.strictEqual(await isSettled(waiting), true);
      assert.strictEqual(gate.mayRunBackground(), true);
    } finally {
      mock.timers.reset();
    }
  });

  it('bounds the wait while the plugin list does not answer', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const gate = new InternetGate({
        getPluginsList: () => new Promise(() => undefined),
        allowMeteredCharts: () => false,
        subscribeState: () => () => undefined
      });
      const waiting = gate.firstStateKnown();
      await settle();
      mock.timers.tick(FIRST_STATE_WAIT_MS - 1);
      assert.strictEqual(await isSettled(waiting), false);
      mock.timers.tick(1);
      assert.strictEqual(await isSettled(waiting), true);
    } finally {
      mock.timers.reset();
    }
  });

  it('ends the wait when a state arrives while the plugin list is asked', async () => {
    let onState: (value: unknown) => void = () => undefined;
    const gate = new InternetGate({
      getPluginsList: () => new Promise(() => undefined),
      allowMeteredCharts: () => false,
      subscribeState: (listener) => {
        onState = listener;
        return () => undefined;
      }
    });
    const waiting = gate.firstStateKnown();
    await settle();
    onState('metered');
    assert.strictEqual(await isSettled(waiting), true);
    gate.stop();
  });

  it('stops waiting once stopped', async () => {
    const { gate } = setup({ plugins: enabled });
    const waiting = gate.firstStateKnown();
    await settle();
    gate.stop();
    assert.strictEqual(await isSettled(waiting), true);
  });

  it('does not wait on a server that cannot list plugins, and believes a state', async () => {
    const gate = new InternetGate({
      getPluginsList: () => Promise.reject(new Error('boom')),
      allowMeteredCharts: () => false,
      subscribeState: () => () => undefined
    });
    assert.strictEqual(await isSettled(gate.firstStateKnown()), true);
    const { gate: published } = setup({ state: 'metered', plugins: null });
    assert.strictEqual(published.mayRunBackground(), false);
  });
});

describe('subscribeInternetState', () => {
  it('follows the path through the subscription manager until unsubscribed', () => {
    const seen: unknown[] = [];
    let unsubscribed = 0;
    let onDelta: ((delta: unknown) => void) | undefined;
    const subscriptionmanager = {
      subscribe: (
        subscription: { context: string; subscribe: { path: string; policy: string }[] },
        unsubscribes: (() => void)[],
        _onError: unknown,
        callback: (delta: unknown) => void
      ) => {
        assert.strictEqual(subscription.context, 'vessels.self');
        assert.deepStrictEqual(subscription.subscribe, [
          { path: INTERNET_STATE_PATH, policy: 'instant' }
        ]);
        onDelta = callback;
        unsubscribes.push(() => unsubscribed++);
      },
      unsubscribe: () => undefined
    } as unknown as ServerAPI['subscriptionmanager'];
    const unsubscribe = subscribeInternetState(
      subscriptionmanager,
      () => undefined
    )((value) => seen.push(value));
    onDelta?.({
      updates: [
        { values: [{ path: INTERNET_STATE_PATH, value: 'metered' }] },
        { meta: [{ path: INTERNET_STATE_PATH, value: {} }] },
        { values: [{ path: 'navigation.position', value: {} }] },
        { values: [{ path: INTERNET_STATE_PATH, value: null }] }
      ]
    });
    assert.deepStrictEqual(seen, ['metered', null]);
    unsubscribe();
    assert.strictEqual(unsubscribed, 1);
  });
});
