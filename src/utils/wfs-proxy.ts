/**
 * The local WFS proxy: a WFS server on the loopback interface that peer
 * plugins (signalk-underkeel, and its build processes) read instead of the
 * upstream WFS, so an area is downloaded once and read again from the store
 * (`wfs-cache.ts`).
 *
 * A request the cache can answer (`wfs-query.ts`) for an area it holds whole
 * and fresh is answered from the store. Any other is passed to the upstream
 * server and its reply streamed back as it arrives; the features of its pages
 * are kept, and once every page of an area has passed, the area is held. An
 * area keeps the way its read began, from the store or upstream, until the
 * read has been idle a while, so its pages come from one ordering.
 *
 * It listens on 127.0.0.1 only, under a path holding a random token only
 * this server's plugins learn (`proxyUrl`): it is no open proxy, and needs no
 * Signal K login.
 */

import crypto from 'crypto';
import http from 'http';
import type { AddressInfo } from 'net';
import type { WfsCache, Layer } from './wfs-cache.js';
import {
  answerBox,
  featureQuery,
  hitsReply,
  matchedIn,
  pageReply,
  type FeatureQuery,
  type WfsFeature
} from './wfs-query.js';

/** An area's read keeps its way this long after its last request, ms. */
export const READ_IDLE_MS = 10 * 60_000;
/** Answers from the store kept for their next pages, at most. */
const KEPT_ANSWERS = 32;

export interface WfsProxyOptions {
  cache: WfsCache;
  /** The upstream servers proxied, as base URLs (no query). */
  upstreams: () => readonly string[];
  /** An area fetched longer ago than this is fetched again, ms. */
  maxAgeMs: () => number;
  /** False while going online on its own is held back: a stale area is read from the store. */
  mayRefresh: () => boolean;
  fetch?: typeof fetch;
  now?: () => number;
  log?: (message: string) => void;
}

interface AreaRead {
  way: 'store' | 'upstream';
  lastUsed: number;
  /** Upstream: the pages passed, as [start, end) of the features' indexes. */
  ranges: [number, number][];
  matched?: number;
  /** Upstream: a page could not be kept, so the area is not held. */
  spoilt: boolean;
  startedAt: number;
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

export class WfsProxy {
  private server: http.Server | null = null;
  private port = 0;
  private readonly reads = new Map<string, AreaRead>();
  private readonly answers = new Map<string, number[]>();
  private readonly fetchUpstream: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly options: WfsProxyOptions) {
    this.fetchUpstream = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
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

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    }
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
    const key = `${upstream}\n${q.typeName}\n${q.boxText}`;
    const read = this.readOf(key, layer, q);
    if (read.way === 'store') {
      this.answer(key, layer, q, res);
      return;
    }
    await this.pass(target, req, res, (text) => {
      this.keep(key, layer, q, read, text);
    });
  }

  /** The area's read: going on, else begun now, from the store when it holds the area. */
  private readOf(key: string, layer: Layer, q: FeatureQuery): AreaRead {
    const now = this.now();
    for (const [k, r] of this.reads) {
      if (now - r.lastUsed > READ_IDLE_MS) {
        this.reads.delete(k);
        this.answers.delete(k);
      }
    }
    const going = this.reads.get(key);
    if (going) {
      going.lastUsed = now;
      return going;
    }
    const fresh = this.options.cache.covers(layer, q.box, now - this.options.maxAgeMs());
    const held =
      fresh || (!this.options.mayRefresh() && this.options.cache.covers(layer, q.box, 0));
    const read: AreaRead = {
      way: held ? 'store' : 'upstream',
      lastUsed: now,
      ranges: [],
      spoilt: false,
      startedAt: now
    };
    this.reads.set(key, read);
    return read;
  }

  private answer(key: string, layer: Layer, q: FeatureQuery, res: http.ServerResponse): void {
    let ids = this.answers.get(key);
    if (ids === undefined) {
      // As much as the upstream would answer, and the features past the box it adds.
      ids = this.options.cache.idsIn(layer, answerBox(q.box));
      this.answers.set(key, ids);
      while (this.answers.size > KEPT_ANSWERS) {
        const oldest = this.answers.keys().next().value as string;
        this.answers.delete(oldest);
      }
    }
    if (q.hits) {
      res.writeHead(200, { 'content-type': 'application/xml' }).end(hitsReply(ids.length));
      return;
    }
    const page = ids.slice(
      q.startIndex,
      q.count === undefined ? undefined : q.startIndex + q.count
    );
    res
      .writeHead(200, { 'content-type': 'application/json' })
      .end(pageReply(ids.length, this.options.cache.features(page)));
  }

  /** The features of an upstream page kept; the area held once every page of it has passed. */
  private keep(key: string, layer: Layer, q: FeatureQuery, read: AreaRead, text: string): void {
    const matched = matchedIn(text);
    if (matched !== undefined) {
      read.matched = matched;
    }
    if (q.hits) {
      this.settle(key, layer, q, read);
      return;
    }
    let features: WfsFeature[];
    try {
      const body = JSON.parse(text) as { features?: unknown };
      if (!Array.isArray(body.features)) {
        read.spoilt = true;
        return;
      }
      features = body.features as WfsFeature[];
    } catch {
      read.spoilt = true;
      return;
    }
    if (!this.options.cache.put(layer, features, this.now())) {
      read.spoilt = true;
      return;
    }
    read.ranges.push([q.startIndex, q.startIndex + features.length]);
    // A short page, or one with no page size, is the last: it says how many there are.
    if (q.count === undefined || features.length < q.count) {
      read.matched ??= q.startIndex + features.length;
    }
    this.settle(key, layer, q, read);
  }

  private settle(key: string, layer: Layer, q: FeatureQuery, read: AreaRead): void {
    if (read.spoilt || read.matched === undefined || !coversFromZero(read.ranges, read.matched)) {
      return;
    }
    // Held as of the read's start: a feature changed meanwhile may be older.
    this.options.cache.markCovered(layer, q.box, read.startedAt);
    this.reads.delete(key);
    this.options.log?.(
      `WFS proxy: kept ${q.typeName} in ${q.boxText.split(',').slice(0, 4).join(',')} (${String(read.matched)} features)`
    );
  }

  /** `target`'s reply streamed to `res`; `onBody` gets the whole body of a 200. */
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
      upstream = await this.fetchUpstream(target, {
        signal: gone.signal,
        headers: { accept: req.headers.accept ?? '*/*' }
      });
    } catch (err) {
      if (!res.headersSent && !gone.signal.aborted) {
        res.writeHead(502, { 'content-type': 'text/plain' }).end(`upstream WFS: ${String(err)}`);
      }
      return;
    }
    const type = upstream.headers.get('content-type');
    res.writeHead(upstream.status, type ? { 'content-type': type } : {});
    const chunks: Buffer[] = [];
    const keep = onBody !== undefined && upstream.ok;
    if (upstream.body) {
      try {
        for await (const chunk of upstream.body) {
          const buf = Buffer.from(chunk as Uint8Array);
          if (keep) {
            chunks.push(buf);
          }
          res.write(buf);
        }
      } catch {
        // The client left or the upstream broke off: nothing whole to keep.
        res.end();
        return;
      }
    }
    const whole = !gone.signal.aborted;
    res.end();
    if (keep && whole) {
      onBody(Buffer.concat(chunks).toString('utf8'));
    }
  }
}
