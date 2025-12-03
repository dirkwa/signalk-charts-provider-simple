const fs = require('fs');
const path = require('path');

/**
 * Get chart name from MBTiles metadata
 * @param {string} filePath - Path to .mbtiles file
 * @returns {string|null} Chart name or null
 */
function getChartName(filePath) {
  try {
    const Database = require('better-sqlite3');
    const db = new Database(filePath, { readonly: true });

    try {
      const row = db.prepare("SELECT value FROM metadata WHERE name = 'name'").get();
      return row ? row.value : null;
    } finally {
      db.close();
    }
  } catch (err) {
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
 * Scan all subdirectories (including empty ones)
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
