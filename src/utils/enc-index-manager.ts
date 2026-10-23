/**
 * Downloads and caches the ENC index (`docs/enc-index.md`) that this repo
 * publishes next to the merged chart catalog, the same way
 * `catalog-manager.ts` handles the catalog: revalidated by ETag, the last
 * good copy kept on disk so the ENC Charts tab works offline, and
 * `ENC_INDEX_URL` pointing a development server at another copy.
 *
 * Only chart sets need the index. Serving charts never waits for it, and a
 * failed download keeps whatever was loaded before.
 */

import fs from 'fs';
import path from 'path';
import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';
import {
  ENC_INDEX_SCHEMA_VERSION,
  EncIndexCellSchema,
  EncOutlineSchema,
  type EncIndexArchive,
  type EncIndexUnit
} from '../catalog/enc-index-schema.js';
import { BboxSchema } from '../catalog/merged-catalog-schema.js';
import type { CatalogStatus, DebugFunction } from '../types.js';
import { buildEncIndexLookup, type EncIndexLookup } from './enc-chart-set.js';

const DEFAULT_ENC_INDEX_URL =
  'https://dirkwa.github.io/signalk-charts-provider-simple/enc-index.json';

const CACHE_DIR = 'enc-index-cache';
const CACHE_FILE = 'enc-index.json';
const CACHE_META_FILE = 'enc-index.meta.json';
const FETCH_TIMEOUT_MS = 120000;

// The index is republished at most every few hours, like the catalog.
const STALE_AFTER_MS = 6 * 60 * 60 * 1000;

/**
 * What this plugin needs from each entry, and nothing more. The published
 * schema closes some value lists (a source's `kind`, the scale as an
 * integer) that the compatibility policy lets grow, so checking against it
 * would drop entries over a change this version never reads. Only what the
 * plugin acts on is strict: an archive `kind` the downloader cannot handle,
 * or an outline it cannot draw, makes the entry unreadable.
 */
const SourceReadSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  label: Type.String({ minLength: 1 })
});

const ArchiveReadSchema = Type.Object({
  url: Type.String({ pattern: '^https?://' }),
  source: Type.String({ minLength: 1 }),
  version: Type.String(),
  kind: Type.Union([Type.Literal('zip'), Type.Literal('cell')]),
  updates: Type.Optional(Type.Array(Type.String({ minLength: 1 })))
});

const UnitReadSchema = Type.Object({
  source: Type.String({ minLength: 1 }),
  id: Type.String({ minLength: 1 }),
  title: Type.String(),
  scale: Type.Optional(Type.Number()),
  bbox: BboxSchema,
  outline: EncOutlineSchema,
  cells: Type.Array(EncIndexCellSchema, { minItems: 1 }),
  statusCells: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })
});

/** A source as the tab shows it. */
export type EncIndexSourceInfo = Static<typeof SourceReadSchema>;

/** The downloaded index, reduced to the entries this plugin can read. */
export interface LoadedEncIndex extends EncIndexLookup {
  fetchedAt: string;
  etag: string | null;
  generatedAt: string;
  contentHash: string;
  sources: EncIndexSourceInfo[];
  units: EncIndexUnit[];
}

interface CacheMeta {
  fetchedAt: string;
  etag: string | null;
}

export type InterpretedEncIndex =
  | {
      ok: true;
      index: Omit<LoadedEncIndex, 'fetchedAt' | 'etag'>;
      skipped: number;
    }
  | { ok: false; reason: 'invalid' | 'incompatible'; message: string };

const DAMAGED = 'The downloaded ENC index is damaged. Try Refresh again later.';

let indexUrl = DEFAULT_ENC_INDEX_URL;
let cacheDir = '';
let debug: DebugFunction = () => {};
let loaded: LoadedEncIndex | null = null;
// The disk copy is read on first use, not at start: a start happens on every
// config save, and a device without chart sets may never need the index.
let cacheRead = false;
let mapPayload: string | null = null;
let inFlightRefresh: Promise<void> | null = null;
const status: CatalogStatus = {
  status: 'never',
  lastAttemptAt: null,
  lastSuccessAt: null,
  httpStatus: null,
  message: null
};

/**
 * Read a downloaded index under the published compatibility policy: unknown
 * fields are ignored and sources, archives and units are checked one at a
 * time, so one this version cannot read is skipped and not the file. Only
 * a newer `schemaVersion` makes the whole file unusable.
 */
