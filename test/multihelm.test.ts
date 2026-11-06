/**
 * The datasets this plugin registers with signalk-multihelm, and following
 * Multihelm's PropertyValue.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type {
  DatasetDefinition,
  DatasetHandle,
  IncomingEntry
} from '../dist/utils/multihelm/api.js';
import { chartsDataset, isChartKey } from '../dist/utils/multihelm/charts-dataset.js';
import { encDataset, type EncHost } from '../dist/utils/multihelm/enc-dataset.js';
import { linkMultihelm } from '../dist/utils/multihelm/link.js';
import {
  chartOwner,
  collectionOwner,
  collectionState,
  getCollection,
  initEncStore,
  listCollectionsWithCells,
  removeCollection,
  storeCollection,
  storedFilePath
} from '../dist/utils/enc-store.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'multihelm-adapter-'));
const SHA = 'a'.repeat(64);

function incoming(file: string, content: string): string {
  const full = path.join(tmp, 'incoming', file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

describe('following Multihelm', () => {
  it('registers the datasets while Multihelm runs, and again after its restart', () => {
    let listener: ((values: ({ value: unknown } | undefined)[]) => void) | null = null;
    const values: ({ value: unknown } | undefined)[] = [undefined];
    const registered: string[] = [];
    const unregistered: string[] = [];
    let changed = 0;
    const api = (): {
      apiVersion: number;
      registerDataset: (d: DatasetDefinition) => DatasetHandle;
    } => ({
      apiVersion: 1,
      registerDataset: (d) => {
        registered.push(d.id);
        return {
          changed: () => {
            changed++;
          },
          unregister: () => {
            unregistered.push(d.id);
          }
        };
      }
    });
    const emit = (value: unknown): void => {
      values.push({ value });
      listener?.(values);
    };
    const definition = { id: 'x/y' } as DatasetDefinition;
    const link = linkMultihelm(
      {
        onPropertyValues: (_name, cb) => {
          listener = cb;
          cb(values);
          return () => {
            listener = null;
          };
        }
      },
      () => [definition],
      { debug: () => {}, error: () => {} }
    );
    assert.strictEqual(link.connected(), false);

    emit(api());
    assert.deepStrictEqual(registered, ['x/y']);
    link.changed();
    assert.strictEqual(changed, 1);

    emit({ apiVersion: 1 });
    assert.strictEqual(link.connected(), false);
    assert.deepStrictEqual(unregistered, ['x/y']);

    emit(api());
    assert.deepStrictEqual(registered, ['x/y', 'x/y']);

    link.stop();
    assert.deepStrictEqual(unregistered, ['x/y', 'x/y']);
    assert.strictEqual(listener, null);
  });

  it('releases the datasets registered before one that fails', () => {
    const unregistered: string[] = [];
    const errors: string[] = [];
    const link = linkMultihelm(
      {
        onPropertyValues: (_name, cb) => {
          cb([
            undefined,
            {
              value: {
                apiVersion: 1,
                registerDataset: (d: DatasetDefinition): DatasetHandle => {
                  if (d.id === 'x/bad') {
                    throw new Error('refused');
                  }
                  return {
                    changed: () => {},
                    unregister: () => {
                      unregistered.push(d.id);
                    }
                  };
                }
              }
            }
          ]);
          return () => {};
        }
      },
      () => [{ id: 'x/good' } as DatasetDefinition, { id: 'x/bad' } as DatasetDefinition],
      {
        debug: () => {},
        error: (msg) => {
          errors.push(msg);
        }
      }
    );
    assert.deepStrictEqual(unregistered, ['x/good']);
    assert.strictEqual(link.connected(), false);
    assert.strictEqual(errors.length, 1);
  });

  it('ignores an API version it does not know', () => {
    const registered: string[] = [];
    linkMultihelm(
      {
        onPropertyValues: (_name, cb) => {
          cb([
            undefined,
            {
              value: {
                apiVersion: 2,
                registerDataset: (d: DatasetDefinition) => {
                  registered.push(d.id);
                }
              }
            }
          ]);
          return () => {};
        }
      },
      () => [{ id: 'x/y' } as DatasetDefinition],
      { debug: () => {}, error: () => {} }
    );
    assert.deepStrictEqual(registered, []);
  });
});

describe('the charts dataset', () => {
  const chartDir = path.join(tmp, 'charts');
  const enabled = new Map<string, boolean>();
  const changed: string[] = [];
  const deleted: string[] = [];
  const dataset = chartsDataset({
    chartPath: () => chartDir,
    isEnabled: (p) => enabled.get(p) ?? true,
    setEnabled: (p, e) => {
      enabled.set(p, e);
    },
    chartsChanged: (paths) => {
      changed.push(...paths);
      return Promise.resolve();
    },
    chartDeleted: (p) => {
      deleted.push(p);
      return Promise.resolve();
    }
  });

  before(() => {
    fs.mkdirSync(path.join(chartDir, 'Baltic'), { recursive: true });
    fs.writeFileSync(path.join(chartDir, 'Baltic', 'finland.mbtiles'), 'tiles');
    fs.writeFileSync(path.join(chartDir, 'notes.txt'), 'not a chart');
    fs.mkdirSync(path.join(chartDir, '.hidden'));
    fs.writeFileSync(path.join(chartDir, '.hidden', 'x.mbtiles'), 'hidden');
  });

  it('accepts only relative chart paths inside the folder', () => {
    assert.ok(isChartKey('chart.mbtiles'));
    assert.ok(isChartKey('Baltic/Finland/chart.pmtiles'));
    assert.ok(isChartKey('Online/osm.onlinechart.json'));
    for (const bad of [
      '',
      '../chart.mbtiles',
      'a/../../chart.mbtiles',
      '/etc/chart.mbtiles',
      'C:/chart.mbtiles',
      'a\\b.mbtiles',
      'a//b.mbtiles',
      './chart.mbtiles',
      '.multihelm-incoming/x.mbtiles',
      'chart.txt',
      'chart.mbtiles-journal'
    ]) {
      assert.strictEqual(isChartKey(bad), false, bad);
    }
  });

  it('lists the chart files with their enabled state', async () => {
    enabled.set(path.join('Baltic', 'finland.mbtiles'), false);
    const entries = await dataset.list();
    assert.deepStrictEqual(
      entries.map((e) => [e.key, e.meta, e.files.map((f) => f.name)]),
      [['Baltic/finland.mbtiles', { enabled: false }, ['chart']]]
    );
  });

  it('moves a received chart into place and serves it', async () => {
    const entry: IncomingEntry = {
      key: 'Med/greece.pmtiles',
      meta: { enabled: true },
      files: [
        {
          name: 'chart',
          path: incoming('g', 'greek tiles'),
          size: 11,
          sha256: SHA,
          unchanged: false
        }
      ]
    };
    await dataset.apply(entry);
    assert.strictEqual(
      fs.readFileSync(path.join(chartDir, 'Med', 'greece.pmtiles'), 'utf-8'),
      'greek tiles'
    );
    assert.strictEqual(enabled.get(path.join('Med', 'greece.pmtiles')), true);
    assert.deepStrictEqual(changed, ['Med/greece.pmtiles']);
  });

  it('takes over the enabled state alone when the file did not change', async () => {
    const file = path.join(chartDir, 'Med', 'greece.pmtiles');
    await dataset.apply({
      key: 'Med/greece.pmtiles',
      meta: { enabled: false },
      files: [{ name: 'chart', path: file, size: 11, sha256: SHA, unchanged: true }]
    });
    assert.strictEqual(enabled.get(path.join('Med', 'greece.pmtiles')), false);
    assert.strictEqual(fs.readFileSync(file, 'utf-8'), 'greek tiles');
  });

  it('fails the listing when a folder cannot be read, rather than missing its charts', async () => {
    const locked = path.join(chartDir, 'Locked');
    fs.mkdirSync(locked);
    fs.writeFileSync(path.join(locked, 'hidden-from-us.mbtiles'), 'tiles');
    fs.chmodSync(locked, 0o000);
    try {
      let readable = true;
      try {
        fs.readdirSync(locked);
      } catch {
        readable = false;
      }
      if (readable) {
        return; // Running as root: permissions do not apply.
      }
      await assert.rejects(dataset.list());
    } finally {
      fs.chmodSync(locked, 0o755);
      fs.rmSync(locked, { recursive: true, force: true });
    }
  });

  it('fails the listing when the chart folder is gone', async () => {
    const gone = chartsDataset({
      chartPath: () => path.join(tmp, 'no-such-folder'),
      isEnabled: () => true,
      setEnabled: () => {},
      chartsChanged: () => Promise.resolve(),
      chartDeleted: () => Promise.resolve()
    });
    await assert.rejects(gone.list());
  });

  it('deletes a chart a peer deleted', async () => {
    assert.strictEqual(await dataset.remove('Med/greece.pmtiles'), true);
    assert.strictEqual(fs.existsSync(path.join(chartDir, 'Med', 'greece.pmtiles')), false);
    assert.deepStrictEqual(deleted, ['Med/greece.pmtiles']);
  });
});

describe('the enc dataset', () => {
  const dataDir = path.join(tmp, 'enc-data');
  const host: EncHost = {
    ready: () => listCollectionsWithCells().filter((c) => collectionState(c.id) === 'ready'),
    filePath: storedFilePath,
    owner: collectionOwner,
    ownerFor: (id, chart) => (chart !== undefined ? chartOwner(chart) : `detached:${id}`),
    store: storeCollection,
    remove: removeCollection
  };
  let dataset: DatasetDefinition;

  const cellFiles = (dir: string, cell: string, files: Record<string, string>): string[] => {
    fs.mkdirSync(path.join(dir, cell), { recursive: true });
    return Object.entries(files).map(([name, content]) => {
      const full = path.join(dir, cell, name);
      fs.writeFileSync(full, content);
      return full;
    });
  };

  before(async () => {
    fs.mkdirSync(dataDir, { recursive: true });
    initEncStore(dataDir, () => {});
    dataset = encDataset(host, dataDir);
    const files = cellFiles(path.join(tmp, 'set-cells'), 'US5MA1AM', {
      'US5MA1AM.000': 'base cell',
      'US5MA1AM.001': 'update 1'
    });
    await storeCollection({
      owner: 'chart-set:boston',
      preferredId: 'boston',
      name: 'Boston',
      kind: 'chart-set',
      source: 'chart-set',
      cells: [{ base: files[0], files, version: '3.1' }],
      mode: 'copy'
    });
  });

  it('lists a collection with its cells and files', async () => {
    const [entry] = await dataset.list();
    assert.strictEqual(entry.key, 'boston');
    assert.deepStrictEqual(entry.meta, {
      name: 'Boston',
      source: 'chart-set',
      cells: [{ name: 'US5MA1AM', version: '3.1' }]
    });
    assert.deepStrictEqual(
      entry.files.map((f) => [f.name, f.size]),
      [
        ['US5MA1AM.000', 9],
        ['US5MA1AM.001', 8]
      ]
    );
  });

  it('stores a peer collection under its chart, and keeps the key it came under', async () => {
    const base = incoming('b0', 'other base');
    const update = incoming('b1', 'other update');
    await dataset.apply({
      key: 'boston',
      meta: {
        name: 'Boston',
        chart: 'boston.mbtiles',
        source: 'upload',
        cells: [{ name: 'US5BOS01' }]
      },
      files: [
        { name: 'US5BOS01.000', path: base, size: 10, sha256: SHA, unchanged: false },
        { name: 'US5BOS01.001', path: update, size: 12, sha256: SHA, unchanged: false }
      ]
    });
    // The local chart set keeps its id; the peer's collection gets another.
    const stored = getCollection('boston-2');
    assert.ok(stored);
    assert.strictEqual(collectionOwner('boston-2'), chartOwner('boston.mbtiles'));
    assert.deepStrictEqual(
      stored.cells[0].files.map((f) => f.name),
      ['US5BOS01.000', 'US5BOS01.001']
    );
    const keys = (await dataset.list()).map((e) => e.key).sort();
    assert.deepStrictEqual(keys, ['boston', 'boston-local']);
    assert.strictEqual(
      (await dataset.list()).find((e) => e.key === 'boston')?.files[0]?.name,
      'US5BOS01.000'
    );
  });

  it('keeps the key of a collection that is not ready while it is rewritten', async () => {
    const notReady = encDataset({ ...host, ready: () => [] }, dataDir);
    await notReady.list();
    const keys = (await dataset.list()).map((e) => e.key).sort();
    assert.deepStrictEqual(keys, ['boston', 'boston-local']);
  });

  it('treats a key such as constructor as plain data', async () => {
    const files = cellFiles(path.join(tmp, 'constructor-cells'), 'US5CON01', {
      'US5CON01.000': 'cell'
    });
    await storeCollection({
      owner: 'chart:constructor.mbtiles',
      preferredId: 'constructor',
      name: 'Constructor',
      kind: 'conversion',
      chart: 'constructor.mbtiles',
      source: 'upload',
      cells: [{ base: files[0], files }],
      mode: 'copy'
    });
    const keyed = encDataset(host, dataDir);
    assert.deepStrictEqual((await keyed.list()).map((e) => e.key).sort(), [
      'boston',
      'boston-local',
      'constructor'
    ]);
    assert.strictEqual(await keyed.remove('constructor'), true);
    assert.strictEqual(getCollection('constructor'), null);
  });

  it('never removes a chart set because a peer deleted its collection', async () => {
    assert.strictEqual(await dataset.remove('boston-local'), false);
    assert.ok(getCollection('boston'));
  });

  it('removes a received collection when its origin does', async () => {
    assert.strictEqual(await dataset.remove('boston'), true);
    assert.strictEqual(getCollection('boston-2'), null);
  });

  it('refuses a collection without a usable description', async () => {
    await assert.rejects(dataset.apply({ key: 'x', meta: { name: 1 }, files: [] }));
  });
});
