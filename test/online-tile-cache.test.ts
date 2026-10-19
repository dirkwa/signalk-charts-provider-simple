import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { OnlineCatalogChart } from '../dist/catalog/merged-catalog-schema.js';
import {
  OnlineTileProxy,
  OnlineTileStore,
  TILE_REFRESH_MS,
  allowsAreaDownload,
  areaDownloadLimits,
  httpTileFetcher,
  needsTileProxy,
  offlineTileSource,
  tileBbox3857,
  tileImageType,
  upstreamTileUrl,
  type OnlineTileSource
} from '../dist/utils/online-tile-cache.js';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const PNG2 = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9]);

function entry(overrides: Partial<OnlineCatalogChart> = {}): OnlineCatalogChart {
  return {
    id: 'depths',
    name: 'Depths',
    description: 'Depths',
    category: 'navigation',
    bbox: [-180, -85, 180, 85],
    provider: 'Test',
    license: 'Public domain',
    licenseUrl: 'https://example.com/license',
    chart: { type: 'WMS', url: 'https://example.com/ows', layers: ['a', 'b'] },
    ...overrides
  };
}

describe('offlineTileSource', () => {
  it('keeps nothing unless the entry allows offline copies', () => {
    assert.strictEqual(offlineTileSource(entry()), null);
  });

  it('proxies WMS layers and tile layers', () => {
    assert.deepStrictEqual(offlineTileSource(entry({ offline: {} })), {
      kind: 'wms',
      url: 'https://example.com/ows',
      layers: ['a', 'b']
    });
    const tiles = entry({
      chart: { type: 'tilelayer', url: 'https://example.com/{z}/{x}/{y}.png' },
      offline: {}
    });
    assert.deepStrictEqual(offlineTileSource(tiles), {
      kind: 'xyz',
      url: 'https://example.com/{z}/{x}/{y}.png'
    });
  });

  it('uses the tileUrl for a WMTS chart and keeps nothing without one', () => {
    const wmts = entry({ chart: { type: 'WMTS', url: 'https://example.com/wmts', layers: ['x'] } });
    assert.strictEqual(offlineTileSource({ ...wmts, offline: {} }), null);
    assert.deepStrictEqual(
      offlineTileSource({ ...wmts, offline: { tileUrl: 'https://example.com/t/{z-2}/{y}/{x}' } }),
      { kind: 'xyz', url: 'https://example.com/t/{z-2}/{y}/{x}' }
    );
  });

  it('never keeps time-varying charts or a malformed offline block', () => {
    const radar = entry({
      offline: {},
      temporal: { kind: 'observation', refreshInterval: 300000 }
    });
    assert.strictEqual(offlineTileSource(radar), null);
    assert.strictEqual(offlineTileSource(entry({ offline: { tileUrl: 'http://x/{z}' } })), null);
    assert.strictEqual(offlineTileSource(entry({ offline: true })), null);
  });

  it('streams a chart whose published offline template the plugin cannot fill', () => {
    const subdomains = entry({
      chart: { type: 'tilelayer', url: 'https://{s}.example.com/{z}/{x}/{y}.png' },
      offline: {}
    });
    assert.strictEqual(offlineTileSource(subdomains), null);
    assert.strictEqual(
      offlineTileSource(entry({ offline: { tileUrl: 'https://{s}.example.com/{z}/{x}/{y}' } })),
      null
    );
  });
});

