/**
 * findCharts opens a sqlite handle per chart, and every caller owns closing
 * them. cleanupChartDirectory did not: it rescans the directory (deliberately,
 * so charts added during startup are seen) and dropped the resulting handles
 * on the floor.
 *
 * On Linux that is an invisible fd leak — an unlinked file with an open handle
 * simply disappears when the handle closes. On Windows an open handle LOCKS
 * the file, so the leak surfaced as CI failures in the Windows matrix legs:
 *
 *   EBUSY: resource busy or locked, unlink '…\charts\test-chart.mbtiles'
 *
 * thrown from the test teardown that removes the temp chart directory, and
 * equally from cleanupChartDirectory's own unlink of an invalid chart.
 *
 * This test pins the contract at the loader boundary — where the handles are
 * created — by counting the process's open .mbtiles descriptors. That is
 * Linux-only (it reads /proc/self/fd), which is fine: the assertion is about
 * the handle being released, and the platform that punishes not releasing it
 * is the one we cannot easily count on.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { findCharts } from '../dist/charts-loader.js';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, '..', 'test', 'fixtures');

/** Open file descriptors pointing at a .mbtiles file, for this process. */
function openMbtilesHandles(): number {
  const dir = `/proc/${process.pid}/fd`;
  let count = 0;
  for (const fd of fs.readdirSync(dir)) {
    try {
      if (fs.readlinkSync(path.join(dir, fd)).includes('.mbtiles')) {
        count++;
      }
    } catch {
      // The descriptor closed between readdir and readlink.
    }
  }
  return count;
}

const canCountFds = process.platform === 'linux' && fs.existsSync('/proc/self/fd');

describe('chart handle lifecycle', { skip: !canCountFds && 'needs /proc/self/fd' }, () => {
  it('opens one handle per chart, and closing releases every one', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'handle-leak-'));
    const chartPath = path.join(tempDir, 'charts');
    fs.mkdirSync(chartPath, { recursive: true });
    for (const name of ['a.mbtiles', 'b.mbtiles']) {
      fs.copyFileSync(path.join(FIXTURES, 'test-chart.mbtiles'), path.join(chartPath, name));
    }

    const before = openMbtilesHandles();
    return findCharts(chartPath)
      .then((charts) => {
        const providers = Object.values(charts);
        assert.equal(providers.length, 2, 'both fixtures should load');

        // The leak itself: without an explicit close these stay open, and on
        // Windows keep both files locked.
        assert.equal(
          openMbtilesHandles() - before,
          providers.length,
          'findCharts should hold one handle per chart'
        );

        for (const provider of providers) {
          provider._mbtilesHandle?.close();
        }
        assert.equal(
          openMbtilesHandles(),
          before,
          'closing every handle must return the process to its starting count'
        );
      })
      .finally(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
      });
  });

  // findCharts opens handles as it walks and rejects on an unreadable
  // directory (deliberately — callers must tell a failed scan from an empty
  // one). An unreadable SUBdirectory throws after earlier charts already hold
  // handles, and those never reach a caller, so nothing else can close them.
  it('releases the handles it already opened when the walk throws', async (t) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'handle-throw-'));
    const chartPath = path.join(tempDir, 'charts');
    fs.mkdirSync(chartPath, { recursive: true });
    for (const name of ['a.mbtiles', 'b.mbtiles']) {
      fs.copyFileSync(path.join(FIXTURES, 'test-chart.mbtiles'), path.join(chartPath, name));
    }
    // The unreadable directory lives one level DOWN, so the charts above it
    // are opened before the recursion reaches it whatever order readdir
    // returns — fs.readdir does not sort, so a name that merely sorts last is
    // not a guarantee.
    const subDir = path.join(chartPath, 'nested');
    fs.mkdirSync(subDir);
    const unreadable = path.join(subDir, 'unreadable');
    fs.mkdirSync(unreadable);
    fs.chmodSync(unreadable, 0o000);

    // chmod does not stop root, and CI images often run as root. Skip rather
    // than assert a rejection that cannot happen — a test that quietly checks
    // nothing is worse than one that says it did not run.
    let blocked = false;
    try {
      fs.readdirSync(unreadable);
    } catch {
      blocked = true;
    }
    if (!blocked) {
      fs.chmodSync(unreadable, 0o755);
      fs.rmSync(tempDir, { recursive: true, force: true });
      t.skip('chmod does not restrict this user (running as root)');
      return;
    }

    const before = openMbtilesHandles();
    try {
      await assert.rejects(
        () => findCharts(chartPath),
        'an unreadable directory must still reject'
      );
      assert.equal(
        openMbtilesHandles(),
        before,
        'a walk that threw must not leave chart handles open'
      );
    } finally {
      fs.chmodSync(unreadable, 0o755);
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
  // Two folders can hold the same .mbtiles basename (zip extraction
  // disambiguates on import; a hand-assembled directory need not), which
  // yields the same identifier. The loser drops out of the returned map, so
  // nothing downstream can ever close its handle.
  it('closes the handle of a provider displaced by an identifier collision', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'handle-dup-'));
    const chartPath = path.join(tempDir, 'charts');
    for (const folder of ['folderA', 'folderB']) {
      fs.mkdirSync(path.join(chartPath, folder), { recursive: true });
      fs.copyFileSync(
        path.join(FIXTURES, 'test-chart.mbtiles'),
        path.join(chartPath, folder, 'same.mbtiles')
      );
    }

    const before = openMbtilesHandles();
    try {
      const charts = await findCharts(chartPath);
      const providers = Object.values(charts);
      assert.equal(providers.length, 1, 'the collision leaves one provider');

      // One handle per RETURNED provider: the displaced one is already closed.
      assert.equal(
        openMbtilesHandles() - before,
        providers.length,
        'the displaced provider must not keep its handle open'
      );

      for (const provider of providers) {
        provider._mbtilesHandle?.close();
      }
      assert.equal(openMbtilesHandles(), before, 'closing the survivor releases the rest');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
  // open() constructs the reader (opening the sqlite handle), then calls
  // getInfo() as a validity probe. A file that is valid sqlite but not valid
  // mbtiles makes that probe throw, and open() used to reject WITHOUT closing
  // the reader it had just built — leaking a handle to a caller that never
  // received the reader and so could never close it. On Windows that locks the
  // very file the cleanup sweep goes on to unlink as invalid.
  it('releases the handle when the validity probe rejects', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'handle-probe-'));
    const chartPath = path.join(tempDir, 'charts');
    fs.mkdirSync(chartPath, { recursive: true });

    const broken = path.join(chartPath, 'no-metadata.mbtiles');
    const db = new DatabaseSync(broken);
    // A tiles table but no metadata table: opens fine, getInfo() throws.
    db.exec('CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_data BLOB)');
    db.close();

    const before = openMbtilesHandles();
    try {
      const charts = await findCharts(chartPath);
      assert.equal(Object.keys(charts).length, 0, 'the unloadable chart is skipped');
      assert.equal(
        openMbtilesHandles(),
        before,
        'a chart that failed to load must not keep its handle open'
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
