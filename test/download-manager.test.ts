/**
 * Tests for the download manager's transient-failure retry behaviour.
 * A small local HTTP server stands in for a flaky chart source.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

import { downloadManager } from '../dist/utils/download-manager.js';
import type { DownloadJob } from '../dist/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TMP = path.join(__dirname, 'fixtures', 'download-test');

// A controllable origin: `behaviour` decides the response per request and
// records how many times it was hit.
interface Origin {
  url: string;
  hits: () => number;
  close: () => Promise<void>;
}

function startOrigin(handler: (hit: number, res: http.ServerResponse) => void): Promise<Origin> {
  let hits = 0;
  const server = http.createServer((_req, res) => {
    hits += 1;
    handler(hits, res);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}/chart.bin`,
        hits: () => hits,
        close: () =>
          new Promise<void>((r) => {
            server.close(() => r());
          })
      });
    });
  });
}

// Resolve when the given job reaches a terminal state (completed / failed /
// cancelled). A cancelled job is emitted via job-cancelled by cancelJob().
function waitForTerminal(jobId: string): Promise<DownloadJob> {
  return new Promise((resolve) => {
    const check = (job: DownloadJob): void => {
      if (job.id !== jobId) {
        return;
      }
      if (job.status === 'completed' || job.status === 'failed') {
        downloadManager.removeListener('job-completed', check);
        downloadManager.removeListener('job-failed', check);
        downloadManager.removeListener('job-cancelled', check);
        resolve(job);
      }
    };
    downloadManager.on('job-completed', check);
    downloadManager.on('job-failed', check);
    downloadManager.on('job-cancelled', check);
  });
}

// Build a minimal STORED (uncompressed) ZIP in memory so the zip tests
// need no archiver dependency: local file headers + central directory +
// end-of-central-directory, method 0 throughout.
function storedZip(entries: { name: string; data: Buffer }[]): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = zlib.crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 8); // method: stored
    local.writeUInt16LE(0x21, 12); // mod date (any valid DOS date)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); // compressed size
    local.writeUInt32LE(data.length, 22); // uncompressed size
    local.writeUInt16LE(nameBuf.length, 26);
    chunks.push(local, nameBuf, data);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); // central directory signature
    cen.writeUInt16LE(20, 4); // version made by
    cen.writeUInt16LE(20, 6); // version needed
    cen.writeUInt16LE(0, 10); // method: stored
    cen.writeUInt16LE(0x21, 14); // mod date
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(data.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(offset, 42); // local header offset
    central.push(cen, nameBuf);

    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // EOCD signature
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cd, eocd]);
}

describe('DownloadManager zip extraction', () => {
  before(() => {
    fs.mkdirSync(TMP, { recursive: true });
  });

  beforeEach(() => {
    downloadManager.removeAllListeners();
  });

  after(() => {
    downloadManager.removeAllListeners();
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  it('extracts every .mbtiles entry from a multi-chart ZIP and skips the rest', async () => {
    const zip = storedZip([
      { name: 'Kiribati/Gilbert Islands GoogleSat.mbtiles', data: Buffer.from('SAT-DATA') },
      { name: 'Kiribati/readme.txt', data: Buffer.from('not a chart') },
      { name: 'Kiribati/Gilbert Islands ArcGis.mbtiles', data: Buffer.from('ARC-DATA') }
    ]);
    const origin = await startOrigin((_hit, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/zip');
      res.end(zip);
    });

    const dir = fs.mkdtempSync(path.join(TMP, 'zip-multi-'));
    try {
      const jobId = downloadManager.createJob(origin.url, dir, 'Kiribati');
      const job = await waitForTerminal(jobId);

      assert.strictEqual(job.status, 'completed', `expected completed, got ${job.error ?? ''}`);
      assert.deepStrictEqual([...job.extractedFiles].sort(), [
        'Gilbert Islands ArcGis.mbtiles',
        'Gilbert Islands GoogleSat.mbtiles'
      ]);
      assert.strictEqual(
        fs.readFileSync(path.join(dir, 'Gilbert Islands GoogleSat.mbtiles'), 'utf8'),
        'SAT-DATA'
      );
      assert.strictEqual(
        fs.readFileSync(path.join(dir, 'Gilbert Islands ArcGis.mbtiles'), 'utf8'),
        'ARC-DATA'
      );
      assert.strictEqual(fs.existsSync(path.join(dir, 'readme.txt')), false);
    } finally {
      await origin.close();
    }
  });

  it('uniquifies duplicate basenames across archive folders instead of clobbering', async () => {
    const zip = storedZip([
      { name: 'region-a/chart.mbtiles', data: Buffer.from('AAA') },
      { name: 'region-b/chart.mbtiles', data: Buffer.from('BBB') }
    ]);
    const origin = await startOrigin((_hit, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/zip');
      res.end(zip);
    });

    const dir = fs.mkdtempSync(path.join(TMP, 'zip-dup-'));
    try {
      const jobId = downloadManager.createJob(origin.url, dir, 'dup');
      const job = await waitForTerminal(jobId);

      assert.strictEqual(job.status, 'completed', `expected completed, got ${job.error ?? ''}`);
      assert.deepStrictEqual([...job.extractedFiles].sort(), ['chart-2.mbtiles', 'chart.mbtiles']);
      assert.strictEqual(fs.readFileSync(path.join(dir, 'chart.mbtiles'), 'utf8'), 'AAA');
      assert.strictEqual(fs.readFileSync(path.join(dir, 'chart-2.mbtiles'), 'utf8'), 'BBB');
    } finally {
      await origin.close();
    }
  });

  it('follows a relative redirect Location', async () => {
    const origin = await startOrigin((hit, res) => {
      if (hit === 1) {
        res.statusCode = 302;
        res.setHeader('location', '/moved/chart.bin');
        res.end();
        return;
      }
      res.statusCode = 200;
      res.setHeader('content-type', 'application/octet-stream');
      res.end('CHARTDATA');
    });

    const dir = fs.mkdtempSync(path.join(TMP, 'relredir-'));
    try {
      const jobId = downloadManager.createJob(origin.url, dir, 'relredir', { saveRaw: true });
      const job = await waitForTerminal(jobId);

      assert.strictEqual(job.status, 'completed', `expected completed, got ${job.error ?? ''}`);
      assert.strictEqual(origin.hits(), 2);
      assert.strictEqual(fs.readFileSync(path.join(dir, 'relredir.bin'), 'utf8'), 'CHARTDATA');
    } finally {
      await origin.close();
    }
  });

  it(
    'fails cleanly when the target dir vanishes mid-extraction (no unhandled rejection, no hang)',
    { timeout: 20000 },
    async () => {
      // Regression: the quarantine dir being rm -rf'd under a running
      // extraction used to (a) leak the write-stream ENOENTs as
      // process-level unhandled rejections and (b) stall the zip parser
      // (pipe() unpipes on destination error), so the job never reached a
      // terminal state.
      const zip = storedZip([
        { name: 'a.mbtiles', data: Buffer.from('AAA') },
        { name: 'b.mbtiles', data: Buffer.from('BBB') }
      ]);
      const origin = await startOrigin((_hit, res) => {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/zip');
        res.end(zip);
      });

      const vanishedDir = path.join(TMP, 'vanished-quarantine'); // never created
      let unhandled = 0;
      const onUnhandled = (): void => {
        unhandled += 1;
      };
      process.on('unhandledRejection', onUnhandled);
      try {
        const jobId = downloadManager.createJob(origin.url, vanishedDir, 'Kiribati');
        const job = await waitForTerminal(jobId);

        assert.strictEqual(job.status, 'failed');
        assert.match(job.error ?? '', /ENOENT/);
        // A failed write must not be counted as an extracted file (the
        // write stream's 'close' fires even after 'error').
        assert.deepStrictEqual(job.extractedFiles, []);
        // Give any stray unhandled rejection a beat to surface.
        await new Promise((r) => setTimeout(r, 100));
        assert.strictEqual(unhandled, 0, 'write failures must not leak as unhandled rejections');
      } finally {
        process.removeListener('unhandledRejection', onUnhandled);
        await origin.close();
      }
    }
  );
});

// Origin that honors HTTP Range requests over a fixed body. `perHit`
// returns how many bytes of the (range-adjusted) response to send before
// hard-destroying the socket — or null to send everything cleanly. Set
// `ignoreRange` to emulate a server without Range support (always 200,
// always the full body).
interface ResumableOrigin extends Origin {
  ranges: () => (string | undefined)[];
}

function startResumableOrigin(
  body: Buffer,
  perHit: (hit: number) => number | null,
  opts: { ignoreRange?: boolean; failWith?: (hit: number) => number | null } = {}
): Promise<ResumableOrigin> {
  let hits = 0;
  const ranges: (string | undefined)[] = [];
  const server = http.createServer((req, res) => {
    hits += 1;
    ranges.push(req.headers.range);

    const failStatus = opts.failWith?.(hits) ?? null;
    if (failStatus !== null) {
      res.statusCode = failStatus;
      res.end('nope');
      return;
    }

    const m = /^bytes=(\d+)-$/.exec(req.headers.range ?? '');
    const start = !opts.ignoreRange && m ? parseInt(m[1], 10) : 0;
    const slice = body.subarray(start);
    if (start > 0) {
      res.statusCode = 206;
      res.setHeader('content-range', `bytes ${start}-${body.length - 1}/${body.length}`);
    } else {
      res.statusCode = 200;
    }
    res.setHeader('content-type', 'application/octet-stream');
    res.setHeader('content-length', slice.length);

    const n = perHit(hits);
    if (n === null || n >= slice.length) {
      res.end(slice);
      return;
    }
    res.write(slice.subarray(0, n));
    // Give the chunk a beat to flush, then cut the connection hard.
    setTimeout(() => {
      res.destroy();
    }, 50);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}/chart.bin`,
        hits: () => hits,
        ranges: () => ranges,
        close: () =>
          new Promise<void>((r) => {
            server.close(() => {
              r();
            });
          })
      });
    });
  });
}

describe('DownloadManager resume', () => {
  before(() => {
    fs.mkdirSync(TMP, { recursive: true });
  });

  beforeEach(() => {
    downloadManager.removeAllListeners();
  });

  after(() => {
    downloadManager.removeAllListeners();
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  const body = Buffer.alloc(8192);
  for (let i = 0; i < body.length; i++) {
    body[i] = i % 251;
  }

  it('resumes from the interrupted offset with a Range request', async () => {
    // First attempt is cut after ~3000 bytes; the retry must ask for the
    // remainder (Range) and the final file must be byte-identical.
    const origin = await startResumableOrigin(body, (hit) => (hit === 1 ? 3000 : null));
    const dir = fs.mkdtempSync(path.join(TMP, 'resume-'));
    try {
      const jobId = downloadManager.createJob(origin.url, dir, 'resume-test', { saveRaw: true });
      const job = await waitForTerminal(jobId);

      assert.strictEqual(job.status, 'completed', `expected completed, got ${job.error ?? ''}`);
      assert.strictEqual(origin.hits(), 2);
      const secondRange = origin.ranges()[1];
      const offsetMatch = /^bytes=(\d+)-$/.exec(secondRange ?? '');
      assert.ok(
        offsetMatch,
        `second request must carry a Range header, got ${String(secondRange)}`
      );
      const offset = parseInt(offsetMatch[1], 10);
      assert.ok(
        offset > 0 && offset <= 3000,
        `resume offset must be within the first attempt's delivered bytes, got ${String(offset)}`
      );
      const written = fs.readFileSync(path.join(dir, 'resume-test.bin'));
      assert.ok(written.equals(body), 'resumed file must be byte-identical to the source');
      // No .part leftovers after success.
      assert.deepStrictEqual(
        fs.readdirSync(dir).filter((f) => f.endsWith('.part')),
        []
      );
    } finally {
      await origin.close();
    }
  });

  it('rewrites from scratch when the server ignores Range', async () => {
    const origin = await startResumableOrigin(body, (hit) => (hit === 1 ? 3000 : null), {
      ignoreRange: true
    });
    const dir = fs.mkdtempSync(path.join(TMP, 'norange-'));
    try {
      const jobId = downloadManager.createJob(origin.url, dir, 'norange-test', { saveRaw: true });
      const job = await waitForTerminal(jobId);

      assert.strictEqual(job.status, 'completed', `expected completed, got ${job.error ?? ''}`);
      const written = fs.readFileSync(path.join(dir, 'norange-test.bin'));
      assert.strictEqual(written.length, body.length, 'body must not be duplicated/appended');
      assert.ok(written.equals(body));
    } finally {
      await origin.close();
    }
  });

  it(
    'keeps retrying through stalls as long as bytes advance (budget rearms on progress)',
    { timeout: 30000 },
    async () => {
      // Four consecutive cut connections — more than MAX_DOWNLOAD_ATTEMPTS —
      // but every attempt delivers ~2000 new bytes, so the job must still
      // complete on the fifth request.
      const origin = await startResumableOrigin(body, (hit) => (hit <= 4 ? 2000 : null));
      const dir = fs.mkdtempSync(path.join(TMP, 'stalls-'));
      try {
        const jobId = downloadManager.createJob(origin.url, dir, 'stalls-test', {
          saveRaw: true
        });
        const job = await waitForTerminal(jobId);

        assert.strictEqual(job.status, 'completed', `expected completed, got ${job.error ?? ''}`);
        assert.strictEqual(origin.hits(), 5, 'should have taken 5 requests (4 stalls + 1 final)');
        // Every retry must resume at a strictly higher offset — this fails
        // if retries throw away partial data and re-download from zero.
        const offsets = origin.ranges().map((r, i) => {
          if (i === 0) {
            return 0;
          }
          const m = /^bytes=(\d+)-$/.exec(r ?? '');
          assert.ok(m, `request ${String(i + 1)} must carry a Range header, got ${String(r)}`);
          return parseInt(m[1], 10);
        });
        for (let i = 1; i < offsets.length; i++) {
          assert.ok(
            offsets[i] > offsets[i - 1],
            `resume offsets must strictly increase, got ${offsets.join(', ')}`
          );
        }
        const written = fs.readFileSync(path.join(dir, 'stalls-test.bin'));
        assert.ok(written.equals(body));
      } finally {
        await origin.close();
      }
    }
  );

  it('fails fast when the resume request gets a 4xx (expired link) and drops the part file', async () => {
    const origin = await startResumableOrigin(body, (hit) => (hit === 1 ? 2500 : null), {
      failWith: (hit) => (hit >= 2 ? 403 : null)
    });
    const dir = fs.mkdtempSync(path.join(TMP, 'expired-'));
    try {
      const jobId = downloadManager.createJob(origin.url, dir, 'expired-test', { saveRaw: true });
      const job = await waitForTerminal(jobId);

      assert.strictEqual(job.status, 'failed');
      assert.match(job.error ?? '', /403/);
      assert.strictEqual(origin.hits(), 2, 'a 4xx on resume must not be retried');
      assert.ok(
        /^bytes=\d+-$/.test(origin.ranges()[1] ?? ''),
        'the second request must have been a resume attempt'
      );
      assert.deepStrictEqual(
        fs.readdirSync(dir).filter((f) => f.endsWith('.part')),
        [],
        'part file must be cleaned up on final failure'
      );
    } finally {
      await origin.close();
    }
  });
});

describe('DownloadManager retry', () => {
  before(() => {
    fs.mkdirSync(TMP, { recursive: true });
  });

  beforeEach(() => {
    downloadManager.removeAllListeners();
  });

  after(() => {
    downloadManager.removeAllListeners();
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  it('retries a transient 5xx and then succeeds', async () => {
    // Fail with 503 twice, then serve the file on the 3rd attempt.
    const origin = await startOrigin((hit, res) => {
      if (hit < 3) {
        res.statusCode = 503;
        res.end('busy');
        return;
      }
      res.statusCode = 200;
      res.setHeader('content-type', 'application/octet-stream');
      res.end('CHARTDATA');
    });

    try {
      const jobId = downloadManager.createJob(origin.url, TMP, 'retry-5xx', { saveRaw: true });
      const terminal = waitForTerminal(jobId);
      const job = await terminal;

      assert.strictEqual(job.status, 'completed', `expected completed, got ${job.status}`);
      assert.strictEqual(origin.hits(), 3, 'should have taken exactly 3 attempts');
    } finally {
      await origin.close();
    }
  });

  it('clears file lists between retries so they cannot accumulate (issue: dup filenames)', async () => {
    // downloadAndExtract pushes onto targetFiles/extractedFiles as files (raw)
    // or zip entries arrive. If a partially-streamed attempt fails transiently
    // and retries without clearing those lists, the names accumulate. Simulate
    // a prior partial attempt by pre-seeding the lists, then drive a 503→200
    // retry; the successful attempt must leave exactly one clean entry, not the
    // stale one(s) plus the new push.
    const origin = await startOrigin((hit, res) => {
      if (hit === 1) {
        res.statusCode = 503;
        res.end('busy');
        return;
      }
      res.statusCode = 200;
      res.setHeader('content-type', 'application/octet-stream');
      res.end('CHARTDATA');
    });

    try {
      const jobId = downloadManager.createJob(origin.url, TMP, 'clears-lists', { saveRaw: true });
      const job = downloadManager.getJob(jobId);
      assert.ok(job);
      // Stand in for a prior partial attempt's leftovers.
      job.targetFiles.push('stale-from-prior-attempt.bin');
      job.extractedFiles.push('stale-from-prior-attempt.bin');

      const finished = await waitForTerminal(jobId);
      assert.strictEqual(
        finished.status,
        'completed',
        `expected completed, got ${finished.status}`
      );
      assert.strictEqual(origin.hits(), 2, 'should have retried once after the 503');
      assert.ok(
        !finished.targetFiles.includes('stale-from-prior-attempt.bin'),
        `stale entry survived the retry: ${JSON.stringify(finished.targetFiles)}`
      );
      assert.ok(
        !finished.extractedFiles.includes('stale-from-prior-attempt.bin'),
        `stale extracted entry survived the retry: ${JSON.stringify(finished.extractedFiles)}`
      );
    } finally {
      await origin.close();
    }
  });

  it('fails fast on 404 without retrying', async () => {
    const origin = await startOrigin((_hit, res) => {
      res.statusCode = 404;
      res.end('gone');
    });

    try {
      const jobId = downloadManager.createJob(origin.url, TMP, 'no-retry-404', { saveRaw: true });
      const job = await waitForTerminal(jobId);

      assert.strictEqual(job.status, 'failed', 'a 404 must fail the job');
      assert.match(job.error ?? '', /404/);
      assert.strictEqual(origin.hits(), 1, 'a 404 must NOT be retried');
    } finally {
      await origin.close();
    }
  });

  it('gives up after the max attempts on a persistent 5xx', async () => {
    const origin = await startOrigin((_hit, res) => {
      res.statusCode = 500;
      res.end('always down');
    });

    try {
      const jobId = downloadManager.createJob(origin.url, TMP, 'persistent-5xx', { saveRaw: true });
      const job = await waitForTerminal(jobId);

      assert.strictEqual(job.status, 'failed');
      assert.match(job.error ?? '', /500/);
      assert.strictEqual(origin.hits(), 3, 'should stop after MAX_DOWNLOAD_ATTEMPTS (3)');
    } finally {
      await origin.close();
    }
  });

  it('does not retry (or complete) a job cancelled during backoff', async () => {
    // First attempt 503 (→ enters backoff); cancel during the backoff window.
    // The retry must NOT run a second attempt, and the job must stay cancelled
    // — never overwritten by a later completion.
    let secondAttempt = false;
    // Resolve the moment the first attempt actually reaches the origin, so we
    // cancel based on a real signal rather than a wall-clock guess (flaky CI).
    let signalFirstHit: () => void = () => {};
    const firstHit = new Promise<void>((resolve) => {
      signalFirstHit = resolve;
    });
    const origin = await startOrigin((hit, res) => {
      if (hit === 1) {
        signalFirstHit();
        res.statusCode = 503;
        res.end('busy');
        return;
      }
      secondAttempt = true; // would only fire if a retry wrongly proceeded
      res.statusCode = 200;
      res.setHeader('content-type', 'application/octet-stream');
      res.end('CHARTDATA');
    });

    try {
      const jobId = downloadManager.createJob(origin.url, TMP, 'cancel-in-backoff', {
        saveRaw: true
      });
      // Wait for the first attempt to land (deterministic), then cancel while
      // the loop is in its ~2s backoff before the second attempt.
      await firstHit;
      const result = downloadManager.cancelJob(jobId);
      assert.strictEqual(result.success, true, 'cancel should succeed mid-flight');

      // Wait past the full backoff window so a (wrongly) resumed retry would
      // have hit the origin and possibly completed the job by now.
      await new Promise((r) => setTimeout(r, 3000));

      const job = downloadManager.getJob(jobId);
      assert.ok(job);
      assert.strictEqual(job.status, 'failed');
      assert.strictEqual(job.error, 'Cancelled by user', 'cancellation must not be overwritten');
      assert.strictEqual(secondAttempt, false, 'must not start a retry after cancel');
      assert.strictEqual(origin.hits(), 1, 'only the first (pre-cancel) attempt should hit');
    } finally {
      await origin.close();
    }
  });
});
