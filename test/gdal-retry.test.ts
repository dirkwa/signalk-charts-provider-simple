import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { retryWhenLocked } from '../dist/utils/gdal-retry.js';

const LOCKED = 'sqlite3_exec(UPDATE partial_tiles SET zoom_level = -2) failed: database is locked';

describe('retryWhenLocked', () => {
  it('writes the file again, from scratch, once SQLite reports it locked', async () => {
    const dst = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gdal-retry-')), 'world.mbtiles');
    let calls = 0;
    const result = await retryWhenLocked(
      dst,
      () => {
        calls++;
        if (calls === 1) {
          fs.writeFileSync(dst, 'half written');
          throw new Error(LOCKED);
        }
        assert.strictEqual(fs.existsSync(dst), false, 'the half-written file is removed first');
        return 'done';
      },
      0
    );
    assert.strictEqual(result, 'done');
    assert.strictEqual(calls, 2);
  });

  it('gives up after one more try', async () => {
    let calls = 0;
    await assert.rejects(
      retryWhenLocked(
        path.join(os.tmpdir(), 'never-written.mbtiles'),
        () => {
          calls++;
          throw new Error(LOCKED);
        },
        0
      ),
      /database is locked/
    );
    assert.strictEqual(calls, 2);
  });

  it('fails at once on any other error', async () => {
    let calls = 0;
    await assert.rejects(
      retryWhenLocked(
        path.join(os.tmpdir(), 'never-written.mbtiles'),
        () => {
          calls++;
          throw new Error('Unable to open datasource');
        },
        0
      ),
      /Unable to open/
    );
    assert.strictEqual(calls, 1);
  });
});
