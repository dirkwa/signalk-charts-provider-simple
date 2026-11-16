/**
 * Downloaded unit and overview files, under `<dataDir>/open-data-cache/`,
 * named `<id>.<version>.mbtiles` so a new version never overwrites the file
 * a chart was built from. Files are shared by every set; the ones no set
 * uses any more are pruned.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import type { ReadableStream as WebReadableStream } from 'stream/web';
import {
  MAX_DOWNLOAD_ATTEMPTS,
  RETRY_BACKOFF_MS,
  TransientDownloadError
} from '../download-manager.js';

const CACHE_ROOT = 'open-data-cache';
const PART_SUFFIX = '.part';
const IDLE_TIMEOUT_MS = 60_000;
// Marks the folder as a rebuildable cache, so backup tools can skip it.
const CACHEDIR_TAG =
  'Signature: 8a477f597d28d172789f06886806bc55\n# Open Data Charts downloads; they are downloaded again when needed.\n';

export type CacheKind = 'units' | 'overviews';

export interface DownloadTarget {
  url: string;
  size: number;
  sha256: string;
}

export interface DownloadOptions {
  signal?: AbortSignal;
  /** Bytes of this file on disk so far, as they arrive. */
  onBytes?: (bytes: number) => void;
}

export class UnitCache {
  readonly root: string;

  constructor(dataDir: string) {
    this.root = path.join(dataDir, CACHE_ROOT);
  }

  file(kind: CacheKind, id: string, version: string): string {
    return path.join(this.root, kind, `${id}.${version}.mbtiles`);
  }

  has(kind: CacheKind, id: string, version: string): boolean {
    return fs.existsSync(this.file(kind, id, version));
  }

  /** Bytes the cached file takes, or 0 when it is not cached. */
  bytes(kind: CacheKind, id: string, version: string): number {
    try {
      return fs.statSync(this.file(kind, id, version)).size;
    } catch {
      return 0;
    }
  }

  /**
   * Download `target` into the cache unless it is there already. The body
   * lands in a `.part` file that a retry resumes, and is renamed into place
   * only once its size and SHA-256 match the index.
   */
  async ensure(
    kind: CacheKind,
    id: string,
    version: string,
    target: DownloadTarget,
    options: DownloadOptions = {}
  ): Promise<string> {
    const dest = this.file(kind, id, version);
    if (fs.existsSync(dest)) {
      return dest;
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    this.writeTag();
    const part = `${dest}${PART_SUFFIX}`;
    let attemptsWithoutProgress = 0;
    for (;;) {
      options.signal?.throwIfAborted();
      const before = fileSize(part);
      try {
        await fetchInto(target, part, options);
        break;
      } catch (error) {
        if (options.signal?.aborted || !(error instanceof TransientDownloadError)) {
          throw error;
        }
        // Bytes that arrived rearm the budget, as in the download manager.
        attemptsWithoutProgress = fileSize(part) > before ? 0 : attemptsWithoutProgress + 1;
        if (attemptsWithoutProgress >= MAX_DOWNLOAD_ATTEMPTS) {
          throw error;
        }
        await sleep(RETRY_BACKOFF_MS * Math.max(1, attemptsWithoutProgress), options.signal);
      }
    }
    const digest = await sha256Of(part);
    if (digest !== target.sha256.toLowerCase()) {
      fs.rmSync(part, { force: true });
      throw new Error(
        `The download of ${id} does not match its checksum; it was discarded. Try again later.`
      );
    }
    fs.renameSync(part, dest);
    return dest;
  }

  /**
   * Remove every cached file whose name `keep` does not hold, partial
   * downloads included; call it only while nothing downloads.
   */
  prune(keep: ReadonlySet<string>): string[] {
    const removed: string[] = [];
    for (const kind of ['units', 'overviews'] as const) {
      const dir = path.join(this.root, kind);
      let names: string[];
      try {
        names = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        if (!keep.has(path.join(kind, name))) {
          fs.rmSync(path.join(dir, name), { force: true });
          removed.push(name);
        }
      }
    }
    return removed;
  }

  /** The `prune` key of a cached file. */
  static key(kind: CacheKind, id: string, version: string): string {
    return path.join(kind, `${id}.${version}.mbtiles`);
  }

  private writeTag(): void {
    const tag = path.join(this.root, 'CACHEDIR.TAG');
    if (!fs.existsSync(tag)) {
      fs.writeFileSync(tag, CACHEDIR_TAG);
    }
  }
}

function fileSize(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason as Error);
      },
      { once: true }
    );
  });
}

async function sha256Of(file: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest('hex');
}

/** One attempt: append the rest of the body to `part`, resuming by Range. */
async function fetchInto(
  target: DownloadTarget,
  part: string,
  options: DownloadOptions
): Promise<void> {
  let start = fileSize(part);
  if (start > target.size) {
    fs.rmSync(part, { force: true });
    start = 0;
  }
  if (start === target.size) {
    return;
  }
  // An idle limit, not a total one: a large unit on a slow link takes long.
  const idle = new AbortController();
  const idleTimer = setTimeout(() => {
    idle.abort(new Error('No data received for a minute'));
  }, IDLE_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, idle.signal]) : idle.signal;
  try {
    await transfer();
  } finally {
    clearTimeout(idleTimer);
  }

  async function transfer(): Promise<void> {
    let response: Response;
    try {
      response = await fetch(target.url, {
        headers: start > 0 ? { Range: `bytes=${String(start)}-` } : {},
        signal
      });
    } catch (error) {
      if (options.signal?.aborted) {
        throw error;
      }
      throw new TransientDownloadError(error instanceof Error ? error.message : String(error));
    }
    const resumed = response.status === 206 && start > 0;
    if (!response.ok || response.body === null) {
      const message = `HTTP ${String(response.status)}`;
      throw response.status >= 500 ? new TransientDownloadError(message) : new Error(message);
    }
    if (
      resumed &&
      !(response.headers.get('content-range') ?? '').startsWith(`bytes ${String(start)}-`)
    ) {
      fs.rmSync(part, { force: true });
      throw new TransientDownloadError('The server resumed at another offset; restarting');
    }
    let written = resumed ? start : 0;
    const body = Readable.fromWeb(response.body as WebReadableStream<Uint8Array>);
    body.on('data', (chunk: Buffer) => {
      idleTimer.refresh();
      written += chunk.length;
      options.onBytes?.(written);
    });
    try {
      // A 200 to a Range request means the server sent the whole body again.
      await pipeline(body, fs.createWriteStream(part, { flags: resumed ? 'a' : 'w' }));
    } catch (error) {
      if (options.signal?.aborted) {
        throw error;
      }
      throw new TransientDownloadError(error instanceof Error ? error.message : String(error));
    }
    if (fileSize(part) < target.size) {
      throw new TransientDownloadError('The connection closed early');
    }
    if (fileSize(part) > target.size) {
      fs.rmSync(part, { force: true });
      throw new Error('The download is larger than the index says');
    }
  }
}
