const https = require('https');
const fs = require('fs');
const path = require('path');
const xml2js = require('xml2js');

const CATALOG_BASE_URL = 'https://raw.githubusercontent.com/chartcatalogs/catalogs/master/';

const CATALOG_REGISTRY = [
  {
    file: 'NOAA_MBTiles_Catalog.xml',
    label: 'NOAA Vector Charts (MBTiles)',
    category: 'mbtiles'
  },
  {
    file: 'GSHHG_Catalog.xml',
    label: 'World Basemap Polygons (GSHHG)',
    category: 'general'
  },
  {
    file: 'PILOT_Catalog.xml',
    label: 'World Pilot Charts',
    category: 'general'
  },
  {
    file: 'OSMSHP_Catalog.xml',
    label: 'OpenStreetMap Shapefiles',
    category: 'general'
  },
  {
    file: 'ACE_BUOY_Catalog.xml',
    label: 'ACE Buoy Charts',
    category: 'general'
  },
  {
    file: 'AR_RNC_Catalog.xml',
    label: 'Argentina Raster Charts',
    category: 'rnc'
  },
  {
    file: 'BR_RNC_Catalog.xml',
    label: 'Brazil Raster Charts',
    category: 'rnc'
  },
  {
    file: 'NZ_RNC_Catalog.xml',
    label: 'New Zealand Raster Charts',
    category: 'rnc'
  },
  {
    file: 'PE_RNC_Catalog.xml',
    label: 'Peru Raster Charts',
    category: 'rnc'
  },
  {
    file: 'SCS_ENC_Catalog.xml',
    label: 'South China Sea ENC',
    category: 'rnc'
  },
  {
    file: 'AT_IENC_Catalog.xml',
    label: 'Austria Inland ENC',
    category: 'ienc'
  },
  {
    file: 'BE_IENC_Catalog.xml',
    label: 'Belgium Inland ENC',
    category: 'ienc'
  },
  {
    file: 'BG_IENC_Catalog.xml',
    label: 'Bulgaria Inland ENC',
    category: 'ienc'
  },
  {
    file: 'BR_IENC_Catalog.xml',
    label: 'Brazil Inland ENC',
    category: 'ienc'
  },
  {
    file: 'CH_IENC_Catalog.xml',
    label: 'Switzerland Inland ENC',
    category: 'ienc'
  },
  {
    file: 'CZ_IENC_Catalog.xml',
    label: 'Czech Republic Inland ENC',
    category: 'ienc'
  },
  {
    file: 'DE_IENC_Catalog.xml',
    label: 'Germany Inland ENC',
    category: 'ienc'
  },
  {
    file: 'EURIS_IENC_Catalog.xml',
    label: 'European RIS Inland ENC',
    category: 'ienc'
  },
  {
    file: 'FR_IENC_Catalog.xml',
    label: 'France Inland ENC',
    category: 'ienc'
  },
  {
    file: 'FR_IENC_RHONE_Catalog.xml',
    label: 'France Rhone Inland ENC',
    category: 'ienc'
  },
  {
    file: 'HR_IENC_Catalog.xml',
    label: 'Croatia Inland ENC',
    category: 'ienc'
  },
  {
    file: 'HU_IENC_Catalog.xml',
    label: 'Hungary Inland ENC',
    category: 'ienc'
  },
  {
    file: 'NL_IENC_Catalog.xml',
    label: 'Netherlands Inland ENC',
    category: 'ienc'
  },
  {
    file: 'PL_IENC_Catalog.xml',
    label: 'Poland Inland ENC',
    category: 'ienc'
  },
  {
    file: 'RO_IENC_Catalog.xml',
    label: 'Romania Inland ENC',
    category: 'ienc'
  },
  {
    file: 'RS_IENC_Catalog.xml',
    label: 'Serbia Inland ENC',
    category: 'ienc'
  },
  {
    file: 'SK_IENC_Catalog.xml',
    label: 'Slovakia Inland ENC',
    category: 'ienc'
  }
];

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
  return CATALOG_REGISTRY.map((entry) => {
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
  const registryEntry = CATALOG_REGISTRY.find((r) => r.file === catalogFile);
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

module.exports = {
  initCatalogManager,
  getCatalogRegistry,
  fetchCatalog,
  getCachedCatalog,
  classifyUrl,
  trackInstall,
  removeInstall,
  getInstalledCatalogCharts,
  setConvertingState,
  getConvertingCharts,
  checkForUpdates,
  getCatalogsWithInstalledCharts,
  CATALOG_REGISTRY
};