describe('allowsAreaDownload', () => {
  const tiles = (offline: unknown) =>
    entry({ chart: { type: 'tilelayer', url: 'https://example.com/{z}/{y}/{x}.jpg' }, offline });

  it('allows area downloads of a chart kept offline unless its entry says otherwise', () => {
    assert.strictEqual(allowsAreaDownload(tiles({})), true);
    assert.strictEqual(allowsAreaDownload(tiles({ areaDownload: true })), true);
    assert.strictEqual(allowsAreaDownload(tiles({ areaDownload: false })), false);
  });

  it('still keeps the viewed tiles of a chart that downloads no areas', () => {
    assert.deepStrictEqual(offlineTileSource(tiles({ areaDownload: false })), {
      kind: 'xyz',
      url: 'https://example.com/{z}/{y}/{x}.jpg'
    });
  });

  it('allows no area downloads of a chart that is not kept offline', () => {
    assert.strictEqual(allowsAreaDownload(entry()), false);
    assert.strictEqual(allowsAreaDownload(tiles({ areaDownload: 'no' })), false);
  });

  it("reads the provider's limits on area downloads", () => {
    const limits = { maxTiles: 5000, requestsPerSecond: 2 };
    assert.deepStrictEqual(areaDownloadLimits(tiles({ areaDownloadLimits: limits })), limits);
    assert.deepStrictEqual(areaDownloadLimits(tiles({})), {});
    assert.deepStrictEqual(areaDownloadLimits(entry()), {});
  });

  it('keeps the tiles but downloads no areas when it cannot read the limits', () => {
    const unreadable = tiles({ areaDownloadLimits: { requestsPerSecond: 'slowly' } });
    assert.notStrictEqual(offlineTileSource(unreadable), null);
    assert.strictEqual(allowsAreaDownload(unreadable), false);
    assert.deepStrictEqual(areaDownloadLimits(unreadable), {});
  });
});

describe('upstreamTileUrl', () => {
  it('fills an XYZ template, including TMS rows and shifted levels', () => {
    const xyz: OnlineTileSource = { kind: 'xyz', url: 'https://t/{z}/{x}/{y}/{-y}/{z-2}' };
    assert.strictEqual(upstreamTileUrl(xyz, 3, 5, 1), 'https://t/3/5/1/6/1');
  });

  it('fills a single-image request with the tile extent', () => {
    const box: OnlineTileSource = { kind: 'xyz', url: 'https://w/map?a={bbox}&b={bbox_3857}' };
    const url = new URL(upstreamTileUrl(box, 1, 1, 0) ?? '');
    assert.deepStrictEqual(
      url.searchParams
        .get('a')
        ?.split(',')
        .map((n) => Math.round(Number(n))),
      [0, 0, 180, 85]
    );
    assert.deepStrictEqual(
      url.searchParams
        .get('b')
        ?.split(',')
        .map((n) => Math.round(Number(n))),
      [0, 0, 20037508, 20037508]
    );
  });

  it('knows which templates a chart plotter cannot fill in', () => {
    assert.strictEqual(needsTileProxy('https://t/{z}/{x}/{y}.png'), false);
    for (const url of ['https://t/{z}/{x}/{-y}', 'https://t/{z-2}/{y}/{x}', 'https://w?b={bbox}']) {
      assert.strictEqual(needsTileProxy(url), true, url);
    }
  });

  it('has no tile below a shifted first level', () => {
    const noaa: OnlineTileSource = { kind: 'xyz', url: 'https://t/{z-2}/{y}/{x}' };
    assert.strictEqual(upstreamTileUrl(noaa, 1, 0, 0), null);
    assert.strictEqual(upstreamTileUrl(noaa, 2, 1, 3), 'https://t/0/3/1');
  });

  it('asks a WMS for one 256 px EPSG:3857 tile', () => {
    const wms: OnlineTileSource = { kind: 'wms', url: 'https://w/ows?map=x', layers: ['a', 'b'] };
    const url = new URL(upstreamTileUrl(wms, 0, 0, 0) ?? '');
    assert.strictEqual(url.searchParams.get('map'), 'x');
    assert.strictEqual(url.searchParams.get('REQUEST'), 'GetMap');
    assert.strictEqual(url.searchParams.get('LAYERS'), 'a,b');
    assert.strictEqual(url.searchParams.get('SRS'), 'EPSG:3857');
    assert.strictEqual(url.searchParams.get('WIDTH'), '256');
    assert.deepStrictEqual(
      url.searchParams
        .get('BBOX')
        ?.split(',')
        .map((n) => Math.round(Number(n))),
      [-20037508, -20037508, 20037508, 20037508]
    );
  });

  it('places tiles north-west first', () => {
    const [minX, minY, maxX, maxY] = tileBbox3857(1, 0, 0);
    assert.ok(minX < 0 && maxX === 0 && minY === 0 && maxY > 0);
  });
});

