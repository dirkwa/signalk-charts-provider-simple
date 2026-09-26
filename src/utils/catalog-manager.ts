import fs from 'fs';
import path from 'path';
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import {
  MERGED_CATALOG_SCHEMA_VERSION,
  MergedCatalogChartSchema,
  MergedCatalogSchema,
  MergedOnlineChartSchema,
  type MergedCatalogChart,
  type MergedOnlineChart
} from '../catalog/merged-catalog-schema.js';
import type {
  CatalogCategory,
  CatalogData,
  CatalogHeader,
  CatalogInstall,
  CatalogInstallsMap,
  CatalogRegistryInfo,
  CatalogSources,
  CatalogStatus,
  CatalogUpdate,
  DebugFunction,
  UrlClassification
} from '../types.js';
import { CatalogInstallsMapSchema, safeParse } from './catalog-schemas.js';

// The merged catalog (chartcatalogs.github.io + curated online charts) that
// this repo's publish-catalog workflow builds and serves from GitHub Pages.
// CHARTS_CATALOG_URL points a development server at a fork's Pages site.
const DEFAULT_CATALOG_URL = 'https://dirkwa.github.io/signalk-charts-provider-simple/catalog.json';

const CATALOG_CACHE_FILE = 'merged-catalog.json';
const FETCH_TIMEOUT_MS = 20000;

// The catalog is republished at most every few hours, so re-checking more
// often than this when the UI opens only costs bandwidth.
const STALE_AFTER_MS = 6 * 60 * 60 * 1000;

/**
 * What this plugin needs from a chartcatalogs entry, and nothing more. The
 * published schema also constrains facets (category, regions, bbox) with
 * closed value lists; checking those here would drop a whole catalog over a
 * new facet value this version never reads, which the compatibility policy
 * promises is an additive change.
 */
const ChartcatalogsReadSchema = Type.Object({
  file: Type.String({ minLength: 1 }),
  label: Type.String({ minLength: 1 }),
  format: Type.Optional(Type.String()),
  header: Type.Object({ title: Type.String() }),
  charts: Type.Array(Type.Unknown())
});

interface ChartcatalogsEntry {
  file: string;
  label: string;
  format: string | undefined;
  header: CatalogHeader;
  charts: MergedCatalogChart[];
}

/** The downloaded catalog, reduced to the entries this plugin can read. */
interface LoadedCatalog {
  fetchedAt: string;
  etag: string | null;
  /** The file as downloaded, so a 304 can refresh the cache's timestamp. */
  raw: unknown;
  generatedAt: string;
  contentHash: string;
  sources: CatalogSources | null;
  chartcatalogs: Map<string, ChartcatalogsEntry>;
  online: MergedOnlineChart[];
}

/** On-disk form of the last good download, so the tab works across restarts. */
interface CatalogCacheFile {
  fetchedAt: string;
  etag: string | null;
  catalog: unknown;
}

let catalogUrl = DEFAULT_CATALOG_URL;
let loaded: LoadedCatalog | null = null;
const catalogStatus: CatalogStatus = {
  status: 'never',
  lastAttemptAt: null,
  lastSuccessAt: null,
  httpStatus: null,
  message: null
};

// Single-flight guard: the fetch at init, the UI's first-load and staleness
// checks and a Refresh click must not issue concurrent downloads.
let inFlightRefresh: Promise<void> | null = null;

let dataDir = '';
let cacheDir = '';
let installsFilePath = '';
let installs: CatalogInstallsMap = {};
const converting: Record<string, true> = {};
let debug: DebugFunction = () => {};

export type InterpretedCatalog =
  | {
      ok: true;
      catalog: Omit<LoadedCatalog, 'fetchedAt' | 'etag' | 'raw'>;
      skippedEntries: number;
      skippedCharts: number;
    }
  | { ok: false; reason: 'invalid' | 'incompatible'; message: string };

function readHeader(header: Record<string, unknown>): CatalogHeader {
  const text = (v: unknown) => (typeof v === 'string' ? v : undefined);
  return {
    title: text(header.title) ?? '',
    dateCreated: text(header.dateCreated),
    dateValid: text(header.dateValid)
  };
}

