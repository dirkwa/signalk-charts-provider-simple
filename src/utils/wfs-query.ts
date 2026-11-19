/**
 * The WFS requests the local WFS proxy (`wfs-proxy.ts`) can answer from its
 * cache: WFS 2.0 `GetFeature` of one feature type in a latitude/longitude box,
 * as GeoJSON pages (`startIndex`, `count`) or as a count (`resultType=hits`).
 * Anything else is passed to the upstream server as it is.
 */

/** [west, south, east, north], degrees. */
export type Box = readonly [number, number, number, number];

export interface FeatureQuery {
  typeName: string;
  box: Box;
  /** The box as the request wrote it: the pages of one area share it. */
  boxText: string;
  /** A `resultType=hits` request: the count alone. */
  hits: boolean;
  startIndex: number;
  /** The page size asked for; undefined for every feature at once. */
  count: number | undefined;
  /** The ordering asked for, as written. */
  sortBy: string | undefined;
}

export interface WfsFeature {
  id?: string | number;
  type?: string;
  geometry?: { type?: string; coordinates?: unknown } | null;
  properties?: Record<string, unknown> | null;
}

const EPSG_4326_URN = 'urn:ogc:def:crs:EPSG::4326';

/** Parameters a cached answer gives the same reply for; any other makes a request pass through. */
const KNOWN = new Set([
  'service',
  'version',
  'request',
  'typenames',
  'bbox',
  'srsname',
  'outputformat',
  'sortby',
  'count',
  'startindex',
  'resulttype'
]);

const nonNegativeInteger = (text: string | undefined): number | undefined => {
  if (text === undefined || !/^\d+$/.test(text)) {
    return undefined;
  }
  const n = Number(text);
  return Number.isSafeInteger(n) ? n : undefined;
};

/**
 * WFS 2.0 with an EPSG URN reads a box as latitude, longitude: `s,w,n,e,urn`.
 * A box in any other reference system is not one the cache can place.
 */
function parseBox(text: string): Box | undefined {
  const parts = text.split(',');
  if (parts.length !== 5 || parts[4] !== EPSG_4326_URN) {
    return undefined;
  }
  const [s, w, n, e] = parts.slice(0, 4).map(Number) as [number, number, number, number];
  const ok =
    [s, w, n, e].every(Number.isFinite) &&
    Math.abs(s) <= 90 &&
    Math.abs(n) <= 90 &&
    Math.abs(w) <= 180 &&
    Math.abs(e) <= 180 &&
    s < n &&
    w < e;
  return ok ? [w, s, e, n] : undefined;
}

/** The request as one the cache can answer, or null to pass it through. */
export function featureQuery(params: URLSearchParams): FeatureQuery | null {
  const p = new Map<string, string>();
  for (const [key, value] of params) {
    const k = key.toLowerCase();
    if (!KNOWN.has(k) || p.has(k)) {
      return null;
    }
    p.set(k, value);
  }
  const typeName = p.get('typenames');
  const boxText = p.get('bbox');
  if (
    p.get('service')?.toUpperCase() !== 'WFS' ||
    p.get('request')?.toLowerCase() !== 'getfeature' ||
    p.get('version') !== '2.0.0' ||
    typeName === undefined ||
    typeName === '' ||
    typeName.includes(',') ||
    boxText === undefined
  ) {
    return null;
  }
  const box = parseBox(boxText);
  const srs = p.get('srsname');
  // Without srsName the reply is in the feature type's own system (Traficom's: metres).
  if (box === undefined || srs !== 'EPSG:4326') {
    return null;
  }
  const hits = p.get('resulttype')?.toLowerCase() === 'hits';
  if (!hits && (p.get('resulttype') ?? 'results').toLowerCase() !== 'results') {
    return null;
  }
  if (!hits && p.get('outputformat') !== 'application/json') {
    return null;
  }
  const startIndex = nonNegativeInteger(p.get('startindex') ?? '0');
  const count = p.has('count') ? nonNegativeInteger(p.get('count')) : undefined;
  if (startIndex === undefined || (p.has('count') && (count === undefined || count === 0))) {
    return null;
  }
  return { typeName, box, boxText, hits, startIndex, count, sortBy: p.get('sortby') };
}

export interface SortOrder {
  property: string;
  descending: boolean;
}

/**
 * A `sortBy` of one property, `NAME`, `NAME ASC|DESC` or `NAME A|D`, as the store can
 * order it; undefined for any other, which the store does not answer.
 */
export function sortOrder(sortBy: string): SortOrder | undefined {
  const m = /^([A-Za-z_][\w.:-]*)(?:\s+(ASC|DESC|A|D))?$/i.exec(sortBy.trim());
  if (m?.[1] === undefined) {
    return undefined;
  }
  return { property: m[1], descending: /^d/i.test(m[2] ?? '') };
}

type SortValue = string | number | undefined;