describe('httpTileFetcher', () => {
  it('refuses an answer far too large to be a tile', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = () =>
      Promise.resolve(
        new Response(PNG, { headers: { 'content-length': String(50 * 1024 * 1024) } })
      );
    try {
      assert.strictEqual(await httpTileFetcher('test')('https://t/0/0/0'), null);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('stops reading an answer with no length once it is too large to be a tile', async () => {
    const original = globalThis.fetch;
    let sent = 0;
    const chunk = new Uint8Array(1024 * 1024);
    globalThis.fetch = () =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              sent++;
              controller.enqueue(sent === 1 ? PNG : chunk);
            }
          })
        )
      );
    try {
      assert.strictEqual(await httpTileFetcher('test')('https://t/0/0/0'), null);
      assert.ok(sent < 20, `read ${String(sent)} chunks`);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('reads a tile sent without a length', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = () =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(PNG.slice(0, 4));
              controller.enqueue(PNG.slice(4));
              controller.close();
            }
          })
        )
      );
    try {
      const data = await httpTileFetcher('test')('https://t/0/0/0');
      assert.ok(data instanceof Uint8Array);
      assert.deepStrictEqual([...data], [...PNG]);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('tileImageType', () => {
  it('recognises PNG, JPEG and WebP and nothing else', () => {
    assert.strictEqual(tileImageType(PNG), 'image/png');
    assert.strictEqual(tileImageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
    const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]);
    assert.strictEqual(tileImageType(webp), 'image/webp');
    assert.strictEqual(tileImageType(Buffer.from('<?xml version="1.0"?><ServiceException')), null);
  });
});