const DAMAGED = 'The downloaded chart catalog is damaged. Try Refresh again later.';

/**
 * Read a downloaded catalog under the published compatibility policy:
 * unknown fields and facet values are ignored, and entries and charts are
 * validated one at a time, so something this version cannot interpret is
 * skipped rather than taking its neighbours with it. Only a newer
 * `schemaVersion` - a breaking change - makes the file unusable.
 */
export function interpretCatalog(raw: unknown): InterpretedCatalog {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'invalid', message: DAMAGED };
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.schemaVersion !== 'number') {
    return { ok: false, reason: 'invalid', message: DAMAGED };
  }
  if (obj.schemaVersion > MERGED_CATALOG_SCHEMA_VERSION) {
    return {
      ok: false,
      reason: 'incompatible',
      message:
        'The chart catalog uses a newer format than this version of the plugin. Update the plugin to see it.'
    };
  }
  if (
    obj.schemaVersion !== MERGED_CATALOG_SCHEMA_VERSION ||
    typeof obj.contentHash !== 'string' ||
    typeof obj.generatedAt !== 'string' ||
    !Array.isArray(obj.chartcatalogs) ||
    !Array.isArray(obj.online)
  ) {
    return { ok: false, reason: 'invalid', message: DAMAGED };
  }

  let skippedEntries = 0;
  let skippedCharts = 0;
  const chartcatalogs = new Map<string, ChartcatalogsEntry>();
  for (const entry of obj.chartcatalogs as unknown[]) {
    if (!Value.Check(ChartcatalogsReadSchema, entry)) {
      skippedEntries++;
      continue;
    }
    const charts = entry.charts.filter((c): c is MergedCatalogChart =>
      Value.Check(MergedCatalogChartSchema, c)
    );
    skippedCharts += entry.charts.length - charts.length;
    chartcatalogs.set(entry.file, {
      file: entry.file,
      label: entry.label,
      format: entry.format,
      header: readHeader(entry.header),
      charts
    });
  }

  const online: MergedOnlineChart[] = [];
  for (const entry of obj.online as unknown[]) {
    if (Value.Check(MergedOnlineChartSchema, entry)) {
      online.push(entry);
    } else {
      skippedEntries++;
    }
  }

  // Source links end up as hrefs in the tab, so they must be the https URLs
  // the schema describes; a bad block only loses the links, not the catalog.
  const sources = Value.Check(MergedCatalogSchema.properties.sources, obj.sources)
    ? obj.sources
    : null;

  return {
    ok: true,
    catalog: {
      generatedAt: obj.generatedAt,
      contentHash: obj.contentHash,
      sources,
      chartcatalogs,
      online
    },
    skippedEntries,
    skippedCharts
  };
}

/**
 * The bucket the download flow (`classifyUrl`) and the Chart Catalog filter
 * use, from the catalog's format facet. A catalog the index doesn't know
 * yet has no facet, so fall back to its file name.
 */
function downloadCategory(entry: ChartcatalogsEntry): CatalogCategory {
  switch (entry.format) {
    case 'mbtiles':
      return 'mbtiles';
    case 'enc':
      return 'ienc';
    case 'rnc':
      return 'rnc';
    case undefined:
      break;
    default:
      return 'general';
  }
  const file = entry.file;
  if (file.includes('MBTiles')) {
    return 'mbtiles';
  }
  if (file.includes('_IENC_') || file.includes('_ENC_')) {
    return 'ienc';
  }
  if (file.includes('_RNC_')) {
    return 'rnc';
  }
  return 'general';
}

function applyCatalog(raw: unknown, fetchedAt: string, etag: string | null): boolean {
  const result = interpretCatalog(raw);
  if (!result.ok) {
    catalogStatus.status = result.reason === 'incompatible' ? 'incompatible' : 'error';
    catalogStatus.message = result.message;
    return false;
  }
  if (result.skippedEntries > 0 || result.skippedCharts > 0) {
    debug(
      `Chart catalog: skipped ${String(result.skippedEntries)} entries and ${String(result.skippedCharts)} charts this version cannot read`
    );
  }
  loaded = { ...result.catalog, fetchedAt, etag, raw };
  removeLegacyCacheFiles();
  return true;
}

