import { after, before, describe, it } from 'node:test';
import assert from 'node:assert';
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';

import {
  answerBox,
  featureBox,
  featureId,
  featureQuery,
  geometryReaches,
  hitsMatched,
  hitsReply,
  pageMatched,
  sortedBy,
  sortOrder,
  uncovered,
  type Box,
  type ByBox,
  type WfsFeature
} from '../dist/utils/wfs-query.js';
import { WfsCache, type Layer, type Pin } from '../dist/utils/wfs-cache.js';
import {
  normalizeUpstream,
  READ_IDLE_MS,
  WfsProxy,
  type WfsSource
} from '../dist/utils/wfs-proxy.js';
import {
  refreshWfsSources,
  releaseWfsProxy,
  startWfsProxy,
  stopWfsProxy,
  wfsOffer,
  wfsSources
} from '../dist/utils/wfs-proxy-service.js';
import { WfsSourceError, WfsSourceList } from '../dist/utils/wfs-sources.js';

/** The fake upstream's grid is turned by about 6°: it answers this far past a box. */
const MARGIN = 0.12;
const BY_BOX: ByBox = { margin: MARGIN };
const grown = (box: Box): Box => answerBox(box, MARGIN);
const byBoxSources =
  (...urls: string[]) =>
  (): WfsSource[] =>
    urls.map((url) => ({ url, byBox: BY_BOX }));

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

/** An upstream WFS over AREAS, read in a grid turned against latitude and longitude. */
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
    if (url.pathname === '/redirect-other') {
      // To the same server, asking for pages twice the size asked for.
      const other = new URLSearchParams(url.searchParams);
      const count = other.get('count');
      if (count !== null) {
        other.set('count', String(Number(count) * 2));
      }
      res.writeHead(302, { location: `/wfs?${other.toString()}` }).end();
      return;
    }
    if (url.pathname === '/busy') {
      res.writeHead(503, { 'content-type': 'text/plain', 'retry-after': '7' }).end('busy');
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
    // The box read in a turned grid, so a little past it too.
    const turned = grown(q.box);
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

/** The query a peer plugin sends for `box`, `[west, south, east, north]`. */
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

/** A layer read as a peer plugin reads it: the count, then pages of `size` sorted by IDENTIFIER. */
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
  it('reads a GetFeature as a box in longitude, latitude', () => {
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
    // Each case differs from an answerable page in the field it names alone.
    const page = { ...json, count: '25' };
    assert.ok(featureQuery(new URLSearchParams(query('A', [22, 60, 22.5, 60.2], page))));
    const cases = [
      // GML, not GeoJSON
      query('A', [22, 60, 22.5, 60.2], { count: '25' }),
      // a box in another reference system
      new URLSearchParams({
        service: 'WFS',
        version: '2.0.0',
        request: 'GetFeature',
        typeNames: 'A',
        bbox: '200000,6600000,300000,6700000',
        srsName: 'EPSG:4326',
        ...page
      }).toString(),
      // the answerable box, named in another reference system
      new URLSearchParams({
        service: 'WFS',
        version: '2.0.0',
        request: 'GetFeature',
        typeNames: 'A',
        bbox: '60,22,60.2,22.5,urn:ogc:def:crs:EPSG::3067',
        srsName: 'EPSG:4326',
        ...page
      }).toString(),
      // a filter the cache does not apply
      `${query('A', [22, 60, 22.5, 60.2], page)}&cql_filter=DRVAL1>5`,
      // two feature types
      query('A,B', [22, 60, 22.5, 60.2], page),
      // no srsName: the reply is in the feature type's own system
      new URLSearchParams({
        service: 'WFS',
        version: '2.0.0',
        request: 'GetFeature',
        typeNames: 'A',
        bbox: '60,22,60.2,22.5,urn:ogc:def:crs:EPSG::4326',
        ...page
      }).toString(),
      new URLSearchParams({ service: 'WFS', request: 'GetCapabilities' }).toString(),
      // a page with no page size: the server's own default, unknown here
      query('A', [22, 60, 22.5, 60.2], json),
      // a count asked for in a format other than the default XML
      query('A', [22, 60, 22.5, 60.2], { ...json, resultType: 'hits' }),
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
    // Only the document element counts: not a comment, nor an element after it.
    assert.strictEqual(
      hitsMatched(
        '<?xml version="1.0"?>\n<!-- <wfs:FeatureCollection numberMatched="5"/> -->\n<wfs:FeatureCollection numberMatched="0"/>'
      ),
      0
    );
    assert.strictEqual(
      hitsMatched('<!-- <wfs:FeatureCollection numberMatched="5"/> --><ows:ExceptionReport/>'),
      undefined
    );
    assert.strictEqual(
      hitsMatched(
        '<ows:ExceptionReport><wfs:FeatureCollection numberMatched="5"/></ows:ExceptionReport>'
      ),
      undefined
    );
    // Nor an attribute whose value only holds the text.
    assert.strictEqual(
      hitsMatched('<wfs:FeatureCollection note=" numberMatched=\'5\'" numberMatched="2"/>'),
      2
    );
    assert.strictEqual(
      hitsMatched('<wfs:FeatureCollection note=" numberMatched=\'5\'"/>'),
      undefined
    );
    const reply = hitsReply(7, new Date(0));
    assert.strictEqual(hitsMatched(reply), 7);
    assert.ok(reply.includes('timeStamp="1970-01-01T00:00:00.000Z"'));
  });

  it("a feature's id and box", () => {
    const f = AREAS[3] as Feature;
    assert.strictEqual(featureId(f), JSON.stringify(f.id));
    assert.strictEqual(featureId(f, 'IDENTIFIER'), JSON.stringify(f.id));
    // GeoJSON's number 1 and string "1" are two ids.
    assert.notStrictEqual(featureId({ id: 1 }), featureId({ id: '1' }));
    assert.notStrictEqual(
      featureId({ properties: { IDENTIFIER: 1 } }, 'IDENTIFIER'),
      featureId({ properties: { IDENTIFIER: '1' } }, 'IDENTIFIER')
    );
    assert.strictEqual(featureId({ properties: { IDENTIFIER: 7 } }), undefined);
    assert.strictEqual(featureId({ properties: { IDENTIFIER: 7 } }, 'IDENTIFIER'), '7');
    assert.strictEqual(featureId({ properties: {} }, 'IDENTIFIER'), undefined);
    const [w, s, e, n] = featureBox(f) as Box;
    assert.ok(Math.abs(e - w - 0.01) < 1e-12 && Math.abs(n - s - 0.01) < 1e-12);
    assert.strictEqual(featureBox({ geometry: null }), undefined);
    // A position it cannot read leaves the box unknown, not smaller.
    assert.strictEqual(
      featureBox({
        geometry: {
          type: 'LineString',
          coordinates: [
            [22, 60],
            [null, 61]
          ]
        }
      }),
      undefined
    );
    // Metres, not degrees: no box this store places.
    assert.strictEqual(
      featureBox({ geometry: { type: 'Point', coordinates: [240000, 6680000] } }),
      undefined
    );
  });

  it('answerBox: grown by the margin a turned grid adds, each way by the other side', () => {
    const [w, s, e, n] = answerBox([22, 60, 22.2, 60.1], MARGIN);
    const cos = Math.cos((60.05 * Math.PI) / 180);
    // East and west by the box's height, north and south by its width.
    assert.ok(Math.abs(22 - w - (MARGIN * 0.1) / cos) < 1e-9);
    assert.ok(Math.abs(60 - s - MARGIN * 0.2 * cos) < 1e-9);
    assert.ok(e > 22.2 && n > 60.1);
    assert.deepStrictEqual(answerBox([22, 60, 22.2, 60.1], 0), [22, 60, 22.2, 60.1]);
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
    // Numbers and text in one property: numbers first, as SQLite orders them, so the order is
    // the same whatever order the features come in.
    const mixed = [10, '5', 9, 'a', 100].map((v) => ({ properties: { v } }));
    const values = (items: typeof mixed): unknown[] =>
      sortedBy(items, (f) => f, { property: 'v', descending: false }).map((f) => f.properties.v);
    assert.deepStrictEqual(values(mixed), [9, 10, 100, '5', 'a']);
    assert.deepStrictEqual(values([...mixed].reverse()), [9, 10, 100, '5', 'a']);
  });

  it('geometryReaches: a geometry reaches a box it crosses, holds, lies in or touches', () => {
    const box: Box = [0, 3, 1, 4];
    const line = (coordinates: number[][]): WfsFeature => ({
      geometry: { type: 'LineString', coordinates }
    });
    // The line's box reaches the box, but the line passes it by.
    assert.strictEqual(
      geometryReaches(
        line([
          [0, 0],
          [4, 4]
        ]),
        box
      ),
      false
    );
    assert.strictEqual(
      geometryReaches(
        line([
          [0, 0],
          [4, 4]
        ]),
        [3, 3, 5, 5]
      ),
      true
    );
    assert.strictEqual(
      geometryReaches(
        line([
          [-1, 3.5],
          [2, 3.5]
        ]),
        box
      ),
      true
    );
    // On the edge is in the box.
    assert.strictEqual(
      geometryReaches(
        line([
          [1, 0],
          [1, 10]
        ]),
        box
      ),
      true
    );
    assert.strictEqual(
      geometryReaches({ geometry: { type: 'Point', coordinates: [1, 4] } }, box),
      true
    );
    assert.strictEqual(
      geometryReaches(
        {
          geometry: {
            type: 'MultiPoint',
            coordinates: [
              [2, 2],
              [0.5, 3.5]
            ]
          }
        },
        box
      ),
      true
    );
    assert.strictEqual(
      geometryReaches({ geometry: { type: 'MultiPoint', coordinates: [[2, 2]] } }, box),
      false
    );
    const square = (w: number, s: number, e: number, n: number): number[][] => [
      [w, s],
      [e, s],
      [e, n],
      [w, n],
      [w, s]
    ];
    const polygon = (...rings: number[][][]): WfsFeature => ({
      geometry: { type: 'Polygon', coordinates: rings }
    });
    // A polygon holding the box reaches it; a hole holding it does not.
    assert.strictEqual(geometryReaches(polygon(square(-5, -5, 5, 10)), box), true);
    assert.strictEqual(
      geometryReaches(polygon(square(-5, -5, 5, 10), square(-1, 2, 2, 5)), box),
      false
    );
    // A triangle whose box holds the box but which lies past its corner.
    assert.strictEqual(
      geometryReaches(
        polygon([
          [2, 0],
          [4, 0],
          [4, 5],
          [2, 0]
        ]),
        box
      ),
      false
    );
    assert.strictEqual(
      geometryReaches(
        {
          geometry: {
            type: 'MultiPolygon',
            coordinates: [[square(5, 5, 6, 6)], [square(0.2, 3.2, 0.4, 3.4)]]
          }
        },
        box
      ),
      true
    );
    // Geometries it cannot tell about are not left out.
    assert.strictEqual(
      geometryReaches({ geometry: { type: 'GeometryCollection', coordinates: [] } }, box),
      undefined
    );
    assert.strictEqual(
      geometryReaches({ geometry: { type: 'Point', coordinates: [[1, 2]] } }, box),
      undefined
    );
    // Nor is one nested unevenly: a position where a line should be.
    const uneven: WfsFeature = {
      geometry: {
        type: 'MultiLineString',
        coordinates: [
          [
            [22, 60],
            [24, 60]
          ],
          [23, 62]
        ]
      }
    };
    assert.strictEqual(geometryReaches(uneven, [22.9, 61, 23.1, 61.2]), undefined);
  });
});

