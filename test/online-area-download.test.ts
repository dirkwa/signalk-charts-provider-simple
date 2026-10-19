import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  AreaDownloadError,
  AreaDownloader,
  MAX_AREA_TILES,
  areaTiles,
  countAreaTiles,
  type AreaBbox,
  type AreaDownloadJob
} from '../dist/utils/online-area-download.js';
import {
  OnlineTileProxy,
  OnlineTileStore,
  type OnlineTileSource,
  type TileFetcher
} from '../dist/utils/online-tile-cache.js';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
const SOURCE: OnlineTileSource = { kind: 'xyz', url: 'https://t/{z}/{x}/{y}' };
const FIJI: AreaBbox = [177.2, -18.2, 178.6, -17.2];

describe('area tiles', () => {
  it('counts exactly the tiles it lists', () => {
    const listed = [...areaTiles(FIJI, 5, 11)];
    assert.strictEqual(listed.length, countAreaTiles(FIJI, 5, 11));
    assert.strictEqual(new Set(listed.map((t) => t.join('/'))).size, listed.length);
  });

  it('lists lower zoom levels first', () => {
    const zooms = [...areaTiles(FIJI, 3, 6)].map(([z]) => z);
    assert.deepStrictEqual(
      zooms,
      [...zooms].sort((a, b) => a - b)
    );
  });

  it('is the whole world at zoom 0', () => {
    assert.deepStrictEqual([...areaTiles([-180, -85, 180, 85], 0, 0)], [[0, 0, 0]]);
  });

  it('splits an area that crosses the antimeridian at 180°', () => {
    const tiles = [...areaTiles([179, -18, -179, -17], 4, 4)];
    assert.deepStrictEqual(
      tiles.map(([, x]) => x),
      [15, 0]
    );
  });

  it('lists each tile once when the two halves of a crossing area meet', () => {
    const bbox: AreaBbox = [179, -18, -179, -17];
    const tiles = [...areaTiles(bbox, 0, 1)];
    assert.strictEqual(new Set(tiles.map((t) => t.join('/'))).size, tiles.length);
    assert.strictEqual(tiles.length, countAreaTiles(bbox, 0, 1));
    assert.strictEqual(tiles.filter(([z]) => z === 0).length, 1);
  });
});