export function interpretEncIndex(raw: unknown): InterpretedEncIndex {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'invalid', message: DAMAGED };
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.schemaVersion !== 'number') {
    return { ok: false, reason: 'invalid', message: DAMAGED };
  }
  if (obj.schemaVersion > ENC_INDEX_SCHEMA_VERSION) {
    return {
      ok: false,
      reason: 'incompatible',
      message:
        'The ENC index uses a newer format than this version of the plugin. Update the plugin to use it.'
    };
  }
  if (
    obj.schemaVersion !== ENC_INDEX_SCHEMA_VERSION ||
    typeof obj.generatedAt !== 'string' ||
    typeof obj.contentHash !== 'string' ||
    !Array.isArray(obj.sources) ||
    !Array.isArray(obj.archives) ||
    !Array.isArray(obj.units)
  ) {
    return { ok: false, reason: 'invalid', message: DAMAGED };
  }

  let skipped = 0;
  const keep = <T>(list: unknown[], check: (x: unknown) => x is T): T[] => {
    const out: T[] = [];
    for (const item of list) {
      if (check(item)) {
        out.push(item);
      } else {
        skipped++;
      }
    }
    return out;
  };
  const sources = keep(obj.sources as unknown[], (x): x is EncIndexSourceInfo =>
    Value.Check(SourceReadSchema, x)
  ).map((s) => ({ id: s.id, label: s.label }));
  const archives = keep(obj.archives as unknown[], (x): x is EncIndexArchive =>
    Value.Check(ArchiveReadSchema, x)
  );
  // A unit whose cells name an archive that was skipped could be selected
  // but not downloaded, so it goes too.
  const archiveUrls = new Set(archives.map((a) => a.url));
  const units = keep(
    obj.units as unknown[],
    (x): x is EncIndexUnit =>
      Value.Check(UnitReadSchema, x) && x.cells.every((c) => archiveUrls.has(c.archive))
  );
  return {
    ok: true,
    index: {
      generatedAt: obj.generatedAt,
      contentHash: obj.contentHash,
      sources,
      units,
      ...buildEncIndexLookup(units, archives)
    },
    skipped
  };
}

/**
 * What the ENC Charts map draws: each selectable unit's outline and labels,
 * without the cell lists, which only the server needs. It changes only with
 * the index's content, so it is built once per download.
 */
export function encMapPayload(index: Omit<LoadedEncIndex, 'etag' | 'fetchedAt'>): string {
  const selectable = [...index.noaaUnits.values(), ...index.otherUnits.values()];
  const counts = new Map<string, number>();
  for (const unit of selectable) {
    counts.set(unit.source, (counts.get(unit.source) ?? 0) + 1);
  }
  return JSON.stringify({
    generatedAt: index.generatedAt,
    // A unit whose source the index does not list (or this version could not
    // read) still gets an entry, named by its id.
    sources: [
      ...index.sources.map((s) => ({ id: s.id, label: s.label })),
      ...[...counts.keys()]
        .filter((id) => !index.sources.some((s) => s.id === id))
        .map((id) => ({ id, label: id }))
    ].map((s) => ({ ...s, units: counts.get(s.id) ?? 0 })),
    units: selectable.map((u) => ({
      source: u.source,
      id: u.id,
      title: u.title,
      ...(u.scale !== undefined ? { scale: u.scale } : {}),
      bbox: u.bbox,
      outline: u.outline
    }))
  });
}

function applyIndex(raw: unknown, fetchedAt: string, etag: string | null): boolean {
  const result = interpretEncIndex(raw);
  if (!result.ok) {
    status.status = result.reason === 'incompatible' ? 'incompatible' : 'error';
    status.message = result.message;
    return false;
  }
  if (result.skipped > 0) {
    debug(`ENC index: skipped ${String(result.skipped)} entries this version cannot read`);
  }
  loaded = { ...result.index, fetchedAt, etag };
  mapPayload = null;
  return true;
}

function cachePath(name: string): string {
  return path.join(cacheDir, name);
}

// Each file goes to a temporary name and is renamed into place, so a power
// cut mid-write cannot leave a truncated index for an offline boat.
function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text, 'utf-8');
  fs.renameSync(tmp, file);
}

