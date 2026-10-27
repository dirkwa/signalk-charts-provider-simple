import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { chartOutputNames } from '../dist/utils/rnc-converter.js';
import { forEachLine } from '../dist/utils/line-reader.js';
import { TaskFailedError, withWorkerPool } from '../dist/utils/worker-pool.js';

describe('forEachLine', () => {
  it('keeps multi-byte characters whole across read boundaries', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-charts-lines-'));
    try {
      const lines = ['Ålesund havn', 'Göteborg — Älvsborg', '', 'plain', 'Łeba 港'];
      const file = path.join(tmp, 'lines.ndjson');
      fs.writeFileSync(file, lines.join('\n'));
      // Every chunk size, so a boundary lands inside every character.
      for (let chunk = 1; chunk <= 12; chunk++) {
        const read: string[] = [];
        forEachLine(file, (line) => read.push(line), chunk);
        assert.deepStrictEqual(
          read,
          lines.filter((l) => l !== ''),
          `chunk size ${String(chunk)}`
        );
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('chartOutputNames', () => {
  it('keeps unique names and numbers repeated ones', () => {
    assert.deepStrictEqual(
      chartOutputNames([
        path.join('a', 'Med01.kap'),
        path.join('b', 'Med01.kap'),
        path.join('c', 'med01.KAP'),
        path.join('a', 'Med02.kap')
      ]),
      ['Med01.mbtiles', 'Med01-2.mbtiles', 'med01-3.mbtiles', 'Med02.mbtiles']
    );
  });
});

describe('WorkerPool', () => {
  it('fails a task whose event consumer throws, without crashing, and keeps working', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-charts-pool-'));
    try {
      const shard = path.join(tmp, 'shard.ndjson');
      const feature = {
        type: 'Feature',
        properties: {},
        geometry: { type: 'Point', coordinates: [0.001, 0.001] }
      };
      fs.writeFileSync(shard, `0\t${JSON.stringify(feature)}\n`);
      const task = {
        op: 'tile-shard' as const,
        shard: {
          files: [shard],
          groups: [{ layer: 'X', minzoom: 2, maxzoom: 3 }],
          z: 2,
          x: 2,
          y: 1,
          extent: 4096,
          buffer: 64,
          gzip: false
        }
      };
      await withWorkerPool(1, undefined, async (pool) => {
        await assert.rejects(
          pool.run(task, {
            onEvent: () => {
              throw new Error('disk full');
            }
          }),
          /disk full/
        );
        const ok = await pool.run(task);
        assert.ok(ok.tiles > 0);
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('runs tasks on workers with a heap limit', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-charts-pool-'));
    try {
      const shard = path.join(tmp, 'shard.ndjson');
      const feature = {
        type: 'Feature',
        properties: {},
        geometry: { type: 'Point', coordinates: [0.001, 0.001] }
      };
      fs.writeFileSync(shard, `0\t${JSON.stringify(feature)}\n`);
      await withWorkerPool({ workers: 1, heapMb: 256 }, undefined, async (pool) => {
        const done = await pool.run({
          op: 'tile-shard',
          shard: {
            files: [shard],
            groups: [{ layer: 'X', minzoom: 2, maxzoom: 3 }],
            z: 2,
            x: 2,
            y: 1,
            extent: 4096,
            buffer: 64,
            gzip: false
          }
        });
        assert.ok(done.tiles > 0);
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('reports a failed task as a TaskFailedError', async () => {
    await withWorkerPool(1, undefined, async (pool) => {
      await assert.rejects(
        pool.run({
          op: 'gdal-translate',
          source: { path: path.join(os.tmpdir(), 'no-such-chart.kap') },
          dst: path.join(os.tmpdir(), 'no-such-chart.mbtiles'),
          args: ['-of', 'MBTiles']
        }),
        (err: unknown) => err instanceof TaskFailedError
      );
    });
  });
});
