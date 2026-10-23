/**
 * A download fallback for servers whose HTTP responses Node's strict parser
 * refuses. The Brazilian Navy's download host folds a long header across
 * lines ("obsolete line folding"), which HTTP/1.1 deprecated and which
 * curl and browsers still accept. Node versions differ in how `fetch`
 * handles it: some refuse the header, others accept it but then miscount
 * the body against its Content-Length. `fetch` cannot relax its parser, so
 * a download that fails either way is retried once through `node:https`
 * with `insecureHTTPParser`. A body genuinely cut short fails the same
 * way, and the retry is harmless for it.
 *
 * Only header parsing is relaxed. TLS is untouched: the certificate is
 * verified exactly as for `fetch`. The parser's strictness guards against
 * request smuggling between proxies and servers, which does not arise for
 * a client fetching one file.
 */

import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import type { LookupFunction } from 'node:net';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/**
 * True when `fetch` failed because it could not read the response as
 * valid HTTP/1.1: a header it refused, or a body that did not match the
 * Content-Length it read.
 */
export function isMalformedResponse(err: unknown): boolean {
  const cause = (err as { cause?: { code?: unknown; message?: unknown } } | null)?.cause;
  const code = typeof cause?.code === 'string' ? cause.code : '';
  const text = typeof cause?.message === 'string' ? cause.message : '';
  return (
    code.startsWith('HPE_') ||
    code === 'UND_ERR_RES_CONTENT_LENGTH_MISMATCH' ||
    text.includes('does not match the HTTP/1.1 protocol')
  );
}

/** A pass-through stream that fails once more than `maxBytes` have gone through it. */
export function byteLimit(maxBytes: number): Transform {
  let bytes = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      callback(bytes > maxBytes ? new Error('download exceeds the size limit') : null, chunk);
    }
  });
}

/** An HTTP answer other than 200, with its status for the caller to judge. */
export class HttpStatusError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${String(status)}`);
    this.name = 'HttpStatusError';
  }
}

export interface LenientDownloadOptions {
  headers: Record<string, string>;
  maxBytes: number;
  signal?: AbortSignal;
  /** Relax header parsing (the default). False parses as strictly as `fetch`. */
  insecureHTTPParser?: boolean;
  /** Trusted certificates in place of Node's default set. */
  ca?: string[];
  /** Fail when the connection is silent this long. */
  timeoutMs?: number;
  /**
   * Refuse a URL, the first or any redirect hop, by returning why; null
   * lets it through. The download fails with `RefusedUrlError`.
   */
  checkUrl?: (url: URL) => string | null;
  /** Resolves host names in place of `dns.lookup`, for every hop. */
  lookup?: LookupFunction;
}

/** A URL `checkUrl` refused. */
export class RefusedUrlError extends Error {
  constructor(
    readonly url: string,
    readonly reason: string
  ) {
    super(`refused ${url}: ${reason}`);
    this.name = 'RefusedUrlError';
  }
}

/** Download `url` to `target`, following redirects, with header parsing relaxed. */
export function downloadLenient(
  url: string,
  target: string,
  options: LenientDownloadOptions,
  redirectsLeft = 5
): Promise<void> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const refusal = options.checkUrl?.(parsed) ?? null;
    if (refusal !== null) {
      reject(new RefusedUrlError(parsed.href, refusal));
      return;
    }
    const get = parsed.protocol === 'https:' ? https.get : http.get;
    // Once a response has arrived, its own handling settles the promise: a
    // body cut short (such as by the size limit) also makes the request
    // report "socket hang up", which must not mask the real reason.
    let responded = false;
    const request = get(
      parsed,
      {
        headers: options.headers,
        insecureHTTPParser: options.insecureHTTPParser ?? true,
        signal: options.signal,
        ...(options.ca ? { ca: options.ca } : {}),
        ...(options.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
        ...(options.lookup ? { lookup: options.lookup } : {})
      },
      (response) => {
        responded = true;
        const status = response.statusCode ?? 0;
        const location = response.headers.location;
        if (status >= 300 && status < 400 && location) {
          response.resume();
          if (redirectsLeft <= 0) {
            reject(new Error('too many redirects'));
            return;
          }
          downloadLenient(new URL(location, url).href, target, options, redirectsLeft - 1).then(
            resolve,
            reject
          );
          return;
        }
        if (status !== 200) {
          response.resume();
          reject(new HttpStatusError(status));
          return;
        }
        pipeline(response, byteLimit(options.maxBytes), fs.createWriteStream(target)).then(
          resolve,
          reject
        );
      }
    );
    request.on('error', (err) => {
      if (!responded) {
        reject(err);
      }
    });
    // 'timeout' only reports a silent socket; destroying it with an error
    // fails the request (or the body, once a response has arrived).
    request.on('timeout', () => {
      request.destroy(new Error('the server stopped responding'));
    });
  });
}
