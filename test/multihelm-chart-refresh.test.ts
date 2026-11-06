/**
 * Refreshing the chart list after Multihelm changed charts: one refresh per
 * burst, retried until it succeeds, deleted charts dropped at once.
 */

import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  ChartRefreshQueue,
  MIN_INTERVAL_MS,
  REFRESH_DELAY_MS,
  RETRY_DELAY_MS,
  removeVanishedCharts
} from '../dist/utils/multihelm/chart-refresh.js';
import type { ChartProvider } from '../dist/types.js';

interface Recorder {
  refreshes: number;
  results: boolean[];
  announced: string[][];
  dropped: string[];
}

function queue(rec: Recorder): ChartRefreshQueue {
  return new ChartRefreshQueue({
    refresh: () => {
      rec.refreshes++;
      return Promise.resolve(rec.results.shift() ?? true);
    },
    announce: (relPaths) => {
      rec.announced.push([...relPaths].sort());
    },
    drop: (relPath) => {
      rec.dropped.push(relPath);
    }
  });
}

async function advance(ms: number): Promise<void> {
  mock.timers.tick(ms);
  // Let the refresh promise and what follows it settle.
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

describe('ChartRefreshQueue', () => {
  let rec: Recorder;

  beforeEach(() => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    rec = { refreshes: 0, results: [], announced: [], dropped: [] };
  });

  afterEach(() => {
    mock.timers.reset();
  });

  it('refreshes once for a burst of changes and announces them all', async () => {
    const q = queue(rec);
    q.changed(['a.mbtiles']);
    await advance(REFRESH_DELAY_MS - 1);
    q.changed(['b.mbtiles', 'dir/c.mbtiles']);
    await advance(REFRESH_DELAY_MS - 1);
    assert.strictEqual(rec.refreshes, 0);
    await advance(1);
    assert.strictEqual(rec.refreshes, 1);
    assert.deepStrictEqual(rec.announced, [['a.mbtiles', 'b.mbtiles', 'dir/c.mbtiles']]);
  });

  it('retries a failed refresh and announces only after it succeeds', async () => {
    rec.results = [false, false, true];
    const q = queue(rec);
    q.changed(['a.mbtiles']);
    await advance(REFRESH_DELAY_MS);
    assert.strictEqual(rec.refreshes, 1);
    assert.deepStrictEqual(rec.announced, []);
    await advance(RETRY_DELAY_MS);
    assert.strictEqual(rec.refreshes, 2);
    assert.deepStrictEqual(rec.announced, []);
    await advance(RETRY_DELAY_MS);
    assert.strictEqual(rec.refreshes, 3);
    assert.deepStrictEqual(rec.announced, [['a.mbtiles']]);
  });

  it('drops a deleted chart at once, before the refresh', async () => {
    rec.results = [false];
    const q = queue(rec);
    q.deleted('old.mbtiles');
    assert.deepStrictEqual(rec.dropped, ['old.mbtiles']);
    await advance(REFRESH_DELAY_MS);
    assert.strictEqual(rec.refreshes, 1);
    assert.deepStrictEqual(rec.announced, []);
  });

  it('does nothing after stop', async () => {
    rec.results = [false];
    const q = queue(rec);
    q.changed(['a.mbtiles']);
    await advance(REFRESH_DELAY_MS);
    q.stop();
    await advance(RETRY_DELAY_MS);
    q.changed(['b.mbtiles']);
    await advance(REFRESH_DELAY_MS);
    assert.strictEqual(rec.refreshes, 1);
    assert.deepStrictEqual(rec.announced, []);
  });

  it('keeps the short wait of a change that arrived during a failed refresh', async () => {
    let finish: (ok: boolean) => void = () => undefined;
    const q = new ChartRefreshQueue({
      refresh: () => {
        rec.refreshes++;
        if (rec.refreshes === 1) {
          return new Promise<boolean>((resolve) => {
            finish = resolve;
          });
        }
        return Promise.resolve(true);
      },
      announce: (relPaths) => {
        rec.announced.push([...relPaths].sort());
      },
      drop: () => undefined
    });
    q.changed(['a.mbtiles']);
    await advance(REFRESH_DELAY_MS);
    assert.strictEqual(rec.refreshes, 1);
    q.changed(['b.mbtiles']);
    finish(false);
    await advance(0);
    await advance(MIN_INTERVAL_MS - 1);
    assert.strictEqual(rec.refreshes, 1);
    await advance(1);
    assert.strictEqual(rec.refreshes, 2);
    assert.deepStrictEqual(rec.announced, [['a.mbtiles', 'b.mbtiles']]);
  });

  it('drops nothing once stopped', () => {
    const q = queue(rec);
    q.stop();
    q.deleted('old.mbtiles');
    assert.deepStrictEqual(rec.dropped, []);
  });

  it('keeps refreshes apart while charts trickle in', async () => {
    const q = queue(rec);
    q.changed(['a.mbtiles']);
    await advance(REFRESH_DELAY_MS);
    assert.strictEqual(rec.refreshes, 1);
    for (const name of ['b', 'c', 'd', 'e']) {
      q.changed([`${name}.mbtiles`]);
      await advance(REFRESH_DELAY_MS + 1_000);
    }
    assert.strictEqual(rec.refreshes, 1);
    await advance(MIN_INTERVAL_MS);
    assert.strictEqual(rec.refreshes, 2);
    assert.deepStrictEqual(rec.announced, [
      ['a.mbtiles'],
      ['b.mbtiles', 'c.mbtiles', 'd.mbtiles', 'e.mbtiles']
    ]);
  });
});

describe('removeVanishedCharts', () => {
  it('takes out the charts whose file is gone and keeps the rest', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chart-refresh-'));
    try {
      const kept = path.join(dir, 'kept.mbtiles');
      fs.writeFileSync(kept, '');
      const provider = (filePath: string): ChartProvider =>
        ({ _filePath: filePath }) as unknown as ChartProvider;
      const deleted = provider(path.join(dir, 'deleted.mbtiles'));
      const charts: Record<string, ChartProvider> = {
        kept: provider(kept),
        deleted,
        online: provider('')
      };
      const removed = await removeVanishedCharts(charts);
      assert.deepStrictEqual(removed, [deleted]);
      assert.deepStrictEqual(Object.keys(charts).sort(), ['kept', 'online']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
