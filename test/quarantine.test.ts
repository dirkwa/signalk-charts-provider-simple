import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  cleanupQuarantineDir,
  makeQuarantineDir,
  makeUniqueQuarantineDir,
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

  it('promoteQuarantine rejects path-traversal filenames', async () => {
    const q = makeQuarantineDir(dataDir, 'reject-1');
    fs.writeFileSync(path.join(q, 'ok.mbtiles'), 'ok');

    await assert.rejects(
      promoteQuarantine(q, ['../escape.mbtiles'], chartPath),
      /Invalid promoted filename/
    );
    await assert.rejects(
      promoteQuarantine(q, ['nested/foo.mbtiles'], chartPath),
      /Invalid promoted filename/
    );
    await assert.rejects(
      promoteQuarantine(q, ['/abs/path.mbtiles'], chartPath),
      /Invalid promoted filename/
    );
    // Empty string also rejected.
    await assert.rejects(promoteQuarantine(q, [''], chartPath), /Invalid promoted filename/);
    // Source file is still there because the guard runs before any move.
    assert.strictEqual(fs.existsSync(path.join(q, 'ok.mbtiles')), true);
  });

  it('promoteQuarantine rolls back successfully-moved files when a later one fails', async () => {
    const q = makeQuarantineDir(dataDir, 'rollback-1');
    fs.writeFileSync(path.join(q, 'first.mbtiles'), 'A');
    fs.writeFileSync(path.join(q, 'second.mbtiles'), 'B');
    // 'missing.mbtiles' is referenced but doesn't exist — third move
    // will fail with ENOENT.

    const subTarget = path.join(chartPath, 'rollback-target');
    await assert.rejects(
      promoteQuarantine(q, ['first.mbtiles', 'second.mbtiles', 'missing.mbtiles'], subTarget)
    );

    // No partial chart set in the live target.
    assert.strictEqual(fs.existsSync(path.join(subTarget, 'first.mbtiles')), false);
    assert.strictEqual(fs.existsSync(path.join(subTarget, 'second.mbtiles')), false);
    // The quarantine still has the originals (rolled back).
    assert.strictEqual(fs.readFileSync(path.join(q, 'first.mbtiles'), 'utf8'), 'A');
    assert.strictEqual(fs.readFileSync(path.join(q, 'second.mbtiles'), 'utf8'), 'B');
  });

  it('promoteQuarantine overwrites a pre-existing live file on success and removes the backup', async () => {
    const q = makeQuarantineDir(dataDir, 'overwrite-1');
    fs.writeFileSync(path.join(q, 'chart.mbtiles'), 'NEW');

    const subTarget = path.join(chartPath, 'overwrite-target');
    fs.mkdirSync(subTarget, { recursive: true });
    fs.writeFileSync(path.join(subTarget, 'chart.mbtiles'), 'OLD');

    await promoteQuarantine(q, ['chart.mbtiles'], subTarget);

    assert.strictEqual(fs.readFileSync(path.join(subTarget, 'chart.mbtiles'), 'utf8'), 'NEW');
    // No backup left behind once the promotion succeeded.
    const leftover = fs.readdirSync(subTarget).filter((f) => f.includes('.replaced-'));
    assert.deepStrictEqual(leftover, []);
  });

  it('promoteQuarantine restores a pre-existing live file when a later promotion fails', async () => {
    const q = makeQuarantineDir(dataDir, 'restore-1');
    fs.writeFileSync(path.join(q, 'first.mbtiles'), 'NEW1');
    // 'second.mbtiles' missing → second move will fail with ENOENT,
    // triggering rollback after first.mbtiles has already overwritten
    // a pre-existing live file.

    const subTarget = path.join(chartPath, 'restore-target');
    fs.mkdirSync(subTarget, { recursive: true });
    fs.writeFileSync(path.join(subTarget, 'first.mbtiles'), 'OLD1');

    await assert.rejects(promoteQuarantine(q, ['first.mbtiles', 'second.mbtiles'], subTarget));

    // Pre-existing file restored from backup.
    assert.strictEqual(fs.readFileSync(path.join(subTarget, 'first.mbtiles'), 'utf8'), 'OLD1');
    // New file rolled back to quarantine.
    assert.strictEqual(fs.readFileSync(path.join(q, 'first.mbtiles'), 'utf8'), 'NEW1');
    // No leftover backup entries.
    const leftover = fs.readdirSync(subTarget).filter((f) => f.includes('.replaced-'));
    assert.deepStrictEqual(leftover, []);
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

  it('sweepStaleQuarantineDirs wipes stale subdirs from a previous process lifecycle', () => {
    // Use a fresh dataDir so prior test cases' leftover subdirs don't
    // get counted into this test's swept total. Stale dirs are created
    // directly on disk — that's what a previous server process leaves
    // behind (this process's active registry has never seen them).
    const sweepDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-quarantine-sweep-'));
    try {
      const a = path.join(sweepDir, 'in-progress', 'stale-a');
      const b = path.join(sweepDir, 'in-progress', 'stale-b');
      const c = path.join(sweepDir, 'in-progress', 'stale-c');
      for (const dir of [a, b, c]) {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'half-built.mbtiles'), 'stale');
      }

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

  it('sweepStaleQuarantineDirs skips dirs still active in this process (live downloads survive a plugin restart)', () => {
    const sweepDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-quarantine-active-'));
    try {
      // A previous-lifecycle leftover, unknown to the registry.
      const stale = path.join(sweepDir, 'in-progress', 'stale');
      fs.mkdirSync(stale, { recursive: true });
      // A live workspace created in this process — e.g. a download still
      // extracting when a config save re-ran start()'s sweep.
      const active = makeQuarantineDir(sweepDir, 'active-download');
      fs.writeFileSync(path.join(active, 'streaming.mbtiles'), 'live');

      const swept = sweepStaleQuarantineDirs(sweepDir);
      assert.strictEqual(swept, 1);
      assert.strictEqual(fs.existsSync(stale), false);
      assert.strictEqual(fs.existsSync(active), true);
      assert.strictEqual(fs.readFileSync(path.join(active, 'streaming.mbtiles'), 'utf8'), 'live');

      // Once the job is done and cleaned up, the same path is no longer
      // protected: a later recreation by a dead process would be swept.
      cleanupQuarantineDir(active);
      fs.mkdirSync(active, { recursive: true });
      assert.strictEqual(sweepStaleQuarantineDirs(sweepDir), 1);
      assert.strictEqual(fs.existsSync(active), false);
    } finally {
      fs.rmSync(sweepDir, { recursive: true, force: true });
    }
  });

  it('makeUniqueQuarantineDir returns a distinct dir per call for the same base name', () => {
    const a = makeUniqueQuarantineDir(dataDir, 'Kiribati');
    const b = makeUniqueQuarantineDir(dataDir, 'Kiribati');
    assert.notStrictEqual(a, b);
    for (const dir of [a, b]) {
      assert.ok(dir.startsWith(path.join(dataDir, 'in-progress') + path.sep));
      assert.ok(path.basename(dir).startsWith('Kiribati-'));
      assert.strictEqual(fs.existsSync(dir), true);
    }
  });

  it('makeUniqueQuarantineDir keeps the unique suffix on very long base names', () => {
    // sanitizeIdSegment caps segments at 64 chars; the suffix must survive.
    const longBase = 'x'.repeat(200);
    const a = makeUniqueQuarantineDir(dataDir, longBase);
    const b = makeUniqueQuarantineDir(dataDir, longBase);
    assert.notStrictEqual(a, b);
    assert.ok(path.basename(a).length <= 64);
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
