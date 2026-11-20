import { after, before, describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';

import {
  ANSWER_MARGIN,
  answerBox,
  featureBox,
  featureId,
  featureQuery,
  matchedIn,
  sortedBy,
  sortOrder,
  uncovered,
  type Box
} from '../dist/utils/wfs-query.js';
import { WfsCache } from '../dist/utils/wfs-cache.js';
import { normalizeUpstream, READ_IDLE_MS, WfsProxy } from '../dist/utils/wfs-proxy.js';

interface Feature {
  type: 'Feature';
  id: string;
  geometry: { type: 'Polygon'; coordinates: number[][][] };
  properties: { IDENTIFIER: string; DRVAL1: number };
}

/** A square depth area of side 0.01° at (x, y). */
function area(i: number, x: number, y: number): Feature {
  const d = 0.01;
  return {
    type: 'Feature',
    id: `DepthArea_A.${String(i).padStart(4, '0')}`,
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [x, y],
          [x + d, y],
          [x + d, y + d],
          [x, y + d],
          [x, y]
        ]
      ]
    },
    properties: { IDENTIFIER: `FI${String(i).padStart(4, '0')}`, DRVAL1: i % 20 }
  };
}

/** A grid of areas over [22, 60]–[22.2, 60.1]. */
const AREAS: Feature[] = [];
/** Areas the fake upstream no longer has. */
const REMOVED = new Set<string>();
for (let i = 0; i < 20; i++) {
  for (let j = 0; j < 10; j++) {
    AREAS.push(area(AREAS.length, 22 + i * 0.01, 60 + j * 0.01));
  }
}

const intersects = (f: Feature, [w, s, e, n]: Box): boolean => {
  const [fw, fs, fe, fn] = featureBox(f) as Box;
  return fe >= w && fw <= e && fn >= s && fs <= n;
};

/** An upstream WFS over AREAS, as Traficom's answers underkeel's requests. */
function upstreamServer() {
  const seen: string[] = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    seen.push(url.search);
    const q = featureQuery(url.searchParams);
    if (url.searchParams.get('request') === 'GetCapabilities') {
      res.writeHead(200, { 'content-type': 'application/xml' }).end('<Capabilities/>');
      return;
    }
    if (q === null) {
      res.writeHead(400).end('bad request');
      return;
    }
    // As Traficom does: the box read in a turned grid, so a little past it too.
    const turned = answerBox(q.box);
    const past = (b: Box): Box => {
      const [w, s, e, n] = b;
      const [tw, ts, te, tn] = turned;
      return [w + (tw - w) / 2, s + (ts - s) / 2, e + (te - e) / 2, n + (tn - n) / 2];
    };
    const matching = AREAS.filter((f) => !REMOVED.has(f.id) && intersects(f, past(q.box))).sort(
      (a, b) => a.properties.IDENTIFIER.localeCompare(b.properties.IDENTIFIER)
    );
    if (q.hits) {
      res
        .writeHead(200, { 'content-type': 'application/xml' })
        .end(`<wfs:FeatureCollection numberMatched="${String(matching.length)}"/>`);
      return;
    }
    const page = matching.slice(
      q.startIndex,
      q.count === undefined ? undefined : q.startIndex + q.count
    );
    res.writeHead(200, { 'content-type': 'application/json' }).end(
      JSON.stringify({
        type: 'FeatureCollection',
        numberMatched: matching.length,
        numberReturned: page.length,
        features: page
      })
    );
  });
  return { server, seen };
}

/** The query underkeel sends for `box`, `[west, south, east, north]`. */
function query(typeName: string, [w, s, e, n]: Box, extra: Record<string, string>): string {
  return new URLSearchParams({
    service: 'WFS',
    version: '2.0.0',
    request: 'GetFeature',
    typeNames: typeName,
    bbox: `${String(s)},${String(w)},${String(n)},${String(e)},urn:ogc:def:crs:EPSG::4326`,
    srsName: 'EPSG:4326',
    ...extra
  }).toString();
}

