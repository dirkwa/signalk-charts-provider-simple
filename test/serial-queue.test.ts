import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { serialQueue } from '../dist/utils/serial-queue.js';
import { chartFileNamesBeside } from '../dist/utils/online-charts.js';
import { promoteQuarantine } from '../dist/utils/quarantine.js';

describe('serialQueue', () => {
  it('runs one step at a time, in order', async () => {
    const queue = serialQueue();
    const log: string[] = [];
    const step = (name: string, ms: number) => async () => {
      log.push(`start ${name}`);
      await new Promise((r) => setTimeout(r, ms));
      log.push(`end ${name}`);
      return name;
    };
    const results = await Promise.all([queue(step('a', 20)), queue(step('b', 0))]);
    assert.deepStrictEqual(results, ['a', 'b']);
    assert.deepStrictEqual(log, ['start a', 'end a', 'start b', 'end b']);
  });

  it('keeps going after a step fails', async () => {
    const queue = serialQueue();
    const failed = queue(() => Promise.reject(new Error('disk full')));
    const next = queue(() => Promise.resolve('ok'));
    await assert.rejects(failed, /disk full/);
    assert.strictEqual(await next, 'ok');
  });

  it('gives two downloads with the same chart id that finish together different ids', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'serial-queue-'));
    try {
      const target = path.join(root, 'charts');
      fs.mkdirSync(target);
      const stage = (job: string, fileName: string): [string, string] => {
        const dir = path.join(root, job);
        fs.mkdirSync(dir);
        fs.writeFileSync(path.join(dir, fileName), job);
        return [dir, fileName];
      };
      const promote =
        ([dir, fileName]: [string, string]) =>
        async () => {
          const names = chartFileNamesBeside([fileName], fs.readdirSync(target));
          const free = names[0] ?? fileName;
          if (free !== fileName) {
            fs.renameSync(path.join(dir, fileName), path.join(dir, free));
          }
          await promoteQuarantine(dir, names, target);
        };
      const queue = serialQueue();
      await Promise.all([
        queue(promote(stage('one', 'foo.pmtiles'))),
        queue(promote(stage('two', 'foo.mbtiles')))
      ]);
      assert.deepStrictEqual(fs.readdirSync(target).sort(), ['foo-2.mbtiles', 'foo.pmtiles']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
