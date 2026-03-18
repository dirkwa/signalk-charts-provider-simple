const fs = require('fs');
const path = require('path');

/**
 * Get chart name from MBTiles metadata
 * @param {string} filePath - Path to .mbtiles file
 * @returns {string|null} Chart name or null
 */
function getChartName(filePath) {
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(filePath, { readOnly: true });

    try {
      const row = db.prepare("SELECT value FROM metadata WHERE name = 'name'").get();
      return row ? row.value : null;
    } finally {
      db.close();
    }
  } catch (_err) {
    return null;
  }
}

/**
 * Recursively scan a directory for .mbtiles files
 * @param {string} basePath - The base chart directory
 * @param {string} currentPath - The current directory being scanned (for recursion)
 * @returns {Promise<Array>} Array of chart file information
 */
async function scanChartsRecursively(basePath, currentPath = basePath) {
  const charts = [];

  if (!fs.existsSync(currentPath)) {
    return charts;
  }

  const entries = await fs.promises.readdir(currentPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(currentPath, entry.name);

    if (entry.isDirectory()) {
      // Skip hidden directories and node_modules
      if (entry.name.startsWith('.') || entry.name === 'node_modules') {
        continue;
      }

      // Check if this is a chart directory (contains metadata.json)
      if (isChartDirectory(fullPath)) {
        const metadata = readChartMetadata(fullPath);
        if (metadata) {
          const relativePath = path.relative(basePath, fullPath);
          const folder = path.dirname(relativePath) || '/';
          const stats = await fs.promises.stat(fullPath);

          charts.push({
            name: entry.name,
            chartName: metadata.name || entry.name,
            size: null, // directory-based charts don't have a single file size
            path: fullPath,
            relativePath: relativePath,
            folder: folder === '.' ? '/' : folder,
            dateCreated: stats.birthtimeMs,
            dateModified: stats.mtimeMs,
            enabled: true,
            format: metadata.format || 'pbf',
            type: metadata.type || 'tilelayer',
            isDirectory: true
          });
        }
        // Don't recurse into chart directories
        continue;
      }

      // Recursively scan subdirectory
      const subCharts = await scanChartsRecursively(basePath, fullPath);
      charts.push(...subCharts);
    } else if (entry.isFile() && entry.name.endsWith('.mbtiles')) {
      const stats = await fs.promises.stat(fullPath);
      const relativePath = path.relative(basePath, fullPath);
      const folder = path.dirname(relativePath) || '/';

      // Read chart name from MBTiles metadata (fast synchronous query)
      const chartName = getChartName(fullPath);

      charts.push({
        name: entry.name,
        chartName: chartName, // Chart name from metadata
        size: stats.size,
        path: fullPath,
        relativePath: relativePath,
        folder: folder === '.' ? '/' : folder,
        dateCreated: stats.birthtimeMs,
        dateModified: stats.mtimeMs,
        enabled: true // Default to enabled
      });
    }
  }

  return charts;
}

/**
 * Get all unique folders containing charts
 * @param {Array} charts - Array of chart file information
 * @returns {Array<string>} Sorted array of folder paths
 */
function getUniqueFolders(charts) {
  const folders = new Set();

  for (const chart of charts) {
    folders.add(chart.folder);
  }

  return Array.from(folders).sort();
}

/**
 * Check if a directory is a chart directory (contains metadata.json or tilemapresource.xml)
 * These are directory-based charts (XYZ/TMS/S-57) and should not be recursed into.
 * @param {string} dirPath - Directory path to check
 * @returns {boolean}
 */
function isChartDirectory(dirPath) {
  return (
    fs.existsSync(path.join(dirPath, 'metadata.json')) ||
    fs.existsSync(path.join(dirPath, 'tilemapresource.xml'))
  );
}

/**
 * Read metadata.json from a chart directory
 * @param {string} dirPath - Directory path containing metadata.json
 * @returns {object|null} Parsed metadata or null
 */
function readChartMetadata(dirPath) {
  try {
    const metadataPath = path.join(dirPath, 'metadata.json');
    if (fs.existsSync(metadataPath)) {
      return JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
    }
  } catch (_e) {
    // ignore
  }
  return null;
}

/**
 * Scan all subdirectories (including empty ones), skipping chart directories
 * and their tile tree subdirectories.
 * @param {string} basePath - The base chart directory
 * @param {string} currentPath - The current directory being scanned (for recursion)
 * @returns {Promise<Array<string>>} Array of all folder paths (relative to basePath)
 */
async function scanAllFolders(basePath, currentPath = basePath) {
  const folders = [];

  if (!fs.existsSync(currentPath)) {
    return folders;
  }

  const entries = await fs.promises.readdir(currentPath, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isDirectory()) {
      // Skip hidden directories and node_modules
      if (entry.name.startsWith('.') || entry.name === 'node_modules') {
        continue;
      }

      const fullPath = path.join(currentPath, entry.name);
      const relativePath = path.relative(basePath, fullPath);

      // Skip chart directories (contain metadata.json / tilemapresource.xml)
      // These are directory-based charts — don't show their z/x/y tile tree as folders
      if (isChartDirectory(fullPath)) {
        continue;
      }

      // Add this folder
      folders.push(relativePath || '/');

      // Recursively scan subdirectories
      const subFolders = await scanAllFolders(basePath, fullPath);
      folders.push(...subFolders);
    }
  }

  return folders;
}

module.exports = {
  scanChartsRecursively,
  getUniqueFolders,
  scanAllFolders
};
