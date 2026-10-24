import { describe, it, mock } from 'node:test';
import assert from 'node:assert';

import {
  FIRST_STATE_WAIT_MS,
  INTERNET_STATE_PATH,
  InternetGate,
  PUBLISHER_CHECK_MS,
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
    clock: 0,
    listCalls: 0,
    sleeps: 0,
    listeners: new Set<(value: unknown) => void>()
  };
  const gate = new InternetGate({
    getSelfPath: (path) =>
      path === INTERNET_STATE_PATH && world.state !== undefined
        ? { value: world.state, $source: 'signalk-internet.internet' }
        : undefined,
    getPluginsList:
      world.plugins === null
        ? undefined
        : () => {
            world.listCalls++;
            return Promise.resolve(world.plugins ?? []);
          },
    allowMeteredCharts: () => world.allowMetered,
    subscribeState: (onState) => {
      world.listeners.add(onState);
      return () => world.listeners.delete(onState);
    },
    now: () => world.clock,
    sleep: (ms) => {
      world.sleeps++;
      world.clock += ms;
      return new Promise((r) => setImmediate(r));
    }
  });
  // As the server does: listeners hear the value before the data model has it.
  const publish = (value: string): void => {
    for (const listener of [...world.listeners]) {
      listener(value);
    }
    world.state = value;
  };
  return { world, gate, publish };
}

