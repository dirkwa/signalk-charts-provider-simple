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
 *
 * A chart added by URL instead carries its service in a `custom` block, the
 * way charts-plugin's online providers do, for services the catalog does not
 * list. Whether its tiles may be kept is the user's call, since only they
 * know the provider's terms.
 */

import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type { OnlineCatalogChart } from '../catalog/merged-catalog-schema.js';
import type { ChartProvider } from '../types.js';
import { needsTileProxy, offlineTileSource, type OnlineTileSource } from './online-tile-cache.js';

export const ONLINE_CHART_SUFFIX = '.onlinechart.json';

export const CustomOnlineChartSchema = Type.Object({
  type: Type.Union([Type.Literal('tilelayer'), Type.Literal('WMS')]),
  url: Type.String({ pattern: '^https?://[^\\s]+$', maxLength: 2048 }),
  layers: Type.Optional(
    Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { minItems: 1, maxItems: 50 })
  ),
  minzoom: Type.Optional(Type.Integer({ minimum: 0, maximum: 24 })),
  maxzoom: Type.Optional(Type.Integer({ minimum: 0, maximum: 24 })),
  keepOffline: Type.Optional(Type.Boolean())
});

export type CustomOnlineChart = Static<typeof CustomOnlineChartSchema>;

export const OnlineChartFileSchema = Type.Object({
  catalogId: Type.String({ minLength: 1 }),
  name: Type.String({ minLength: 1 }),
  custom: Type.Optional(CustomOnlineChartSchema)
});

export type OnlineChartFile = Static<typeof OnlineChartFileSchema>;

/** Looks up a catalog entry by id; undefined when the catalog lacks it. */
export type OnlineChartResolver = (catalogId: string) => OnlineCatalogChart | undefined;

/**
 * The id a chart added by URL is known by in place of a catalog id. It names
 * the file its tiles are kept in, so it follows the service: pointing the
 * chart at another URL starts a fresh copy instead of mixing two services.
 */
export function customChartId(custom: CustomOnlineChart): string {
  const hash = createHash('sha256')
    .update(`${custom.type}\n${custom.url}\n${(custom.layers ?? []).join(',')}`)
    .digest('hex');
  return `custom-${hash.slice(0, 12)}`;
}

/** Why a chart added by URL cannot be served, or null when it can. */
export function customOnlineChartProblem(custom: CustomOnlineChart): string | null {
  try {
    new URL(custom.url);
  } catch {
    return 'The URL is not valid';
  }
  if (custom.type === 'WMS' && !custom.layers) {
    return 'A WMS chart needs at least one layer';
  }
  const { url } = custom;
  const tiled = /\{z(-\d+)?\}/.test(url) && url.includes('{x}') && /\{-?y\}/.test(url);
  if (custom.type === 'tilelayer' && !tiled && !/\{bbox(_3857)?\}/.test(url)) {
    return 'A tile URL needs {z}, {x} and {y}, or {bbox} or {bbox_3857}';
  }
  if (
    custom.minzoom !== undefined &&
    custom.maxzoom !== undefined &&
    custom.minzoom > custom.maxzoom
  ) {
    return 'The lowest zoom level is above the highest';
  }
  return null;
}

/**
 * The catalog entry for a chart added by URL, built from the file so the
 * rest of the plugin serves and lists it like any catalog chart.
 */
export function customCatalogEntry(custom: CustomOnlineChart): OnlineCatalogChart {
  const { host, origin } = new URL(custom.url);
  return {
    id: customChartId(custom),
    name: host,
    description: `Online chart added by URL, from ${host}.`,
    category: 'navigation',
    bbox: [-180, -85, 180, 85],
    provider: host,
    license: "The provider's terms of use",
    licenseUrl: origin,
    chart: {
      type: custom.type,
      url: custom.url,
      ...(custom.layers ? { layers: custom.layers } : {}),
      ...(custom.minzoom !== undefined ? { minzoom: custom.minzoom } : {}),
      ...(custom.maxzoom !== undefined ? { maxzoom: custom.maxzoom } : {})
    },
    ...(custom.keepOffline ? { offline: {} } : {})
  };
}

/** The catalog entry an online chart file is served from, or undefined when there is none. */
export function onlineChartEntry(
  file: { catalogId: string; custom?: CustomOnlineChart | undefined },
  resolve: OnlineChartResolver
): OnlineCatalogChart | undefined {
  return file.custom ? customCatalogEntry(file.custom) : resolve(file.catalogId);
}

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
  return filename.replace(/\.(mbtiles|pmtiles)$/i, '');
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
  takenIds: ReadonlySet<string> = new Set(),
  custom?: CustomOnlineChart
): string {
  fs.mkdirSync(dir, { recursive: true });
  const stem = safeStem(custom ? name.toLowerCase() : catalogId);
  const content = `${JSON.stringify({ catalogId, name, ...(custom ? { custom } : {}) }, null, 2)}\n`;
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
 * The served chart for an online chart file, or null when its catalog entry
 * is unknown (the catalog hasn't loaded yet, or the entry was removed).
 */
export function onlineChartProvider(
  filePath: string,
  file: OnlineChartFile,
  resolve: OnlineChartResolver
): ChartProvider | null {
  const entry = onlineChartEntry(file, resolve);
  if (!entry) {
    return null;
  }
  const { chart } = entry;
  const identifier = chartIdFromFilename(path.basename(filePath));
  const offlineSource = offlineTileSource(entry);
  // A template only the plugin can fill in goes through it even when its
  // tiles may not be kept.
  const streamedSource: OnlineTileSource | null =
    !offlineSource && chart.type === 'tilelayer' && needsTileProxy(chart.url)
      ? { kind: 'xyz', url: chart.url }
      : null;
  const proxiedSource = offlineSource ?? streamedSource;
  if (proxiedSource) {
    // Served by the plugin's tile route as a plain tile layer, whatever the
    // service type, so plotters fetch every tile through the server.
    const tileSize =
      proxiedSource.kind === 'xyz' && (chart.tileSize === 256 || chart.tileSize === 512)
        ? chart.tileSize
        : undefined;
    const url = `~tilePath~/${identifier}/{z}/{x}/{y}`;
    return {
      _fileFormat: 'online',
      _filePath: filePath,
      _flipY: false,
      identifier,
      name: file.name,
      description: entry.description,
      bounds: [...entry.bbox],
      minzoom: chart.minzoom,
      maxzoom: chart.maxzoom,
      format: 'png',
      type: 'tilelayer',
      scale: 250000,
      ...(tileSize !== undefined ? { tileSize } : {}),
      ...(chart.defaultOpacity !== undefined ? { defaultOpacity: chart.defaultOpacity } : {}),
      _catalogId: entry.id,
      _offlineSource: proxiedSource,
      _keepTiles: offlineSource !== null,
      v1: { tilemapUrl: url, chartLayers: [] },
      v2: { url, layers: [], ...(tileSize !== undefined ? { tileSize } : {}) }
    };
  }
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
    bounds: [...entry.bbox],
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
 * Every chart id in the library — `.mbtiles`, `.pmtiles` and online chart file stems,
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
      (isOnlineChartFile(entry.name) || /\.(mbtiles|pmtiles)$/i.test(entry.name))
    ) {
      ids.add(chartIdFromFilename(entry.name));
    }
  }
  return ids;
}