describe('AreaDownloader', () => {
  let dir: string | null = null;
  let store: OnlineTileStore | null = null;

  afterEach(() => {
    store?.close();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function setup(fetchTile: TileFetcher): AreaDownloader {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'area-'));
    store = new OnlineTileStore(dir);
    return new AreaDownloader(new OnlineTileProxy(store, fetchTile), 2);
  }

  async function finished(downloader: AreaDownloader, id: string): Promise<AreaDownloadJob> {
    for (let i = 0; i < 500; i++) {
      const job = downloader.get(id);
      if (job && job.status !== 'running') {
        return job;
      }
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error('download did not finish');
  }

  const request = { chartId: 'depths', catalogId: 'depths', source: SOURCE, bbox: FIJI };

  it('fetches every tile once and skips the ones already kept', async () => {
    const fetched: string[] = [];
    const downloader = setup((url) => {
      fetched.push(url);
      return Promise.resolve(PNG);
    });
    const first = await finished(
      downloader,
      downloader.start({ ...request, minzoom: 6, maxzoom: 9 }).id
    );
    assert.strictEqual(first.status, 'completed');
    assert.strictEqual(first.done, first.total);
    assert.strictEqual(first.fetched, first.total);
    assert.strictEqual(fetched.length, first.total);
    assert.strictEqual(store?.stats('depths').tiles, first.total);

    const again = await finished(
      downloader,
      downloader.start({ ...request, minzoom: 6, maxzoom: 9 }).id
    );
    assert.strictEqual(again.fetched, 0);
    assert.strictEqual(fetched.length, first.total);
  });

  it('gives up when the provider stops answering', async () => {
    const downloader = setup(() => Promise.resolve(null));
    const job = await finished(
      downloader,
      downloader.start({ ...request, minzoom: 8, maxzoom: 12 }).id
    );
    assert.strictEqual(job.status, 'failed');
    assert.match(job.error ?? '', /stopped answering/);
    assert.ok(job.done < job.total);
  });

  it('counts tiles the provider has none of as done, not failed', async () => {
    const downloader = setup(() => Promise.resolve('absent'));
    const job = await finished(
      downloader,
      downloader.start({ ...request, minzoom: 8, maxzoom: 12 }).id
    );
    assert.strictEqual(job.status, 'completed');
    assert.strictEqual(job.failed, 0);
    assert.strictEqual(job.done, job.total);
  });

  it('reports a failure only once every tile in flight has ended', async () => {
    // One worker fails fast while the other is still waiting on a slow answer.
    let slow: ((data: Uint8Array | null) => void) | null = null;
    let calls = 0;
    const downloader = setup(() => {
      calls++;
      if (calls === 1) {
        return new Promise((resolve) => {
          slow = resolve;
        });
      }
      return Promise.resolve(null);
    });
    const { id } = downloader.start({ ...request, minzoom: 8, maxzoom: 12 });
    for (let i = 0; i < 200 && calls < 26; i++) {
      await new Promise((r) => setTimeout(r, 1));
    }
    assert.strictEqual(downloader.get(id)?.status, 'running');
    (slow as ((data: Uint8Array | null) => void) | null)?.(PNG);
    const job = await finished(downloader, id);
    assert.strictEqual(job.status, 'failed');
  });

  it('stops when cancelled', async () => {
    const downloader = setup(() => new Promise((resolve) => setTimeout(() => resolve(PNG), 5)));
    const { id } = downloader.start({ ...request, minzoom: 8, maxzoom: 12 });
    assert.ok(downloader.cancel(id));
    const job = await finished(downloader, id);
    assert.strictEqual(job.status, 'cancelled');
    assert.ok(job.done < job.total);
  });

  it("stops a chart's downloads and waits until their last tile is written", async () => {
    let inFlight = 0;
    let written = 0;
    const downloader = setup(async () => {
      inFlight++;
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      written++;
      return PNG;
    });
    const { id } = downloader.start({ ...request, minzoom: 8, maxzoom: 12 });
    await new Promise((r) => setTimeout(r, 12));
    await downloader.stop('depths');
    assert.strictEqual(inFlight, 0);
    assert.strictEqual(downloader.get(id)?.status, 'cancelled');
    const after = written;
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(written, after);
  });

  it('refuses areas too large, inverted zoom ranges and a second download of one chart', () => {
    const downloader = setup(() => new Promise(() => {}));
    assert.throws(
      () => downloader.start({ ...request, bbox: [-180, -85, 180, 85], minzoom: 0, maxzoom: 10 }),
      (err: unknown) => err instanceof AreaDownloadError && /tiles/.test(err.message)
    );
    assert.ok(countAreaTiles([-180, -85, 180, 85], 0, 10) > MAX_AREA_TILES);
    assert.throws(
      () => downloader.start({ ...request, minzoom: 9, maxzoom: 8 }),
      AreaDownloadError
    );
    downloader.start({ ...request, minzoom: 6, maxzoom: 6 });
    assert.throws(
      () => downloader.start({ ...request, minzoom: 6, maxzoom: 6 }),
      /already downloading/
    );
    downloader.cancelAll();
  });

  it("holds to the provider's pace, one request at a time", async () => {
    let inFlight = 0;
    let most = 0;
    const downloader = setup(async () => {
      inFlight++;
      most = Math.max(most, inFlight);
      await Promise.resolve();
      inFlight--;
      return PNG;
    });
    const started = Date.now();
    const { id } = downloader.start({
      ...request,
      minzoom: 6,
      maxzoom: 8,
      limits: { requestsPerSecond: 100 }
    });
    const job = await finished(downloader, id);
    assert.strictEqual(job.status, 'completed');
    assert.strictEqual(most, 1);
    // Timers may fire a little early, so allow some slack per request.
    assert.ok(
      Date.now() - started >= (job.fetched - 1) * 5,
      `took ${String(Date.now() - started)} ms`
    );

    // Tiles already kept cost the provider nothing and need no wait.
    const againStarted = Date.now();
    const again = await finished(
      downloader,
      downloader.start({ ...request, minzoom: 6, maxzoom: 8, limits: { requestsPerSecond: 1 } }).id
    );
    assert.strictEqual(again.fetched, 0);
    assert.ok(Date.now() - againStarted < 1000);
  });

  it('paces a provider once, however many charts use it, and stops mid-pause', async () => {
    const downloader = setup(() => Promise.resolve(PNG));
    const limits = { requestsPerSecond: 0.2 };
    const { id } = downloader.start({ ...request, minzoom: 6, maxzoom: 8, limits });
    assert.throws(
      () => downloader.start({ ...request, chartId: 'depths-2', minzoom: 6, maxzoom: 8, limits }),
      /already downloading/
    );
    // Let the first request go out, so the worker is in its five-second pause.
    await new Promise((r) => setTimeout(r, 50));
    const stopping = Date.now();
    await downloader.stop('depths');
    assert.ok(Date.now() - stopping < 1000, `took ${String(Date.now() - stopping)} ms`);
    assert.strictEqual(downloader.get(id)?.status, 'cancelled');
  });

  it("refuses an area larger than the provider's limit", () => {
    const downloader = setup(() => new Promise(() => {}));
    const total = countAreaTiles(FIJI, 6, 9);
    assert.throws(
      () =>
        downloader.start({ ...request, minzoom: 6, maxzoom: 9, limits: { maxTiles: total - 1 } }),
      (err: unknown) =>
        err instanceof AreaDownloadError && err.message.includes(`at most ${String(total - 1)}`)
    );
    downloader.start({ ...request, minzoom: 6, maxzoom: 9, limits: { maxTiles: total } });
    downloader.cancelAll();
  });

  it('counts levels a service does not offer as done, not failed', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'area-'));
    store = new OnlineTileStore(dir);
    const downloader = new AreaDownloader(
      new OnlineTileProxy(store, () => Promise.resolve(PNG)),
      2
    );
    const { id } = downloader.start({
      ...request,
      source: { kind: 'xyz', url: 'https://t/{z-2}/{y}/{x}' },
      minzoom: 0,
      maxzoom: 3
    });
    const job = await finished(downloader, id);
    assert.strictEqual(job.status, 'completed');
    assert.strictEqual(job.failed, 0);
    assert.strictEqual(job.fetched, countAreaTiles(FIJI, 2, 3));
  });
});

describe('OnlineTileStore.clear', () => {
  it('drops every kept tile of a chart', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clear-'));
    const store = new OnlineTileStore(dir);
    store.put('depths', 1, 0, 0, PNG, 1);
    assert.strictEqual(store.stats('depths').tiles, 1);
    store.clear('depths');
    assert.deepStrictEqual(store.stats('depths'), { tiles: 0, bytes: 0 });
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
