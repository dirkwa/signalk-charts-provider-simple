import https from 'https';
import fs from 'fs';
import path from 'path';
import { parseStringPromise } from 'xml2js';
import type {
  CatalogRegistryEntry,
  CatalogRegistryInfo,
  CatalogCategory,
  CatalogData,
  CatalogChart,
  CatalogInstallsMap,
  UrlClassification,
  CatalogUpdate,
  DebugFunction
} from '../types';

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
      catalogRegistry = JSON.parse(fs.readFileSync(cachePath, 'utf-8')) as CatalogRegistryEntry[];
    }
  } catch {
    // ignore
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
      installs = JSON.parse(data) as CatalogInstallsMap;
    }
  } catch (error) {
    console.error('Error loading catalog installs:', error);
    installs = {};
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
      return JSON.parse(data) as CatalogData;
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
    | Record<string, unknown>
    | undefined;

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
  return new Promise((resolve, reject) => {
    const req = https
      .get(
        CATALOG_GITHUB_API,
        { headers: { 'User-Agent': 'signalk-charts-provider-simple' } },
        (response) => {
          if (response.statusCode !== 200) {
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
              const files = JSON.parse(data) as Array<{ name: string }>;
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
              resolve(xmlFiles);
            } catch (err) {
              reject(err);
            }
          });
        }
      )
      .on('error', reject);
    req.setTimeout(15000, () => {
      req.destroy(new Error('GitHub API request timed out after 15s'));
    });
  });
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
  installs[chartNumber] = {
    catalogFile,
    zipfile_datetime_iso8601: zipfileDatetime,
    installedAt: new Date().toISOString(),
    zipfile_location: url
  };
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
      updates.push({
        chartNumber,
        catalogFile: install.catalogFile,
        title: catalogChart.title,
        installedDate: install.zipfile_datetime_iso8601,
        availableDate: catalogChart.zipfile_datetime_iso8601,
        downloadUrl: catalogChart.zipfile_location
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

  for (const key of Object.keys(installs)) {
    const keyLower = key.toLowerCase();

    if (ids.has(keyLower)) {
      continue;
    }

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
