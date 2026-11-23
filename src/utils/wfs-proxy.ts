/**
 * The local WFS proxy: a WFS server on the loopback interface that peer
 * plugins (and their worker processes) read instead of the upstream WFS
 * servers configured as its sources, so an area is downloaded once and read
 * again from the store (`wfs-cache.ts`).
 *
 * A request the cache can answer (`wfs-query.ts`) for an area it holds whole
 * and fresh is answered from the store. Any other is passed to the upstream
 * server and its reply streamed back as it arrives; the features of its pages
 * are staged, and once every page of an area has passed, they are published
 * and the area is held. A read keeps the way it began, from the store or
 * upstream, until it has been idle a while, so its pages come from one
 * ordering; a count begins a read.
 *
 * It listens on 127.0.0.1 only, under a path holding a random token only
 * this server's plugins learn (`proxyUrl`): it is no open proxy, and needs no
 * Signal K login.
 */

import crypto from 'crypto';
import http from 'http';
import type { AddressInfo } from 'net';
import type { Layer, Pin, ReadStart, WfsCache } from './wfs-cache.js';
import {
  answerBox,
  featureQuery,
  hitsMatched,
  hitsReply,
  pageMatched,
  pageReply,
  sortedBy,
  sortOrder,
  type ByBox,
  type FeatureQuery,
  type WfsFeature
} from './wfs-query.js';

/** An area's read keeps its way this long after its last request, ms. */
export const READ_IDLE_MS = 10 * 60_000;

/** A reply larger than this is passed on but not kept, bytes. */
export const MAX_KEPT_BYTES = 64 * 1024 * 1024;

const MAX_REDIRECTS = 5;

/** How long a closing proxy lets replies in progress finish, ms. */
const CLOSE_GRACE_MS = 5000;

/** An upstream WFS server proxied, and how it chooses and identifies the features it answers. */
export interface WfsSource {
  /** Its base URL, as `normalizeUpstream` gives it. */
  url: string;
  /**
   * Set for a server that answers a box with every feature reaching it (`ByBox`): the store
   * answers boxes inside those it holds. Without it, an area is answered from the store only
   * for the same box, with what it gave.
   */
  byBox?: ByBox;
  /** The property identifying a feature that has no GeoJSON `id` (`featureId`). */
  idProperty?: string;
}

/** What the store keeps a source's data by (`WfsCache.useRule`). */
const ruleOf = (source: WfsSource): string =>
  JSON.stringify({ byBox: source.byBox?.margin ?? null, idProperty: source.idProperty ?? null });

export interface WfsProxyOptions {
  cache: WfsCache;
  /** The upstream servers proxied. */
  sources: () => readonly WfsSource[];
  /** An area fetched longer ago than this is fetched again, ms. */
  maxAgeMs: () => number;
  /** The store's size limit (`WfsCache.fit`), bytes; 0 or none for no limit. */
  maxBytes?: () => number;
  /** False while going online on its own is held back: a stale area is read from the store. */
  mayRefresh: () => boolean;
  /**
   * True while a stopped plugin's proxy serves on for the next start (`releaseWfsProxy`): it
   * answers from the store and carries on the reads going upstream, and begins no new one.
   */
  handingOver?: boolean;
  fetch?: typeof fetch;
  now?: () => number;
  log?: (message: string) => void;
}

/** The settings a running proxy takes again when the plugin restarts. */
export type WfsProxySettings = Pick<
  WfsProxyOptions,
  'sources' | 'maxAgeMs' | 'maxBytes' | 'mayRefresh' | 'handingOver' | 'log'
>;

interface UpstreamRead {
  lastUsed: number;
  /** The pages passed, as [start, end) of the features' indexes. */
  ranges: [number, number][];
  /** Pages asked for upstream whose reply has not passed yet. */
  inFlight: number;
  matched?: number;
  /** A page could not be kept, the count changed, or a newer read was kept: the area is not held. */
  spoilt: boolean;
  /** Every page has passed and the area is held. */
  held: boolean;
  /** Its time, for the area's age, and its place in the order of reads and pages. */
  startedAt: Exclude<ReadStart, number>;
  /** Where its pages wait until the area is whole (`WfsCache.stage`). */
  stage: number;
}

interface StoreRead {
  lastUsed: number;
  /** The features answered, each as it was when the read began, so its count and pages agree. */
  pin: Pin;
  /** The pinned features in each ordering asked for, by `sortBy`. */
  orders?: Map<string, number[]>;
}

/** A process-wide token: a plugin restarted by a config save keeps its URLs. */
const TOKEN = crypto.randomBytes(18).toString('base64url');