/** A layer read as underkeel reads it: the count, then pages of `size` sorted by IDENTIFIER. */
async function readLayer(
  base: string,
  box: Box,
  size = 25,
  sortBy = 'IDENTIFIER'
): Promise<string[]> {
  const hits = await (
    await fetch(`${base}?${query('DepthArea_A', box, { resultType: 'hits' })}`)
  ).text();
  const matched = matchedIn(hits) ?? 0;
  const ids: string[] = [];
  for (let start = 0; start < matched; start += size) {
    const r = await fetch(
      `${base}?${query('DepthArea_A', box, {
        outputFormat: 'application/json',
        sortBy,
        count: String(size),
        startIndex: String(start)
      })}`
    );
    const body = (await r.json()) as { features: Feature[] };
    ids.push(...body.features.map((f) => f.id));
  }
  return ids;
}

describe('wfs-query', () => {
  it("reads underkeel's GetFeature as a box in longitude, latitude", () => {
    const q = featureQuery(
      new URLSearchParams(
        query('DepthArea_A', [22, 60, 22.5, 60.2], {
          outputFormat: 'application/json',
          sortBy: 'IDENTIFIER',
          count: '250',
          startIndex: '500'
        })
      )
    );
    assert.deepStrictEqual(q?.box, [22, 60, 22.5, 60.2]);
    assert.strictEqual(q?.startIndex, 500);
    assert.strictEqual(q?.count, 250);
    assert.strictEqual(q?.hits, false);
  });

  it('passes through what it cannot answer the same way', () => {
    const json = { outputFormat: 'application/json' };
    const cases = [
      // GML, not GeoJSON
      query('A', [22, 60, 22.5, 60.2], {}),
      // a box in another reference system
      new URLSearchParams({
        service: 'WFS',
        version: '2.0.0',
        request: 'GetFeature',
        typeNames: 'A',
        bbox: '200000,6600000,300000,6700000',
        ...json
      }).toString(),
      // a filter the cache does not apply
      `${query('A', [22, 60, 22.5, 60.2], json)}&cql_filter=DRVAL1>5`,
      // two feature types
      query('A,B', [22, 60, 22.5, 60.2], json),
      // no srsName: the reply is in the feature type's own system
      new URLSearchParams({
        service: 'WFS',
        version: '2.0.0',
        request: 'GetFeature',
        typeNames: 'A',
        bbox: '60,22,60.2,22.5,urn:ogc:def:crs:EPSG::4326',
        ...json
      }).toString(),
      new URLSearchParams({ service: 'WFS', request: 'GetCapabilities' }).toString()
    ];
    for (const c of cases) {
      assert.strictEqual(featureQuery(new URLSearchParams(c)), null, c);
    }
  });

  it("a feature's id and box", () => {
    const f = AREAS[3] as Feature;
    assert.strictEqual(featureId(f), f.id);
    assert.strictEqual(featureId({ properties: { IDENTIFIER: 7 } }), '7');
    assert.strictEqual(featureId({ properties: {} }), undefined);
    const [w, s, e, n] = featureBox(f) as Box;
    assert.ok(Math.abs(e - w - 0.01) < 1e-12 && Math.abs(n - s - 0.01) < 1e-12);
    assert.strictEqual(featureBox({ geometry: null }), undefined);
    // Metres, not degrees: no box this store places.
    assert.strictEqual(
      featureBox({ geometry: { type: 'Point', coordinates: [240000, 6680000] } }),
      undefined
    );
  });

  it('answerBox: grown by the margin a turned grid adds, each way by the other side', () => {
    const [w, s, e, n] = answerBox([22, 60, 22.2, 60.1]);
    const cos = Math.cos((60.05 * Math.PI) / 180);
    // East and west by the box's height, north and south by its width.
    assert.ok(Math.abs(22 - w - (ANSWER_MARGIN * 0.1) / cos) < 1e-9);
    assert.ok(Math.abs(60 - s - ANSWER_MARGIN * 0.2 * cos) < 1e-9);
    assert.ok(e > 22.2 && n > 60.1);
  });

  it('uncovered: what boxes leave of a box', () => {
    const box: Box = [0, 0, 2, 2];
    assert.deepStrictEqual(uncovered(box, [[-1, -1, 3, 3]]), []);
    assert.deepStrictEqual(
      uncovered(box, [
        [0, 0, 1, 2],
        [1, 0, 2, 2]
      ]),
      []
    );
    const left = uncovered(box, [[0, 0, 1, 2]]);
    assert.strictEqual(left.length, 1);
    assert.deepStrictEqual(left[0], [1, 0, 2, 2]);
    // A hole in the middle leaves four parts.
    assert.strictEqual(uncovered(box, [[0.5, 0.5, 1.5, 1.5]]).length, 4);
  });

  it('sortOrder and sortedBy: one property, either way, none last ascending', () => {
    assert.deepStrictEqual(sortOrder('IDENTIFIER'), { property: 'IDENTIFIER', descending: false });
    assert.deepStrictEqual(sortOrder('DRVAL1 DESC'), { property: 'DRVAL1', descending: true });
    assert.deepStrictEqual(sortOrder('DRVAL1 a'), { property: 'DRVAL1', descending: false });
    assert.strictEqual(sortOrder('DRVAL1,IDENTIFIER'), undefined);
    assert.strictEqual(sortOrder('DRVAL1 SIDEWAYS'), undefined);
    const fs = [{ v: 10 }, { v: 9 }, {}, { v: 9 }].map((p, i) => ({ i, properties: p }));
    const asc = sortedBy(fs, (f) => f, { property: 'v', descending: false }).map((f) => f.i);
    assert.deepStrictEqual(asc, [1, 3, 0, 2]);
    const desc = sortedBy(fs, (f) => f, { property: 'v', descending: true }).map((f) => f.i);
    assert.deepStrictEqual(desc, [2, 0, 1, 3]);
  });
});

