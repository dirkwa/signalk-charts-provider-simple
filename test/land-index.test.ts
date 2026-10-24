import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { decodeRings } from '../dist/utils/land-geometry.js';
import { buildLandIndex, LandIndex, type LandSource } from '../dist/utils/land-index.js';
import {
  deleteLandIndex,
  getLandIndex,
  initLandIndex,
  landIndexBuildSettled,
  landIndexState,
  requestLandIndex
} from '../dist/utils/land-index-manager.js';
import { landZip, rect, type TestRing } from './land-fixtures.js';

// The simplified set has a 50 km island and a 500 m one; the full set has
// the first in two pieces, and a large polygon the build has to split.
const SIMPLIFIED: TestRing[][] = [[rect(0, 0, 50000, 50000)], [rect(90000, 0, 90500, 500)]];
const big: TestRing = [];
for (let i = 0; i < 5000; i++) {
  const a = (2 * Math.PI * i) / 5000;
  big.push([50000 + 1000 * Math.cos(a), 50000 + 1000 * Math.sin(a)]);
}
big.push(big[0]);
const FULL: TestRing[][] = [[rect(0, 0, 500, 1000)], [rect(500, 0, 1000, 1000)], [big]];

const ZIPS: Record<string, Buffer> = {
  '/simplified.zip': landZip('simplified-land-polygons-complete-3857', SIMPLIFIED),
  '/full.zip': landZip('land-polygons-split-3857', FULL)
};

