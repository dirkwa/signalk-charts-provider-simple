/**
 * The local WFS proxy: a WFS server on the loopback interface that peer
 * plugins (signalk-underkeel, and its build processes) read instead of the
 * upstream WFS, so an area is downloaded once and read again from the store
 * (`wfs-cache.ts`).
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
import type { CacheSnapshot, Layer, WfsCache } from './wfs-cache.js';
import {
  answerBox,
  featureQuery,
  hitsMatched,
  hitsReply,
  pageMatched,
  pageReply,
  sortedBy,
  sortOrder,
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

export interface WfsProxyOptions {
  cache: WfsCache;
  /** The upstream servers proxied, as base URLs (no query). */
  upstreams: () => readonly string[];
  /**
   * Whether `upstream` answers a box as Traficom's does, with every feature
   * reaching it and those its turned grid adds past it (`answerBox`), so the
   * store answers boxes inside those it holds. Any other upstream's area is
   * answered from the store only for the same box, with what it gave.
   */
  answersByBox: (upstream: string) => boolean;
  /** An area fetched longer ago than this is fetched again, ms. */
  maxAgeMs: () => number;
  /** False while going online on its own is held back: a stale area is read from the store. */
  mayRefresh: () => boolean;
  fetch?: typeof fetch;
  now?: () => number;
  log?: (message: string) => void;
}

/** The settings a running proxy takes again when the plugin restarts. */
export type WfsProxySettings = Pick<
  WfsProxyOptions,
  'upstreams' | 'answersByBox' | 'maxAgeMs' | 'mayRefresh' | 'log'
>;

interface UpstreamRead {
  lastUsed: number;
  /** The pages passed, as [start, end) of the features' indexes. */
  ranges: [number, number][];
  matched?: number;
  /** A page could not be kept, or the count changed: the area is not held. */
  spoilt: boolean;
  /** Every page has passed and the area is held. */
  held: boolean;
  startedAt: number;
  /** Where its pages wait until the area is whole (`WfsCache.stage`). */
  stage: number;
}

