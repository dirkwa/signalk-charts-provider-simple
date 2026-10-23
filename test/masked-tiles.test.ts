/**
 * Masked chart versions served from the proxy's kept tiles: masked once,
 * kept stamped with the source tile, and failing open for "Water only".
 * The land index here is one rectangle of land covering the left half of
 * tile 2/0/0.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';

import { buildLandIndex, LandIndex } from '../dist/utils/land-index.js';
import { MaskedTiles, maskedCacheText } from '../dist/utils/masked-tiles.js';
import {
  OnlineTileProxy,
  OnlineTileStore,
  tileBbox3857,
  TILE_REFRESH_MS,
  type OnlineTileSource
} from '../dist/utils/online-tile-cache.js';
import { RasterTileCache } from '../dist/utils/raster-tile-cache.js';
import { landZip, rect } from './land-fixtures.js';

const SIZE = 256;
const [minX, minY, maxX, maxY] = tileBbox3857(2, 0, 0);
const midX = (minX + maxX) / 2;

function solidJpeg(): Buffer {
  const data = Buffer.alloc(SIZE * SIZE * 4, 200);
  return Buffer.from(jpeg.encode({ data, width: SIZE, height: SIZE }, 90).data);
}

function alphaAt(png: Buffer, px: number, py: number): number {
  const img = PNG.sync.read(png);
  return img.data[(py * img.width + px) * 4 + 3];
}

describe('masked chart tiles', () => {
  let tempDir: string;
  let index: LandIndex;
  let store: OnlineTileStore;
  let cache: RasterTileCache;
  let now = 1_000_000;
  let upstream: Uint8Array | 'absent' = solidJpeg();
  let fetches = 0;
  const source: OnlineTileSource = { kind: 'xyz', url: 'https://t/{z}/{x}/{y}' };
  let tiles: MaskedTiles;
  let proxy: OnlineTileProxy;

  before(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'masked-tiles-'));
    const zip = landZip('land', [[rect(minX - 1000, minY - 1000, midX, maxY + 1000)]]);
    const file = path.join(tempDir, 'land.sqlite');
    await buildLandIndex(file, {
      userAgent: 'test',
      sources: [
        { set: 'simplified', url: 'https://land/simplified.zip' },
        { set: 'full', url: 'https://land/full.zip' }
      ],
      fetch: (_url, init) =>
        Promise.resolve(
          init?.method === 'HEAD'
            ? new Response(null, { headers: { 'content-length': String(zip.length) } })
            : new Response(zip)
        )
    });
    const opened = LandIndex.open(file);
    assert.ok(opened);
    index = opened;
    store = new OnlineTileStore(path.join(tempDir, 'online'));
    proxy = new OnlineTileProxy(
      store,
      () => {
        fetches++;
        return Promise.resolve(upstream);
      },
      () => now
    );
    cache = new RasterTileCache('Test cache');
    await cache.init(path.join(tempDir, 'masked'));
    tiles = new MaskedTiles(proxy, cache, () => index);
  });

  after(() => {
    index.close();
    store.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const key = (): string => cache.key(maskedCacheText('chart', 'water-only', index.version)) ?? '';

  it('cuts the land away and serves PNG', async () => {
    const tile = (await tiles.getTile('chart', source, 'water-only', 2, 0, 0))?.data;
    assert.ok(tile);
    assert.strictEqual(tile[0], 0x89, 'PNG, since JPEG has no alpha');
    assert.strictEqual(alphaAt(tile, 10, 128), 0, 'land is transparent');
    assert.strictEqual(alphaAt(tile, 240, 128), 255, 'water is kept');
    await cache.flush();
  });

  it('keeps the provider tile exactly as it was sent', () => {
    const kept = store.get('chart', 2, 0, 0);
    assert.ok(kept);
    assert.deepStrictEqual([...kept.data], [...(upstream as Uint8Array)]);
  });

  it('serves a tile masked before from the cache', async () => {
    const kept = store.get('chart', 2, 0, 0);
    assert.ok(kept);
    const planted = Buffer.concat([Buffer.of(2), Buffer.from('planted')]);
    cache.writeStamped(key(), 2, 0, 0, kept.fetchedAt, planted);
    await cache.flush();
    const tile = await tiles.getTile('chart', source, 'water-only', 2, 0, 0);
    assert.strictEqual(tile?.data.toString(), 'planted');
  });

  it('masks again once the provider tile is refreshed', async () => {
    now += TILE_REFRESH_MS + 1;
    const before = fetches;
    // The old tile is served while it is refreshed behind it.
    await tiles.getTile('chart', source, 'water-only', 2, 0, 0);
    await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual(fetches, before + 1);
    const tile = (await tiles.getTile('chart', source, 'water-only', 2, 0, 0))?.data;
    assert.ok(tile);
    assert.notStrictEqual(tile.toString(), 'planted');
    assert.strictEqual(alphaAt(tile, 10, 128), 0);
    await cache.flush();
  });

  it('keys masked tiles to the land index version', () => {
    assert.notStrictEqual(
      cache.key(maskedCacheText('chart', 'water-only', index.version)),
      cache.key(maskedCacheText('chart', 'water-only', `${index.version}-rebuilt`))
    );
  });

  it('serves a tile with no land under it unchanged, still JPEG', async () => {
    const tile = await tiles.getTile('chart', source, 'water-only', 2, 3, 3);
    assert.deepStrictEqual([...(tile?.data ?? [])], [...(upstream as Uint8Array)]);
    assert.strictEqual(tile?.provisional, undefined, 'a final answer a plotter may keep');
  });

  it('serves no tile where everything is land', async () => {
    const tile = await tiles.getTile('chart', source, 'water-only', 4, 0, 1);
    assert.strictEqual(tile, null);
  });

  it('serves no tile where the provider has none', async () => {
    upstream = 'absent';
    try {
      assert.strictEqual(await tiles.getTile('other', source, 'water-only', 2, 0, 0), null);
    } finally {
      upstream = solidJpeg();
    }
  });

  it('serves a tile it cannot decode as sent, and remembers not to try again', async () => {
    upstream = Buffer.from('not an image the plugin can decode');
    try {
      const tile = await tiles.getTile('broken', source, 'water-only', 2, 0, 0);
      assert.strictEqual(tile?.data.toString(), 'not an image the plugin can decode');
      assert.strictEqual(tile.provisional, undefined);
      await cache.flush();
      const brokenKey = cache.key(maskedCacheText('broken', 'water-only', index.version)) ?? '';
      const kept = store.get('broken', 2, 0, 0);
      assert.ok(kept);
      assert.deepStrictEqual(
        [...(cache.readStamped(brokenKey, 2, 0, 0, kept.fetchedAt) ?? [])],
        [3]
      );
    } finally {
      upstream = solidJpeg();
    }
  });

  it('masks a tile once for requests that arrive together', async () => {
    const before = fetches;
    const [a, b] = await Promise.all([
      tiles.getTile('together', source, 'water-only', 2, 0, 0),
      tiles.getTile('together', source, 'water-only', 2, 0, 0)
    ]);
    assert.strictEqual(fetches, before + 1);
    assert.strictEqual(a, b);
  });

  it('cuts the water away for Land only', async () => {
    const tile = (await tiles.getTile('chart', source, 'land-only', 2, 0, 0))?.data;
    assert.ok(tile);
    assert.strictEqual(alphaAt(tile, 10, 128), 255, 'land is kept');
    assert.strictEqual(alphaAt(tile, 240, 128), 0, 'water is cut away');
  });

  it('fails closed for Land only: a transparent tile plotters do not keep, never the raw one', async () => {
    const transparent = (png: Buffer | undefined): boolean => {
      assert.ok(png);
      const img = PNG.sync.read(png);
      return img.data.every((v, i) => i % 4 !== 3 || v === 0);
    };
    const noIndex = await new MaskedTiles(proxy, cache, () => null).getTile(
      'chart',
      source,
      'land-only',
      2,
      0,
      0
    );
    assert.ok(transparent(noIndex?.data));
    assert.strictEqual(noIndex?.provisional, true);

    upstream = 'absent';
    try {
      const none = await tiles.getTile('nothing-here', source, 'land-only', 2, 0, 0);
      assert.ok(transparent(none?.data));
      assert.strictEqual(none?.provisional, true);
    } finally {
      upstream = solidJpeg();
    }

    upstream = Buffer.from('not an image the plugin can decode');
    try {
      const broken = await tiles.getTile('broken-land', source, 'land-only', 2, 0, 0);
      assert.ok(transparent(broken?.data), 'the raw bytes never reach the plotter');
      await cache.flush();
      const again = await tiles.getTile('broken-land', source, 'land-only', 2, 0, 0);
      assert.ok(transparent(again?.data), 'nor from the cache');
    } finally {
      upstream = solidJpeg();
    }

    // No land at all: nothing to show, remembered as such.
    assert.strictEqual(await tiles.getTile('chart', source, 'land-only', 2, 3, 3), null);
    await cache.flush();
    const key = cache.key(maskedCacheText('chart', 'land-only', index.version)) ?? '';
    const kept = store.get('chart', 2, 3, 3);
    assert.ok(kept);
    assert.deepStrictEqual([...(cache.readStamped(key, 2, 3, 3, kept.fetchedAt) ?? [])], [0]);
  });

  it('serves the plain tile without a land index', async () => {
    const plain = new MaskedTiles(proxy, cache, () => null);
    const tile = await plain.getTile('chart', source, 'water-only', 2, 0, 0);
    assert.deepStrictEqual([...(tile?.data ?? [])], [...(upstream as Uint8Array)]);
    assert.strictEqual(tile?.provisional, true);
  });
});