function saveCache(text: string | null, meta: CacheMeta): void {
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    if (text !== null) {
      writeAtomic(cachePath(CACHE_FILE), text);
    }
    writeAtomic(cachePath(CACHE_META_FILE), JSON.stringify(meta));
  } catch (error) {
    debug(
      `Error writing ENC index cache: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function loadCache(): void {
  if (cacheRead) {
    return;
  }
  cacheRead = true;
  try {
    if (!fs.existsSync(cachePath(CACHE_FILE))) {
      return;
    }
    const meta = JSON.parse(
      fs.readFileSync(cachePath(CACHE_META_FILE), 'utf-8')
    ) as Partial<CacheMeta>;
    const raw: unknown = JSON.parse(fs.readFileSync(cachePath(CACHE_FILE), 'utf-8'));
    if (typeof meta.fetchedAt === 'string' && applyIndex(raw, meta.fetchedAt, meta.etag ?? null)) {
      // A cached copy is usable, but not news: the status stays 'never'
      // until this start has reached the server.
      status.message = null;
    }
  } catch {
    debug('Discarding ENC index cache - unreadable');
  }
}

export function initEncIndexManager(dataDirPath: string, debugFn: DebugFunction): void {
  cacheDir = path.join(dataDirPath, CACHE_DIR);
  debug = debugFn || (() => {});
  indexUrl = process.env.ENC_INDEX_URL || DEFAULT_ENC_INDEX_URL;
  loaded = null;
  mapPayload = null;
  cacheRead = false;
  status.status = 'never';
  status.lastSuccessAt = null;
  status.message = null;
  // The NOAA Charts tab cached NOAA's footprint file here; the index
  // replaces it.
  try {
    fs.rmSync(path.join(dataDirPath, 'noaa-enc-cache'), { recursive: true, force: true });
  } catch {
    // Best effort; a stale cache is only wasted disk.
  }
}

/**
 * Download the index. Never rejects: the outcome is recorded in
 * `getEncIndexStatus()`, and a failed refresh keeps the index loaded before.
 */
export function refreshEncIndex(): Promise<void> {
  if (inFlightRefresh) {
    return inFlightRefresh;
  }
  inFlightRefresh = doRefresh().finally(() => {
    inFlightRefresh = null;
  });
  return inFlightRefresh;
}

/** Refresh in the background when the last success is old; for UI opens. */
export function refreshEncIndexIfStale(): void {
  const last = status.lastSuccessAt;
  if (last === null || Date.now() - last > STALE_AFTER_MS) {
    refreshEncIndex().catch(() => undefined);
  }
}

async function doRefresh(): Promise<void> {
  // The cached copy's ETag lets an unchanged index answer 304.
  loadCache();
  status.lastAttemptAt = Date.now();
  let response: Response;
  try {
    response = await fetchIndexFile(loaded?.etag ?? null);
    if (response.status === 304 && !loaded) {
      response = await fetchIndexFile(null);
    }
  } catch (error) {
    status.status = 'error';
    status.httpStatus = null;
    status.message =
      "Could not reach the ENC index. Check this device's internet connection, then click Refresh.";
    debug(`ENC index refresh failed: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  status.httpStatus = response.status;
  const now = new Date().toISOString();
  if (response.status === 304 && loaded) {
    loaded.fetchedAt = now;
    saveCache(null, { fetchedAt: now, etag: loaded.etag });
  } else if (response.ok) {
    let text: string;
    let raw: unknown;
    try {
      text = await response.text();
      raw = JSON.parse(text);
    } catch {
      status.status = 'error';
      status.message = DAMAGED;
      return;
    }
    const etag = response.headers.get('etag');
    if (!applyIndex(raw, now, etag)) {
      return;
    }
    saveCache(text, { fetchedAt: now, etag });
    debug(`ENC index: ${String(loaded?.units.length ?? 0)} units`);
  } else {
    status.status = 'error';
    status.message =
      response.status === 404
        ? 'The ENC index has not been published yet. Try Refresh again later.'
        : `The ENC index is not available right now (HTTP ${String(response.status)}). Try Refresh again later.`;
    return;
  }
  status.status = 'ok';
  status.message = null;
  status.lastSuccessAt = Date.now();
}

function fetchIndexFile(etag: string | null): Promise<Response> {
  return fetch(indexUrl, {
    headers: etag ? { 'If-None-Match': etag } : {},
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  });
}

/** The index loaded now (downloaded this start, or the cached copy), if any. */
export function getEncIndex(): LoadedEncIndex | null {
  loadCache();
  return loaded;
}

export function getEncIndexStatus(): CatalogStatus {
  return { ...status };
}

/** The map's JSON, built once per loaded index. */
export function getEncMapPayload(): string | null {
  loadCache();
  if (!loaded) {
    return null;
  }
  mapPayload ??= encMapPayload(loaded);
  return mapPayload;
}
