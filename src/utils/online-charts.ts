/**
 * Online charts: charts streamed from a provider while the boat has
 * internet (weather layers, online nautical charts, base maps), added from
 * the Chart Catalog.
 *
 * Each added chart is a small `<catalogId>.onlinechart.json` file in the chart
 * folder, so it takes part in everything Manage Charts does with files —
 * folders, enable/disable, move, delete — without special cases. The file
 * references its catalog entry by id instead of copying the service URL,
 * so a fix to the catalog reaches every boat on the next catalog refresh.
 */

import fs from 'fs';
import path from 'path';
import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type { OnlineCatalogChart } from '../catalog/merged-catalog-schema.js';
import type { ChartProvider } from '../types.js';

export const ONLINE_CHART_SUFFIX = '.onlinechart.json';

export const OnlineChartFileSchema = Type.Object({
  catalogId: Type.String({ minLength: 1 }),
  name: Type.String({ minLength: 1 })
});

export type OnlineChartFile = Static<typeof OnlineChartFileSchema>;

/** Looks up a catalog entry by id; undefined when the catalog lacks it. */
export type OnlineChartResolver = (catalogId: string) => OnlineCatalogChart | undefined;

export function isOnlineChartFile(filename: string): boolean {
  return filename.toLowerCase().endsWith(ONLINE_CHART_SUFFIX);
}

/**
 * The chart identifier for a file in the chart folder: its name without the
 * chart-file extension. Every route that maps a file back to its served
 * chart must use this, or online charts get the wrong id.
 */
export function chartIdFromFilename(filename: string): string {
  if (isOnlineChartFile(filename)) {
    return filename.slice(0, -ONLINE_CHART_SUFFIX.length);
  }
  return filename.replace(/\.mbtiles$/i, '');
}

