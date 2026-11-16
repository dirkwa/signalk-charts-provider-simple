/**
 * Downloads and caches the Open Data Charts index the way
 * `enc-index-manager.ts` handles the ENC index: revalidated by ETag, the
 * last good copy kept on disk so the tab and the update status work
 * offline, and `OPEN_DATA_INDEX_URL` pointing a development server at
 * another copy. Serving charts never needs it.
 */

import fs from 'fs';
import path from 'path';
import type { CatalogStatus, DebugFunction } from '../../types.js';
import { interpretOpenDataIndex, type OpenDataIndex } from './index-schema.js';

export const DEFAULT_OPEN_DATA_INDEX_URL =
  'https://dirkwa.github.io/open-data-charts/open-data-index.json';

const CACHE_DIR = 'open-data-index-cache';
const CACHE_FILE = 'open-data-index.json';
const CACHE_META_FILE = 'open-data-index.meta.json';
const FETCH_TIMEOUT_MS = 120_000;
const STALE_AFTER_MS = 6 * 60 * 60 * 1000;

export interface LoadedOpenDataIndex extends OpenDataIndex {
  fetchedAt: string;
  etag: string | null;
}

interface CacheMeta {
  fetchedAt: string;
  etag: string | null;
}

export class OpenDataIndexManager {
  private loaded: LoadedOpenDataIndex | null = null;
  // Read on first use: a start happens on every config save, and a boat
  // without Open Data Charts never needs the file.
  private cacheRead = false;
  private inFlight: Promise<void> | null = null;
  private readonly status: CatalogStatus = {
    status: 'never',
    lastAttemptAt: null,
    lastSuccessAt: null,
    httpStatus: null,
    message: null
  };
  private readonly cacheDir: string;

  constructor(
    dataDir: string,
    private readonly url: string,
    private readonly debug: DebugFunction
  ) {
    this.cacheDir = path.join(dataDir, CACHE_DIR);
  }

  index(): LoadedOpenDataIndex | null {
    this.loadCache();
    return this.loaded;
  }

  getStatus(): CatalogStatus {
    return { ...this.status };
  }

  /** Never rejects; a failed refresh keeps the index loaded before. */
  refresh(): Promise<void> {
    this.inFlight ??= this.doRefresh().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  isStale(): boolean {
    const last = this.status.lastSuccessAt;
    return last === null || Date.now() - last > STALE_AFTER_MS;
  }

  private apply(raw: unknown, fetchedAt: string, etag: string | null): boolean {
    const result = interpretOpenDataIndex(raw);
    if (!result.ok) {
      this.status.status = result.reason === 'incompatible' ? 'incompatible' : 'error';
      this.status.message = result.message;
      return false;
    }
    if (result.skipped > 0) {
      this.debug(
        `Open Data Charts index: skipped ${String(result.skipped)} entries this version cannot read`
      );
    }
    this.loaded = { ...result.index, fetchedAt, etag };
    return true;
  }

  private loadCache(): void {
    if (this.cacheRead) {
      return;
    }
    this.cacheRead = true;
    try {
      const file = path.join(this.cacheDir, CACHE_FILE);
      if (!fs.existsSync(file)) {
        return;
      }
      const meta = JSON.parse(
        fs.readFileSync(path.join(this.cacheDir, CACHE_META_FILE), 'utf-8')
      ) as Partial<CacheMeta>;
      const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf-8'));
      if (
        typeof meta.fetchedAt === 'string' &&
        this.apply(raw, meta.fetchedAt, meta.etag ?? null)
      ) {
        // Usable, but not news: the status stays 'never' until this start reaches the server.
        this.status.message = null;
      }
    } catch {
      this.debug('Discarding the Open Data Charts index cache - unreadable');
    }
  }

  // A temporary name renamed into place, so a power cut cannot leave a truncated index.
  private saveCache(text: string | null, meta: CacheMeta): void {
    const write = (name: string, content: string): void => {
      const file = path.join(this.cacheDir, name);
      fs.writeFileSync(`${file}.tmp`, content, 'utf-8');
      fs.renameSync(`${file}.tmp`, file);
    };
    try {
      fs.mkdirSync(this.cacheDir, { recursive: true });
      if (text !== null) {
        write(CACHE_FILE, text);
      }
      write(CACHE_META_FILE, JSON.stringify(meta));
    } catch (error) {
      this.debug(
        `Error writing the Open Data Charts index cache: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private fetchIndex(etag: string | null): Promise<Response> {
    return fetch(this.url, {
      headers: etag ? { 'If-None-Match': etag } : {},
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });
  }

  private async doRefresh(): Promise<void> {
    this.loadCache();
    const status = this.status;
    status.lastAttemptAt = Date.now();
    let response: Response;
    try {
      response = await this.fetchIndex(this.loaded?.etag ?? null);
      if (response.status === 304 && !this.loaded) {
        response = await this.fetchIndex(null);
      }
    } catch (error) {
      status.status = 'error';
      status.httpStatus = null;
      status.message =
        "Could not reach the Open Data Charts index. Check this device's internet connection, then click Refresh.";
      this.debug(
        `Open Data Charts index refresh failed: ${error instanceof Error ? error.message : String(error)}`
      );
      return;
    }
    status.httpStatus = response.status;
    const now = new Date().toISOString();
    if (response.status === 304 && this.loaded) {
      this.loaded.fetchedAt = now;
      this.saveCache(null, { fetchedAt: now, etag: this.loaded.etag });
    } else if (response.ok) {
      let text: string;
      let raw: unknown;
      try {
        text = await response.text();
        raw = JSON.parse(text);
      } catch {
        status.status = 'error';
        status.message = 'The Open Data Charts index is damaged. Try Refresh again later.';
        return;
      }
      const etag = response.headers.get('etag');
      if (!this.apply(raw, now, etag)) {
        return;
      }
      this.saveCache(text, { fetchedAt: now, etag });
    } else {
      status.status = 'error';
      status.message =
        response.status === 404
          ? 'The Open Data Charts index has not been published yet. Try Refresh again later.'
          : `The Open Data Charts index is not available right now (HTTP ${String(response.status)}). Try Refresh again later.`;
      return;
    }
    status.status = 'ok';
    status.message = null;
    status.lastSuccessAt = Date.now();
  }
}