const encodeUpstream = (url: string): string => Buffer.from(url, 'utf8').toString('base64url');
const decodeUpstream = (part: string): string => Buffer.from(part, 'base64url').toString('utf8');

/** A URL's form for comparing upstreams: no trailing slash, no query or fragment. */
export function normalizeUpstream(url: string): string | undefined {
  try {
    const u = new URL(url);
    // A URL's user and password would be listed to anyone who may read the server.
    if (
      (u.protocol !== 'https:' && u.protocol !== 'http:') ||
      u.username !== '' ||
      u.password !== ''
    ) {
      return undefined;
    }
    u.search = '';
    u.hash = '';
    return u.toString().replace(/\/+$/, '');
  } catch {
    return undefined;
  }
}

/** Whether `ranges` cover [0, end). */
function coversFromZero(ranges: readonly [number, number][], end: number): boolean {
  let reach = 0;
  for (const [a, b] of [...ranges].sort((x, y) => x[0] - y[0])) {
    if (a > reach) {
      return false;
    }
    reach = Math.max(reach, b);
    if (reach >= end) {
      return true;
    }
  }
  return reach >= end;
}

/** Resolves once `res` can take more, or is gone. */
const drained = (res: http.ServerResponse): Promise<void> =>
  new Promise((resolve) => {
    const done = (): void => {
      res.off('drain', done);
      res.off('close', done);
      resolve();
    };
    res.on('drain', done);
    res.on('close', done);
  });

export class WfsProxy {
  private server: http.Server | null = null;
  private sweeper: NodeJS.Timeout | undefined;
  private port = 0;
  private options: WfsProxyOptions;
  private readonly upstreamReads = new Map<string, UpstreamRead>();
  private readonly storeReads = new Map<string, StoreRead>();
  private readonly fetchUpstream: typeof fetch;
  private readonly now: () => number;

  constructor(options: WfsProxyOptions) {
    this.options = options;
    this.fetchUpstream = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.useRules();
    this.fit();
  }

  /** Takes `settings` in place of those it has; reads going on keep their way. */
  configure(settings: Partial<WfsProxySettings>): void {
    this.options = { ...this.options, ...settings };
    if (settings.sources) {
      this.useRules();
    }
    if (settings.maxBytes) {
      this.fit();
    }
  }

  /**
   * A source whose rule changed answers nothing it kept by the old one, and what a source no
   * longer proxied kept is dropped.
   */
  private useRules(): void {
    const { cache, log } = this.options;
    const sources = this.options.sources();
    for (const source of sources) {
      if (cache.useRule(source.url, ruleOf(source))) {
        log?.(`WFS proxy: ${source.url} is read by new settings, its kept areas dropped`);
      }
    }
    for (const gone of cache.keepOnly(sources.map((s) => s.url))) {
      log?.(`WFS proxy: ${gone} is no longer proxied, its kept areas dropped`);
    }
  }

  private fit(): void {
    const dropped = this.options.cache.fit(this.options.maxBytes?.() ?? 0);
    if (dropped > 0) {
      this.options.log?.(
        `WFS proxy: dropped the ${String(dropped)} area(s) read longest ago to stay within its space`
      );
    }
  }

  upstreams(): readonly string[] {
    return this.options.sources().map((s) => s.url);
  }