export function readOnlineChartFile(filePath: string): OnlineChartFile | null {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    return Value.Check(OnlineChartFileSchema, raw) ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Rewrite a chart file's display name, keeping any other fields. Written to
 * a temporary file and renamed into place, so a power cut or a concurrent
 * scan never sees a half-written file (which would drop the chart).
 */
export function renameOnlineChartFile(filePath: string, name: string): boolean {
  if (!readOnlineChartFile(filePath)) {
    return false;
  }
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify({ ...raw, name }, null, 2)}\n`, 'utf-8');
  fs.renameSync(tmpPath, filePath);
  return true;
}

/**
 * The file-name stem for a catalog id. The stem becomes the chart's
 * identifier, which appears in resource URLs and Signal K delta paths, so
 * it comes from the catalog id (lower-case, hyphenated) rather than the
 * display name, which lives inside the file.
 */
function safeStem(catalogId: string): string {
  const stem = catalogId.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return stem || 'online-chart';
}

/**
 * Create `<catalogId>.onlinechart.json` in `dir`, choosing "<catalogId>-2"
 * and so on when the name is taken. A chart's identifier is its file stem,
 * shared with every `.mbtiles` and online chart in the whole library, so
 * `takenIds` must hold all of them: an id clash would hide one chart behind
 * the other, and startup cleanup deletes an `.mbtiles` it can't account for.
 * Returns the file name written.
 */
export function writeOnlineChartFile(
  dir: string,
  catalogId: string,
  name: string,
  takenIds: ReadonlySet<string> = new Set()
): string {
  fs.mkdirSync(dir, { recursive: true });
  const stem = safeStem(catalogId);
  const content = `${JSON.stringify({ catalogId, name }, null, 2)}\n`;
  for (let n = 1; ; n++) {
    const id = n === 1 ? stem : `${stem}-${String(n)}`;
    if (takenIds.has(id)) {
      continue;
    }
    const filename = `${id}${ONLINE_CHART_SUFFIX}`;
    try {
      // 'wx' fails if the file exists, so two concurrent Adds can't clobber
      // each other's file.
      fs.writeFileSync(path.join(dir, filename), content, { encoding: 'utf-8', flag: 'wx' });
      return filename;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw err;
      }
    }
  }
}

/**
 * Chart plotters draw `bounds` as an extent, and a box that crosses the
 * antimeridian (west > east) has no single-extent form, so widen it to all
 * longitudes rather than send an inverted box.
 */
function boundsForBbox([west, south, east, north]: number[]): number[] {
  return west <= east ? [west, south, east, north] : [-180, south, 180, north];
}

/**
 * The served chart for an online chart file, or null when its catalog entry
 * is unknown (the catalog hasn't loaded yet, or the entry was removed).
 */
export function onlineChartProvider(
  filePath: string,
  file: OnlineChartFile,
  resolve: OnlineChartResolver
): ChartProvider | null {
  const entry = resolve(file.catalogId);
  if (!entry) {
    return null;
  }
  const { chart } = entry;
  const identifier = chartIdFromFilename(path.basename(filePath));
  const layers = chart.layers ?? [];
  // Plotters only lay tiles out on 256 or 512 px grids.
  const tileSize = chart.tileSize === 256 || chart.tileSize === 512 ? chart.tileSize : undefined;
  return {
    _fileFormat: 'online',
    _filePath: filePath,
    _flipY: false,
    identifier,
    name: file.name,
    description: entry.description,
    bounds: boundsForBbox(entry.bbox),
    minzoom: chart.minzoom,
    maxzoom: chart.maxzoom,
    format: chart.type === 'mapstyleJSON' ? 'pbf' : 'png',
    type: chart.type,
    scale: 250000,
    ...(tileSize !== undefined ? { tileSize } : {}),
    ...(chart.defaultOpacity !== undefined ? { defaultOpacity: chart.defaultOpacity } : {}),
    ...(entry.temporal ? { refreshInterval: entry.temporal.refreshInterval } : {}),
    _catalogId: entry.id,
    v1: { tilemapUrl: chart.url, chartLayers: layers },
    v2: {
      url: chart.url,
      layers,
      ...(tileSize !== undefined ? { tileSize } : {})
    }
  };
}

export interface OnlineChartFileRef {
  relativePath: string;
  catalogId: string;
}

/** Every online chart file under `basePath`, for the catalog's "Added" state. */
export async function findOnlineChartFiles(
  basePath: string,
  currentPath: string = basePath
): Promise<OnlineChartFileRef[]> {
  const found: OnlineChartFileRef[] = [];
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(currentPath, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const fullPath = path.join(currentPath, entry.name);
    if (entry.isDirectory()) {
      // A tile directory is a chart, not a folder; walking its thousands of
      // tile files would only cost time.
      if (
        !entry.name.startsWith('.') &&
        entry.name !== 'node_modules' &&
        !isTileDirectory(fullPath)
      ) {
        found.push(...(await findOnlineChartFiles(basePath, fullPath)));
      }
    } else if (entry.isFile() && isOnlineChartFile(entry.name)) {
      const file = readOnlineChartFile(fullPath);
      if (file) {
        found.push({ relativePath: path.relative(basePath, fullPath), catalogId: file.catalogId });
      }
    }
  }
  return found;
}

function isTileDirectory(dirPath: string): boolean {
  return (
    fs.existsSync(path.join(dirPath, 'metadata.json')) ||
    fs.existsSync(path.join(dirPath, 'tilemapresource.xml'))
  );
}

/**
 * Every chart id in the library — `.mbtiles` and online chart file stems,
 * and tile-directory names — whether or not the chart currently loads.
 * A new online chart must avoid all of them (see writeOnlineChartFile).
 */
export async function collectChartIds(
  basePath: string,
  currentPath: string = basePath
): Promise<Set<string>> {
  const ids = new Set<string>();
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(currentPath, { withFileTypes: true });
  } catch {
    return ids;
  }
  for (const entry of entries) {
    const fullPath = path.join(currentPath, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') {
        continue;
      }
      if (isTileDirectory(fullPath)) {
        ids.add(entry.name);
      } else {
        for (const id of await collectChartIds(basePath, fullPath)) {
          ids.add(id);
        }
      }
    } else if (
      entry.isFile() &&
      (isOnlineChartFile(entry.name) || /\.mbtiles$/i.test(entry.name))
    ) {
      ids.add(chartIdFromFilename(entry.name));
    }
  }
  return ids;
}