/** Ascending order of property values as a database sorts them: numbers by value, none last. */
function compareValues(a: SortValue, b: SortValue): number {
  if (a === undefined || b === undefined) {
    return a === b ? 0 : a === undefined ? 1 : -1;
  }
  if (typeof a === 'number' && typeof b === 'number') {
    return a - b;
  }
  const x = String(a);
  const y = String(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** `items` in `order` of their features' property, ties kept in their given order. */
export function sortedBy<T>(
  items: readonly T[],
  featureOf: (item: T) => WfsFeature | undefined,
  order: SortOrder
): T[] {
  const valueOf = (item: T): SortValue => {
    const v = featureOf(item)?.properties?.[order.property];
    return typeof v === 'number' || typeof v === 'string' ? v : undefined;
  };
  const keyed = items.map((item, i) => ({ item, i, v: valueOf(item) }));
  keyed.sort((p, q) => {
    const c = compareValues(p.v, q.v);
    // None sorts last ascending and first descending, as PostgreSQL does.
    return (order.descending ? -c : c) || p.i - q.i;
  });
  return keyed.map((k) => k.item);
}

/** A feature's identity across requests: its `id`, else its `IDENTIFIER`; undefined without one. */
export function featureId(f: WfsFeature): string | undefined {
  if (typeof f.id === 'string' || typeof f.id === 'number') {
    return String(f.id);
  }
  const ident = f.properties?.IDENTIFIER;
  return typeof ident === 'string' || typeof ident === 'number' ? String(ident) : undefined;
}

/** The box of a feature's coordinates, `[x, y]` pairs at any depth of nesting; undefined without any. */
export function featureBox(f: WfsFeature): Box | undefined {
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  const walk = (c: unknown): void => {
    if (!Array.isArray(c)) {
      return;
    }
    if (typeof c[0] === 'number' && typeof c[1] === 'number') {
      const [x, y] = c as [number, number];
      if (Number.isFinite(x) && Number.isFinite(y)) {
        w = Math.min(w, x);
        e = Math.max(e, x);
        s = Math.min(s, y);
        n = Math.max(n, y);
      }
      return;
    }
    for (const inner of c) {
      walk(inner);
    }
  };
  walk(f.geometry?.coordinates);
  // Coordinates past longitude and latitude are in another system: not a box this store places.
  const inRange = w >= -180 && e <= 180 && s >= -90 && n <= 90;
  return w <= e && s <= n && inRange ? [w, s, e, n] : undefined;
}

/**
 * How far past a box a WFS may answer, as a share of the box's size: one whose
 * own grid is turned against latitude and longitude (Traficom's TM35FIN, by up
 * to 6° across Finland) reads a box as the larger box holding it turned, and
 * returns features that far outside.
 */
export const ANSWER_MARGIN = 0.12;

const M_PER_DEG = 111_195;

/**
 * `box` grown to hold what a WFS whose grid is turned may answer for it
 * (`ANSWER_MARGIN`): east and west by its height, north and south by its width.
 */
export function answerBox([w, s, e, n]: Box): Box {
  const cos = Math.max(Math.cos((((s + n) / 2) * Math.PI) / 180), 1e-6);
  const height = (n - s) * M_PER_DEG;
  const width = (e - w) * M_PER_DEG * cos;
  const dLon = (ANSWER_MARGIN * height) / (M_PER_DEG * cos);
  const dLat = (ANSWER_MARGIN * width) / M_PER_DEG;
  return [
    Math.max(-180, w - dLon),
    Math.max(-90, s - dLat),
    Math.min(180, e + dLon),
    Math.min(90, n + dLat)
  ];
}

/** Margins this small are rounding where boxes meet edge to edge, degrees. */
const EPS = 1e-9;

/**
 * The parts of `box` that none of `covers` holds: empty when they hold it all.
 * Each cover cuts every remaining part into at most four.
 */
export function uncovered(box: Box, covers: readonly Box[]): Box[] {
  let parts: Box[] = [box];
  for (const [cw, cs, ce, cn] of covers) {
    const next: Box[] = [];
    for (const part of parts) {
      const [w, s, e, n] = part;
      if (ce <= w + EPS || cw >= e - EPS || cn <= s + EPS || cs >= n - EPS) {
        next.push(part);
        continue;
      }
      if (cs > s + EPS) {
        next.push([w, s, e, cs]);
      }
      if (cn < n - EPS) {
        next.push([w, cn, e, n]);
      }
      const lo = Math.max(s, cs);
      const hi = Math.min(n, cn);
      if (cw > w + EPS) {
        next.push([w, lo, cw, hi]);
      }
      if (ce < e - EPS) {
        next.push([ce, lo, e, hi]);
      }
    }
    parts = next;
    if (parts.length === 0) {
      break;
    }
  }
  return parts;
}

/** A `resultType=hits` reply, as WFS 2.0 servers write it. */
export function hitsReply(matched: number): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    `<wfs:FeatureCollection xmlns:wfs="http://www.opengis.net/wfs/2.0" numberMatched="${String(matched)}" numberReturned="0"/>`
  );
}

/** A GeoJSON page of `features` out of `matched`. */
export function pageReply(matched: number, features: readonly unknown[]): string {
  return JSON.stringify({
    type: 'FeatureCollection',
    numberMatched: matched,
    numberReturned: features.length,
    features
  });
}

/** `numberMatched` from a hits reply (XML) or a GeoJSON page; undefined without one. */
export function matchedIn(text: string): number | undefined {
  const m = /numberMatched="(\d+)"/.exec(text) ?? /"numberMatched"\s*:\s*(\d+)/.exec(text);
  return m?.[1] === undefined ? undefined : Number(m[1]);
}