describe('OnlineTileStore and OnlineTileProxy', () => {
  const source: OnlineTileSource = { kind: 'xyz', url: 'https://t/{z}/{x}/{y}' };
  let dir: string;
  let store: OnlineTileStore;
  let now: number;
  let fetched: string[];
  let answer: Uint8Array | null;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'online-tiles-'));
    store = new OnlineTileStore(dir);
    now = 1_000_000;
    fetched = [];
    answer = PNG;
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function proxy(): OnlineTileProxy {
    return new OnlineTileProxy(
      store,
      (url) => {
        fetched.push(url);
        return Promise.resolve(answer);
      },
      () => now
    );
  }

  it('keeps a fetched tile as a valid MBTiles row in TMS order', async () => {
    const data = await proxy().getTile('depths', source, 2, 1, 0);
    assert.deepStrictEqual(data && [...data], [...PNG]);
    store.close();
    const db = new DatabaseSync(path.join(dir, 'depths.mbtiles'), { readOnly: true });
    const row = db.prepare('SELECT zoom_level, tile_column, tile_row FROM tiles').get() as Record<
      string,
      number
    >;
    db.close();
    assert.deepStrictEqual({ ...row }, { zoom_level: 2, tile_column: 1, tile_row: 3 });
  });

  it('serves a kept tile without asking the provider again', async () => {
    const p = proxy();
    await p.getTile('depths', source, 2, 1, 0);
    answer = PNG2;
    const data = await p.getTile('depths', source, 2, 1, 0);
    assert.deepStrictEqual(data && [...data], [...PNG]);
    assert.strictEqual(fetched.length, 1);
  });

  it('serves an old tile at once and refreshes it behind, keeping it when the provider is unreachable', async () => {
    const p = proxy();
    await p.getTile('depths', source, 2, 1, 0);
    now += TILE_REFRESH_MS + 1;
    answer = null;
    const stale = await p.getTile('depths', source, 2, 1, 0);
    assert.deepStrictEqual(stale && [...stale], [...PNG]);
    await new Promise((r) => setImmediate(r));
    answer = PNG2;
    const stillStale = await p.getTile('depths', source, 2, 1, 0);
    assert.deepStrictEqual(stillStale && [...stillStale], [...PNG]);
    await new Promise((r) => setImmediate(r));
    const fresh = await p.getTile('depths', source, 2, 1, 0);
    assert.deepStrictEqual(fresh && [...fresh], [...PNG2]);
    assert.strictEqual(fetched.length, 3);
  });

  it('serves an old tile without waiting for a provider that hangs', async () => {
    await proxy().getTile('depths', source, 2, 1, 0);
    now += TILE_REFRESH_MS + 1;
    const hanging = new OnlineTileProxy(
      store,
      () => new Promise(() => undefined),
      () => now
    );
    const stale = await hanging.getTile('depths', source, 2, 1, 0);
    assert.deepStrictEqual(stale && [...stale], [...PNG]);
  });

  it('fetches from the provider when the kept file is damaged', async () => {
    store.close();
    store = new OnlineTileStore(dir);
    fs.writeFileSync(path.join(dir, 'depths.mbtiles'), 'not a database');
    const data = await proxy().getTile('depths', source, 2, 1, 0);
    assert.deepStrictEqual(data && [...data], [...PNG]);
  });

  it('moves a damaged file aside and keeps tiles in a new one', async () => {
    store.close();
    store = new OnlineTileStore(dir);
    const file = path.join(dir, 'depths.mbtiles');
    fs.writeFileSync(file, 'not a database');
    await proxy().getTile('depths', source, 2, 1, 0);
    assert.strictEqual(fs.readFileSync(`${file}.damaged`, 'utf8'), 'not a database');
    await proxy().getTile('depths', source, 2, 1, 0);
    answer = null;
    const kept = await proxy().getTile('depths', source, 2, 1, 0);
    assert.deepStrictEqual(kept && [...kept], [...PNG]);
  });

  it('serves an old tile when the fetcher itself throws', async () => {
    await proxy().getTile('depths', source, 2, 1, 0);
    now += TILE_REFRESH_MS + 1;
    const throwing = new OnlineTileProxy(
      store,
      () => Promise.reject(new Error('socket hang up')),
      () => now
    );
    const stale = await throwing.getTile('depths', source, 2, 1, 0);
    assert.deepStrictEqual(stale && [...stale], [...PNG]);
  });

  it('has nothing for a tile it never kept while offline', async () => {
    answer = null;
    assert.strictEqual(await proxy().getTile('depths', source, 2, 1, 0), null);
  });

  it('never names a file after a catalog id that is not a plain slug', () => {
    assert.throws(() => store.get('../escape', 0, 0, 0), /Invalid catalog id/);
  });

  it('asks for no tile outside the zoom pyramid', async () => {
    assert.strictEqual(await proxy().getTile('depths', source, 2, 4, 0), null);
    assert.strictEqual(await proxy().getTile('depths', source, 30, 0, 0), null);
    assert.strictEqual(fetched.length, 0);
  });

  it('passes a tile through without keeping it', async () => {
    const data = await proxy().streamTile(source, 2, 1, 0);
    assert.deepStrictEqual(data && [...data], [...PNG]);
    assert.strictEqual(fs.existsSync(path.join(dir, 'depths.mbtiles')), false);
  });

  it('asks the provider once for a streamed tile requested twice at once', async () => {
    const p = proxy();
    await Promise.all([p.streamTile(source, 2, 1, 0), p.streamTile(source, 2, 1, 0)]);
    assert.strictEqual(fetched.length, 1);
  });

  it('opens no file for a request that arrives after the plugin stopped', async () => {
    const p = proxy();
    store.close();
    await p.getTile('depths', source, 2, 1, 0);
    assert.strictEqual(fs.existsSync(path.join(dir, 'depths.mbtiles')), false);
  });

  it('asks the provider once for concurrent requests of the same tile', async () => {
    const p = proxy();
    await Promise.all([p.getTile('depths', source, 3, 2, 1), p.getTile('depths', source, 3, 2, 1)]);
    assert.strictEqual(fetched.length, 1);
  });

  it('keeps a fetch under way when a chart is forgotten from writing its tile back', async () => {
    const releases: ((data: Uint8Array) => void)[] = [];
    const proxy = new OnlineTileProxy(
      store,
      () =>
        new Promise((resolve) => {
          releases.push(resolve);
        })
    );
    const before = proxy.getTile('depths', source, 5, 2, 2);
    proxy.forget('depths');
    const after = proxy.getTile('depths', source, 5, 2, 2);
    assert.strictEqual(releases.length, 2);
    releases[0]?.(PNG);
    assert.ok(await before);
    assert.strictEqual(store.get('depths', 5, 2, 2), null);
    releases[1]?.(PNG2);
    assert.ok(await after);
    assert.deepStrictEqual(new Uint8Array(store.get('depths', 5, 2, 2)?.data ?? []), PNG2);
  });
});