describe('WfsCache', () => {
  let dir: string;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfs-cache-'));
  });
  after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('keeps each feature once and finds those reaching a box, in a fixed order', () => {
    const cache = new WfsCache(path.join(dir, 'a.sqlite'));
    const layer = { upstream: 'https://wfs.example/wfs', typeName: 'DepthArea_A' };
    assert.ok(cache.put(layer, AREAS.slice(0, 50), 1));
    // The same features again, from an overlapping box: still one each.
    assert.ok(cache.put(layer, AREAS.slice(25, 75), 2));
    assert.strictEqual(cache.stats().features, 75);
    const ids = cache.idsIn(layer, [22, 60, 22.2, 60.1]);
    assert.strictEqual(ids.length, 75);
    const features = cache.features(ids);
    const order = features.map((f) => String(f.id));
    assert.deepStrictEqual(order, [...order].sort());
    // Another layer of the same server is its own.
    assert.deepStrictEqual(cache.idsIn({ ...layer, typeName: 'Other' }, [22, 60, 22.2, 60.1]), []);
    cache.close();
  });

  it('refuses a page with a feature it could not find again', () => {
    const cache = new WfsCache(path.join(dir, 'b.sqlite'));
    const layer = { upstream: 'https://wfs.example/wfs', typeName: 'A' };
    assert.strictEqual(cache.put(layer, [AREAS[0] as Feature, { properties: {} }], 1), false);
    assert.strictEqual(cache.stats().features, 0);
    cache.close();
  });

  it('a box is held by the boxes fetched since a time', () => {
    const cache = new WfsCache(path.join(dir, 'c.sqlite'));
    const layer = { upstream: 'https://wfs.example/wfs', typeName: 'A' };
    cache.markCovered(layer, [22, 60, 22.1, 60.1], 100);
    cache.markCovered(layer, [22.1, 60, 22.2, 60.1], 200);
    assert.ok(cache.covers(layer, [22.05, 60.02, 22.15, 60.08], 0));
    assert.ok(!cache.covers(layer, [22.05, 60.02, 22.15, 60.08], 150));
    assert.ok(cache.covers(layer, [22.12, 60.02, 22.15, 60.08], 150));
    assert.ok(!cache.covers(layer, [22.15, 60.02, 22.25, 60.08], 0));
    // A box inside a newer one is pruned.
    cache.markCovered(layer, [21.9, 59.9, 22.3, 60.2], 300);
    assert.strictEqual(cache.stats().areas, 1);
    cache.close();
  });

  it('a feature gone upstream is found no more, but read until purged', () => {
    const cache = new WfsCache(path.join(dir, 'd.sqlite'));
    const layer = { upstream: 'https://wfs.example/wfs', typeName: 'A' };
    assert.ok(cache.put(layer, AREAS.slice(0, 10), 1));
    const ids = cache.idsIn(layer, [21, 59, 23, 61]);
    assert.ok(cache.put(layer, AREAS.slice(1, 10), 2));
    assert.strictEqual(cache.pruneUnseen(layer, [21, 59, 23, 61], 2), 1);
    assert.strictEqual(cache.idsIn(layer, [21, 59, 23, 61]).length, 9);
    assert.strictEqual(cache.stats().features, 9);
    assert.strictEqual(cache.features(ids).length, 10);
    cache.purgeGone();
    assert.strictEqual(cache.features(ids).length, 9);
    cache.close();
  });
});