  /** Listens on 127.0.0.1, on `port` when it is free, else any free one; resolves with the port. */
  async listen(port = 0): Promise<number> {
    const server = http.createServer((req, res) => {
      this.handle(req, res).catch((err: unknown) => {
        this.options.log?.(`WFS proxy: ${String(err)}`);
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'text/plain' });
        }
        res.end();
      });
    });
    const bound = await new Promise<number>((resolve, reject) => {
      let anyPort = port === 0;
      const onListening = (): void => {
        server.removeListener('error', onError);
        resolve((server.address() as AddressInfo).port);
      };
      const onError = (err: NodeJS.ErrnoException): void => {
        if (!anyPort && err.code === 'EADDRINUSE') {
          anyPort = true;
          server.listen(0, '127.0.0.1');
          return;
        }
        server.removeListener('listening', onListening);
        reject(err);
      };
      server.on('error', onError);
      server.once('listening', onListening);
      server.listen(port, '127.0.0.1');
    });
    this.server = server;
    this.port = bound;
    // Reads left idle let go of their stage and pins without waiting for another request.
    this.sweeper = setInterval(() => {
      this.sweep();
    }, READ_IDLE_MS);
    this.sweeper.unref();
    return bound;
  }

  /** The proxy's URL for the upstream WFS `upstream`, or undefined when it is not proxied. */
  proxyUrl(upstream: string): string | undefined {
    const base = normalizeUpstream(upstream);
    if (this.server === null || base === undefined || !this.allowed(base)) {
      return undefined;
    }
    return `http://127.0.0.1:${String(this.port)}/${TOKEN}/${encodeUpstream(base)}`;
  }

  /** Stops listening; replies in progress get a while to finish. */
  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    clearInterval(this.sweeper);
    if (server) {
      const closed = new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
      server.closeIdleConnections();
      const cut = setTimeout(() => {
        server.closeAllConnections();
      }, CLOSE_GRACE_MS);
      cut.unref();
      await closed;
      clearTimeout(cut);
    }
    for (const r of this.storeReads.values()) {
      r.pin.release();
    }
    this.storeReads.clear();
    for (const r of this.upstreamReads.values()) {
      this.options.cache.dropStage(r.stage);
    }
    this.upstreamReads.clear();
  }

  private source(base: string): WfsSource | undefined {
    return this.options.sources().find((s) => normalizeUpstream(s.url) === base);
  }

  private allowed(base: string): boolean {
    return this.source(base) !== undefined;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const [, token, encoded, ...rest] = url.pathname.split('/');
    if (token !== TOKEN || encoded === undefined || rest.length > 0) {
      res.writeHead(404).end();
      return;
    }
    const upstream = decodeUpstream(encoded);
    if (normalizeUpstream(upstream) !== upstream || !this.allowed(upstream)) {
      res.writeHead(403).end();
      return;
    }
    if (req.method !== 'GET') {
      res.writeHead(405, { allow: 'GET' }).end();
      return;
    }
    const q = featureQuery(url.searchParams);
    const target = `${upstream}${url.search}`;
    if (q === null) {
      await this.passUnlessHandingOver(target, req, res);
      return;
    }
    const layer: Layer = { upstream, typeName: q.typeName };
    const area = `${upstream}\n${q.typeName}\n${q.boxText}`;
    const readKey = `${area}\n${q.sortBy ?? ''}`;
    this.sweep();
    if (q.hits) {
      // A count begins a read: the area's finished upstream reads end, and a count of its own
      // ordering that no page followed, so its pages may come from the store, or upstream and
      // be kept again.
      for (const [k, r] of this.upstreamReads) {
        const countOnly = k === readKey && r.ranges.length === 0 && r.inFlight === 0;
        if (k.startsWith(`${area}\n`) && (r.held || countOnly)) {
          this.endUpstreamRead(k, r);
        }
      }
    }
    const fromStore = this.storeRead(area, readKey, layer, q);
    if (fromStore) {
      this.answer(fromStore, q, res);
      return;
    }
    if (this.options.handingOver === true && !this.upstreamReads.has(readKey)) {
      this.refuseWhileHandingOver(res);
      return;
    }
    if (q.hits) {
      const read = this.upstreamRead(readKey);
      await this.pass(target, req, res, (text) => {
        if (this.upstreamReads.get(readKey) === read) {
          this.counted(layer, q, read, hitsMatched(text));
        }
      });
      return;
    }
    const read = this.upstreamRead(readKey);
    read.inFlight++;
    let inFlight = true;
    const passed = (): void => {
      if (inFlight) {
        inFlight = false;
        read.inFlight--;
      }
    };
    try {
      await this.pass(target, req, res, (text) => {
        passed();
        // A page that outlived its read, which another has replaced, keeps nothing.
        if (this.upstreamReads.get(readKey) === read) {
          this.keep(layer, q, read, text);
        }
      });
    } finally {
      passed();
    }
  }

  private refuseWhileHandingOver(res: http.ServerResponse): void {
    res
      .writeHead(503, { 'content-type': 'text/plain', 'retry-after': '5' })
      .end('the WFS proxy is restarting');
  }

  private async passUnlessHandingOver(
    target: string,
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    if (this.options.handingOver === true) {
      this.refuseWhileHandingOver(res);
      return;
    }
    await this.pass(target, req, res);
  }

  private endUpstreamRead(key: string, read: UpstreamRead): void {
    this.upstreamReads.delete(key);
    this.options.cache.dropStage(read.stage);
  }

  private sweep(): void {
    const now = this.now();
    for (const [k, r] of this.upstreamReads) {
      if (now - r.lastUsed > READ_IDLE_MS) {
        this.endUpstreamRead(k, r);
      }
    }
    for (const [k, r] of this.storeReads) {
      if (now - r.lastUsed > READ_IDLE_MS) {
        this.storeReads.delete(k);
        r.pin.release();
      }
    }
  }

  /**
   * The area's read from the store: going on, else begun now when the store holds the area,
   * else undefined. A request in an ordering the store cannot give goes upstream, and so does
   * one, count or page, in the ordering of a read going on upstream. One read serves every
   * ordering of the area and pins its features until idle, so its count and its pages agree.
   */
  private storeRead(
    area: string,
    readKey: string,
    layer: Layer,
    q: FeatureQuery
  ): StoreRead | undefined {
    const now = this.now();
    if (
      (q.sortBy !== undefined && sortOrder(q.sortBy) === undefined) ||
      this.upstreamReads.has(readKey)
    ) {
      return undefined;
    }
    const going = this.storeReads.get(area);
    if (going) {
      going.lastUsed = now;
      return going;
    }
    const cache = this.options.cache;
    const byBox = this.source(layer.upstream)?.byBox;
    // By box: as much as the upstream would answer, and the features past the box it adds.
    const pinned = (since: number): Pin | undefined => {
      if (byBox) {
        return cache.covers(layer, q.box, since)
          ? cache.answerIn(layer, q.box, answerBox(q.box, byBox.margin))
          : undefined;
      }
      const coveredId = cache.exactCover(layer, q.boxText, since);
      return coveredId === undefined ? undefined : cache.pinArea(coveredId);
    };
    const pin =
      pinned(now - this.options.maxAgeMs()) ?? (this.options.mayRefresh() ? undefined : pinned(0));
    if (!pin) {
      return undefined;
    }
    const read: StoreRead = { lastUsed: now, pin };
    this.storeReads.set(area, read);
    return read;
  }

  /**
   * The area's read upstream in the request's ordering: each ordering is its own, as pages of
   * two orderings do not make up an area. A count is its own read's alone: one in another
   * ordering, or before the read began, may describe other features.
   */
  private upstreamRead(readKey: string): UpstreamRead {
    const now = this.now();
    const going = this.upstreamReads.get(readKey);
    if (going) {
      going.lastUsed = now;
      return going;
    }
    const read: UpstreamRead = {
      lastUsed: now,
      ranges: [],
      inFlight: 0,
      spoilt: false,
      held: false,
      startedAt: { at: now, order: this.options.cache.orderAt(now) },
      stage: this.options.cache.beginStage()
    };
    this.upstreamReads.set(readKey, read);
    return read;
  }

  private answer(read: StoreRead, q: FeatureQuery, res: http.ServerResponse): void {
    const ids = read.pin.ids;
    if (q.hits) {
      res
        .writeHead(200, { 'content-type': 'application/xml' })
        .end(hitsReply(ids.length, new Date(this.now())));
      return;
    }
    const ordered = this.inOrder(read, ids, q.sortBy);
    const page = ordered.slice(
      q.startIndex,
      q.count === undefined ? undefined : q.startIndex + q.count
    );
    res
      .writeHead(200, { 'content-type': 'application/json' })
      .end(pageReply(ids.length, read.pin.features(page)));
  }

  /** A store read's features in the ordering `sortBy` asks for (`storeRead` took only those). */
  private inOrder(
    read: StoreRead,
    ids: readonly number[],
    sortBy: string | undefined
  ): readonly number[] {
    const order = sortBy === undefined ? undefined : sortOrder(sortBy);
    if (sortBy === undefined || order === undefined) {
      return ids;
    }
    read.orders ??= new Map();
    let ordered = read.orders.get(sortBy);
    if (!ordered) {
      const byId = read.pin.featuresById(ids);
      ordered = sortedBy(ids, (id) => byId.get(id), order);
      read.orders.set(sortBy, ordered);
    }
    return ordered;
  }

  private spoil(read: UpstreamRead): void {
    read.spoilt = true;
    this.options.cache.dropStage(read.stage);
  }

  /**
   * An upstream count in the read's ordering: the read takes it, and settles if its pages have
   * all passed already. A count of none holds the area once no page asked for is still to come.
   */
  private counted(
    layer: Layer,
    q: FeatureQuery,
    read: UpstreamRead,
    matched: number | undefined
  ): void {
    if (matched === undefined || read.held || read.spoilt) {
      return;
    }
    // Pages of two counts do not make up an area.
    if (read.matched !== undefined && read.matched !== matched) {
      this.spoil(read);
      return;
    }
    read.matched = matched;
    this.settle(layer, q, read);
  }

  /** The features of an upstream page staged; the area held once every page of it has passed. */
  private keep(layer: Layer, q: FeatureQuery, read: UpstreamRead, text: string): void {
    if (read.held || read.spoilt) {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.spoil(read);
      return;
    }
    const body = parsed as { features?: unknown; numberMatched?: unknown } | null;
    if (typeof body !== 'object' || body === null || !Array.isArray(body.features)) {
      this.spoil(read);
      return;
    }
    const features = body.features as WfsFeature[];
    const matched = pageMatched(body);
    if (matched !== undefined) {
      if (read.matched !== undefined && read.matched !== matched) {
        this.spoil(read);
        return;
      }
      read.matched = matched;
    }
    const cache = this.options.cache;
    const idProperty = this.source(layer.upstream)?.idProperty;
    if (!cache.stage(read.stage, features, cache.orderAt(this.now()), idProperty)) {
      this.spoil(read);
      return;
    }
    read.ranges.push([q.startIndex, q.startIndex + features.length]);
    this.settle(layer, q, read);
  }

  /**
   * Publishes the read once its pages hold all the count says: a count is needed, as a short
   * page may be a server's own page limit. A failure leaves the read to settle on its next page.
   * The read keeps its way until idle, so a page asked for again comes from the same ordering.
   */
  private settle(layer: Layer, q: FeatureQuery, read: UpstreamRead): void {
    if (read.matched === undefined || !coversFromZero(read.ranges, read.matched)) {
      return;
    }
    // A count of none waits for the pages asked for meanwhile: one of them may hold features.
    if (read.matched === 0 && read.inFlight > 0) {
      return;
    }
    // Pages that shifted between requests can cover every index and still repeat a feature.
    // A source no longer configured keeps nothing: its rule is not known.
    const source = this.source(layer.upstream);
    if (!source || this.options.cache.stagedCount(read.stage) !== read.matched) {
      this.spoil(read);
      return;
    }
    const dropped = this.options.cache.publish(read.stage, layer, q, read.startedAt, source.byBox);
    if (dropped === undefined) {
      read.spoilt = true;
      return;
    }
    read.held = true;
    this.options.log?.(
      `WFS proxy: kept ${q.typeName} in ${q.boxText.split(',').slice(0, 4).join(',')} (${String(read.matched)} features)`
    );
    this.fit();
  }

  /** `target` fetched, following a redirect only to a server proxied. */
  private async fetchAllowed(
    target: string,
    req: http.IncomingMessage,
    signal: AbortSignal
  ): Promise<Response> {
    let url = target;
    for (let hop = 0; ; hop++) {
      const reply = await this.fetchUpstream(url, {
        signal,
        redirect: 'manual',
        headers: { accept: req.headers.accept ?? '*/*' }
      });
      const location = reply.headers.get('location');
      if (reply.status < 300 || reply.status >= 400 || location === null) {
        return reply;
      }
      await reply.body?.cancel();
      const next = new URL(location, url);
      const base = normalizeUpstream(next.toString());
      if (hop >= MAX_REDIRECTS || base === undefined || !this.allowed(base)) {
        throw new Error('redirected to a server not proxied');
      }
      url = next.toString();
    }
  }

  /**
   * `target`'s reply streamed to `res` as fast as `res` takes it; `onBody` gets the whole
   * body of a 200 that arrived whole and is no larger than `MAX_KEPT_BYTES`.
   */
  private async pass(
    target: string,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    onBody?: (text: string) => void
  ): Promise<void> {
    const gone = new AbortController();
    res.on('close', () => {
      gone.abort();
    });
    let upstream: Response;
    try {
      upstream = await this.fetchAllowed(target, req, gone.signal);
    } catch (err) {
      if (!res.headersSent && !gone.signal.aborted) {
        res.writeHead(502, { 'content-type': 'text/plain' }).end(`upstream WFS: ${String(err)}`);
      }
      return;
    }
    const type = upstream.headers.get('content-type');
    res.writeHead(upstream.status, type ? { 'content-type': type } : {});
    let kept: Buffer[] | null = onBody !== undefined && upstream.ok ? [] : null;
    let keptBytes = 0;
    if (upstream.body) {
      try {
        for await (const chunk of upstream.body) {
          const buf = Buffer.from(chunk as Uint8Array);
          if (kept) {
            keptBytes += buf.length;
            if (keptBytes > MAX_KEPT_BYTES) {
              kept = null;
            } else {
              kept.push(buf);
            }
          }
          if (!res.write(buf) && !res.destroyed) {
            await drained(res);
          }
          if (gone.signal.aborted) {
            return;
          }
        }
      } catch {
        // The client left or the upstream broke off: the peer must not take it as whole.
        res.destroy();
        return;
      }
    }
    if (gone.signal.aborted) {
      return;
    }
    res.end();
    if (kept && onBody) {
      onBody(Buffer.concat(kept).toString('utf8'));
    }
  }
}