function loadCatalogCache(): void {
  const cachePath = path.join(cacheDir, CATALOG_CACHE_FILE);
  try {
    if (!fs.existsSync(cachePath)) {
      return;
    }
    const cached = JSON.parse(fs.readFileSync(cachePath, 'utf-8')) as Partial<CatalogCacheFile>;
    if (typeof cached.fetchedAt === 'string') {
      applyCatalog(cached.catalog, cached.fetchedAt, cached.etag ?? null);
    }
  } catch {
    debug('Discarding chart catalog cache - unreadable');
  }
}

// Written to a temporary file and renamed into place, so a power cut mid-
// write can't leave a truncated cache that an offline boat then discards.
function saveCatalogCache(cache: CatalogCacheFile): void {
  const cachePath = path.join(cacheDir, CATALOG_CACHE_FILE);
  const tmpPath = `${cachePath}.tmp`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(cache), 'utf-8');
    fs.renameSync(tmpPath, cachePath);
  } catch (error) {
    debug(
      `Error writing chart catalog cache: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

// Before the merged catalog, the tab cached the GitHub file listing and one
// JSON file per chartcatalogs catalog here. Removed once a merged catalog
// has loaded, so a failed first download doesn't leave the user with nothing.
function removeLegacyCacheFiles(): void {
  try {
    for (const name of fs.readdirSync(cacheDir)) {
      if (name === '_registry.json' || name.endsWith('_Catalog.json')) {
        fs.rmSync(path.join(cacheDir, name), { force: true });
      }
    }
  } catch {
    // Best effort; stale files are harmless.
  }
}

function loadInstalls(): void {
  try {
    if (fs.existsSync(installsFilePath)) {
      const data = fs.readFileSync(installsFilePath, 'utf-8');
      const raw: unknown = JSON.parse(data);
      const parsed = safeParse(CatalogInstallsMapSchema, raw);
      if (parsed) {
        installs = parsed;
        recoverInFlightUpdates();
      } else {
        console.error('Discarding catalog installs file — shape did not match schema');
        installs = {};
      }
    }
  } catch (error) {
    console.error('Error loading catalog installs:', error);
    installs = {};
  }
}

/**
 * On load, any record still carrying a `previousVersion` marker is an update
 * that was interrupted before it committed (a clean success clears the marker
 * via setInstallFilename). Since we are loading fresh from disk in a new
 * process, that conversion is by definition not running here — so roll each one
 * back to its prior version (issue #120 restart window). This makes recovery
 * independent of the orphan-reap path, which only fires for leaked containers
 * and never runs when the restart happened during the download phase.
 */
function recoverInFlightUpdates(): void {
  let changed = false;
  for (const [chartNumber, install] of Object.entries(installs)) {
    if (!('previousVersion' in install)) {
      continue;
    }
    const prior = install.previousVersion ?? null;
    if (prior) {
      installs[chartNumber] = prior; // restore the old version (UPDATE)
    } else {
      delete installs[chartNumber]; // drop the pending record (FRESH install)
    }
    changed = true;
    console.log(`[charts-provider] Recovered interrupted update for ${chartNumber} on load`);
  }
  if (changed) {
    saveInstalls();
  }
}

function saveInstalls(): void {
  try {
    fs.writeFileSync(installsFilePath, JSON.stringify(installs, null, 2), 'utf-8');
  } catch (error) {
    console.error('Error saving catalog installs:', error);
  }
}

export function initCatalogManager(dataDirPath: string, debugFn: DebugFunction): void {
  dataDir = dataDirPath;
  cacheDir = path.join(dataDir, 'catalog-cache');
  installsFilePath = path.join(dataDir, 'catalog-installs.json');
  debug = debugFn || (() => {});
  catalogUrl = process.env.CHARTS_CATALOG_URL || DEFAULT_CATALOG_URL;
  loaded = null;
  // A plugin restart starts the staleness clock over, so the UI's first
  // visit re-checks rather than trusting a success from the previous start.
  catalogStatus.lastSuccessAt = null;

  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
  }

  loadInstalls();
  loadCatalogCache();

  refreshCatalog().catch(() => undefined);
}

/**
 * Download the merged catalog. Never rejects: the outcome is recorded in
 * `getCatalogStatus()`, and a failed refresh keeps the last good catalog.
 */
export function refreshCatalog(): Promise<void> {
  if (inFlightRefresh) {
    return inFlightRefresh;
  }
  inFlightRefresh = doRefreshCatalog().finally(() => {
    inFlightRefresh = null;
  });
  return inFlightRefresh;
}

async function doRefreshCatalog(): Promise<void> {
  catalogStatus.lastAttemptAt = Date.now();
  let response: Response;
  try {
    response = await fetchCatalogFile(loaded?.etag ?? null);
    // A 304 answers the ETag of a catalog this start no longer holds (a
    // restart while a request was in flight); ask for the full file instead.
    if (response.status === 304 && !loaded) {
      response = await fetchCatalogFile(null);
    }
  } catch (error) {
    catalogStatus.status = 'error';
    catalogStatus.httpStatus = null;
    catalogStatus.message =
      "Could not reach the chart catalog. Check this device's internet connection, then click Refresh.";
    debug(
      `Chart catalog refresh failed: ${error instanceof Error ? error.message : String(error)}`
    );
    return;
  }

  catalogStatus.httpStatus = response.status;
  const now = new Date().toISOString();

  if (response.status === 304 && loaded) {
    loaded.fetchedAt = now;
    saveCatalogCache({ fetchedAt: now, etag: loaded.etag, catalog: loaded.raw });
  } else if (response.ok) {
    let raw: unknown;
    try {
      raw = await response.json();
    } catch {
      catalogStatus.status = 'error';
      catalogStatus.message = DAMAGED;
      return;
    }
    const etag = response.headers.get('etag');
    if (!applyCatalog(raw, now, etag)) {
      return;
    }
    saveCatalogCache({ fetchedAt: now, etag, catalog: raw });
    debug(
      `Chart catalog: ${String(loaded?.chartcatalogs.size ?? 0)} chartcatalogs catalogs, ${String(loaded?.online.length ?? 0)} online charts`
    );
  } else {
    catalogStatus.status = 'error';
    catalogStatus.message = `The chart catalog is not available right now (HTTP ${String(response.status)}). Try Refresh again later.`;
    return;
  }
  catalogStatus.status = 'ok';
  catalogStatus.message = null;
  catalogStatus.lastSuccessAt = Date.now();
}

function fetchCatalogFile(etag: string | null): Promise<Response> {
  return fetch(catalogUrl, {
    headers: etag ? { 'If-None-Match': etag } : {},
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  });
}

/** Whether any catalog (downloaded now or cached earlier) is available. */
export function hasCatalog(): boolean {
  return loaded !== null;
}

/** Refresh in the background when the last success is old; for UI opens. */
export function refreshCatalogIfStale(): void {
  const last = catalogStatus.lastSuccessAt;
  if (last === null || Date.now() - last > STALE_AFTER_MS) {
    refreshCatalog().catch(() => undefined);
  }
}

export function getCatalogStatus(): CatalogStatus {
  return { ...catalogStatus };
}

export function getCatalogSources(): CatalogSources | null {
  return loaded ? loaded.sources : null;
}

/** Online charts from the catalog (served and added from stage 3 on). */
export function getOnlineCatalogCharts(): MergedOnlineChart[] {
  return loaded ? [...loaded.online] : [];
}

export function getCatalogRegistry(): CatalogRegistryInfo[] {
  if (!loaded) {
    return [];
  }
  const fetchedAt = loaded.fetchedAt;
  return [...loaded.chartcatalogs.values()].map((entry) => ({
    file: entry.file,
    label: entry.label,
    category: downloadCategory(entry),
    chartCount: entry.charts.length,
    cachedAt: fetchedAt
  }));
}

/** One chartcatalogs catalog in the shape the tab and download flow use. */
export function getCatalogData(catalogFile: string): CatalogData | null {
  const entry = loaded?.chartcatalogs.get(catalogFile);
  if (!loaded || !entry) {
    return null;
  }
  return {
    fetchedAt: loaded.fetchedAt,
    catalogFile,
    header: entry.header,
    charts: entry.charts
  };
}

export function classifyUrl(
  url: string,
  catalogCategory: CatalogCategory | string
): UrlClassification {
  if (!url) {
    return { supported: false, format: 'unknown', label: 'Unknown format' };
  }
  const lower = url.toLowerCase();
  if (lower.endsWith('.mbtiles')) {
    return { supported: true, format: 'mbtiles', label: 'MBTiles' };
  }
  if (lower.endsWith('.zip')) {
    if (catalogCategory === 'mbtiles') {
      return { supported: true, format: 'zip', label: 'ZIP archive (contains MBTiles)' };
    }
    if (catalogCategory === 'ienc') {
      return { supported: true, format: 's57-zip', label: 'S-57 ENC (requires Podman)' };
    }
    if (catalogCategory === 'rnc') {
      return { supported: true, format: 'rnc-zip', label: 'BSB raster (requires Podman)' };
    }
    return { supported: false, format: 'zip', label: 'ZIP archive - not yet supported' };
  }
  if (lower.endsWith('.tar.xz') || lower.endsWith('.tar.gz')) {
    if (lower.includes('gshhg') || lower.includes('chartcatalogs/gshhg')) {
      return { supported: true, format: 'gshhg', label: 'GSHHG basemap (requires Podman)' };
    }
    if (lower.includes('pilot_kaps') || lower.includes('pilot')) {
      return { supported: true, format: 'pilot-tar', label: 'Pilot Chart (requires Podman)' };
    }
    if (lower.includes('chartcatalogs/shapefiles') || lower.includes('basemap_')) {
      return { supported: true, format: 'shp-basemap', label: 'Basemap (requires Podman)' };
    }
    return { supported: false, format: 'tar', label: 'Compressed archive - not yet supported' };
  }
  if (lower.includes('.bsb') || lower.includes('/bsb/')) {
    return { supported: false, format: 'bsb', label: 'BSB raster - not yet supported' };
  }
  if (catalogCategory === 'ienc') {
    return { supported: true, format: 's57-zip', label: 'S-57 ENC (requires Podman)' };
  }
  if (catalogCategory === 'rnc') {
    return { supported: true, format: 'rnc-zip', label: 'BSB raster (requires Podman)' };
  }
  return { supported: false, format: 'unknown', label: 'Unknown format - not yet supported' };
}

export function trackInstall(
  chartNumber: string,
  catalogFile: string,
  zipfileDatetime: string,
  url: string
): void {
  // Snapshot the prior record INSIDE the new record (persisted to disk via
  // saveInstalls) so a restart mid-update can still roll back to the
  // still-on-disk old version (issue #120 restart window). An in-memory-only
  // snapshot would be lost on a plugin hot-restart (every config save) or a
  // Signal K restart. The presence of `previousVersion` marks the install as
  // in-flight; a FRESH install records `null` ("delete on rollback").
  // Strip any nested previousVersion so snapshots never stack across
  // sequential failed updates — the snapshot always points at the last
  // committed version.
  let snapshot: CatalogInstall | null = null;
  const prior = installs[chartNumber];
  if (prior) {
    // Omit the prior's own previousVersion key entirely (not set it to
    // undefined) so the snapshot is exactly one level deep and never carries a
    // dangling key.
    const { previousVersion: _nested, ...flat } = prior;
    snapshot = flat;
  }
  installs[chartNumber] = {
    catalogFile,
    zipfile_datetime_iso8601: zipfileDatetime,
    installedAt: new Date().toISOString(),
    zipfile_location: url,
    previousVersion: snapshot
  };
  saveInstalls();
}

/**
 * Undo an in-flight trackInstall() after its conversion/download FAILS, or
 * when the orphan-reap path recovers a job interrupted by a restart (issue
 * #120). Reads the snapshot persisted in the record by trackInstall():
 *   - previousVersion is an object (an UPDATE) → restore it, so checkForUpdates
 *     keeps flagging the update (the old version is still on disk).
 *   - previousVersion is null (a FRESH install) → delete the pending record.
 *   - no `previousVersion` key (a COMMITTED record, or one from an older
 *     plugin build) → no-op: never delete a settled install. This matters
 *     because the orphan-reap site calls rollbackInstall for every reaped
 *     chart, including spurious reaps of already-committed installs.
 */
export function rollbackInstall(chartNumber: string): void {
  const current = installs[chartNumber];
  if (!current || !('previousVersion' in current)) {
    return;
  }
  const prior = current.previousVersion ?? null;
  if (prior) {
    installs[chartNumber] = prior;
  } else {
    delete installs[chartNumber];
  }
  saveInstalls();
}

export function removeInstall(chartNumber: string): void {
  if (installs[chartNumber]) {
    delete installs[chartNumber];
    saveInstalls();
    return;
  }
  const lower = chartNumber.toLowerCase();
  for (const key of Object.keys(installs)) {
    const keyLower = key.toLowerCase();
    if (
      chartNumber === `gshhg-basemap-${key.replace('poly-', '')}` ||
      chartNumber === `osm-basemap-${key.replace('basemap_', '')}` ||
      lower.startsWith(keyLower) ||
      chartNumber.includes(key)
    ) {
      delete installs[key];
      saveInstalls();
      return;
    }
  }
}

export function getInstalledCatalogCharts(): CatalogInstallsMap {
  return { ...installs };
}

/**
 * Record the on-disk filename produced by a successful conversion.
 * Lets the delete flow find this install record by the filename the
 * user actually sees in Manage Charts (which can differ from the
 * chartNumber when the converter renamed by catalog title).
 */
export function setInstallFilename(chartNumber: string, filename: string): void {
  const install = installs[chartNumber];
  if (!install) {
    return;
  }
  install.installedFilename = filename;
  // Conversion succeeded — commit. Drop the previousVersion marker so the
  // record is "settled": a later stray rollbackInstall (or an orphan-reap
  // recovery after a restart) can't resurrect the old version or re-treat it
  // as in-flight.
  delete install.previousVersion;
  saveInstalls();
}

/**
 * Reverse-lookup: clear any install record whose tracked filename
 * matches `filename` (basename match — chartPath is stripped before
 * comparison). Returns true if a record was removed. Called from the
 * chart-delete flow.
 */
export function removeInstallByFilename(filename: string): boolean {
  const base = path.basename(filename);
  for (const [key, install] of Object.entries(installs)) {
    if (install.installedFilename && path.basename(install.installedFilename) === base) {
      delete installs[key];
      saveInstalls();
      return true;
    }
  }
  return false;
}

/**
 * Update an install's tracked filename when the user moves or renames
 * a chart. Matches the prior path's basename to find the right
 * install record (chartPath-relative comparison). Returns true if an
 * install was updated.
 */
export function renameInstallFilename(oldPath: string, newPath: string): boolean {
  const oldBase = path.basename(oldPath);
  for (const install of Object.values(installs)) {
    if (install.installedFilename && path.basename(install.installedFilename) === oldBase) {
      install.installedFilename = newPath;
      saveInstalls();
      return true;
    }
  }
  return false;
}

export function setConvertingState(chartNumber: string, isConverting: boolean): void {
  if (isConverting) {
    converting[chartNumber] = true;
  } else {
    delete converting[chartNumber];
  }
}

export function getConvertingCharts(): Record<string, true> {
  return { ...converting };
}

export function getConvertingCount(): number {
  return Object.keys(converting).length;
}

export function checkForUpdates(): CatalogUpdate[] {
  const updates: CatalogUpdate[] = [];

  for (const [chartNumber, install] of Object.entries(installs)) {
    const cached = getCatalogData(install.catalogFile);
    if (!cached?.charts) {
      continue;
    }

    const catalogChart = cached.charts.find((c) => c.number === chartNumber);
    if (!catalogChart) {
      continue;
    }

    if (
      catalogChart.zipfile_datetime_iso8601 &&
      install.zipfile_datetime_iso8601 &&
      catalogChart.zipfile_datetime_iso8601 > install.zipfile_datetime_iso8601
    ) {
      let installedFolder = '/';
      if (install.installedFilename) {
        // installedFilename is already relative to chartPath (stored by
        // setInstallFilename). Normalize to forward slashes (the frontend
        // joins this folder with '/', and dirname yields backslashes on
        // Windows) and take the directory portion with posix semantics.
        const normalized = install.installedFilename.replace(/\\/g, '/');
        const folder = path.posix.dirname(normalized);
        // dirname returns '.' for a file in the root folder. Treat that, any
        // traversal segment ('../foo', 'a/../b'), a Windows drive prefix
        // ('C:/…' after the backslash normalize), and any absolute path (all
        // malformed records) as root — installedFolder must stay
        // chart-path-relative.
        if (
          folder &&
          folder !== '.' &&
          folder !== '/' &&
          !folder.split('/').includes('..') &&
          !/^[a-zA-Z]:/.test(folder) &&
          !path.posix.isAbsolute(folder)
        ) {
          installedFolder = folder;
        }
      }
      updates.push({
        chartNumber,
        catalogFile: install.catalogFile,
        title: catalogChart.title,
        installedDate: install.zipfile_datetime_iso8601,
        availableDate: catalogChart.zipfile_datetime_iso8601,
        downloadUrl: catalogChart.zipfile_location,
        installedFolder
      });
    }
  }

  return updates;
}

export function getCatalogsWithInstalledCharts(): string[] {
  const catalogs = new Set<string>();
  for (const install of Object.values(installs)) {
    catalogs.add(install.catalogFile);
  }
  return Array.from(catalogs);
}

export function pruneStaleInstalls(chartIdentifiers: string[]): void {
  const ids = new Set(chartIdentifiers.map((id) => id.toLowerCase()));
  let pruned = false;

  for (const [key, install] of Object.entries(installs)) {
    // An in-flight update (carries the previousVersion marker) is not stale —
    // its new file isn't on disk yet, but the old one still is. recoverInFlight-
    // Updates() rolls these back at load, so prune normally never sees one;
    // this guard keeps prune from destroying the snapshot if ordering changes.
    if ('previousVersion' in install) {
      continue;
    }
    // Authoritative path: if we recorded the on-disk filename at
    // conversion/move/rename time, the install key should match the
    // chart whose chartId is the basename-without-extension. Anything
    // else means the file is gone (deleted) and the install record
    // should drop. Skips the legacy fuzzy-match that produced false
    // positives — install key "2" was kept alive by any chartId
    // containing the digit "2".
    if (install.installedFilename) {
      const expectedId = path
        .basename(install.installedFilename)
        .replace(/\.mbtiles$/i, '')
        .toLowerCase();
      if (!ids.has(expectedId)) {
        console.log(
          `[charts-provider] Pruning catalog install ${key}: file not found (${install.installedFilename})`
        );
        delete installs[key];
        pruned = true;
      }
      continue;
    }

    const keyLower = key.toLowerCase();

    if (ids.has(keyLower)) {
      continue;
    }

    // Legacy fuzzy match for installs recorded before installedFilename
    // existed. Kept conservative — substring match has produced false
    // positives for short numeric chart numbers; the explicit-filename
    // branch above is the right path going forward.
    let found = false;
    for (const id of ids) {
      if (
        id === `gshhg-basemap-${key.replace('poly-', '')}` ||
        id === `osm-basemap-${key.replace('basemap_', '')}` ||
        id.startsWith(keyLower) ||
        id.includes(key)
      ) {
        found = true;
        break;
      }
    }

    if (!found) {
      console.log(`[charts-provider] Pruning stale catalog install: ${key}`);
      delete installs[key];
      pruned = true;
    }
  }

  if (pruned) {
    saveInstalls();
  }
}