describe('WfsProxy', () => {
  let dir: string;
  let upstream: ReturnType<typeof upstreamServer>;
  let upstreamBase: string;
  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfs-proxy-'));
    upstream = upstreamServer();
    await new Promise<void>((resolve) => upstream.server.listen(0, '127.0.0.1', resolve));
    upstreamBase = `http://127.0.0.1:${String((upstream.server.address() as AddressInfo).port)}/wfs`;
  });
  after(async () => {
    await new Promise<void>((resolve) => upstream.server.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function proxyWith(file: string, opts: { now?: () => number; mayRefresh?: () => boolean } = {}) {
    const cache = new WfsCache(path.join(dir, file));
    const proxy = new WfsProxy({
      cache,
      upstreams: () => [upstreamBase],
      maxAgeMs: () => 1000,
      mayRefresh: opts.mayRefresh ?? (() => true),
      now: opts.now
    });
    return { cache, proxy };
  }

  const BOX: Box = [22.02, 60.02, 22.12, 60.06];

  it('passes a first read through, then answers it again from the store alone', async () => {
    const { cache, proxy } = proxyWith('p1.sqlite');
    await proxy.listen();
    const base = proxy.proxyUrl(upstreamBase) as string;
    const direct = await readLayer(upstreamBase, BOX);
    upstream.seen.length = 0;
    const first = await readLayer(base, BOX);
    assert.deepStrictEqual(first, direct);
    const firstRequests = upstream.seen.length;
    assert.ok(firstRequests > 1);
    upstream.seen.length = 0;
    const again = await readLayer(base, BOX, 7);
    assert.deepStrictEqual([...again].sort(), [...direct].sort());
    assert.strictEqual(new Set(again).size, again.length);
    // A box inside the one held is answered from the store too.
    const inner = await readLayer(base, [22.05, 60.03, 22.08, 60.05]);
    assert.ok(inner.length > 0);
    assert.strictEqual(upstream.seen.length, 0);
    await proxy.close();
    cache.close();
  });

  it('an area read only in part is not held', async () => {
    const { cache, proxy } = proxyWith('p2.sqlite');
    await proxy.listen();
    const base = proxy.proxyUrl(upstreamBase) as string;
    await fetch(
      `${base}?${query('DepthArea_A', BOX, {
        outputFormat: 'application/json',
        sortBy: 'IDENTIFIER',
        count: '10',
        startIndex: '0'
      })}`
    );
    assert.strictEqual(cache.stats().areas, 0);
    assert.strictEqual(cache.stats().features, 10);
    await proxy.close();
    cache.close();
  });

  it('fetches a stale area again, unless going online is held back', async () => {
    let now = 1_000_000;
    let mayRefresh = true;
    const { cache, proxy } = proxyWith('p3.sqlite', {
      now: () => now,
      mayRefresh: () => mayRefresh
    });
    await proxy.listen();
    const base = proxy.proxyUrl(upstreamBase) as string;
    await readLayer(base, BOX);
    // Past the maximum age (1 s) and the read's idle time.
    now += READ_IDLE_MS + 5000;
    mayRefresh = false;
    upstream.seen.length = 0;
    await readLayer(base, BOX);
    assert.strictEqual(upstream.seen.length, 0);
    now += READ_IDLE_MS + 5000;
    mayRefresh = true;
    await readLayer(base, BOX);
    assert.ok(upstream.seen.length > 0);
    await proxy.close();
    cache.close();
  });

  it('passes other requests through, and serves no one without its token or for another server', async () => {
    const { cache, proxy } = proxyWith('p4.sqlite');
    await proxy.listen();
    const base = proxy.proxyUrl(upstreamBase) as string;
    const caps = await fetch(`${base}?service=WFS&request=GetCapabilities`);
    assert.strictEqual(caps.status, 200);
    assert.strictEqual(await caps.text(), '<Capabilities/>');
    const u = new URL(base);
    const [, token = '', encoded = ''] = u.pathname.split('/');
    const wrongToken = await fetch(`${u.origin}/not-the-token/${encoded}`);
    assert.strictEqual(wrongToken.status, 404);
    const other = Buffer.from('https://elsewhere.example/wfs').toString('base64url');
    const forbidden = await fetch(`${u.origin}/${token}/${other}`);
    assert.strictEqual(forbidden.status, 403);
    assert.strictEqual(proxy.proxyUrl('https://elsewhere.example/wfs'), undefined);
    await proxy.close();
    cache.close();
  });

  it('keeps its port when it is free', async () => {
    const { cache, proxy } = proxyWith('p5.sqlite');
    const port = await proxy.listen();
    await proxy.close();
    const again = new WfsProxy({
      cache,
      upstreams: () => [upstreamBase],
      maxAgeMs: () => 1000,
      mayRefresh: () => true
    });
    assert.strictEqual(await again.listen(port), port);
    await again.close();
    cache.close();
  });

  it("two orderings of one area are two reads: one's pages do not complete the other", async () => {
    const { cache, proxy } = proxyWith('p6.sqlite');
    await proxy.listen();
    const base = proxy.proxyUrl(upstreamBase) as string;
    const page = (sortBy: string, start: number) =>
      fetch(
        `${base}?${query('DepthArea_A', BOX, {
          outputFormat: 'application/json',
          sortBy,
          count: '25',
          startIndex: String(start)
        })}`
      ).then((r) => r.json());
    const total = (await readLayer(upstreamBase, BOX)).length;
    assert.ok(total > 25);
    await page('IDENTIFIER', 0);
    for (let start = 25; start < total; start += 25) {
      await page('DRVAL1', start);
    }
    assert.strictEqual(cache.stats().areas, 0);
    await proxy.close();
    cache.close();
  });

  it("a store read keeps its pages' ordering while many other areas are read", async () => {
    const { cache, proxy } = proxyWith('p7.sqlite');
    await proxy.listen();
    const base = proxy.proxyUrl(upstreamBase) as string;
    await readLayer(base, BOX);
    const pageAt = (box: Box, start: number) =>
      fetch(
        `${base}?${query('DepthArea_A', box, {
          outputFormat: 'application/json',
          sortBy: 'IDENTIFIER',
          count: '10',
          startIndex: String(start)
        })}`
      ).then(async (r) => ((await r.json()) as { features: Feature[] }).features.map((f) => f.id));
    const ids = await pageAt(BOX, 0);
    // Forty other areas inside the one held, each its own read from the store.
    for (let k = 0; k < 40; k++) {
      const d = k * 0.001;
      await pageAt([22.03 + d, 60.03, 22.06 + d, 60.05], 0);
    }
    for (let start = 10; ; start += 10) {
      const next = await pageAt(BOX, start);
      if (next.length === 0) {
        break;
      }
      ids.push(...next);
    }
    assert.strictEqual(new Set(ids).size, ids.length);
    await proxy.close();
    cache.close();
  });

  it('an area read again whole drops the features inside it that are gone upstream', async () => {
    let now = 5_000_000;
    const { cache, proxy } = proxyWith('p8.sqlite', { now: () => now });
    await proxy.listen();
    const base = proxy.proxyUrl(upstreamBase) as string;
    const first = await readLayer(base, BOX);
    const gone = first[3] as string;
    REMOVED.add(gone);
    try {
      now += READ_IDLE_MS + 5000;
      await readLayer(base, BOX);
      now += 1;
      const fromStore = await readLayer(base, [22.03, 60.03, 22.11, 60.05]);
      assert.ok(fromStore.length > 0);
      assert.ok(!fromStore.includes(gone));
    } finally {
      REMOVED.delete(gone);
    }
    await proxy.close();
    cache.close();
  });

  it('an area with no features is held from its count alone', async () => {
    const { cache, proxy } = proxyWith('p9.sqlite');
    await proxy.listen();
    const base = proxy.proxyUrl(upstreamBase) as string;
    const empty: Box = [25, 61, 25.1, 61.05];
    assert.deepStrictEqual(await readLayer(base, empty), []);
    upstream.seen.length = 0;
    assert.deepStrictEqual(await readLayer(base, empty), []);
    assert.strictEqual(upstream.seen.length, 0);
    await proxy.close();
    cache.close();
  });

  /** A page of `box` read through `base`, as the ids of its features. */
  const pageOf = (base: string, box: Box, sortBy: string, start: number, size = 25) =>
    fetch(
      `${base}?${query('DepthArea_A', box, {
        outputFormat: 'application/json',
        sortBy,
        count: String(size),
        startIndex: String(start)
      })}`
    ).then(async (r) => ((await r.json()) as { features: Feature[] }).features.map((f) => f.id));

  it('the store answers in the order of the property sortBy names, and passes others on', async () => {
    const { cache, proxy } = proxyWith('p10.sqlite');
    await proxy.listen();
    const base = proxy.proxyUrl(upstreamBase) as string;
    await readLayer(base, BOX);
    upstream.seen.length = 0;
    const ids = await readLayer(base, BOX, 10, 'DRVAL1 DESC');
    assert.strictEqual(upstream.seen.length, 0);
    const depth = (id: string) => (AREAS.find((f) => f.id === id) as Feature).properties.DRVAL1;
    const depths = ids.map(depth);
    assert.deepStrictEqual(
      depths,
      [...depths].sort((a, b) => b - a)
    );
    await pageOf(base, BOX, 'DRVAL1,IDENTIFIER', 0);
    assert.strictEqual(upstream.seen.length, 1);
    // Its count goes upstream too, so the count and the pages agree.
    const gone = ids.slice(0, 5);
    for (const id of gone) {
      REMOVED.add(id);
    }
    try {
      const count = async (sortBy: string) =>
        matchedIn(
          await (
            await fetch(`${base}?${query('DepthArea_A', BOX, { resultType: 'hits', sortBy })}`)
          ).text()
        );
      assert.strictEqual(await count('DRVAL1,IDENTIFIER'), ids.length - gone.length);
      assert.strictEqual(upstream.seen.length, 2);
      assert.strictEqual(await count('DRVAL1'), ids.length);
    } finally {
      for (const id of gone) {
        REMOVED.delete(id);
      }
    }
    await proxy.close();
    cache.close();
  });

  it('a count of none drops what the store kept inside the area', async () => {
    let now = 7_000_000;
    const { cache, proxy } = proxyWith('p11.sqlite', { now: () => now });
    await proxy.listen();
    const base = proxy.proxyUrl(upstreamBase) as string;
    await readLayer(base, BOX);
    const inner: Box = [22.045, 60.025, 22.075, 60.055];
    const near = answerBox(inner);
    const emptied = AREAS.filter((f) => intersects(f, near)).map((f) => f.id);
    for (const id of emptied) {
      REMOVED.add(id);
    }
    try {
      now += READ_IDLE_MS + 5000;
      const before = cache.stats().features;
      assert.deepStrictEqual(await readLayer(base, inner), []);
      // The four areas wholly inside it.
      assert.strictEqual(cache.stats().features, before - 4);
    } finally {
      for (const id of emptied) {
        REMOVED.delete(id);
      }
    }
    await proxy.close();
    cache.close();
  });

  it('a read begun upstream keeps its pages there when another read holds the area', async () => {
    const { cache, proxy } = proxyWith('p12.sqlite');
    await proxy.listen();
    const base = proxy.proxyUrl(upstreamBase) as string;
    await pageOf(base, BOX, 'IDENTIFIER', 0);
    await readLayer(base, BOX, 25, 'DRVAL1');
    assert.strictEqual(cache.stats().areas, 1);
    // A count from the store, then the first read's next page.
    await fetch(`${base}?${query('DepthArea_A', BOX, { resultType: 'hits' })}`);
    upstream.seen.length = 0;
    await pageOf(base, BOX, 'IDENTIFIER', 25);
    assert.strictEqual(upstream.seen.length, 1);
    await proxy.close();
    cache.close();
  });

  it('an area is held only once its gone features are dropped', async () => {
    const { cache, proxy } = proxyWith('p13.sqlite');
    await proxy.listen();
    const base = proxy.proxyUrl(upstreamBase) as string;
    const prune = cache.pruneUnseen.bind(cache);
    let fail = true;
    cache.pruneUnseen = (...args) => {
      if (fail) {
        fail = false;
        throw new Error('disk full');
      }
      return prune(...args);
    };
    const total = (await readLayer(upstreamBase, BOX)).length;
    await readLayer(base, BOX);
    assert.strictEqual(cache.stats().areas, 0);
    await pageOf(base, BOX, 'IDENTIFIER', Math.floor((total - 1) / 25) * 25);
    assert.strictEqual(cache.stats().areas, 1);
    await proxy.close();
    cache.close();
  });

  it("a store read's pages give what its count says while a refresh drops a feature", async () => {
    let now = 9_000_000;
    let mayRefresh = true;
    const { cache, proxy } = proxyWith('p14.sqlite', {
      now: () => now,
      mayRefresh: () => mayRefresh
    });
    await proxy.listen();
    const base = proxy.proxyUrl(upstreamBase) as string;
    await readLayer(base, BOX);
    now += READ_IDLE_MS + 5000;
    // The stale area from the store, as on a metered link.
    mayRefresh = false;
    const hits = await (
      await fetch(`${base}?${query('DepthArea_A', BOX, { resultType: 'hits' })}`)
    ).text();
    const matched = matchedIn(hits) ?? 0;
    const ids = await pageOf(base, BOX, 'IDENTIFIER', 0);
    // Online again: an area inside it read whole drops a feature gone upstream.
    mayRefresh = true;
    const gone = 'DepthArea_A.0053';
    REMOVED.add(gone);
    try {
      const inner: Box = [22.045, 60.025, 22.075, 60.055];
      assert.ok(!(await readLayer(base, inner)).includes(gone));
      for (let start = 25; start < matched; start += 25) {
        ids.push(...(await pageOf(base, BOX, 'IDENTIFIER', start)));
      }
      assert.strictEqual(ids.length, matched);
      assert.ok(ids.includes(gone));
      assert.strictEqual(new Set(ids).size, ids.length);
    } finally {
      REMOVED.delete(gone);
    }
    await proxy.close();
    cache.close();
  });

  it('normalizes upstream URLs for comparison', () => {
    assert.strictEqual(
      normalizeUpstream('https://julkinen.traficom.fi/inspirepalvelu/rajoitettu/wfs/?x=1'),
      'https://julkinen.traficom.fi/inspirepalvelu/rajoitettu/wfs'
    );
    assert.strictEqual(normalizeUpstream('ftp://x/wfs'), undefined);
    assert.strictEqual(normalizeUpstream('not a url'), undefined);
  });
});
