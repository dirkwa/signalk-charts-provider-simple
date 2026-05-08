import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  cleanupQuarantineDir,
  makeQuarantineDir,
  promoteQuarantine,
  sweepStaleQuarantineDirs
} from '../dist/utils/quarantine.js';

describe('quarantine helpers', () => {
  let dataDir: string;
  let chartPath: string;

  before(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-quarantine-test-'));
    chartPath = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-charts-test-'));
  });

  after(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(chartPath, { recursive: true, force: true });
  });

  it('makeQuarantineDir creates <dataDir>/in-progress/<chartNumber>/', () => {
    const dir = makeQuarantineDir(dataDir, '42');
    assert.strictEqual(dir, path.join(dataDir, 'in-progress', '42'));
    assert.strictEqual(fs.existsSync(dir), true);
  });

  it('makeQuarantineDir is idempotent on existing dir', () => {
    const dir = makeQuarantineDir(dataDir, '42');
    fs.writeFileSync(path.join(dir, 'sentinel'), 'first call');
    const again = makeQuarantineDir(dataDir, '42');
    assert.strictEqual(dir, again);
    assert.strictEqual(fs.readFileSync(path.join(again, 'sentinel'), 'utf8'), 'first call');
  });

  it('makeQuarantineDir sanitizes weird chartNumbers (no path traversal)', () => {
    // A malicious or malformed chartNumber must not escape the quarantine root.
    const dir = makeQuarantineDir(dataDir, '../../../etc/passwd');
    assert.ok(dir.startsWith(path.join(dataDir, 'in-progress')));
    assert.ok(!dir.includes('..'));
  });

  it('promoteQuarantine moves named files to the target dir', async () => {
    const q = makeQuarantineDir(dataDir, 'promote-1');
    fs.writeFileSync(path.join(q, 'a.mbtiles'), 'aaa');
    fs.writeFileSync(path.join(q, 'b.mbtiles'), 'bbb');

    const subTarget = path.join(chartPath, 'sub');
    await promoteQuarantine(q, ['a.mbtiles', 'b.mbtiles'], subTarget);

    assert.strictEqual(fs.readFileSync(path.join(subTarget, 'a.mbtiles'), 'utf8'), 'aaa');
    assert.strictEqual(fs.readFileSync(path.join(subTarget, 'b.mbtiles'), 'utf8'), 'bbb');
    // Originals should be gone after the rename.
    assert.strictEqual(fs.existsSync(path.join(q, 'a.mbtiles')), false);
    assert.strictEqual(fs.existsSync(path.join(q, 'b.mbtiles')), false);
  });

  it('promoteQuarantine creates the target dir recursively', async () => {
    const q = makeQuarantineDir(dataDir, 'promote-2');
    fs.writeFileSync(path.join(q, 'x.mbtiles'), 'xxx');

    const deepTarget = path.join(chartPath, 'deep', 'a', 'b');
    assert.strictEqual(fs.existsSync(deepTarget), false);
    await promoteQuarantine(q, ['x.mbtiles'], deepTarget);
    assert.strictEqual(fs.readFileSync(path.join(deepTarget, 'x.mbtiles'), 'utf8'), 'xxx');
  });

  it('cleanupQuarantineDir removes the entire dir', () => {
    const q = makeQuarantineDir(dataDir, 'cleanup-1');
    fs.writeFileSync(path.join(q, 'leftover'), 'data');
    assert.strictEqual(fs.existsSync(q), true);
    cleanupQuarantineDir(q);
    assert.strictEqual(fs.existsSync(q), false);
  });

  it('cleanupQuarantineDir is a no-op when the dir is already gone', () => {
    const q = path.join(dataDir, 'in-progress', 'never-existed');
    // Must not throw.
    cleanupQuarantineDir(q);
    assert.strictEqual(fs.existsSync(q), false);
  });

  it('sweepStaleQuarantineDirs wipes every subdir under in-progress/', () => {
    // Use a fresh dataDir so prior test cases' leftover subdirs don't
    // get counted into this test's swept total.
    const sweepDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-quarantine-sweep-'));
    try {
      const a = makeQuarantineDir(sweepDir, 'stale-a');
      const b = makeQuarantineDir(sweepDir, 'stale-b');
      const c = makeQuarantineDir(sweepDir, 'stale-c');
      fs.writeFileSync(path.join(a, 'half-built.mbtiles'), 'aaa');
      fs.writeFileSync(path.join(b, 'half-built.mbtiles'), 'bbb');
      fs.writeFileSync(path.join(c, 'half-built.mbtiles'), 'ccc');

      const swept = sweepStaleQuarantineDirs(sweepDir);
      assert.strictEqual(swept, 3);
      assert.strictEqual(fs.existsSync(a), false);
      assert.strictEqual(fs.existsSync(b), false);
      assert.strictEqual(fs.existsSync(c), false);
      // Root in-progress/ dir itself is preserved (recreated lazily
      // by makeQuarantineDir on the next conversion).
      assert.strictEqual(fs.existsSync(path.join(sweepDir, 'in-progress')), true);
    } finally {
      fs.rmSync(sweepDir, { recursive: true, force: true });
    }
  });

  it('sweepStaleQuarantineDirs returns 0 when there is no in-progress root', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-quarantine-empty-'));
    try {
      assert.strictEqual(sweepStaleQuarantineDirs(empty), 0);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});
