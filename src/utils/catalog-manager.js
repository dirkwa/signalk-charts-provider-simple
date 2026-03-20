const https = require('https');
const fs = require('fs');
const path = require('path');
const xml2js = require('xml2js');

const CATALOG_BASE_URL = 'https://raw.githubusercontent.com/chartcatalogs/catalogs/master/';
const CATALOG_GITHUB_API = 'https://api.github.com/repos/chartcatalogs/catalogs/contents/';

// Country code to name mapping for auto-labeling
const COUNTRY_CODES = {
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

// Dynamic catalog registry — fetched from GitHub, cached to disk
let catalogRegistry = [];

const CACHE_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour

let dataDir = '';
let cacheDir = '';
let installsFilePath = '';
let installs = {};
const converting = {}; // chartNumber -> true (in-memory only, not persisted)
let debug = () => {};

function initCatalogManager(dataDirPath, debugFn) {
  dataDir = dataDirPath;
  cacheDir = path.join(dataDir, 'catalog-cache');
  installsFilePath = path.join(dataDir, 'catalog-installs.json');
  debug = debugFn || (() => {});

  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
  }

  loadInstalls();
  loadRegistryCache();

  // Fetch fresh registry in background (don't block startup)
  fetchCatalogRegistry().catch((err) => {
    debug(`Failed to fetch catalog registry: ${err.message}`);
  });
}

/**
 * Derive category from catalog filename
 */