interface StoreRead {
  lastUsed: number;
  snapshot: CacheSnapshot;
  /** For an upstream not answered by box: the read whole whose features it answers. */
  coveredId: number | undefined;
  /** The features answered, fixed for the read so its count and pages agree. */
  ids?: number[];
  /** `ids` in each ordering asked for, by `sortBy`. */
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
    if (u.protocol !== 'https:' && u.protocol !== 'http:') {
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
  private port = 0;
  private options: WfsProxyOptions;
  private readonly upstreamReads = new Map<string, UpstreamRead>();
  private readonly storeReads = new Map<string, StoreRead>();
  /** The count each area's last upstream count gave, for the reads of its pages. */
  private readonly counts = new Map<string, { at: number; matched: number | undefined }>();
  private readonly fetchUpstream: typeof fetch;
  private readonly now: () => number;

  constructor(options: WfsProxyOptions) {
    this.options = options;
    this.fetchUpstream = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  /** Takes `settings` in place of those it has; reads going on keep their way. */
  configure(settings: Partial<WfsProxySettings>): void {
    this.options = { ...this.options, ...settings };
  }

  upstreams(): readonly string[] {
    return this.options.upstreams();
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
      const onError = (err: NodeJS.ErrnoException): void => {
        if (port !== 0 && err.code === 'EADDRINUSE') {
          server.removeListener('error', onError);
          server.listen(0, '127.0.0.1', () => {
            resolve((server.address() as AddressInfo).port);
          });
          return;
        }
        reject(err);
      };
      server.on('error', onError);
      server.listen(port, '127.0.0.1', () => {
        server.removeListener('error', onError);
        resolve((server.address() as AddressInfo).port);
      });
    });
    this.server = server;
    this.port = bound;
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
      r.snapshot.close();
    }
    this.storeReads.clear();
    for (const r of this.upstreamReads.values()) {
      this.options.cache.dropStage(r.stage);
    }
    this.upstreamReads.clear();
  }

  private allowed(base: string): boolean {
    return this.options.upstreams().some((u) => normalizeUpstream(u) === base);
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
      await this.pass(target, req, res);
      return;
    }
    const layer: Layer = { upstream, typeName: q.typeName };
    const area = `${upstream}\n${q.typeName}\n${q.boxText}`;
    const readKey = `${area}\n${q.sortBy ?? ''}`;
    this.sweep();
    if (q.hits) {
      // A count begins a read: the area's finished upstream reads end, so its pages may come
      // from the store, or upstream and be kept again.
      for (const [k, r] of this.upstreamReads) {
        if (k.startsWith(`${area}\n`) && r.held) {
          this.endUpstreamRead(k, r);
        }
      }
    }
    const fromStore = this.storeRead(area, readKey, layer, q);
    if (fromStore) {
      this.answer(fromStore, layer, q, res);
      return;
    }
    if (q.hits) {
      const startedAt = this.now();
      await this.pass(target, req, res, (text) => {
        this.counted(area, readKey, layer, q, startedAt, hitsMatched(text));
      });
      return;
    }
    const read = this.upstreamRead(area, readKey);
    await this.pass(target, req, res, (text) => {
      // A page that outlived its read, which another has replaced, keeps nothing.
      if (this.upstreamReads.get(readKey) === read) {
        this.keep(layer, q, read, text);
      }
    });
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
        r.snapshot.close();
      }
    }
    for (const [k, c] of this.counts) {
      if (now - c.at > READ_IDLE_MS) {
        this.counts.delete(k);
      }
    }
  }

  /**
   * The area's read from the store: going on, else begun now when the store holds the area,
   * else undefined. A request in an ordering the store cannot give goes upstream, and so does
   * one, count or page, in the ordering of a read going on upstream. One read serves every
   * ordering of the area and reads one snapshot until idle, so its count and its pages agree.
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
    const byBox = this.options.answersByBox(layer.upstream);
    const heldSince = (since: number): { coveredId: number | undefined } | undefined => {
      if (byBox) {
        return cache.covers(layer, q.box, since) ? { coveredId: undefined } : undefined;
      }
      const coveredId = cache.exactCover(layer, q.boxText, since);
      return coveredId === undefined ? undefined : { coveredId };
    };
    const held =
      heldSince(now - this.options.maxAgeMs()) ??
      (this.options.mayRefresh() ? undefined : heldSince(0));
    if (!held) {
      return undefined;
    }
    const read: StoreRead = { lastUsed: now, snapshot: cache.snapshot(), ...held };
    this.storeReads.set(area, read);
    return read;
  }

  /**
   * The area's read upstream in the request's ordering: each ordering is its own, as pages of
   * two orderings do not make up an area. A new one takes the area's count, when one passed.
   */
  private upstreamRead(area: string, readKey: string): UpstreamRead {
    const now = this.now();
    const going = this.upstreamReads.get(readKey);
    if (going) {
      going.lastUsed = now;
      return going;
    }
    const read: UpstreamRead = {
      lastUsed: now,
      ranges: [],
      matched: this.counts.get(area)?.matched,
      spoilt: false,
      held: false,
      startedAt: now,
      stage: this.options.cache.beginStage()
    };
    this.upstreamReads.set(readKey, read);
    return read;
  }

  private answer(read: StoreRead, layer: Layer, q: FeatureQuery, res: http.ServerResponse): void {
    // By box: as much as the upstream would answer, and the features past the box it adds.
    const ids = (read.ids ??=
      read.coveredId === undefined
        ? read.snapshot.idsIn(layer, answerBox(q.box))
        : read.snapshot.members(read.coveredId));
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
      .end(pageReply(ids.length, read.snapshot.features(page)));
  }

  /** A store read's features in the ordering `sortBy` asks for (`storeRead` took only those). */
  private inOrder(read: StoreRead, ids: number[], sortBy: string | undefined): number[] {
    const order = sortBy === undefined ? undefined : sortOrder(sortBy);
    if (sortBy === undefined || order === undefined) {
      return ids;
    }
    read.orders ??= new Map();
    let ordered = read.orders.get(sortBy);
    if (!ordered) {
      const byId = read.snapshot.featuresById(ids);
      ordered = sortedBy(ids, (id) => byId.get(id), order);
      read.orders.set(sortBy, ordered);
    }
    return ordered;
  }

  private spoil(read: UpstreamRead): void {
    read.spoilt = true;
    this.options.cache.dropStage(read.stage);
  }

  /** An upstream count of the area: its reads take it, and a count of none holds the area. */
  private counted(
    area: string,
    readKey: string,
    layer: Layer,
    q: FeatureQuery,
    startedAt: number,
    matched: number | undefined
  ): void {
    this.counts.set(area, { at: this.now(), matched });
    const going = this.upstreamReads.get(readKey);
    if (going && matched !== undefined) {
      // Pages of two counts do not make up an area.
      if (going.matched !== undefined && going.matched !== matched) {
        this.spoil(going);
      }
      going.matched = matched;
    }
    // An area with none is whole at once: no page of it will come.
    if (matched === 0) {
      this.options.cache.publish(
        undefined,
        layer,
        q,
        startedAt,
        this.options.answersByBox(layer.upstream)
      );
    }
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
    if (!this.options.cache.stage(read.stage, features, this.now())) {
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
    this.options.cache.publish(
      read.stage,
      layer,
      q,
      read.startedAt,
      this.options.answersByBox(layer.upstream)
    );
    read.held = true;
    this.options.log?.(
      `WFS proxy: kept ${q.typeName} in ${q.boxText.split(',').slice(0, 4).join(',')} (${String(read.matched)} features)`
    );
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