const enabled: PluginListEntry[] = [{ id: 'signalk-internet', enabled: true }];
const settle = () => new Promise((r) => setImmediate(r));

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

  it('accepts a bare value', () => {
    const gate = new InternetGate({
      getSelfPath: () => 'offline',
      allowMeteredCharts: () => false
    });
    assert.strictEqual(gate.mayRunBackground(), false);
  });

  it('ignores a left-over state once signalk-internet is disabled or removed', async () => {
    const { world, gate } = setup({ state: 'metered', plugins: enabled });
    assert.strictEqual(gate.mayRunBackground(), false);
    await settle();
    world.plugins = [{ id: 'signalk-internet', enabled: false }];
    assert.strictEqual(gate.mayRunBackground(), false, 'the last answer holds for a while');
    world.clock += PUBLISHER_CHECK_MS;
    gate.state();
    await settle();
    assert.strictEqual(gate.state(), undefined);
    assert.strictEqual(gate.mayRunBackground(), true);
    world.plugins = [];
    world.clock += PUBLISHER_CHECK_MS;
    gate.state();
    await settle();
    assert.strictEqual(gate.mayFetchCharts(), true, 'not installed at all');
  });

  it('asks the server at most once per check interval', async () => {
    const { world, gate } = setup({ state: 'metered', plugins: enabled });
    for (let i = 0; i < 50; i++) {
      gate.mayFetchCharts();
    }
    await settle();
    gate.mayFetchCharts();
    assert.strictEqual(world.listCalls, 1);
  });

  it('does not wait at startup when signalk-internet is not installed or disabled', async () => {
    for (const plugins of [[], [{ id: 'signalk-internet', enabled: false }], null]) {
      const { world, gate } = setup({ plugins });
      await gate.firstStateKnown();
      assert.strictEqual(world.sleeps, 0);
    }
  });

  it('does not wait at startup when a state is already published', async () => {
    const { world, gate } = setup({ state: 'online', plugins: enabled });
    await gate.firstStateKnown();
    assert.strictEqual(world.sleeps, 0);
  });

  it('ignores a left-over state at startup once signalk-internet is disabled', async () => {
    const { gate } = setup({
      state: 'metered',
      plugins: [{ id: 'signalk-internet', enabled: false }]
    });
    await gate.firstStateKnown();
    assert.strictEqual(gate.mayRunBackground(), true);
  });

  it('runs work at once while background work may run, without subscribing', async () => {
    const { world, gate } = setup({ state: 'online', plugins: enabled });
    await gate.firstStateKnown();
    let runs = 0;
    gate.runWhenBackgroundAllowed(() => runs++);
    assert.strictEqual(runs, 1);
    assert.strictEqual(world.listeners.size, 0);
  });

  it('holds work while restricted and runs it once a usable state arrives', async () => {
    const { world, gate, publish } = setup({ state: 'metered', plugins: enabled });
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
    assert.strictEqual(world.listeners.size, 0, 'unsubscribed');
    publish('metered');
    publish('online');
    await settle();
    assert.strictEqual(runs, 1, 'ran once');
  });

  it('keeps work held when a usable state is replaced before it runs', async () => {
    const { gate, publish } = setup({ state: 'metered', plugins: enabled });
    await gate.firstStateKnown();
    let runs = 0;
    gate.runWhenBackgroundAllowed(() => runs++);
    publish('online');
    publish('offline');
    await settle();
    assert.strictEqual(runs, 0);
    publish('online');
    await settle();
    assert.strictEqual(runs, 1);
  });

  it('asks again on its own while work is held, so a quietly disabled signalk-internet releases it', async () => {
    mock.timers.enable({ apis: ['setInterval'] });
    try {
      const { world, gate } = setup({ state: 'metered', plugins: enabled });
      await gate.firstStateKnown();
      let runs = 0;
      gate.runWhenBackgroundAllowed(() => runs++);
      world.plugins = [{ id: 'signalk-internet', enabled: false }];
      world.clock += PUBLISHER_CHECK_MS;
      mock.timers.tick(PUBLISHER_CHECK_MS);
      await settle();
      assert.strictEqual(runs, 1);
      const calls = world.listCalls;
      world.clock += 10 * PUBLISHER_CHECK_MS;
      mock.timers.tick(10 * PUBLISHER_CHECK_MS);
      await settle();
      assert.strictEqual(world.listCalls, calls, 'no more checks once released');
    } finally {
      mock.timers.reset();
    }
  });

  it('runs held work once signalk-internet turns out disabled', async () => {
    const { world, gate } = setup({ state: 'metered', plugins: enabled });
    await gate.firstStateKnown();
    let runs = 0;
    gate.runWhenBackgroundAllowed(() => runs++);
    world.plugins = [{ id: 'signalk-internet', enabled: false }];
    world.clock += PUBLISHER_CHECK_MS;
    gate.state();
    await settle();
    assert.strictEqual(runs, 1);
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
    const { world, gate } = setup({ plugins: enabled });
    const waiting = gate.firstStateKnown();
    let done = false;
    void waiting.then(() => (done = true));
    for (let i = 0; i < 5; i++) {
      await settle();
    }
    assert.strictEqual(done, false);
    world.state = 'metered';
    await waiting;
    assert.ok(world.sleeps > 0);
    assert.ok(world.clock < FIRST_STATE_WAIT_MS);
    assert.strictEqual(gate.mayRunBackground(), false);
  });

  it('gives up waiting for a first state after a bounded time', async () => {
    const { world, gate } = setup({ plugins: enabled });
    await gate.firstStateKnown();
    assert.ok(world.clock >= FIRST_STATE_WAIT_MS);
    assert.ok(world.clock < FIRST_STATE_WAIT_MS + 2000);
    assert.strictEqual(gate.mayRunBackground(), true);
  });

  it('stops waiting once stopped', async () => {
    const { world, gate } = setup({ plugins: enabled });
    const waiting = gate.firstStateKnown();
    await settle();
    gate.stop();
    await waiting;
    assert.ok(world.clock < FIRST_STATE_WAIT_MS);
  });

  it('treats a server that cannot list plugins as "believe the state"', async () => {
    const gate = new InternetGate({
      getSelfPath: () => ({ value: 'metered' }),
      getPluginsList: () => Promise.reject(new Error('boom')),
      allowMeteredCharts: () => false
    });
    await gate.firstStateKnown();
    gate.state();
    await settle();
    assert.strictEqual(gate.mayRunBackground(), false);
  });
});
