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
  hitsMatched,
  hitsReply,
  pageMatched,
  sortedBy,
  sortOrder,
  uncovered,
  type Box,
  type WfsFeature
} from '../dist/utils/wfs-query.js';
import { WfsCache, type Layer } from '../dist/utils/wfs-cache.js';
import { normalizeUpstream, READ_IDLE_MS, WfsProxy } from '../dist/utils/wfs-proxy.js';
import {
  DEFAULT_WFS_UPSTREAMS,
  releaseWfsProxy,
  startWfsProxy,
  stopWfsProxy
} from '../dist/utils/wfs-proxy-service.js';

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
  const elsewhere: string[] = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/redirect-out') {
      res.writeHead(302, { location: `/elsewhere${url.search}` }).end();
      return;
    }
    if (url.pathname === '/elsewhere') {
      elsewhere.push(url.search);
      res.writeHead(200, { 'content-type': 'text/plain' }).end('elsewhere');
      return;
    }
    if (url.pathname === '/shifting') {
      // Four matches, but the second page repeats one the first gave: the order shifted.
      const start = Number(url.searchParams.get('startIndex') ?? '0');
      const page = start === 0 ? AREAS.slice(0, 2) : [AREAS[1], AREAS[3]];
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ type: 'FeatureCollection', numberMatched: 4, features: page }));
      return;
    }
    if (url.pathname === '/redirect-in') {
      res.writeHead(302, { location: `/wfs${url.search}` }).end();
      return;
    }
    if (url.pathname === '/broken') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"type":"FeatureCollection","features":[');
      setTimeout(() => res.destroy(), 20);
      return;
    }
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
    const uncounted = url.pathname === '/uncounted';
    res.writeHead(200, { 'content-type': 'application/json' }).end(
      JSON.stringify({
        type: 'FeatureCollection',
        ...(uncounted ? {} : { numberMatched: matching.length }),
        numberReturned: page.length,
        features: page
      })
    );
  });
  return { server, seen, elsewhere };
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
  const counted = await fetch(`${base}?${query('DepthArea_A', box, { resultType: 'hits' })}`);
  assert.strictEqual(counted.status, 200);
  const matched = hitsMatched(await counted.text());
  assert.ok(matched !== undefined, 'the count gives a number');
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
      new URLSearchParams({ service: 'WFS', request: 'GetCapabilities' }).toString(),
      // a page with no page size: the server's own default, unknown here
      query('A', [22, 60, 22.5, 60.2], json),
      // a box with a coordinate missing, which Number('') would read as 0
      `service=WFS&version=2.0.0&request=GetFeature&typeNames=A&srsName=EPSG:4326&resultType=hits&bbox=,22,60.2,22.5,${encodeURIComponent('urn:ogc:def:crs:EPSG::4326')}`
    ];
    for (const c of cases) {
      assert.strictEqual(featureQuery(new URLSearchParams(c)), null, c);
    }
    // A coordinate of 0 is one.
    assert.ok(featureQuery(new URLSearchParams(query('A', [0, 0, 1, 1], { resultType: 'hits' }))));
  });

  it('reads a count from the collection alone, and writes one with its time', () => {
    const xml =
      '<wfs:FeatureCollection xmlns:wfs="http://www.opengis.net/wfs/2.0" numberMatched="20" numberReturned="0"/>';
    assert.strictEqual(hitsMatched(xml), 20);
    assert.strictEqual(hitsMatched('<x numberMatched="3"/>'), undefined);
    assert.strictEqual(hitsMatched("<wfs:FeatureCollection numberMatched = '0'/>"), 0);
    assert.strictEqual(
      hitsMatched('<wfs:FeatureCollection numberMatched="unknown" numberReturned="0"/>'),
      undefined
    );
    // A feature's own numberMatched is not the page's.
    const page = JSON.parse(
      '{"type":"FeatureCollection","features":[{"properties":{"numberMatched":1}}],"numberMatched":20}'
    ) as { numberMatched?: unknown };
    assert.strictEqual(pageMatched(page), 20);
    assert.strictEqual(pageMatched({ numberMatched: 'unknown' }), undefined);
    const reply = hitsReply(7, new Date(0));
    assert.strictEqual(hitsMatched(reply), 7);
    assert.ok(reply.includes('timeStamp="1970-01-01T00:00:00.000Z"'));
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
    // A qualified name is not the name GeoJSON properties carry.
    assert.strictEqual(sortOrder('ns:DRVAL1 D'), undefined);
    const fs = [{ v: 10 }, { v: 9 }, {}, { v: 9 }].map((p, i) => ({ i, properties: p }));
    const asc = sortedBy(fs, (f) => f, { property: 'v', descending: false }).map((f) => f.i);
    assert.deepStrictEqual(asc, [1, 3, 0, 2]);
    const desc = sortedBy(fs, (f) => f, { property: 'v', descending: true }).map((f) => f.i);
    assert.deepStrictEqual(desc, [2, 0, 1, 3]);
  });
});

