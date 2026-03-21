import fs from 'fs';
import path from 'path';
import type { ScannedChart } from '../types';

interface ChartMetadata {
  name?: string;
  format?: string;
  type?: string;
}

function getChartName(filePath: string): string | null {
  try {
    const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
    const db = new DatabaseSync(filePath, { readOnly: true });

    try {
      const row = db.prepare("SELECT value FROM metadata WHERE name = 'name'").get() as
        | { value: string }
        | undefined;
      return row ? row.value : null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

function isChartDirectory(dirPath: string): boolean {
  return (
    fs.existsSync(path.join(dirPath, 'metadata.json')) ||
    fs.existsSync(path.join(dirPath, 'tilemapresource.xml'))
  );
}

function readChartMetadata(dirPath: string): ChartMetadata | null {
  try {
    const metadataPath = path.join(dirPath, 'metadata.json');
    if (fs.existsSync(metadataPath)) {
      return JSON.parse(fs.readFileSync(metadataPath, 'utf-8')) as ChartMetadata;
    }
  } catch {
    // ignore
  }
  return null;
}

export async function scanChartsRecursively(
  basePath: string,
  currentPath: string = basePath
): Promise<ScannedChart[]> {
  const charts: ScannedChart[] = [];

  if (!fs.existsSync(currentPath)) {
    return charts;
  }

  const entries = await fs.promises.readdir(currentPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(currentPath, entry.name);

    if (entry.isDirectory()) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') {
        continue;
      }

      if (isChartDirectory(fullPath)) {
        const metadata = readChartMetadata(fullPath);
        if (metadata) {
          const relativePath = path.relative(basePath, fullPath);
          const folder = path.dirname(relativePath) || '/';
          const stats = await fs.promises.stat(fullPath);

          charts.push({
            name: entry.name,
            chartName: metadata.name ?? entry.name,
            size: null,
            path: fullPath,
            relativePath: relativePath,
            folder: folder === '.' ? '/' : folder,
            dateCreated: stats.birthtimeMs,
            dateModified: stats.mtimeMs,
            enabled: true,
            format: metadata.format ?? 'pbf',
            type: metadata.type ?? 'tilelayer',
            isDirectory: true
          });
        }
        continue;
      }

      const subCharts = await scanChartsRecursively(basePath, fullPath);
      charts.push(...subCharts);
    } else if (entry.isFile() && entry.name.endsWith('.mbtiles')) {
      const stats = await fs.promises.stat(fullPath);
      const relativePath = path.relative(basePath, fullPath);
      const folder = path.dirname(relativePath) || '/';

      const chartName = getChartName(fullPath);

      charts.push({
        name: entry.name,
        chartName: chartName,
        size: stats.size,
        path: fullPath,
        relativePath: relativePath,
        folder: folder === '.' ? '/' : folder,
        dateCreated: stats.birthtimeMs,
        dateModified: stats.mtimeMs,
        enabled: true
      });
    }
  }

  return charts;
}

export function getUniqueFolders(charts: ScannedChart[]): string[] {
  const folders = new Set<string>();

  for (const chart of charts) {
    folders.add(chart.folder);
  }

  return Array.from(folders).sort();
}

export async function scanAllFolders(
  basePath: string,
  currentPath: string = basePath
): Promise<string[]> {
  const folders: string[] = [];

  if (!fs.existsSync(currentPath)) {
    return folders;
  }

  const entries = await fs.promises.readdir(currentPath, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') {
        continue;
      }

      const fullPath = path.join(currentPath, entry.name);
      const relativePath = path.relative(basePath, fullPath);

      if (isChartDirectory(fullPath)) {
        continue;
      }

      folders.push(relativePath || '/');

      const subFolders = await scanAllFolders(basePath, fullPath);
      folders.push(...subFolders);
    }
  }

  return folders;
}
