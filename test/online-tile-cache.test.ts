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
