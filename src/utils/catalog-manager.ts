import fs from 'fs';
import https from 'https';
import path from 'path';
import { parseStringPromise } from 'xml2js';
import type {
  CatalogCategory,
  CatalogChart,
  CatalogData,
  CatalogInstall,
  CatalogInstallsMap,
  CatalogRegistryEntry,
  CatalogRegistryInfo,
  CatalogUpdate,
  DebugFunction,
  RegistryStatus,
  UrlClassification
} from '../types.js';
import {
  CatalogDataSchema,
  CatalogInstallsMapSchema,
  CatalogRegistryCacheSchema,
  GithubContentsListingSchema,
  safeParse
} from './catalog-schemas.js';

const CATALOG_BASE_URL = 'https://raw.githubusercontent.com/chartcatalogs/catalogs/master/';
const CATALOG_GITHUB_API = 'https://api.github.com/repos/chartcatalogs/catalogs/contents/';

const COUNTRY_CODES: Record<string, string> = {
  AR: 'Argentina',
  AT: 'Austria',
  BE: 'Belgium',
  BG: 'Bulgaria',
  BR: 'Brazil',
  CH: 'Switzerland',
  CZ: 'Czech Republic',
  DE: 'Germany',
  FR: 'France',
  HR: 'Croatia',
  HU: 'Hungary',
  NL: 'Netherlands',
  NZ: 'New Zealand',
  PE: 'Peru',
  PL: 'Poland',
  RO: 'Romania',
  RS: 'Serbia',
  SK: 'Slovakia',
  SCS: 'South China Sea'
};

let catalogRegistry: CatalogRegistryEntry[] = [];

// Result of the last GitHub registry-fetch attempt — surfaced to the UI so an
// empty/failed fetch can show an accurate reason (rate-limited vs offline vs
// generic error) instead of a misleading "you may be offline".
const registryStatus: RegistryStatus = {
  status: 'never',
  isRateLimited: false,
  remaining: null,
  resetAt: null,
  retryAfter: null,
  lastAttemptAt: null,
  lastSuccessAt: null,
  httpStatus: null
};

// Single-flight guard: the up-front fetch at init plus a Refresh-button click
// (or two clicks) must not issue concurrent GitHub requests. A call while one
// is in flight returns the in-progress promise.
let inFlightRegistryFetch: Promise<CatalogRegistryEntry[]> | null = null;

function parseHeaderInt(v: string | string[] | undefined): number | null {
  if (v === undefined) {
    return null;
  }
  const n = parseInt(Array.isArray(v) ? (v[0] ?? '') : v, 10);
  return Number.isFinite(n) ? n : null;
}

const CACHE_MAX_AGE_MS = 60 * 60 * 1000;

let dataDir = '';
let cacheDir = '';
let installsFilePath = '';
let installs: CatalogInstallsMap = {};
const converting: Record<string, true> = {};
let debug: DebugFunction = () => {};

function deriveCategory(filename: string): CatalogCategory {
  if (filename.includes('MBTiles')) {
    return 'mbtiles';
  }
  if (filename.includes('_IENC_') || filename.includes('_ENC_')) {
    return 'ienc';
  }
  if (filename.includes('_RNC_')) {
    return 'rnc';
  }
  return 'general';
}

function deriveLabel(filename: string): string {
  const base = filename.replace('_Catalog.xml', '');

  if (base === 'NOAA_MBTiles') {
    return 'NOAA Vector Charts (MBTiles)';
  }
  if (base === 'GSHHG') {
    return 'World Basemap Polygons (GSHHG)';
  }
  if (base === 'PILOT') {
    return 'World Pilot Charts';
  }
  if (base === 'OSMSHP') {
    return 'OpenStreetMap Shapefiles';
  }
  if (base === 'ACE_BUOY') {
    return 'ACE Buoy Charts';
  }
  if (base === 'EURIS_IENC') {
    return 'European RIS Inland ENC';
  }

  const parts = base.split('_');
  const code = parts[0];
  const country = COUNTRY_CODES[code] ?? code;
  const type = parts.slice(1).join(' ');

  if (type.includes('IENC')) {
    return `${country} Inland ENC`;
  }
  if (type.includes('ENC')) {
    return `${country} ENC`;
  }
  if (type.includes('RNC')) {
    return `${country} Raster Charts`;
  }
  if (type.includes('RHONE')) {
    return `${country} Rhone Inland ENC`;
  }

  return `${country} ${type}`;
}

function loadRegistryCache(): void {
  const cachePath = path.join(cacheDir, '_registry.json');
  try {
    if (fs.existsSync(cachePath)) {
      const raw: unknown = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
      const parsed = safeParse(CatalogRegistryCacheSchema, raw);
      if (parsed) {
        catalogRegistry = parsed;
      } else {
        debug('Discarding registry cache — shape did not match schema');
      }
    }
  } catch {
    // JSON parse error — file is corrupted, leave registry empty.
  }
}