describe('OnlineTileStore limit', () => {
  let dir: string;
  let store: OnlineTileStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'online-limit-'));
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** A tile big enough to fill its own pages, so freeing it frees space. */
  function tile(seed: number): Uint8Array {
    const data = new Uint8Array(20_000).fill(seed);
    data.set(PNG.subarray(0, 8));
    return data;
  }

  it('removes the tiles kept longest, across charts, until the cache fits', () => {
    store = new OnlineTileStore(dir);
    for (let i = 0; i < 20; i++) {
      store.put(i % 2 ? 'depths' : 'harbours', 10, i, 0, tile(i), 1000 + i);
    }
    const before = store.totalBytes();
    store.setLimit(Math.floor(before / 2));
    store.evict();
    assert.ok(store.totalBytes() <= before / 2);
    // The oldest are gone from both charts and the newest kept.
    assert.strictEqual(store.get('harbours', 10, 0, 0), null);
    assert.strictEqual(store.get('depths', 10, 1, 0), null);
    assert.ok(store.get('depths', 10, 19, 0));
    assert.ok(store.get('harbours', 10, 18, 0));
    // Not far below the limit either: about half the tiles stay.
    const left = Array.from({ length: 20 }, (_, i) =>
      store.get(i % 2 ? 'depths' : 'harbours', 10, i, 0)
    ).filter(Boolean).length;
    assert.ok(left >= 7 && left <= 10, `${String(left)} tiles left`);
  });

  it('never removes the tiles of an area download, even when browsing refreshes them', () => {
    store = new OnlineTileStore(dir);
    store.put('depths', 10, 0, 0, tile(1), 1000, true);
    store.put('depths', 10, 1, 0, tile(2), 1001);
    store.pin('depths', 10, 1, 0);
    store.put('depths', 10, 1, 0, tile(3), 5000);
    store.put('depths', 10, 2, 0, tile(4), 2000);
    store.setLimit(1);
    assert.strictEqual(store.evict(), false);
    assert.ok(store.get('depths', 10, 0, 0));
    assert.ok(store.get('depths', 10, 1, 0));
    assert.strictEqual(store.get('depths', 10, 2, 0), null);
  });

  it('keeps everything without a limit', () => {
    store = new OnlineTileStore(dir);
    store.put('depths', 10, 0, 0, tile(1), 1000);
    store.evict();
    assert.ok(store.get('depths', 10, 0, 0));
  });

  it('enforces the limit on its own as tiles are kept', async () => {
    store = new OnlineTileStore(dir, 200_000);
    for (let i = 0; i < 30; i++) {
      store.put('depths', 10, i, 0, tile(i), 1000 + i);
    }
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.ok(store.totalBytes() <= 200_000);
    assert.ok(store.get('depths', 10, 29, 0));
  });

  /** What the chart's tile files take on disk, write-ahead log included. */
  function diskBytes(catalogId: string): number {
    return ['', '-wal'].reduce((sum, suffix) => {
      const file = path.join(dir, `${catalogId}.mbtiles${suffix}`);
      return sum + (fs.existsSync(file) ? fs.statSync(file).size : 0);
    }, 0);
  }

  it('gives the space of removed tiles back to the disk', () => {
    store = new OnlineTileStore(dir);
    for (let i = 0; i < 20; i++) {
      store.put('depths', 10, i, 0, tile(i), 1000 + i);
    }
    store.setLimit(Math.floor(store.totalBytes() / 4));
    store.evict();
    assert.ok(diskBytes('depths') <= store.totalBytes() * 1.5, String(diskBytes('depths')));
  });

  it('gives space back a bounded amount per turn across all charts', () => {
    store = new OnlineTileStore(dir);
    // Each chart frees fewer pages than one turn allows, together more.
    for (let i = 0; i < 150; i++) {
      store.put('depths', 10, i, 0, tile(i), 1000 + i);
      store.put('wrecks', 10, i, 0, tile(i), 1000 + i);
    }
    store.setLimit(1);
    assert.strictEqual(store.evict(), true);
    assert.strictEqual(store.evict(), false);
    assert.ok(diskBytes('depths') + diskBytes('wrecks') < 200_000);
  });

  it('adds the pinned column to a file kept before it existed', () => {
    fs.mkdirSync(dir, { recursive: true });
    const old = new DatabaseSync(path.join(dir, 'depths.mbtiles'));
    old.exec(`CREATE TABLE tiles (zoom_level INTEGER NOT NULL, tile_column INTEGER NOT NULL,
      tile_row INTEGER NOT NULL, tile_data BLOB NOT NULL, fetched_at INTEGER,
      PRIMARY KEY (zoom_level, tile_column, tile_row))`);
    old.prepare('INSERT INTO tiles VALUES (10, 0, 1023, ?, 1000)').run(tile(1));
    old.close();
    store = new OnlineTileStore(dir);
    store.pin('depths', 10, 0, 0);
    store.setLimit(1);
    store.evict();
    assert.ok(store.get('depths', 10, 0, 0));
  });
});