/** `features` kept as a whole read of `box` begun at `at`. */
function keepWhole(
  cache: WfsCache,
  layer: Layer,
  features: readonly WfsFeature[],
  box: Box,
  at: number,
  byBox = true
): number | undefined {
  const stage = cache.beginStage();
  assert.ok(cache.stage(stage, features, at));
  return cache.publish(stage, layer, { box, boxText: box.join(',') }, at, byBox);
}

describe('WfsCache', () => {
  let dir: string;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfs-cache-'));
  });
  after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const layer: Layer = { upstream: 'https://wfs.example/wfs', typeName: 'DepthArea_A' };
  const WIDE: Box = [21, 59, 23, 61];

  it('keeps each feature once and finds those reaching a box, in a fixed order', () => {
    const cache = new WfsCache(path.join(dir, 'a.sqlite'));
    keepWhole(cache, layer, AREAS.slice(0, 50), [22, 60, 22.05, 60.1], 1);
    // The same features again, from an overlapping box: still one each.
    keepWhole(cache, layer, AREAS.slice(25, 75), [22.025, 60, 22.075, 60.1], 2);
    assert.strictEqual(cache.stats().features, 75);
    const ids = cache.idsIn(layer, [22, 60, 22.2, 60.1]);
    assert.strictEqual(ids.length, 75);
    const order = cache.features(ids).map((f) => String(f.id));
    assert.deepStrictEqual(order, [...order].sort());
    // Another layer of the same server is its own.
    assert.deepStrictEqual(cache.idsIn({ ...layer, typeName: 'Other' }, [22, 60, 22.2, 60.1]), []);
    cache.close();
  });

  it('refuses a page with a feature it could not find again', () => {
    const cache = new WfsCache(path.join(dir, 'b.sqlite'));
    const stage = cache.beginStage();
    assert.strictEqual(cache.stage(stage, [AREAS[0] as Feature, { properties: {} }], 1), false);
    cache.publish(stage, layer, { box: WIDE, boxText: 'w' }, 1, true);
    assert.strictEqual(cache.stats().features, 0);
    cache.close();
  });

  it('a box is held by the boxes fetched since a time', () => {
    const cache = new WfsCache(path.join(dir, 'c.sqlite'));
    const held = (box: Box, at: number) =>
      cache.publish(undefined, layer, { box, boxText: box.join(',') }, at, true);
    held([22, 60, 22.1, 60.1], 100);
    held([22.1, 60, 22.2, 60.1], 200);
    assert.ok(cache.covers(layer, [22.05, 60.02, 22.15, 60.08], 0));
    assert.ok(!cache.covers(layer, [22.05, 60.02, 22.15, 60.08], 150));
    assert.ok(cache.covers(layer, [22.12, 60.02, 22.15, 60.08], 150));
    assert.ok(!cache.covers(layer, [22.15, 60.02, 22.25, 60.08], 0));
    // A box inside a newer one is pruned.
    held([21.9, 59.9, 22.3, 60.2], 300);
    assert.strictEqual(cache.stats().areas, 1);
    cache.close();
  });

  it('drops a feature gone upstream, while a read that pinned it before still gets it', () => {
    const cache = new WfsCache(path.join(dir, 'd.sqlite'));
    keepWhole(cache, layer, AREAS.slice(0, 10), WIDE, 1);
    const before = cache.pinIn(layer, WIDE);
    assert.strictEqual(keepWhole(cache, layer, AREAS.slice(1, 10), WIDE, 2), 1);
    assert.strictEqual(cache.idsIn(layer, WIDE).length, 9);
    assert.strictEqual(cache.stats().features, 9);
    assert.strictEqual(before.features(before.ids).length, 10);
    before.release();
    const after = cache.pinIn(layer, WIDE);
    assert.strictEqual(after.features(after.ids).length, 9);
    cache.close();
  });

  it('a pinned read gets the version of a feature it began with', () => {
    const cache = new WfsCache(path.join(dir, 'e.sqlite'));
    const f = AREAS[0] as Feature;
    keepWhole(cache, layer, [f], WIDE, 1);
    const pin = cache.pinIn(layer, WIDE);
    const [id] = pin.ids as [number];
    keepWhole(cache, layer, [{ ...f, properties: { ...f.properties, DRVAL1: 99 } }], WIDE, 2);
    assert.strictEqual((pin.features([id])[0] as Feature).properties.DRVAL1, f.properties.DRVAL1);
    assert.strictEqual((cache.features([id])[0] as Feature).properties.DRVAL1, 99);
    pin.release();
    cache.close();
  });

  it('an older read is not kept over a newer one of an area overlapping it', () => {
    const cache = new WfsCache(path.join(dir, 'i.sqlite'));
    const older = cache.beginStage();
    assert.ok(cache.stage(older, AREAS.slice(0, 3), 1));
    // A newer read of the box found it empty, and was kept first.
    assert.strictEqual(
      cache.publish(undefined, layer, { box: WIDE, boxText: 'newer' }, 5, true),
      0
    );
    assert.strictEqual(
      cache.publish(older, layer, { box: [22, 60, 22.1, 60.1], boxText: 'older' }, 1, true),
      undefined
    );
    assert.strictEqual(cache.stats().features, 0);
    assert.strictEqual(cache.stagedCount(older), 0);
    cache.close();
  });

  it('pages staged but not published change nothing', () => {
    const cache = new WfsCache(path.join(dir, 'f.sqlite'));
    keepWhole(cache, layer, AREAS.slice(0, 10), WIDE, 1);
    const f = AREAS[0] as Feature;
    const stage = cache.beginStage();
    assert.ok(cache.stage(stage, [{ ...f, properties: { ...f.properties, DRVAL1: 99 } }], 2));
    const [id] = cache.idsIn(layer, [22, 60, 22.005, 60.005]) as [number];
    assert.strictEqual((cache.features([id])[0] as Feature).properties.DRVAL1, f.properties.DRVAL1);
    cache.dropStage(stage);
    assert.strictEqual(cache.stats().features, 10);
    cache.close();
  });

  it('drops a gone feature lying exactly on the box edge, and keeps one reaching past it', () => {
    const cache = new WfsCache(path.join(dir, 'g.sqlite'));
    const point = (id: string, x: number) => ({
      type: 'Feature',
      id,
      geometry: { type: 'Point', coordinates: [x, 60.05] },
      properties: {}
    });
    const line = {
      type: 'Feature',
      id: 'across',
      geometry: {
        type: 'LineString',
        coordinates: [
          [22.05, 60.05],
          [22.15, 60.05]
        ]
      },
      properties: {}
    };
    const box: Box = [22.1, 60, 22.2, 60.1];
    keepWhole(cache, layer, [point('edge', 22.1), line], [22, 60, 22.2, 60.1], 1);
    assert.strictEqual(keepWhole(cache, layer, [], box, 2), 1);
    assert.deepStrictEqual(
      cache.features(cache.idsIn(layer, [22, 60, 22.2, 60.1])).map((f) => f.id),
      ['across']
    );
    cache.close();
  });

  it('an area of an upstream answered box by box keeps the features that box gave, as it gave them', () => {
    const cache = new WfsCache(path.join(dir, 'h.sqlite'));
    const box: Box = [22, 60, 22.05, 60.05];
    const other: Box = [22, 60, 22.06, 60.06];
    const f = AREAS[0] as Feature;
    keepWhole(cache, layer, AREAS.slice(0, 3), box, 1, false);
    // Another box gives the same feature changed: the first box keeps it as it gave it.
    keepWhole(
      cache,
      layer,
      [{ ...f, properties: { ...f.properties, DRVAL1: 99 } }],
      other,
      2,
      false
    );
    const covered = cache.exactCover(layer, box.join(','), 0);
    assert.ok(covered !== undefined);
    const pin = cache.pinArea(covered);
    const kept = pin.features(pin.ids) as Feature[];
    assert.strictEqual(kept.length, 3);
    assert.strictEqual(kept.find((k) => k.id === f.id)?.properties.DRVAL1, f.properties.DRVAL1);
    // No other box is held, not even one inside it.
    assert.strictEqual(cache.exactCover(layer, '22,60,22.01,60.01', 0), undefined);
    pin.release();
    cache.close();
  });

  it('begins a store of another schema again, and closes it if it cannot open', () => {
    const file = path.join(dir, 'old.sqlite');
    const cache = new WfsCache(file);
    keepWhole(cache, layer, AREAS.slice(0, 3), WIDE, 1);
    cache.close();
    const old = new WfsCache(file);
    // As an older plugin left it.
    (old as unknown as { db: { exec: (sql: string) => void } }).db.exec(
      "UPDATE meta SET value = '1' WHERE name = 'schema'"
    );
    old.close();
    const again = new WfsCache(file);
    assert.strictEqual(again.stats().features, 0);
    again.close();
    // A file that is no database: the error, and no handle left open on it.
    const bad = path.join(dir, 'bad.sqlite');
    fs.writeFileSync(bad, 'not a database, not at all, for sure');
    assert.throws(() => new WfsCache(bad));
    fs.rmSync(bad);
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

  function proxyWith(
    file: string,
    opts: {
      now?: () => number;
      mayRefresh?: () => boolean;
      byBox?: boolean;
      upstreams?: () => string[];
    } = {}
  ) {
    const cache = new WfsCache(path.join(dir, file));
    const proxy = new WfsProxy({
      cache,
      upstreams: opts.upstreams ?? (() => [upstreamBase]),
      answersByBox: () => opts.byBox ?? true,
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

  it('an area read only in part is not held, and keeps none of its pages', async () => {
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
    assert.strictEqual(cache.stats().features, 0);
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
      answersByBox: () => true,
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
    await readLayer(base, BOX);
    const inner: Box = [22.03, 60.03, 22.11, 60.05];
    // An area wholly inside the inner box, which a read of it gives.
    const gone = (
      AREAS.find((f) => {
        const [w, s, e, n] = featureBox(f) as Box;
        const eps = 1e-9;
        return (
          w >= inner[0] - eps && s >= inner[1] - eps && e <= inner[2] + eps && n <= inner[3] + eps
        );
      }) as Feature
    ).id;
    assert.ok((await readLayer(base, inner)).includes(gone));
    REMOVED.add(gone);
    try {
      now += READ_IDLE_MS + 5000;
      await readLayer(base, BOX);
      now += 1;
      upstream.seen.length = 0;
      const fromStore = await readLayer(base, inner);
      assert.strictEqual(upstream.seen.length, 0);
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
        hitsMatched(
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

  it('an area is held only once its read is published', async () => {
    const { cache, proxy } = proxyWith('p13.sqlite');
    await proxy.listen();
    const base = proxy.proxyUrl(upstreamBase) as string;
    const publish = cache.publish.bind(cache);
    let fail = true;
    cache.publish = (...args) => {
      if (fail) {
        fail = false;
        throw new Error('disk full');
      }
      return publish(...args);
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
    const matched = hitsMatched(hits) ?? 0;
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

  it('answers an upstream not read by box only for the same box, with what it gave', async () => {
    const { cache, proxy } = proxyWith('p15.sqlite', { byBox: false });
    await proxy.listen();
    const base = proxy.proxyUrl(upstreamBase) as string;
    const first = await readLayer(base, BOX);
    upstream.seen.length = 0;
    assert.deepStrictEqual(await readLayer(base, BOX), first);
    assert.strictEqual(upstream.seen.length, 0);
    await readLayer(base, [22.05, 60.03, 22.08, 60.05]);
    assert.ok(upstream.seen.length > 0);
    await proxy.close();
    cache.close();
  });

  it('a count during a read upstream in its ordering goes upstream too', async () => {
    const { cache, proxy } = proxyWith('p16.sqlite');
    await proxy.listen();
    const base = proxy.proxyUrl(upstreamBase) as string;
    await pageOf(base, BOX, 'IDENTIFIER', 0);
    await readLayer(base, BOX, 25, 'DRVAL1');
    assert.strictEqual(cache.stats().areas, 1);
    upstream.seen.length = 0;
    await fetch(
      `${base}?${query('DepthArea_A', BOX, { resultType: 'hits', sortBy: 'IDENTIFIER' })}`
    );
    assert.strictEqual(upstream.seen.length, 1);
    await proxy.close();
    cache.close();
  });

  it('holds no area from a short page alone: it may be the server page limit', async () => {
    const uncounted = upstreamBase.replace(/\/wfs$/, '/uncounted');
    const { cache, proxy } = proxyWith('p17.sqlite', { upstreams: () => [uncounted] });
    await proxy.listen();
    const base = proxy.proxyUrl(uncounted) as string;
    const ids = await pageOf(base, BOX, 'IDENTIFIER', 0, 1000);
    assert.ok(ids.length > 0);
    assert.strictEqual(cache.stats().areas, 0);
    await proxy.close();
    cache.close();
  });

  it('follows a redirect only to a server it proxies, and breaks off a broken reply', async () => {
    const origin = new URL(upstreamBase).origin;
    const servers = ['/redirect-out', '/redirect-in', '/broken', '/wfs'].map((p) => origin + p);
    const { cache, proxy } = proxyWith('p18.sqlite', { upstreams: () => servers });
    await proxy.listen();
    const caps = '?service=WFS&request=GetCapabilities';
    upstream.elsewhere.length = 0;
    const out = await fetch(`${proxy.proxyUrl(`${origin}/redirect-out`) as string}${caps}`);
    assert.strictEqual(out.status, 502);
    assert.deepStrictEqual(upstream.elsewhere, []);
    const inside = await fetch(`${proxy.proxyUrl(`${origin}/redirect-in`) as string}${caps}`);
    assert.strictEqual(inside.status, 200);
    assert.strictEqual(await inside.text(), '<Capabilities/>');
    const broken = await fetch(
      `${proxy.proxyUrl(`${origin}/broken`) as string}?${query('DepthArea_A', BOX, {
        outputFormat: 'application/json',
        count: '10'
      })}`
    );
    await assert.rejects(broken.text());
    await proxy.close();
    cache.close();
  });

  it("holds no area from another read's count, nor from pages that repeat a feature", async () => {
    const origin = new URL(upstreamBase).origin;
    const uncounted = `${origin}/uncounted`;
    const shifting = `${origin}/shifting`;
    const { cache, proxy } = proxyWith('p19.sqlite', { upstreams: () => [uncounted, shifting] });
    await proxy.listen();
    // A count with no ordering, then pages in another that carry none.
    const base = proxy.proxyUrl(uncounted) as string;
    await fetch(`${base}?${query('DepthArea_A', BOX, { resultType: 'hits' })}`);
    await pageOf(base, BOX, 'IDENTIFIER', 0, 1000);
    assert.strictEqual(cache.stats().areas, 0);
    // Four matched, every index covered, three features.
    const moving = proxy.proxyUrl(shifting) as string;
    await pageOf(moving, BOX, 'IDENTIFIER', 0, 2);
    await pageOf(moving, BOX, 'IDENTIFIER', 2, 2);
    assert.strictEqual(cache.stats().areas, 0);
    await proxy.close();
    cache.close();
  });

  it('a read whose pages passed before its count is held when the count comes', async () => {
    const uncounted = upstreamBase.replace(/\/wfs$/, '/uncounted');
    const { cache, proxy } = proxyWith('p20.sqlite', { upstreams: () => [uncounted] });
    await proxy.listen();
    const base = proxy.proxyUrl(uncounted) as string;
    const page = await fetch(
      `${base}?${query('DepthArea_A', BOX, { outputFormat: 'application/json', count: '1000' })}`
    );
    assert.ok(((await page.json()) as { features: unknown[] }).features.length > 0);
    assert.strictEqual(cache.stats().areas, 0);
    await fetch(`${base}?${query('DepthArea_A', BOX, { resultType: 'hits' })}`);
    assert.strictEqual(cache.stats().areas, 1);
    await proxy.close();
    cache.close();
  });

  it('while handing over, answers from the store and begins nothing upstream', async () => {
    const { cache, proxy } = proxyWith('p21.sqlite');
    await proxy.listen();
    const base = proxy.proxyUrl(upstreamBase) as string;
    const held = await readLayer(base, BOX);
    proxy.configure({ handingOver: true });
    upstream.seen.length = 0;
    assert.deepStrictEqual([...(await readLayer(base, BOX))].sort(), [...held].sort());
    const fresh = await fetch(
      `${base}?${query('DepthArea_A', [23, 61, 23.1, 61.1], { resultType: 'hits' })}`
    );
    assert.strictEqual(fresh.status, 503);
    const caps = await fetch(`${base}?service=WFS&request=GetCapabilities`);
    assert.strictEqual(caps.status, 503);
    assert.strictEqual(upstream.seen.length, 0);
    await proxy.close();
    cache.close();
  });

  it('a config save hands the running proxy to the next start', async () => {
    const dataDir = fs.mkdtempSync(path.join(dir, 'service-'));
    const settings = {
      dataDir,
      maxAgeDays: () => 30,
      extraUpstreams: () => ['htps://typo.example/wfs'],
      mayRefresh: () => true,
      log: () => undefined,
      warn: (m: string) => {
        warnings.push(m);
      }
    };
    const warnings: string[] = [];
    const running = await startWfsProxy(settings);
    const url = running.api.proxyUrl(DEFAULT_WFS_UPSTREAMS[0]);
    assert.ok(url !== undefined);
    assert.deepStrictEqual(warnings, [
      'Other WFS servers to keep: entry 1 is not an http or https URL, so it is not proxied'
    ]);
    releaseWfsProxy(running);
    const again = await startWfsProxy({ ...settings, extraUpstreams: () => [] });
    assert.strictEqual(again, running);
    assert.strictEqual(again.api.proxyUrl(DEFAULT_WFS_UPSTREAMS[0]), url);
    await stopWfsProxy(again);
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
