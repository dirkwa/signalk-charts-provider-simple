/**
 * The master's charts on a server that is not the master: listed with tile
 * URLs through Multihelm's proxy, refreshed on role changes, withdrawn
 * when Multihelm or the master goes away.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert';

import {
  MASTER_CHARTS_LIST,
  MASTER_TILES_PREFIX,
  MasterCharts,
  chartsFromMaster
} from '../dist/utils/multihelm/master-charts.js';
import type { MasterResponse, Role } from '../dist/utils/multihelm/api.js';
import type { SanitizedChart } from '../dist/types.js';

const masterPath = (path: string): string => `/plugins/signalk-multihelm/master${path}`;

const masterList = {
  harbour: {
    identifier: 'harbour',
    name: 'Harbour',
    type: 'tilelayer',
    url: `${MASTER_TILES_PREFIX}harbour/{z}/{x}/{y}`
  },
  osm: {
    identifier: 'osm',
    name: 'OSM',
    type: 'tilelayer',
    url: 'https://tile.example/{z}/{x}/{y}.png'
  },
  elsewhere: { identifier: 'elsewhere', name: 'Elsewhere', url: '/plugins/other/{z}/{x}/{y}' },
  broken: { identifier: 'broken' }
};

describe('chartsFromMaster', () => {
  it('routes the master’s own tiles through Multihelm and keeps online charts', () => {
    const charts = chartsFromMaster(masterList, masterPath);
    assert.deepStrictEqual(Object.keys(charts).sort(), ['harbour', 'osm']);
    assert.strictEqual(
      charts.harbour?.url,
      '/plugins/signalk-multihelm/master/signalk/v1/api/resources/charts/harbour/{z}/{x}/{y}'
    );
    assert.strictEqual(charts.osm?.url, 'https://tile.example/{z}/{x}/{y}.png');
  });

  it('ignores anything but an object of charts', () => {
    assert.deepStrictEqual(chartsFromMaster([], masterPath), {});
    assert.deepStrictEqual(chartsFromMaster(null, masterPath), {});
  });
});

interface FakeMultihelm {
  role: Role;
  hasMaster: boolean;
  list: unknown;
  fail: boolean;
  routes: string[];
  roleListeners: Set<() => void>;
}

function fakeMultihelm(): { state: FakeMultihelm; property: Record<string, unknown> } {
  const state: FakeMultihelm = {
    role: 'member',
    hasMaster: true,
    list: masterList,
    fail: false,
    routes: [],
    roleListeners: new Set()
  };
  const property = {
    apiVersion: 1,
    role: () => state.role,
    master: () => (state.hasMaster ? { id: 'm' } : null),
    onRoleChanged: (cb: () => void) => {
      state.roleListeners.add(cb);
      return () => state.roleListeners.delete(cb);
    },
    registerMasterRoute: (prefix: string) => {
      state.routes.push(prefix);
      return {
        unregister: () => {
          state.routes = state.routes.filter((r) => r !== prefix);
        }
      };
    },
    masterPath,
    fetchMaster: (path: string): Promise<MasterResponse> => {
      assert.strictEqual(path, MASTER_CHARTS_LIST);
      if (state.fail) {
        return Promise.reject(new Error('master unreachable'));
      }
      return Promise.resolve({
        status: 200,
        headers: {},
        body: Buffer.from(JSON.stringify(state.list))
      });
    }
  };
  return { state, property };
}

function propertySource(): {
  app: {
    onPropertyValues: (
      name: string,
      cb: (values: ({ value: unknown } | undefined)[]) => void
    ) => () => void;
  };
  emit: (value: unknown) => void;
} {
  let listener: ((values: ({ value: unknown } | undefined)[]) => void) | null = null;
  return {
    app: {
      onPropertyValues: (_name, cb) => {
        listener = cb;
        return () => {
          listener = null;
        };
      }
    },
    emit: (value) => listener?.([{ value }])
  };
}

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const log = { debug: () => undefined, error: () => undefined };

describe('MasterCharts', () => {
  let charts: MasterCharts | null = null;

  afterEach(() => {
    charts?.stop();
    charts = null;
  });

  it('lists the master’s charts on a member and withdraws them when Multihelm stops', async () => {
    const { state, property } = fakeMultihelm();
    const source = propertySource();
    const changes: [string, SanitizedChart | null][] = [];
    charts = new MasterCharts(source.app, (id, chart) => changes.push([id, chart]), log);

    source.emit(property);
    await settle();
    assert.deepStrictEqual(
      state.routes.sort(),
      [`${MASTER_CHARTS_LIST}/`, MASTER_TILES_PREFIX].sort()
    );
    assert.deepStrictEqual(Object.keys(charts.charts()).sort(), ['harbour', 'osm']);
    assert.deepStrictEqual(changes.map(([id]) => id).sort(), ['harbour', 'osm']);

    changes.length = 0;
    source.emit({ apiVersion: 1 });
    assert.deepStrictEqual(charts.charts(), {});
    assert.deepStrictEqual(state.routes, []);
    assert.deepStrictEqual(changes.sort(), [
      ['harbour', null],
      ['osm', null]
    ]);
  });

  it('serves none on the master itself, and none once the master is gone', async () => {
    const { state, property } = fakeMultihelm();
    const source = propertySource();
    charts = new MasterCharts(source.app, () => undefined, log);
    state.role = 'master';
    source.emit(property);
    await settle();
    assert.deepStrictEqual(charts.charts(), {});

    state.role = 'member';
    for (const cb of state.roleListeners) {
      cb();
    }
    await settle();
    assert.ok(charts.chart('harbour'));

    state.hasMaster = false;
    await charts.refresh();
    assert.deepStrictEqual(charts.charts(), {});
  });

  it('keeps the list while the master fails to answer once', async () => {
    const { state, property } = fakeMultihelm();
    const source = propertySource();
    const changes: string[] = [];
    charts = new MasterCharts(source.app, (id) => changes.push(id), log);
    source.emit(property);
    await settle();
    changes.length = 0;

    state.fail = true;
    await charts.refresh();
    assert.ok(charts.chart('harbour'));
    assert.deepStrictEqual(changes, []);
  });

  it('announces only the charts that changed', async () => {
    const { state, property } = fakeMultihelm();
    const source = propertySource();
    const changes: string[] = [];
    charts = new MasterCharts(source.app, (id) => changes.push(id), log);
    source.emit(property);
    await settle();
    changes.length = 0;

    state.list = { ...masterList, osm: { ...masterList.osm, name: 'OpenStreetMap' } };
    await charts.refresh();
    assert.deepStrictEqual(changes, ['osm']);
  });
});