describe('OnlineTileProxy for area downloads', () => {
  let dir: string;
  let store: OnlineTileStore;
  const source: OnlineTileSource = { kind: 'xyz', url: 'https://t/{z}/{x}/{y}' };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'online-pin-'));
    store = new OnlineTileStore(dir);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('pins what it fetches and what was already kept by browsing', async () => {
    const proxy = new OnlineTileProxy(
      store,
      () => Promise.resolve(PNG),
      () => 1000
    );
    await proxy.getTile('depths', source, 5, 1, 1);
    assert.strictEqual(await proxy.ensureTile('depths', source, 5, 1, 1), 'kept');
    assert.strictEqual(await proxy.ensureTile('depths', source, 5, 2, 2), 'fetched');
    await proxy.getTile('depths', source, 5, 3, 3);
    store.setLimit(1);
    store.evict();
    assert.ok(store.get('depths', 5, 1, 1));
    assert.ok(store.get('depths', 5, 2, 2));
    assert.strictEqual(store.get('depths', 5, 3, 3), null);
  });

  it('pins an old kept tile of the area even when its refresh fails', async () => {
    let now = 1000;
    let answer: Uint8Array | null = PNG;
    const proxy = new OnlineTileProxy(
      store,
      () => Promise.resolve(answer),
      () => now
    );
    await proxy.getTile('depths', source, 5, 1, 1);
    now += TILE_REFRESH_MS + 1;
    answer = null;
    assert.strictEqual(await proxy.ensureTile('depths', source, 5, 1, 1), 'failed');
    store.setLimit(1);
    store.evict();
    assert.ok(store.get('depths', 5, 1, 1));
  });

  it('tells whether any tile is kept for a chart', () => {
    assert.strictEqual(store.hasTiles('depths'), false);
    assert.strictEqual(store.hasTiles('../x'), false);
    store.put('depths', 1, 0, 0, PNG, 1000);
    assert.strictEqual(store.hasTiles('depths'), true);
    store.clear('depths');
    assert.strictEqual(store.hasTiles('depths'), false);
  });

  it('leaves out a tile file that cannot be read, in either order', () => {
    for (const broken of ['aaa', 'zzz']) {
      const healthy = broken === 'aaa' ? 'zzz' : 'aaa';
      store.put('aaa', 10, 0, 0, new Uint8Array(20_000).fill(1), 1000);
      store.put('zzz', 10, 0, 0, new Uint8Array(20_000).fill(1), 1000);
      const oneChart = Math.ceil(store.totalBytes() / 2);
      const other = new DatabaseSync(path.join(dir, `${broken}.mbtiles`));
      other.exec('DROP TABLE tiles');
      other.close();
      // The healthy chart fits on its own, so only the unreadable file's
      // bytes could push it out.
      store.setLimit(oneChart);
      store.evict();
      assert.ok(store.get(healthy, 10, 0, 0));
      store.put(healthy, 11, 0, 0, new Uint8Array(20_000).fill(2), 2000);
      store.setLimit(oneChart);
      store.evict();
      assert.strictEqual(store.get(healthy, 10, 0, 0), null);
      store.clear('aaa');
      store.clear('zzz');
    }
  });

  it('keeps the limit for the other charts when one tile file is damaged', () => {
    store.put('depths', 10, 0, 0, new Uint8Array(20_000).fill(1), 1000);
    fs.writeFileSync(path.join(dir, 'broken.mbtiles'), 'not a database');
    store.setLimit(1);
    store.evict();
    assert.strictEqual(store.get('depths', 10, 0, 0), null);
  });
});