function saveRegistryCache(): void {
  const cachePath = path.join(cacheDir, '_registry.json');
  try {
    fs.writeFileSync(cachePath, JSON.stringify(catalogRegistry, null, 2), 'utf-8');
  } catch {
    // ignore
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

function readCacheFile(catalogFile: string): CatalogData | null {
  const cachePath = path.join(cacheDir, catalogFile.replace('.xml', '.json'));
  try {
    if (fs.existsSync(cachePath)) {
      const data = fs.readFileSync(cachePath, 'utf-8');
      const raw: unknown = JSON.parse(data);
      const parsed = safeParse(CatalogDataSchema, raw);
      if (!parsed) {
        debug(`Discarding cache for ${catalogFile} — shape did not match schema`);
        return null;
      }
      return parsed;
    }
  } catch (error) {
    debug(
      `Error reading cache for ${catalogFile}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  return null;
}

function writeCacheFile(catalogFile: string, data: CatalogData): void {
  const cachePath = path.join(cacheDir, catalogFile.replace('.xml', '.json'));
  try {
    fs.writeFileSync(cachePath, JSON.stringify(data, null, 2), 'utf-8');
  } catch (error) {
    debug(
      `Error writing cache for ${catalogFile}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function isCacheFresh(cached: CatalogData | null): boolean {
  if (!cached?.fetchedAt) {
    return false;
  }
  const age = Date.now() - new Date(cached.fetchedAt).getTime();
  return age < CACHE_MAX_AGE_MS;
}

async function parseCatalogXml(xmlData: string, catalogFile: string): Promise<CatalogData> {
  const result: unknown = await parseStringPromise(xmlData);

  if (typeof result !== 'object' || result === null) {
    throw new Error('Invalid XML parse result');
  }

  const parsed = result as Record<string, unknown>;
  const root = (parsed.RncProductCatalogChartCatalogs ?? parsed.EncProductCatalogcellCatalogs) as
    Record<string, unknown> | undefined;

  if (!root) {
    throw new Error('Unexpected XML root element');
  }

  const headerArr = root.Header as Array<Record<string, string[]>> | undefined;
  const headerNode = headerArr?.[0] ?? {};
  const header = {
    title: headerNode.title?.[0] ?? '',
    dateCreated: headerNode.date_created?.[0] ?? '',
    dateValid: headerNode.date_valid?.[0] ?? ''
  };

  const chartNodes = (root.chart ?? root.cell ?? []) as Array<Record<string, string[]>>;
  const charts: CatalogChart[] = chartNodes
    .map((node): CatalogChart | null => {
      try {
        return {
          number: node.number?.[0] ?? node.name?.[0] ?? '',
          title: node.title?.[0] ?? node.lname?.[0] ?? '',
          format: node.format?.[0] ?? '',
          zipfile_location: node.zipfile_location?.[0] ?? '',
          zipfile_datetime_iso8601: node.zipfile_datetime_iso8601?.[0] ?? ''
        };
      } catch {
        debug(`Skipping malformed chart entry in ${catalogFile}`);
        return null;
      }
    })
    .filter((c): c is CatalogChart => c !== null && !!c.number && !!c.zipfile_location);

  return {
    fetchedAt: new Date().toISOString(),
    catalogFile,
    header,
    charts
  };
}

export function initCatalogManager(dataDirPath: string, debugFn: DebugFunction): void {
  dataDir = dataDirPath;
  cacheDir = path.join(dataDir, 'catalog-cache');
  installsFilePath = path.join(dataDir, 'catalog-installs.json');
  debug = debugFn || (() => {});

  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
  }

  loadInstalls();
  loadRegistryCache();

  fetchCatalogRegistry().catch((err: unknown) => {
    debug(`Failed to fetch catalog registry: ${err instanceof Error ? err.message : String(err)}`);
  });
}

export function fetchCatalogRegistry(): Promise<CatalogRegistryEntry[]> {
  if (inFlightRegistryFetch) {
    return inFlightRegistryFetch;
  }
  inFlightRegistryFetch = doFetchCatalogRegistry().finally(() => {
    inFlightRegistryFetch = null;
  });
  return inFlightRegistryFetch;
}

function doFetchCatalogRegistry(): Promise<CatalogRegistryEntry[]> {
  return new Promise((resolve, reject) => {
    registryStatus.lastAttemptAt = Date.now();
    const req = https
      .get(
        CATALOG_GITHUB_API,
        { headers: { 'User-Agent': 'signalk-charts-provider-simple' } },
        (response) => {
          // Read rate-limit headers on EVERY response (success and failure),
          // so `remaining` is current even on a 200.
          const remaining = parseHeaderInt(response.headers['x-ratelimit-remaining']);
          const resetSec = parseHeaderInt(response.headers['x-ratelimit-reset']);
          const retryAfter = parseHeaderInt(response.headers['retry-after']);
          if (remaining !== null) {
            registryStatus.remaining = remaining;
          }
          if (resetSec !== null) {
            registryStatus.resetAt = resetSec * 1000;
          }
          registryStatus.retryAfter = retryAfter;
          registryStatus.httpStatus = response.statusCode ?? null;

          if (response.statusCode !== 200) {
            // Classify off THIS response's header (the local `remaining`), not
            // the persisted field — a 403/429 without an x-ratelimit-remaining
            // header must not inherit a previous response's 0 and get
            // mislabeled rate-limited.
            const rateLimited =
              (response.statusCode === 403 || response.statusCode === 429) && remaining === 0;
            registryStatus.isRateLimited = rateLimited;
            registryStatus.status = rateLimited ? 'rate_limited' : 'error';
            response.resume();
            reject(new Error(`GitHub API returned ${response.statusCode}`));
            return;
          }

          let data = '';
          response.on('data', (chunk: Buffer) => {
            data += chunk.toString();
          });

          response.on('end', () => {
            try {
              const raw: unknown = JSON.parse(data);
              const files = safeParse(GithubContentsListingSchema, raw);
              if (!files) {
                // Reached GitHub (200) but the body was malformed — a generic
                // error, definitively not a rate limit.
                registryStatus.isRateLimited = false;
                registryStatus.status = 'error';
                reject(new Error('GitHub API response did not match expected shape'));
                return;
              }
              const xmlFiles: CatalogRegistryEntry[] = files
                .filter((f) => f.name.endsWith('_Catalog.xml'))
                .map((f) => ({
                  file: f.name,
                  label: deriveLabel(f.name),
                  category: deriveCategory(f.name)
                }));

              if (xmlFiles.length > 0) {
                catalogRegistry = xmlFiles;
                saveRegistryCache();
                debug(`Catalog registry: ${xmlFiles.length} catalogs from GitHub`);
              }
              // A successful fetch means we are not rate-limited; clear the
              // rate-limit metadata so a stale reset/retry time can't leak into
              // the UI later (resetAt/retryAfter are only meaningful while
              // isRateLimited).
              registryStatus.isRateLimited = false;
              registryStatus.status = 'ok';
              registryStatus.resetAt = null;
              registryStatus.retryAfter = null;
              registryStatus.lastSuccessAt = Date.now();
              resolve(xmlFiles);
            } catch (err) {
              registryStatus.isRateLimited = false;
              registryStatus.status = 'error';
              reject(err);
            }
          });
        }
      )
      .on('error', (err) => {
        // Network/DNS failure or timeout — genuinely offline-ish, NOT a rate
        // limit. httpStatus stays null so the UI shows the connectivity copy.
        registryStatus.status = 'error';
        registryStatus.isRateLimited = false;
        registryStatus.httpStatus = null;
        reject(err);
      });
    req.setTimeout(15000, () => {
      req.destroy(new Error('GitHub API request timed out after 15s'));
    });
  });
}

export function getRegistryStatus(): RegistryStatus {
  return { ...registryStatus };
}

export function getCatalogRegistry(): CatalogRegistryInfo[] {
  return catalogRegistry.map((entry) => {
    const cached = readCacheFile(entry.file);
    return {
      ...entry,
      chartCount: cached ? cached.charts.length : null,
      cachedAt: cached ? cached.fetchedAt : null
    };
  });
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

export function fetchCatalog(catalogFile: string): Promise<CatalogData> {
  const registryEntry = catalogRegistry.find((r) => r.file === catalogFile);
  if (!registryEntry) {
    return Promise.reject(new Error(`Unknown catalog: ${catalogFile}`));
  }

  const cached = readCacheFile(catalogFile);
  if (cached && isCacheFresh(cached)) {
    return Promise.resolve(cached);
  }

  const url = CATALOG_BASE_URL + catalogFile;

  return new Promise((resolve, reject) => {
    const req = https
      .get(url, (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          const err = new Error(`HTTP ${response.statusCode} fetching ${catalogFile}`);
          if (cached) {
            debug(`${err.message}, using stale cache`);
            resolve(cached);
          } else {
            reject(err);
          }
          return;
        }

        let xmlData = '';
        response.on('data', (chunk: Buffer) => {
          xmlData += chunk.toString();
        });

        response.on('end', () => {
          parseCatalogXml(xmlData, catalogFile)
            .then((parsed) => {
              writeCacheFile(catalogFile, parsed);
              resolve(parsed);
            })
            .catch((parseErr: unknown) => {
              debug(
                `Parse error for ${catalogFile}: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`
              );
              if (cached) {
                resolve(cached);
              } else {
                reject(parseErr);
              }
            });
        });
      })
      .on('error', (error) => {
        debug(`Network error fetching ${catalogFile}: ${error.message}`);
        if (cached) {
          resolve(cached);
        } else {
          reject(error);
        }
      });
    req.setTimeout(15000, () => {
      req.destroy(new Error(`Catalog fetch timed out after 15s: ${catalogFile}`));
    });
  });
}

export function getCachedCatalog(catalogFile: string): CatalogData | null {
  return readCacheFile(catalogFile);
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
    const cached = readCacheFile(install.catalogFile);
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
