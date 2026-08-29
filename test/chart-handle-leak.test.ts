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
});