describe('land index', () => {
  let tempDir: string;
  let server: http.Server;
  let base: string;
  let failFull = false;

  const sources = (): LandSource[] => [
    { set: 'simplified', url: `${base}/simplified.zip` },
    { set: 'full', url: `${base}/full.zip` }
  ];

  before(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'land-index-'));
    server = http.createServer((req, res) => {
      const zip = ZIPS[req.url ?? ''];
      if (!zip || (failFull && req.url === '/full.zip')) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'Content-Length': String(zip.length) });
      res.end(req.method === 'HEAD' ? undefined : zip);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });

  after(() => {
    server.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('builds from both sets and reads the set for the zoom', async () => {
    const file = path.join(tempDir, 'build.sqlite');
    const progress: number[] = [];
    const { version } = await buildLandIndex(file, {
      userAgent: 'test',
      sources: sources(),
      onProgress: (p) => progress.push(p.receivedBytes)
    });
    assert.ok(fs.existsSync(file));
    assert.ok(!fs.existsSync(`${file}.building`));
    assert.ok(progress.length > 0);

    const index = LandIndex.open(file);
    assert.ok(index);
    try {
      assert.strictEqual(index.version, version);
      const tile: [number, number, number, number] = [100, 100, 200, 200];
      assert.strictEqual(index.polygonsIn(tile, 9).length, 1, 'zoom 9 reads the simplified set');
      assert.strictEqual(index.polygonsIn(tile, 5).length, 1, 'zoom 5 reads the coarse set');
      assert.strictEqual(index.polygonsIn(tile, 2).length, 1, 'zoom 2 reads the world set');
      const islet: [number, number, number, number] = [90100, 100, 90200, 200];
      assert.strictEqual(index.polygonsIn(islet, 9).length, 1);
      assert.strictEqual(index.polygonsIn(islet, 5).length, 0, 'too small to show at zoom 5');
      assert.strictEqual(index.polygonsIn(tile, 10).length, 1, 'zoom 10 reads the full set');
      assert.strictEqual(index.polygonsIn([0, 0, 1000, 1000], 10).length, 2);
      assert.strictEqual(index.polygonsIn([5000, 5000, 6000, 6000], 12).length, 0);
      const split = index.polygonsIn([49000, 49000, 51000, 51000], 12);
      assert.ok(split.length > 1, 'the large polygon is stored in pieces');
      for (const piece of split) {
        assert.ok(decodeRings(piece).reduce((n, r) => n + r.length / 2, 0) <= 2048);
      }
    } finally {
      index.close();
    }
  });

  it('fails a download that stops sending', async () => {
    const file = path.join(tempDir, 'stalled.sqlite');
    const zip = ZIPS['/simplified.zip'];
    const stalled: typeof fetch = (_url, init) => {
      if (init?.method === 'HEAD') {
        return Promise.resolve(new Response(null, { headers: { 'content-length': '1' } }));
      }
      // Half the zip, then nothing, until the request is aborted.
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(zip.subarray(0, zip.length / 2));
          init?.signal?.addEventListener('abort', () => {
            controller.error(init.signal?.reason);
          });
        }
      });
      return Promise.resolve(new Response(body));
    };
    await assert.rejects(
      buildLandIndex(file, {
        userAgent: 'test',
        sources: [{ set: 'simplified', url: 'https://land/simplified.zip' }],
        fetch: stalled,
        stallTimeoutMs: 200
      }),
      /stalled/
    );
    assert.ok(!fs.existsSync(`${file}.building`));
  });

  it('leaves nothing behind when a download fails', async () => {
    const file = path.join(tempDir, 'failed.sqlite');
    failFull = true;
    try {
      await assert.rejects(buildLandIndex(file, { userAgent: 'test', sources: sources() }));
    } finally {
      failFull = false;
    }
    assert.deepStrictEqual(
      fs.readdirSync(tempDir).filter((f) => f.startsWith('failed')),
      []
    );
    assert.strictEqual(LandIndex.open(file), null);
  });

  const init = (dataDir: string, needed = true, onChange = (): void => undefined): void => {
    initLandIndex(dataDir, {
      userAgent: 'test',
      sources: sources(),
      onChange,
      needed: () => Promise.resolve(needed)
    });
  };
  const settle = async (): Promise<void> => {
    // A resumed build starts once `needed` has answered.
    await new Promise((r) => setTimeout(r, 50));
    await landIndexBuildSettled();
  };

  it('downloads only once asked, builds in a worker, and can be deleted', async () => {
    const dataDir = path.join(tempDir, 'plugin-data');
    let changes = 0;
    init(dataDir, true, () => changes++);
    await settle();
    assert.strictEqual(landIndexState().status, 'absent', 'nothing without consent');
    assert.strictEqual(landIndexState().requested, false);
    assert.strictEqual(getLandIndex(), null);

    await requestLandIndex();
    assert.strictEqual(landIndexState().status, 'building');
    await landIndexBuildSettled();
    const state = landIndexState();
    assert.strictEqual(state.status, 'ready', state.error);
    assert.ok((state.diskBytes ?? 0) > 0);
    assert.ok(getLandIndex());
    assert.strictEqual(changes, 1);
    assert.strictEqual(getLandIndex()?.polygonsIn([100, 100, 200, 200], 5).length, 1, 'coarse set');

    // A restart opens the built index without building again.
    init(dataDir);
    assert.strictEqual(landIndexState().status, 'ready');

    await deleteLandIndex();
    assert.strictEqual(landIndexState().status, 'absent');
    assert.strictEqual(landIndexState().requested, false);
    assert.deepStrictEqual(fs.readdirSync(path.join(dataDir, 'land-index')), []);
  });

  it('starts a build asked for while a cancel is finishing, and keeps its files', async () => {
    const dataDir = path.join(tempDir, 'plugin-data-race');
    init(dataDir);
    await requestLandIndex();
    const cancel = deleteLandIndex();
    const again = requestLandIndex();
    await cancel;
    await again;
    await landIndexBuildSettled();
    assert.strictEqual(landIndexState().status, 'ready');
    assert.strictEqual(landIndexState().requested, true);
    await deleteLandIndex();
  });

  it('cancels a running build, leaving nothing behind', async () => {
    const dataDir = path.join(tempDir, 'plugin-data-cancel');
    init(dataDir);
    await requestLandIndex();
    assert.strictEqual(landIndexState().status, 'building');
    await deleteLandIndex();
    await new Promise((r) => setTimeout(r, 100));
    assert.strictEqual(landIndexState().status, 'absent');
    assert.deepStrictEqual(fs.readdirSync(path.join(dataDir, 'land-index')), []);
  });

  it('does not download again by itself after a failure, but can be retried', async () => {
    const dataDir = path.join(tempDir, 'plugin-data-failed');
    init(dataDir);
    failFull = true;
    try {
      await requestLandIndex();
      await landIndexBuildSettled();
    } finally {
      failFull = false;
    }
    const failed = landIndexState();
    assert.strictEqual(failed.status, 'failed');
    assert.match(failed.error ?? '', /404/);
    assert.ok(failed.requested);
    await new Promise((r) => setTimeout(r, 100));
    assert.deepStrictEqual(fs.readdirSync(path.join(dataDir, 'land-index')), ['state.json']);

    // A restart leaves it failed: on a metered link a gigabyte is not fetched again unasked.
    init(path.join(tempDir, 'elsewhere'));
    init(dataDir);
    await settle();
    assert.strictEqual(landIndexState().status, 'failed');

    await requestLandIndex();
    await landIndexBuildSettled();
    assert.strictEqual(landIndexState().status, 'ready');
    await deleteLandIndex();
  });

  it('resumes a build cut short only while a masked version waits for it', async () => {
    const dataDir = path.join(tempDir, 'plugin-data-resume');
    fs.mkdirSync(path.join(dataDir, 'land-index'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'land-index', 'state.json'), '{"requested":true}');
    fs.writeFileSync(path.join(dataDir, 'land-index', 'land.sqlite.building'), 'partial');

    init(path.join(tempDir, 'elsewhere'));
    init(dataDir, false);
    await settle();
    assert.strictEqual(landIndexState().status, 'absent', 'no masked version: no download');
    assert.strictEqual(landIndexState().requested, false, 'adding one later asks again');
    assert.ok(!fs.existsSync(path.join(dataDir, 'land-index', 'land.sqlite.building')));
    fs.writeFileSync(path.join(dataDir, 'land-index', 'state.json'), '{"requested":true}');

    init(path.join(tempDir, 'elsewhere'));
    init(dataDir, true);
    await settle();
    assert.strictEqual(landIndexState().status, 'ready');
    await deleteLandIndex();
  });

  it('keeps a cut-short build for a later start while a download is not allowed', async () => {
    const dataDir = path.join(tempDir, 'plugin-data-metered');
    fs.mkdirSync(path.join(dataDir, 'land-index'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'land-index', 'state.json'), '{"requested":true}');
    const withResume = (mayResume: boolean): void => {
      initLandIndex(dataDir, {
        userAgent: 'test',
        sources: sources(),
        onChange: () => undefined,
        needed: () => Promise.resolve(true),
        mayResume: () => Promise.resolve(mayResume)
      });
    };

    init(path.join(tempDir, 'elsewhere'));
    withResume(false);
    await settle();
    assert.strictEqual(landIndexState().status, 'absent', 'nothing downloaded on a metered link');
    assert.strictEqual(landIndexState().requested, true, 'the request waits for a later start');

    init(path.join(tempDir, 'elsewhere'));
    withResume(true);
    await settle();
    assert.strictEqual(landIndexState().status, 'ready');
    await deleteLandIndex();
  });
});