function deriveCategory(filename) {
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

/**
 * Derive human-readable label from catalog filename
 */
function deriveLabel(filename) {
  const base = filename.replace('_Catalog.xml', '');

  // Special cases
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

  // Pattern: CC_TYPE or CC_TYPE_EXTRA (e.g., FR_IENC_RHONE)
  const parts = base.split('_');
  const code = parts[0];
  const country = COUNTRY_CODES[code] || code;
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

/**
 * Fetch the catalog registry from GitHub API
 */
function fetchCatalogRegistry() {
  return new Promise((resolve, reject) => {
    https
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
          response.on('data', (chunk) => {
            data += chunk;
          });

          response.on('end', () => {
            try {
              const files = JSON.parse(data);
              const xmlFiles = files
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
  });
}

function loadRegistryCache() {
  const cachePath = path.join(cacheDir, '_registry.json');
  try {
    if (fs.existsSync(cachePath)) {
      catalogRegistry = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
    }
  } catch (_e) {
    // ignore
  }
}

function saveRegistryCache() {
  const cachePath = path.join(cacheDir, '_registry.json');
  try {
    fs.writeFileSync(cachePath, JSON.stringify(catalogRegistry, null, 2), 'utf-8');
  } catch (_e) {
    // ignore
  }
}

function loadInstalls() {
  try {
    if (fs.existsSync(installsFilePath)) {
      const data = fs.readFileSync(installsFilePath, 'utf-8');
      installs = JSON.parse(data);
    }
  } catch (error) {
    console.error('Error loading catalog installs:', error);
    installs = {};
  }
}

function saveInstalls() {
  try {
    fs.writeFileSync(installsFilePath, JSON.stringify(installs, null, 2), 'utf-8');
  } catch (error) {
    console.error('Error saving catalog installs:', error);
  }
}

function getCatalogRegistry() {
  return catalogRegistry.map((entry) => {
    const cached = readCacheFile(entry.file);
    return {
      ...entry,
      chartCount: cached ? cached.charts.length : null,
      cachedAt: cached ? cached.fetchedAt : null
    };
  });
}

function classifyUrl(url, catalogCategory) {
  if (!url) {
    return { supported: false, format: 'unknown', label: 'Unknown format' };
  }
  const lower = url.toLowerCase();
  if (lower.endsWith('.mbtiles')) {
    return { supported: true, format: 'mbtiles', label: 'MBTiles' };
  }
  if (lower.endsWith('.zip')) {
    if (catalogCategory === 'mbtiles') {
      return {
        supported: true,
        format: 'zip',
        label: 'ZIP archive (contains MBTiles)'
      };
    }
    if (catalogCategory === 'ienc') {
      return {
        supported: true,
        format: 's57-zip',
        label: 'S-57 ENC (requires Podman)'
      };
    }
    if (catalogCategory === 'rnc') {
      return {
        supported: true,
        format: 'rnc-zip',
        label: 'BSB raster (requires Podman)'
      };
    }
    // General ZIPs are not yet convertible
    return {
      supported: false,
      format: 'zip',
      label: 'ZIP archive - not yet supported'
    };
  }
  if (lower.endsWith('.tar.xz') || lower.endsWith('.tar.gz')) {
    // GSHHG basemap: we download shapefiles from NOAA instead of the .tar.xz binary
    if (lower.includes('gshhg') || lower.includes('chartcatalogs/gshhg')) {
      return { supported: true, format: 'gshhg', label: 'GSHHG basemap (requires Podman)' };
    }
    // Pilot Charts: .tar.xz containing .kap BSB raster files
    if (lower.includes('pilot_kaps') || lower.includes('pilot')) {
      return { supported: true, format: 'pilot-tar', label: 'Pilot Chart (requires Podman)' };
    }
    // OSM Shapefiles basemap: .tar.xz containing shapefiles
    if (lower.includes('chartcatalogs/shapefiles') || lower.includes('basemap_')) {
      return { supported: true, format: 'shp-basemap', label: 'Basemap (requires Podman)' };
    }
    return { supported: false, format: 'tar', label: 'Compressed archive - not yet supported' };
  }
  // Check for common unsupported patterns
  if (lower.includes('.bsb') || lower.includes('/bsb/')) {
    return { supported: false, format: 'bsb', label: 'BSB raster - not yet supported' };
  }
  // IENC catalogs only contain S-57 ENC data — trust the category even if URL has no extension
  if (catalogCategory === 'ienc') {
    return {
      supported: true,
      format: 's57-zip',
      label: 'S-57 ENC (requires Podman)'
    };
  }
  // RNC catalogs contain BSB raster charts
  if (catalogCategory === 'rnc') {
    return {
      supported: true,
      format: 'rnc-zip',
      label: 'BSB raster (requires Podman)'
    };
  }
  // Default
  return { supported: false, format: 'unknown', label: 'Unknown format - not yet supported' };
}

function readCacheFile(catalogFile) {
  const cachePath = path.join(cacheDir, catalogFile.replace('.xml', '.json'));
  try {
    if (fs.existsSync(cachePath)) {
      const data = fs.readFileSync(cachePath, 'utf-8');
      return JSON.parse(data);
    }
  } catch (error) {
    debug(`Error reading cache for ${catalogFile}: ${error.message}`);
  }
  return null;
}

function writeCacheFile(catalogFile, data) {
  const cachePath = path.join(cacheDir, catalogFile.replace('.xml', '.json'));
  try {
    fs.writeFileSync(cachePath, JSON.stringify(data, null, 2), 'utf-8');
  } catch (error) {
    debug(`Error writing cache for ${catalogFile}: ${error.message}`);
  }
}

function isCacheFresh(cached) {
  if (!cached || !cached.fetchedAt) {
    return false;
  }
  const age = Date.now() - new Date(cached.fetchedAt).getTime();
  return age < CACHE_MAX_AGE_MS;
}

function getCachedCatalog(catalogFile) {
  return readCacheFile(catalogFile);
}

function fetchCatalog(catalogFile) {
  // Validate that catalogFile is in the registry
  const registryEntry = catalogRegistry.find((r) => r.file === catalogFile);
  if (!registryEntry) {
    return Promise.reject(new Error(`Unknown catalog: ${catalogFile}`));
  }

  // Return fresh cache if available
  const cached = readCacheFile(catalogFile);
  if (cached && isCacheFresh(cached)) {
    return Promise.resolve(cached);
  }

  const url = CATALOG_BASE_URL + catalogFile;

  return new Promise((resolve, reject) => {
    https
      .get(url, (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          const err = new Error(`HTTP ${response.statusCode} fetching ${catalogFile}`);
          // Fall back to stale cache
          if (cached) {
            debug(`${err.message}, using stale cache`);
            resolve(cached);
          } else {
            reject(err);
          }
          return;
        }

        let xmlData = '';
        response.on('data', (chunk) => {
          xmlData += chunk;
        });

        response.on('end', () => {
          parseCatalogXml(xmlData, catalogFile)
            .then((parsed) => {
              writeCacheFile(catalogFile, parsed);
              resolve(parsed);
            })
            .catch((parseErr) => {
              debug(`Parse error for ${catalogFile}: ${parseErr.message}`);
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
  });
}

function parseCatalogXml(xmlData, catalogFile) {
  return new Promise((resolve, reject) => {
    xml2js.parseString(xmlData, (err, result) => {
      if (err) {
        return reject(err);
      }

      try {
        // Support both XML root elements:
        // - RncProductCatalogChartCatalogs (most catalogs): <chart> with <number>/<title>
        // - EncProductCatalogcellCatalogs (Czech, some others): <cell> with <name>/<lname>
        const root = result.RncProductCatalogChartCatalogs || result.EncProductCatalogcellCatalogs;
        if (!root) {
          return reject(new Error('Unexpected XML root element'));
        }

        // Parse header
        const headerNode = root.Header ? root.Header[0] : {};
        const header = {
          title: headerNode.title ? headerNode.title[0] : '',
          dateCreated: headerNode.date_created ? headerNode.date_created[0] : '',
          dateValid: headerNode.date_valid ? headerNode.date_valid[0] : ''
        };

        // Parse charts — support both <chart> and <cell> elements
        const chartNodes = root.chart || root.cell || [];
        const charts = chartNodes
          .map((node) => {
            try {
              // Support both <chart> fields (number/title) and <cell> fields (name/lname)
              return {
                number: (node.number && node.number[0]) || (node.name && node.name[0]) || '',
                title: (node.title && node.title[0]) || (node.lname && node.lname[0]) || '',
                format: node.format ? node.format[0] : '',
                zipfile_location: node.zipfile_location ? node.zipfile_location[0] : '',
                zipfile_datetime_iso8601: node.zipfile_datetime_iso8601
                  ? node.zipfile_datetime_iso8601[0]
                  : ''
              };
            } catch (_e) {
              debug(`Skipping malformed chart entry in ${catalogFile}`);
              return null;
            }
          })
          .filter(Boolean)
          .filter((c) => c.number && c.zipfile_location);

        resolve({
          fetchedAt: new Date().toISOString(),
          catalogFile,
          header,
          charts
        });
      } catch (e) {
        reject(e);
      }
    });
  });
}

function trackInstall(chartNumber, catalogFile, zipfileDatetime, url) {
  installs[chartNumber] = {
    catalogFile,
    zipfile_datetime_iso8601: zipfileDatetime,
    installedAt: new Date().toISOString(),
    zipfile_location: url
  };
  saveInstalls();
}

function removeInstall(chartNumber) {
  if (installs[chartNumber]) {
    delete installs[chartNumber];
    saveInstalls();
    return;
  }
  // Also search by output filename pattern (e.g., delete "gshhg-basemap-l" finds "poly-l")
  // GSHHG: gshhg-basemap-{res} → poly-{res}
  // S-57: {number}.mbtiles → {number}
  const lower = chartNumber.toLowerCase();
  for (const [key] of Object.entries(installs)) {
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

function getInstalledCatalogCharts() {
  return { ...installs };
}

function setConvertingState(chartNumber, isConverting) {
  if (isConverting) {
    converting[chartNumber] = true;
  } else {
    delete converting[chartNumber];
  }
}

function getConvertingCharts() {
  return { ...converting };
}

function getConvertingCount() {
  return Object.keys(converting).length;
}

function checkForUpdates() {
  const updates = [];

  for (const [chartNumber, install] of Object.entries(installs)) {
    const cached = readCacheFile(install.catalogFile);
    if (!cached || !cached.charts) {
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

function getCatalogsWithInstalledCharts() {
  const catalogs = new Set();
  for (const install of Object.values(installs)) {
    catalogs.add(install.catalogFile);
  }
  return Array.from(catalogs);
}

/**
 * Remove catalog install entries that have no corresponding chart file on disk.
 * Uses the same fuzzy matching as removeInstall() to handle naming differences
 * (e.g., catalog key "poly-i" maps to file "gshhg-basemap-i").
 *
 * @param {string[]} chartIdentifiers - identifiers of charts actually found on disk
 */
function pruneStaleInstalls(chartIdentifiers) {
  const ids = new Set(chartIdentifiers.map((id) => id.toLowerCase()));
  let pruned = false;

  for (const key of Object.keys(installs)) {
    const keyLower = key.toLowerCase();

    // Direct match: install key matches a file identifier
    if (ids.has(keyLower)) {
      continue;
    }

    // Fuzzy match: check if any file on disk corresponds to this install
    // (mirrors the reverse mappings in removeInstall)
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
      debug(`Pruning stale catalog install: ${key} (no matching chart on disk)`);
      delete installs[key];
      pruned = true;
    }
  }

  if (pruned) {
    saveInstalls();
  }
}

module.exports = {
  initCatalogManager,
  getCatalogRegistry,
  fetchCatalog,
  getCachedCatalog,
  classifyUrl,
  trackInstall,
  removeInstall,
  getInstalledCatalogCharts,
  pruneStaleInstalls,
  setConvertingState,
  getConvertingCharts,
  getConvertingCount,
  checkForUpdates,
  getCatalogsWithInstalledCharts,
  fetchCatalogRegistry
};