/** `features` kept as a whole read of `box` begun at `at`. */
function keepWhole(
  cache: WfsCache,
  layer: Layer,
  features: readonly WfsFeature[],
  box: Box,
  at: number,
  exact = false
): number | undefined {
  const stage = cache.beginStage();
  assert.ok(cache.stage(stage, features, at));
  return cache.publish(
    stage,
    layer,
    { box, boxText: box.join(',') },
    at,
    exact ? undefined : BY_BOX
  );
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

  it('answers a box only with the features whose geometry reaches it', () => {
    const cache = new WfsCache(path.join(dir, 'geometry.sqlite'));
    const diagonal: WfsFeature = {
      id: 'diagonal',
      geometry: {
        type: 'LineString',
        coordinates: [
          [22, 60],
          [22.04, 60.04]
        ]
      },
      properties: {}
    };
    keepWhole(cache, layer, [diagonal, ...AREAS.slice(0, 5)], [21.9, 59.9, 22.1, 60.1], 1);
    const answered = (box: Box): unknown[] => {
      const pin = cache.answerIn(layer, box, box) as Pin;
      const ids = pin.features(pin.ids).map((f) => f.id);
      pin.release();
      return ids;
    };
    // Its box reaches this corner, the line does not.
    const corner: Box = [22.0, 60.03, 22.01, 60.04];
    assert.ok(cache.features(cache.idsIn(layer, corner)).some((f) => f.id === 'diagonal'));
    assert.ok(!answered(corner).includes('diagonal'));
    assert.ok(answered([22.02, 60.02, 22.03, 60.03]).includes('diagonal'));
    // A geometry it cannot tell about is answered, not an error.
    const uneven: WfsFeature = {
      id: 'uneven',
      geometry: {
        type: 'MultiLineString',
        coordinates: [
          [
            [22, 60],
            [22.04, 60]
          ],
          [22.02, 60.08]
        ]
      },
      properties: {}
    };
    keepWhole(cache, layer, [uneven], [21.9, 59.9, 22.1, 60.1], 2);
    assert.ok(answered([22.019, 60.05, 22.021, 60.06]).includes('uneven'));
    cache.close();
  });

  it('refuses a page with a feature it could not find again', () => {
    const cache = new WfsCache(path.join(dir, 'b.sqlite'));
    const stage = cache.beginStage();
    assert.strictEqual(cache.stage(stage, [AREAS[0] as Feature, { properties: {} }], 1), false);
    // Nor one with a feature that is not one at all.
    for (const junk of [null, 'x', [AREAS[0]]]) {
      assert.strictEqual(
        cache.stage(stage, [AREAS[0] as Feature, junk as unknown as WfsFeature], 1),
        false
      );
    }
    assert.strictEqual(cache.stagedCount(stage), 0);
    cache.publish(stage, layer, { box: WIDE, boxText: 'w' }, 1, BY_BOX);
    assert.strictEqual(cache.stats().features, 0);
    cache.close();
  });

  it('a box is held by the boxes fetched since a time', () => {
    const cache = new WfsCache(path.join(dir, 'c.sqlite'));
    const held = (box: Box, at: number) =>
      cache.publish(undefined, layer, { box, boxText: box.join(',') }, at, BY_BOX);
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

  it('a read keeps no area where a feature it did not see was kept after it began', () => {
    const cache = new WfsCache(path.join(dir, 'j.sqlite'));
    const box: Box = [22, 60, 22.1, 60.1];
    const [a, p, q] = [AREAS[0], AREAS[1], AREAS[2]] as [Feature, Feature, Feature];
    // Q kept at 5, before any read below began.
    keepWhole(cache, layer, [q], [22, 60.02, 22.01, 60.03], 5);
    // Read C begins at 10 and keeps P when its page comes, at 30.
    const c = cache.beginStage();
    assert.ok(cache.stage(c, [p], 30));
    // Read B begins at 20; its page, received at 35, gives A alone.
    const b = cache.beginStage();
    assert.ok(cache.stage(b, [a], 35));
    assert.strictEqual(
      cache.publish(c, layer, { box: [22, 60.01, 22.01, 60.02], boxText: 'c' }, 10, BY_BOX),
      0
    );
    // B cannot tell whether P, kept at 30, is gone: it is not kept, and P stays.
    assert.strictEqual(cache.publish(b, layer, { box, boxText: 'b' }, 20, BY_BOX), undefined);
    assert.deepStrictEqual(
      cache
        .features(cache.idsIn(layer, box))
        .map((f) => f.id)
        .sort(),
      [p.id, q.id].sort()
    );
    // A read begun at 40, after P and Q were kept, giving A alone: both are gone upstream.
    const later = cache.beginStage();
    assert.ok(cache.stage(later, [a], 45));
    assert.strictEqual(cache.publish(later, layer, { box, boxText: 'later' }, 40, BY_BOX), 2);
    assert.deepStrictEqual(
      cache.features(cache.idsIn(layer, box)).map((f) => f.id),
      [a.id]
    );
    cache.close();
  });

  it('a read keeps no area where a feature crossing its edge was kept after it began', () => {
    const cache = new WfsCache(path.join(dir, 'k.sqlite'));
    const box: Box = [22, 60, 22.1, 60.1];
    const [crossing, outside] = [area(900, 22.095, 60.02), area(901, 22.15, 60.02)];
    // Read C of a wider box begins at 10 and keeps both when its page comes, at 30.
    const c = cache.beginStage();
    assert.ok(cache.stage(c, [crossing, outside], 30));
    assert.strictEqual(
      cache.publish(c, layer, { box: [22, 60, 22.2, 60.1], boxText: 'c' }, 10, BY_BOX),
      0
    );
    // Read B of the narrower box began at 20 and found it empty: the crossing one may be gone.
    assert.strictEqual(
      cache.publish(undefined, layer, { box, boxText: 'b' }, 20, BY_BOX),
      undefined
    );
    // Had B given the crossing one, or had only the outside one been kept, B is kept.
    const b = cache.beginStage();
    assert.ok(cache.stage(b, [crossing], 35));
    assert.strictEqual(cache.publish(b, layer, { box, boxText: 'b2' }, 20, BY_BOX), 0);
    const other = new WfsCache(path.join(dir, 'l.sqlite'));
    const o = other.beginStage();
    assert.ok(other.stage(o, [outside], 30));
    assert.strictEqual(
      other.publish(o, layer, { box: [22, 60, 22.2, 60.1], boxText: 'c' }, 10, BY_BOX),
      0
    );
    assert.strictEqual(other.publish(undefined, layer, { box, boxText: 'b' }, 20, BY_BOX), 0);
    other.close();
    cache.close();
  });

  it('an older read is not kept over a newer one of an area overlapping it', () => {
    const cache = new WfsCache(path.join(dir, 'i.sqlite'));
    const older = cache.beginStage();
    assert.ok(cache.stage(older, AREAS.slice(0, 3), 1));
    // A newer read of the box found it empty, and was kept first.
    assert.strictEqual(
      cache.publish(undefined, layer, { box: WIDE, boxText: 'newer' }, 5, BY_BOX),
      0
    );
    assert.strictEqual(
      cache.publish(older, layer, { box: [22, 60, 22.1, 60.1], boxText: 'older' }, 1, BY_BOX),
      undefined
    );
    assert.strictEqual(cache.stats().features, 0);
    assert.strictEqual(cache.stagedCount(older), 0);
    cache.close();
  });

  it('of reads begun in the same millisecond, the one begun later is kept', () => {
    for (const byBox of [undefined, BY_BOX]) {
      const cache = new WfsCache(path.join(dir, `m-${byBox ? 'box' : 'exact'}.sqlite`));
      const whole = { box: WIDE, boxText: WIDE.join(',') };
      const first = cache.beginStage();
      const second = cache.beginStage();
      assert.ok(cache.stage(first, [AREAS[0] as Feature], 12));
      assert.ok(cache.stage(second, [], 11));
      // The one begun second found the area empty, and was kept first.
      assert.strictEqual(cache.publish(second, layer, whole, 10, byBox), 0);
      const held = cache.exactCover(layer, whole.boxText, 0);
      assert.strictEqual(cache.publish(first, layer, whole, 10, byBox), undefined);
      assert.strictEqual(cache.exactCover(layer, whole.boxText, 0), held);
      assert.strictEqual(cache.stats().features, 0);
      // Kept in the order they began, the later one replaces the earlier.
      const third = cache.beginStage();
      assert.ok(cache.stage(third, [], 21));
      assert.strictEqual(cache.publish(third, layer, whole, 20, byBox), 0);
      const fourth = cache.beginStage();
      assert.ok(cache.stage(fourth, [AREAS[2] as Feature], 21));
      assert.strictEqual(cache.publish(fourth, layer, whole, 20, byBox), 0);
      const answer = byBox
        ? cache.pinIn(layer, WIDE)
        : cache.pinArea(cache.exactCover(layer, whole.boxText, 0) as number);
      assert.deepStrictEqual(
        answer.features(answer.ids).map((f) => f.id),
        [AREAS[2]?.id]
      );
      answer.release();
      cache.close();
    }
  });

  it('a box read again whole does not answer a feature reaching past it that it did not return', () => {
    const cache = new WfsCache(path.join(dir, 'n.sqlite'));
    const box: Box = [22, 60, 22.1, 60.1];
    const east: Box = [22.1, 60, 22.2, 60.1];
    const crossing = area(910, 22.095, 60.02);
    const inside = area(911, 22.05, 60.05);
    keepWhole(cache, layer, [crossing, inside], [22, 60, 22.2, 60.1], 1);
    // Read again, the box gives only the one inside it.
    assert.strictEqual(keepWhole(cache, layer, [inside], box, 5), 0);
    const ids = (pin: Pin | undefined): unknown[] => {
      assert.ok(pin);
      const out = pin.features(pin.ids).map((f) => f.id);
      pin.release();
      return out;
    };
    assert.deepStrictEqual(ids(cache.answerIn(layer, box, box)), [inside.id]);
    // It is kept: where it reaches past the box, nothing says it is gone.
    assert.strictEqual(cache.idsIn(layer, box).length, 2);
    assert.deepStrictEqual(ids(cache.answerIn(layer, east, east)), [crossing.id]);
    // Where it reaches the box and past it, the store cannot tell.
    assert.strictEqual(cache.answerIn(layer, [22.05, 60, 22.15, 60.1], WIDE), undefined);
    // Returned by a later read of the box, it is answered again.
    assert.strictEqual(keepWhole(cache, layer, [crossing, inside], box, 9), 0);
    assert.deepStrictEqual(ids(cache.answerIn(layer, box, box)), [inside.id, crossing.id].sort());
    assert.deepStrictEqual(
      ids(cache.answerIn(layer, [22.05, 60, 22.15, 60.1], WIDE)),
      [inside.id, crossing.id].sort()
    );
    cache.close();
  });

  const answered = (pin: Pin | undefined): unknown[] | undefined => {
    if (!pin) {
      return undefined;
    }
    const out = pin
      .features(pin.ids)
      .map((f) => f.id)
      .sort();
    pin.release();
    return out;
  };

  it('a line on the edge of a box read again whole that did not return it is not answered there', () => {
    const cache = new WfsCache(path.join(dir, 'o.sqlite'));
    const box: Box = [22, 60, 22.1, 60.1];
    const line = {
      type: 'Feature',
      id: 'edge-line',
      geometry: {
        type: 'LineString',
        coordinates: [
          [22.1, 60.05],
          [22.1, 60.15]
        ]
      },
      properties: {}
    };
    keepWhole(cache, layer, [line], [22, 60, 22.2, 60.2], 1);
    // Read again, the box gives nothing: the line reaches past it, so it is kept.
    assert.strictEqual(keepWhole(cache, layer, [], box, 5), 0);
    assert.deepStrictEqual(answered(cache.answerIn(layer, box, box)), []);
    // Where it lies on the box's edge and past it, the store cannot tell.
    assert.strictEqual(cache.answerIn(layer, [22.05, 60.05, 22.15, 60.2], WIDE), undefined);
    // Past the box, nothing says it is gone.
    const north: Box = [22.05, 60.12, 22.15, 60.2];
    assert.deepStrictEqual(answered(cache.answerIn(layer, north, north)), ['edge-line']);
    cache.close();
  });

  it('leaves out a feature in the margin of a box that a read of the box did not return', () => {
    const cache = new WfsCache(path.join(dir, 'p.sqlite'));
    const box: Box = [22, 60, 22.1, 60.1];
    const margin = grown(box);
    const point = (id: string, x: number) => ({
      type: 'Feature',
      id,
      geometry: { type: 'Point', coordinates: [x, 60.05] },
      properties: {}
    });
    const omitted = point('omitted', box[2] + (margin[2] - box[2]) / 2);
    const returned = point('returned', box[0] - (box[0] - margin[0]) / 2);
    keepWhole(cache, layer, [omitted, returned], WIDE, 1);
    // Read again, the box returns the one in its west margin alone.
    assert.strictEqual(keepWhole(cache, layer, [returned], box, 5), 0);
    assert.deepStrictEqual(answered(cache.answerIn(layer, box, margin)), ['returned']);
    // It is kept for an area where it lies inside.
    const east: Box = [22.1, 60, 22.2, 60.1];
    assert.deepStrictEqual(answered(cache.answerIn(layer, east, east)), ['omitted']);
    cache.close();
  });

  it("another area returning a feature does not answer it where a box's read did not return it", () => {
    const cache = new WfsCache(path.join(dir, 'q.sqlite'));
    const box: Box = [22, 60, 22.1, 60.1];
    const east: Box = [22.1, 60, 22.2, 60.1];
    const crossing = area(920, 22.095, 60.02);
    keepWhole(cache, layer, [crossing], [22, 60, 22.2, 60.1], 1);
    assert.strictEqual(keepWhole(cache, layer, [], box, 5), 0);
    assert.deepStrictEqual(answered(cache.answerIn(layer, box, box)), []);
    // The area east of the box returns it: whether it belongs to the box, only the box can say.
    assert.strictEqual(keepWhole(cache, layer, [crossing], east, 9), 0);
    assert.strictEqual(cache.answerIn(layer, box, box), undefined);
    assert.deepStrictEqual(answered(cache.answerIn(layer, east, east)), [crossing.id]);
    // The box read again says.
    assert.strictEqual(keepWhole(cache, layer, [], box, 12), 0);
    assert.deepStrictEqual(answered(cache.answerIn(layer, box, box)), []);
    assert.strictEqual(keepWhole(cache, layer, [crossing], box, 15), 0);
    assert.deepStrictEqual(answered(cache.answerIn(layer, box, box)), [crossing.id]);
    // A feature new to the store, from a page that came before the box's read began: the box
    // did not return it, so it is not answered there.
    const late = area(921, 22.095, 60.05);
    const other = cache.beginStage();
    assert.ok(cache.stage(other, [late], 14));
    assert.strictEqual(
      cache.publish(other, layer, { box: [22.1, 60.04, 22.2, 60.1], boxText: 'ne' }, 13, BY_BOX),
      0
    );
    assert.deepStrictEqual(answered(cache.answerIn(layer, box, box)), [crossing.id]);
    cache.close();
  });

  it('a feature that moved into a box held already is not answered there until the box says', () => {
    const cache = new WfsCache(path.join(dir, 'r.sqlite'));
    const box: Box = [22, 60, 22.1, 60.1];
    const east: Box = [22.15, 60, 22.25, 60.1];
    const before = area(930, 22.2, 60.05);
    keepWhole(cache, layer, [before], [22, 60, 22.3, 60.1], 1);
    assert.strictEqual(keepWhole(cache, layer, [], box, 5), 0);
    // A read east of the box gives it moved into the box, which never saw it there.
    const moved = { ...area(930, 22.095, 60.05), id: before.id };
    assert.strictEqual(keepWhole(cache, layer, [moved], east, 9), 0);
    assert.strictEqual(cache.answerIn(layer, box, box), undefined);
    assert.strictEqual(keepWhole(cache, layer, [moved], box, 12), 0);
    assert.deepStrictEqual(answered(cache.answerIn(layer, box, box)), [before.id]);
    cache.close();
  });

  it("a newer box holding an older one is not its replacement where the older one's answer reached further", () => {
    const cache = new WfsCache(path.join(dir, 's.sqlite'));
    const older: Box = [22, 60, 22.2, 60.1];
    const newer: Box = [22, 60, 22.2, 61];
    // South of the older box, inside its answer's margin and outside the newer one's.
    const south = {
      type: 'Feature',
      id: 'south',
      geometry: { type: 'Point', coordinates: [22.1, 59.9881] },
      properties: {}
    };
    assert.ok(grown(older)[1] < 59.9881 && grown(newer)[1] > 59.9881);
    keepWhole(cache, layer, [south], WIDE, 1);
    assert.strictEqual(keepWhole(cache, layer, [], older, 5), 0);
    assert.deepStrictEqual(answered(cache.answerIn(layer, older, grown(older))), []);
    // The newer box's answer does not reach the point, so it says nothing of it.
    assert.strictEqual(keepWhole(cache, layer, [], newer, 9), 0);
    assert.deepStrictEqual(answered(cache.answerIn(layer, older, grown(older))), []);
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
    keepWhole(cache, layer, AREAS.slice(0, 3), box, 1, true);
    // Another box gives the same feature changed: the first box keeps it as it gave it.
    keepWhole(
      cache,
      layer,
      [{ ...f, properties: { ...f.properties, DRVAL1: 99 } }],
      other,
      2,
      true
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

  it('tells what each source keeps, by feature type, and how much of it is stale', () => {
    const cache = new WfsCache(path.join(dir, 'stats.sqlite'));
    const other: Layer = { upstream: 'https://other.example/wfs', typeName: 'Soundings' };
    keepWhole(cache, layer, AREAS.slice(0, 3), [22, 60, 22.05, 60.05], 100);
    keepWhole(cache, layer, AREAS.slice(3, 5), [22.05, 60, 22.1, 60.05], 300);
    keepWhole(cache, other, AREAS.slice(0, 2), [22, 60, 22.1, 60.1], 200, true);
    const stats = cache.sourceStats(250);
    const mine = stats.find((s) => s.upstream === layer.upstream);
    assert.ok(mine);
    assert.strictEqual(mine.areas, 2);
    assert.strictEqual(mine.staleAreas, 1);
    assert.strictEqual(mine.features, 5);
    assert.ok(mine.bytes > 0);
    assert.deepStrictEqual([mine.oldest, mine.newest], [100, 300]);
    assert.deepStrictEqual(
      mine.layers.map((l) => l.typeName),
      [layer.typeName]
    );
    const theirs = stats.find((s) => s.upstream === other.upstream);
    assert.strictEqual(theirs?.features, 2);
    assert.strictEqual(theirs.staleAreas, 1);
    cache.close();
  });

  it('forgets one upstream, everything, or the upstreams no longer listed', () => {
    const cache = new WfsCache(path.join(dir, 'forget.sqlite'));
    const other: Layer = { upstream: 'https://other.example/wfs', typeName: 'Soundings' };
    const fill = (): void => {
      keepWhole(cache, layer, AREAS.slice(0, 3), [22, 60, 22.05, 60.05], 1);
      keepWhole(cache, other, AREAS.slice(0, 2), [22, 60, 22.1, 60.1], 2, true);
    };
    const upstreams = (): string[] =>
      cache
        .sourceStats(0)
        .map((s) => s.upstream)
        .sort();
    fill();
    // A read from the store keeps what it pinned.
    const pin = cache.pinIn(layer, WIDE);
    assert.strictEqual(cache.forgetUpstream(layer.upstream), true);
    assert.strictEqual(cache.forgetUpstream(layer.upstream), false);
    assert.deepStrictEqual(upstreams(), [other.upstream]);
    assert.strictEqual(pin.features(pin.ids).length, 3);
    pin.release();
    cache.clear();
    assert.deepStrictEqual(upstreams(), []);
    fill();
    cache.useRule(other.upstream, 'exact');
    assert.deepStrictEqual(cache.keepOnly([layer.upstream]), [other.upstream]);
    assert.deepStrictEqual(upstreams(), [layer.upstream]);
    // Its rule went with it: listed again, it starts afresh.
    assert.strictEqual(cache.useRule(other.upstream, 'box'), false);
    cache.close();
  });

  it('keeps no read begun before what its upstream kept was deleted', () => {
    const cache = new WfsCache(path.join(dir, 'forgotten.sqlite'));
    const begun = cache.orderAt(10);
    const before = cache.beginStage();
    assert.ok(cache.stage(before, AREAS.slice(0, 3), begun));
    cache.forgetUpstream(layer.upstream);
    assert.strictEqual(
      cache.publish(before, layer, { box: WIDE, boxText: 'w' }, begun, BY_BOX),
      undefined
    );
    const later = cache.orderAt(11);
    const after = cache.beginStage();
    assert.ok(cache.stage(after, AREAS.slice(0, 3), later));
    assert.strictEqual(cache.publish(after, layer, { box: WIDE, boxText: 'w' }, later, BY_BOX), 0);
    assert.strictEqual(cache.stats().features, 3);
    cache.close();
  });

  it('within its space, drops the areas read longest ago and the features only they reached', () => {
    const cache = new WfsCache(path.join(dir, 'fit.sqlite'));
    const big = (i: number, x: number): WfsFeature => ({
      ...area(1000 + i, x, 60.5),
      properties: {
        IDENTIFIER: `big${String(i)}`,
        DRVAL1: 0,
        filler: crypto.randomBytes(40_000).toString('hex')
      }
    });
    for (let i = 0; i < 6; i++) {
      const x = 22 + i * 0.1;
      keepWhole(cache, layer, [big(i, x)], [x, 60.5, x + 0.01, 60.51], 10 + i);
    }
    assert.strictEqual(cache.fit(0), 0);
    assert.strictEqual(cache.fit(cache.usedBytes() * 10), 0);
    const limit = cache.usedBytes() / 2;
    const dropped = cache.fit(limit);
    assert.ok(dropped >= 2 && dropped < 6, `dropped ${String(dropped)}`);
    assert.ok(cache.usedBytes() <= limit * 1.2);
    const left = cache.sourceStats(0)[0];
    assert.strictEqual(left?.areas, 6 - dropped);
    assert.strictEqual(left.features, 6 - dropped);
    // The newest areas stay.
    assert.strictEqual(left.newest, 15);
    assert.ok(cache.covers(layer, [22.5, 60.5, 22.51, 60.51], 0));
    assert.ok(!cache.covers(layer, [22, 60.5, 22.01, 60.51], 0));
    // However small the space, the area read last stays.
    cache.fit(1);
    assert.strictEqual(cache.sourceStats(0)[0]?.areas, 1);
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
    const urls = opts.upstreams ?? (() => [upstreamBase]);
    const proxy = new WfsProxy({
      cache,
      sources: () => urls().map((url) => (opts.byBox === false ? { url } : { url, byBox: BY_BOX })),
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
    const partial = await fetch(
      `${base}?${query('DepthArea_A', BOX, {
        outputFormat: 'application/json',
        sortBy: 'IDENTIFIER',
        count: '10',
        startIndex: '0'
      })}`
    );
    assert.strictEqual(partial.status, 200);
    const body = (await partial.json()) as { features: Feature[] };
    assert.strictEqual(body.features.length, 10);
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

  it("a clock set back keeps reads in order but does not make an area's age younger", async () => {
    let now = 100 * (READ_IDLE_MS + 5000);
    const { cache, proxy } = proxyWith('p3b.sqlite', { now: () => now });
    await proxy.listen();
    const base = proxy.proxyUrl(upstreamBase) as string;
    await readLayer(base, BOX);
    now = 0;
    const other: Box = [22.02, 60.06, 22.12, 60.1];
    const held = await readLayer(base, other);
    upstream.seen.length = 0;
    assert.deepStrictEqual([...(await readLayer(base, other))].sort(), [...held].sort());
    assert.strictEqual(upstream.seen.length, 0);
    // Past the maximum age (1 s) of the time it was read, not of its place in the order.
    now += READ_IDLE_MS + 5000;
    await readLayer(base, other);
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

  it("drops a source's kept areas when its rule changes, and keeps them when it does not", async () => {
    const { cache, proxy } = proxyWith('p-rule.sqlite');
    await proxy.listen();
    await readLayer(proxy.proxyUrl(upstreamBase) as string, BOX);
    const held = cache.stats();
    assert.ok(held.areas > 0 && held.features > 0);
    proxy.configure({ sources: byBoxSources(upstreamBase) });
    assert.deepStrictEqual(cache.stats().areas, held.areas);
    proxy.configure({ sources: () => [{ url: upstreamBase, byBox: { margin: 0.2 } }] });
    assert.strictEqual(cache.stats().areas, 0);
    assert.strictEqual(cache.stats().features, 0);
    await proxy.close();
    cache.close();
  });

  it("identifies features by the source's id property when they have no id", async () => {
    const plain = AREAS.slice(0, 3).map(({ id: _id, ...f }) => f);
    const server = http.createServer((req, res) => {
      const q = featureQuery(new URL(req.url ?? '/', 'http://x').searchParams);
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        q?.hits === true
          ? `<wfs:FeatureCollection numberMatched="${String(plain.length)}"/>`
          : JSON.stringify({
              type: 'FeatureCollection',
              numberMatched: plain.length,
              features: plain
            })
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/wfs`;
    try {
      for (const idProperty of [undefined, 'IDENTIFIER']) {
        const cache = new WfsCache(path.join(dir, `p-id-${String(idProperty)}.sqlite`));
        const proxy = new WfsProxy({
          cache,
          sources: () => [{ url, byBox: BY_BOX, ...(idProperty ? { idProperty } : {}) }],
          maxAgeMs: () => 1000,
          mayRefresh: () => true
        });
        await proxy.listen();
        await readLayer(proxy.proxyUrl(url) as string, BOX);
        assert.strictEqual(cache.stats().areas, idProperty ? 1 : 0);
        await proxy.close();
        cache.close();
      }
    } finally {
      server.close();
    }
  });

  it("drops what a source no longer proxied kept, and keeps the others'", async () => {
    const { cache, proxy } = proxyWith('p-unlisted.sqlite');
    await proxy.listen();
    await readLayer(proxy.proxyUrl(upstreamBase) as string, BOX);
    const other = 'https://other.example/wfs';
    proxy.configure({ sources: byBoxSources(upstreamBase, other) });
    assert.ok(cache.stats().areas > 0);
    proxy.configure({ sources: byBoxSources(other) });
    assert.strictEqual(cache.stats().areas, 0);
    assert.strictEqual(proxy.proxyUrl(upstreamBase), undefined);
    await proxy.close();
    cache.close();
  });

  it('keeps its port when it is free', async () => {
    const { cache, proxy } = proxyWith('p5.sqlite');
    const port = await proxy.listen();
    await proxy.close();
    const again = new WfsProxy({
      cache,
      sources: byBoxSources(upstreamBase),
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
    // A count begins the next read, from the store now.
    await fetch(`${base}?${query('DepthArea_A', BOX, { resultType: 'hits' })}`);
    const pageAt = (box: Box, start: number) =>
      fetch(
        `${base}?${query('DepthArea_A', box, {
          outputFormat: 'application/json',
          sortBy: 'IDENTIFIER',
          count: '10',
          startIndex: String(start)
        })}`
      ).then(async (r) => ((await r.json()) as { features: Feature[] }).features.map((f) => f.id));
    const baseline: Feature['id'][] = [];
    for (let start = 0; ; start += 10) {
      const next = await pageAt(BOX, start);
      if (next.length === 0) {
        break;
      }
      baseline.push(...next);
    }
    assert.ok(baseline.length > 10);
    upstream.seen.length = 0;
    // A scan's first page, then forty other areas inside the one held, each its own read from
    // the store, then the rest of the scan.
    const ids = await pageAt(BOX, 0);
    for (let k = 0; k < 40; k++) {
      const d = k * 0.001;
      await pageAt([22.03 + d, 60.03, 22.06 + d, 60.05], 0);
    }
    for (let start = 10; start < baseline.length; start += 10) {
      ids.push(...(await pageAt(BOX, start)));
    }
    assert.deepStrictEqual(ids, baseline);
    assert.strictEqual(upstream.seen.length, 0, 'the scan went on from the store');
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

  it('a read begun in the millisecond the last page of another came is kept over it', async () => {
    const cache = new WfsCache(path.join(dir, 'p41.sqlite'));
    const proxy = new WfsProxy({
      cache,
      sources: byBoxSources(upstreamBase),
      // Every area is stale at once: each read goes upstream.
      maxAgeMs: () => -1,
      mayRefresh: () => true,
      now: () => 7_000_000
    });
    await proxy.listen();
    const base = proxy.proxyUrl(upstreamBase) as string;
    const layerOf: Layer = { upstream: upstreamBase, typeName: 'DepthArea_A' };
    const inside = AREAS.find((f) => {
      const [w, s, e, n] = featureBox(f) as Box;
      return w > BOX[0] && s > BOX[1] && e < BOX[2] && n < BOX[3];
    }) as Feature;
    assert.ok((await readLayer(base, BOX)).includes(inside.id));
    REMOVED.add(inside.id);
    try {
      assert.ok(!(await readLayer(base, BOX)).includes(inside.id));
      // The later read is kept: the feature it did not give is dropped.
      const kept = cache.features(cache.idsIn(layerOf, BOX)).map((f) => f.id);
      assert.ok(kept.length > 0);
      assert.ok(!kept.includes(inside.id));
    } finally {
      REMOVED.delete(inside.id);
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
    const near = grown(inner);
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
      // The store dropped it: only the read that pinned it before still has it.
      const live = cache.features(
        cache.idsIn({ upstream: upstreamBase, typeName: 'DepthArea_A' }, BOX)
      );
      assert.ok(live.length > 0);
      assert.ok(!live.some((f) => f.id === gone));
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

  it('from the store, leaves out a feature reaching past a box that a refresh of it did not give', async () => {
    let now = 9_000_000;
    let mayRefresh = true;
    const { cache, proxy } = proxyWith('p40.sqlite', {
      now: () => now,
      mayRefresh: () => mayRefresh
    });
    await proxy.listen();
    const base = proxy.proxyUrl(upstreamBase) as string;
    const inner: Box = [22.045, 60.025, 22.075, 60.055];
    // Across the inner box's west edge.
    const gone = 'DepthArea_A.0043';
    assert.ok((await readLayer(base, BOX)).includes(gone));
    REMOVED.add(gone);
    try {
      now += READ_IDLE_MS + 5000;
      assert.ok(!(await readLayer(base, inner)).includes(gone));
      now += READ_IDLE_MS + 5000;
      mayRefresh = false;
      upstream.seen.length = 0;
      const again = await readLayer(base, inner);
      assert.strictEqual(upstream.seen.length, 0);
      assert.ok(again.length > 0);
      assert.ok(!again.includes(gone));
      // Kept for the areas past the inner box, where nothing says it is gone.
      assert.ok((await readLayer(base, [22.03, 60.025, 22.045, 60.055])).includes(gone));
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

  it("passes on the upstream's Retry-After", async () => {
    const origin = new URL(upstreamBase).origin;
    const { cache, proxy } = proxyWith('p-busy.sqlite', { upstreams: () => [`${origin}/busy`] });
    await proxy.listen();
    const busy = await fetch(
      `${proxy.proxyUrl(`${origin}/busy`) as string}?service=WFS&request=GetCapabilities`
    );
    assert.strictEqual(busy.status, 503);
    assert.strictEqual(busy.headers.get('retry-after'), '7');
    assert.strictEqual(await busy.text(), 'busy');
    await proxy.close();
    cache.close();
  });

  it('keeps nothing a redirect asking another query answered', async () => {
    const origin = new URL(upstreamBase).origin;
    const other = `${origin}/redirect-other`;
    const same = `${origin}/redirect-in`;
    const { cache, proxy } = proxyWith('p-redirect.sqlite', {
      upstreams: () => [other, same, upstreamBase]
    });
    await proxy.listen();
    // Each page comes back twice the size asked for: passed on, but not kept as asked.
    assert.ok((await readLayer(proxy.proxyUrl(other) as string, BOX)).length > 0);
    assert.strictEqual(cache.stats().areas, 0);
    assert.strictEqual(cache.stats().features, 0);
    // A redirect asking the same query is kept.
    await readLayer(proxy.proxyUrl(same) as string, BOX);
    assert.strictEqual(cache.stats().areas, 1);
    await proxy.close();
    cache.close();
  });

  it('a count ends a read of its ordering that could not be kept, once its pages have passed', async () => {
    const cache = new WfsCache(path.join(dir, 'p-spoilt.sqlite'));
    let pages = 0;
    const proxy = new WfsProxy({
      cache,
      sources: byBoxSources(upstreamBase),
      maxAgeMs: () => 1000,
      mayRefresh: () => true,
      fetch: async (url, init) => {
        // The second page of the first read cannot be read.
        if (String(url).includes('startIndex') && ++pages === 2) {
          return new Response('{ broken', { headers: { 'content-type': 'application/json' } });
        }
        return fetch(url, init);
      }
    });
    await proxy.listen();
    const base = proxy.proxyUrl(upstreamBase) as string;
    await assert.rejects(readLayer(base, BOX));
    assert.strictEqual(cache.stats().areas, 0);
    // Read again from its count, the area is kept.
    await readLayer(base, BOX);
    assert.strictEqual(cache.stats().areas, 1);
    await proxy.close();
    cache.close();
  });

  it("a change of a source's rule ends its reads", async () => {
    const { cache, proxy } = proxyWith('p-rule-read.sqlite');
    await proxy.listen();
    const base = proxy.proxyUrl(upstreamBase) as string;
    await readLayer(base, BOX);
    const count = () => fetch(`${base}?${query('DepthArea_A', BOX, { resultType: 'hits' })}`);
    upstream.seen.length = 0;
    // A read from the store, which pins what it answers.
    assert.strictEqual((await count()).status, 200);
    assert.strictEqual(upstream.seen.length, 0);
    proxy.configure({ sources: () => [{ url: upstreamBase, byBox: { margin: 0.2 } }] });
    // What it pinned was chosen by the old rule: the count goes upstream.
    assert.strictEqual((await count()).status, 200);
    assert.strictEqual(upstream.seen.length, 1);
    await proxy.close();
    cache.close();
  });

  it('a count begins a new store read once one began longer ago than the maximum age', async () => {
    let now = 7_000_000;
    const { cache, proxy } = proxyWith('p-old-read.sqlite', { now: () => now });
    await proxy.listen();
    const base = proxy.proxyUrl(upstreamBase) as string;
    await readLayer(base, BOX);
    const count = () => fetch(`${base}?${query('DepthArea_A', BOX, { resultType: 'hits' })}`);
    upstream.seen.length = 0;
    now += 500;
    await count();
    // Asked often enough never to be idle, a store read would answer its pin for good.
    now += 900;
    await count();
    assert.strictEqual(upstream.seen.length, 0);
    now += 300;
    await count();
    assert.strictEqual(upstream.seen.length, 1, 'the area, stale now, is read upstream again');
    await proxy.close();
    cache.close();
  });

  it('leaves what is kept as it is while the list of sources cannot be read', async () => {
    const { cache, proxy } = proxyWith('p-unknown.sqlite');
    await proxy.listen();
    await readLayer(proxy.proxyUrl(upstreamBase) as string, BOX);
    await proxy.close();
    const held = cache.stats().areas;
    assert.ok(held > 0);
    const options = { cache, maxAgeMs: () => 1000, mayRefresh: () => true };
    const unread = new WfsProxy({ ...options, sources: () => [], sourcesKnown: () => false });
    assert.strictEqual(cache.stats().areas, held);
    unread.configure({ sources: () => [], sourcesKnown: () => true });
    assert.strictEqual(cache.stats().areas, 0);
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

  it('a count while a page is on its way keeps that read', { timeout: 10_000 }, async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let pageAsked: () => void = () => undefined;
    const asked = new Promise<void>((resolve) => {
      pageAsked = resolve;
    });
    const cache = new WfsCache(path.join(dir, 'p22.sqlite'));
    // Its pages carry no count of their own: only the count asked meanwhile can end the area.
    const uncounted = upstreamBase.replace(/\/wfs$/, '/uncounted');
    const proxy = new WfsProxy({
      cache,
      sources: byBoxSources(uncounted),
      maxAgeMs: () => 1000,
      mayRefresh: () => true,
      fetch: async (url, init) => {
        if (String(url).includes('startIndex')) {
          pageAsked();
          await gate;
        }
        return fetch(url, init);
      }
    });
    await proxy.listen();
    const base = proxy.proxyUrl(uncounted) as string;
    // One page holds the whole area.
    const page = pageOf(base, BOX, 'IDENTIFIER', 0, 1000);
    try {
      const first = await Promise.race([
        asked.then(() => 'asked'),
        page.then(
          () => 'page',
          () => 'page'
        )
      ]);
      assert.strictEqual(first, 'asked', 'the page was answered without asking upstream');
      const counted = await fetch(
        `${base}?${query('DepthArea_A', BOX, { resultType: 'hits', sortBy: 'IDENTIFIER' })}`
      );
      assert.strictEqual(counted.status, 200);
      assert.ok((hitsMatched(await counted.text()) ?? 0) > 0);
      release();
      assert.ok((await page).length > 0);
      assert.strictEqual(cache.stats().areas, 1);
    } finally {
      release();
      await page.catch(() => undefined);
      await proxy.close();
      cache.close();
    }
  });

  it('a count of none waits for a page on its way', { timeout: 10_000 }, async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let pageAsked: () => void = () => undefined;
    const asked = new Promise<void>((resolve) => {
      pageAsked = resolve;
    });
    const cache = new WfsCache(path.join(dir, 'p23.sqlite'));
    const uncounted = upstreamBase.replace(/\/wfs$/, '/uncounted');
    const proxy = new WfsProxy({
      cache,
      sources: byBoxSources(uncounted),
      maxAgeMs: () => 1000,
      mayRefresh: () => true,
      fetch: async (url, init) => {
        // The count says none while the page on its way holds features: they disagree.
        if (String(url).includes('resultType=hits')) {
          return new Response(hitsReply(0, new Date(0)), {
            headers: { 'content-type': 'application/xml' }
          });
        }
        if (String(url).includes('startIndex')) {
          pageAsked();
          await gate;
        }
        return fetch(url, init);
      }
    });
    await proxy.listen();
    const base = proxy.proxyUrl(uncounted) as string;
    const page = pageOf(base, BOX, 'IDENTIFIER', 0, 1000);
    try {
      const first = await Promise.race([
        asked.then(() => 'asked'),
        page.then(
          () => 'page',
          () => 'page'
        )
      ]);
      assert.strictEqual(first, 'asked', 'the page was answered without asking upstream');
      const counted = await fetch(
        `${base}?${query('DepthArea_A', BOX, { resultType: 'hits', sortBy: 'IDENTIFIER' })}`
      );
      assert.strictEqual(hitsMatched(await counted.text()), 0);
      assert.strictEqual(cache.stats().areas, 0);
      release();
      assert.ok((await page).length > 0);
      assert.strictEqual(cache.stats().areas, 0);
    } finally {
      release();
      await page.catch(() => undefined);
      await proxy.close();
      cache.close();
    }
  });

  it('a config save hands the running proxy to the next start', async () => {
    const dataDir = fs.mkdtempSync(path.join(dir, 'service-'));
    const kept = 'https://wfs.example/service/wfs';
    let listed = [{ url: 'htps://typo.example/wfs' }, { url: kept, answersByBox: true }];
    const settings = {
      dataDir,
      maxAgeDays: () => 30,
      maxBytes: () => 0,
      sources: () => listed,
      mayRefresh: () => true,
      log: () => undefined,
      warn: () => undefined
    };
    let current: Awaited<ReturnType<typeof startWfsProxy>> | null = null;
    const offer = wfsOffer(() => current);
    const running = await startWfsProxy(settings);
    current = running;
    const url = offer.proxyUrl(kept);
    assert.ok(url !== undefined);
    assert.deepStrictEqual(offer.upstreams(), [kept]);
    // A source added while it runs is proxied at once.
    listed = [...listed, { url: 'https://added.example/wfs', answersByBox: false }];
    refreshWfsSources(running);
    assert.ok(offer.proxyUrl('https://added.example/wfs') !== undefined);
    releaseWfsProxy(running);
    // Stopped, the offer gives no proxy.
    current = null;
    assert.strictEqual(offer.proxyUrl(kept), undefined);
    assert.deepStrictEqual(offer.upstreams(), []);
    assert.strictEqual(offer.stats(), undefined);
    const again = await startWfsProxy({ ...settings, sources: () => [{ url: kept }] });
    assert.strictEqual(again, running);
    current = again;
    assert.strictEqual(offer.proxyUrl(kept), url);
    assert.strictEqual(offer.proxyUrl('https://other.example/wfs'), undefined);
    assert.deepStrictEqual(offer.stats(), { ...again.cache.stats() });
    await stopWfsProxy(again);
  });

  it('takes each configured source once, with its rule and id property', () => {
    assert.deepStrictEqual(
      wfsSources([
        { url: 'https://a.example/wfs/', answersByBox: true, answerMargin: 0.12 },
        { url: 'https://a.example/wfs', answersByBox: false },
        { url: 'https://b.example/wfs', answerMargin: 0.3, idProperty: ' IDENTIFIER ' },
        { url: 'https://c.example/wfs', answersByBox: true, idProperty: '' },
        { url: 'nowhere' }
      ]),
      [
        { url: 'https://a.example/wfs', byBox: { margin: 0.12 } },
        { url: 'https://b.example/wfs', idProperty: 'IDENTIFIER' },
        { url: 'https://c.example/wfs', byBox: { margin: 0 } }
      ]
    );
  });

  it('normalizes upstream URLs for comparison', () => {
    assert.strictEqual(
      normalizeUpstream('https://wfs.example/service/wfs/?x=1'),
      'https://wfs.example/service/wfs'
    );
    assert.strictEqual(normalizeUpstream('ftp://x/wfs'), undefined);
    assert.strictEqual(normalizeUpstream('not a url'), undefined);
    assert.strictEqual(normalizeUpstream('https://user:secret@wfs.example/wfs'), undefined);
  });
});

describe('WfsSourceList', () => {
  let dir: string;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfs-sources-'));
  });
  after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('adds, edits and removes sources, kept in its file', () => {
    const file = path.join(dir, 'a', 'wfs-sources.json');
    const list = new WfsSourceList(file);
    assert.deepStrictEqual(list.list(), []);
    const added = list.save(
      { url: 'https://wfs.example/wfs/', name: ' Depths ', answerMargin: 0.3, idProperty: ' ' },
      false
    );
    assert.deepStrictEqual(added, {
      url: 'https://wfs.example/wfs',
      name: 'Depths',
      answersByBox: false
    });
    assert.throws(
      () => list.save({ url: 'https://wfs.example/wfs' }, false),
      (e: unknown) => e instanceof WfsSourceError && e.status === 409
    );
    assert.throws(
      () => list.save({ url: 'https://none.example/wfs' }, true),
      (e: unknown) => e instanceof WfsSourceError && e.status === 404
    );
    assert.throws(
      () => list.save({ url: 'ftp://wfs.example/wfs' }, false),
      (e: unknown) => e instanceof WfsSourceError && e.status === 400
    );
    list.save({ url: 'https://wfs.example/wfs', answersByBox: true, answerMargin: 0.12 }, true);
    assert.deepStrictEqual(new WfsSourceList(file).list(), [
      { url: 'https://wfs.example/wfs', answersByBox: true, answerMargin: 0.12 }
    ]);
    assert.strictEqual(list.remove('https://wfs.example/wfs/'), true);
    assert.strictEqual(list.remove('https://wfs.example/wfs'), false);
    assert.deepStrictEqual(new WfsSourceList(file).list(), []);
  });

  it('skips the entries it cannot read and keeps the fields it does not know', () => {
    const file = path.join(dir, 'b.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        sources: [
          { url: 'not a url' },
          { url: 7 },
          { url: 'https://wfs.example/wfs', answersByBox: true, answerMargin: 0.1, later: 'x' }
        ]
      })
    );
    const list = new WfsSourceList(file);
    assert.deepStrictEqual(list.list(), [
      { url: 'https://wfs.example/wfs', answersByBox: true, answerMargin: 0.1 }
    ]);
    list.save({ url: 'https://wfs.example/wfs', name: 'Named' }, true);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as { sources: unknown[] };
    assert.deepStrictEqual(saved.sources, [
      { later: 'x', url: 'https://wfs.example/wfs', name: 'Named', answersByBox: false }
    ]);
  });

  it('writes nothing over a file that holds no list of sources', () => {
    const file = path.join(dir, 'd.json');
    const text = JSON.stringify({ sources: { url: 'https://kept.example/wfs' } });
    fs.writeFileSync(file, text);
    const list = new WfsSourceList(file);
    assert.strictEqual(list.readable(), false);
    assert.throws(
      () => list.save({ url: 'https://wfs.example/wfs' }, false),
      (e: unknown) => e instanceof WfsSourceError && e.status === 500
    );
    assert.strictEqual(fs.readFileSync(file, 'utf8'), text);
    // No file is an empty list, readable.
    assert.strictEqual(new WfsSourceList(path.join(dir, 'none.json')).readable(), true);
  });

  it('refuses a URL too long to be read back once written out', () => {
    const list = new WfsSourceList(path.join(dir, 'e.json'));
    // Each space is written out as %20: 700 of them fit the form's limit but not the file's.
    const url = `https://wfs.example/${' '.repeat(700)}wfs`;
    assert.ok(url.length <= 2048);
    assert.throws(
      () => list.save({ url }, false),
      (e: unknown) => e instanceof WfsSourceError && e.status === 400
    );
    assert.deepStrictEqual(list.list(), []);
  });

  it('changes nothing in a file it cannot read until it can', () => {
    const file = path.join(dir, 'c.json');
    fs.writeFileSync(file, '{ broken');
    const list = new WfsSourceList(file);
    assert.deepStrictEqual(list.list(), []);
    assert.throws(
      () => list.save({ url: 'https://wfs.example/wfs' }, false),
      (e: unknown) => e instanceof WfsSourceError && e.status === 500
    );
    assert.strictEqual(fs.readFileSync(file, 'utf8'), '{ broken');
    fs.writeFileSync(file, JSON.stringify({ sources: [{ url: 'https://kept.example/wfs' }] }));
    list.save({ url: 'https://wfs.example/wfs' }, false);
    assert.deepStrictEqual(
      new WfsSourceList(file).list().map((s) => s.url),
      ['https://kept.example/wfs', 'https://wfs.example/wfs']
    );
  });
});
