import { describe, it } from 'node:test';
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
    sleeps: 0
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
    now: () => world.clock,
    sleep: (ms) => {
      world.sleeps++;
      world.clock += ms;
      return new Promise((r) => setImmediate(r));
    }
  });
  return { world, gate };
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
    assert.strictEqual(world.listCalls, 0);
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
