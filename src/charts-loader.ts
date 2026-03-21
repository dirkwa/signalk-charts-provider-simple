import path from 'path';
import { promises as fs } from 'fs';
import { parseStringPromise } from 'xml2js';
import { open as openMbtiles } from './utils/mbtiles-reader';
import type { ChartProvider, TilemapXml, VectorLayer } from './types';

export async function findCharts(chartBaseDir: string): Promise<Record<string, ChartProvider>> {
  try {
    const results = await findChartsRecursive(chartBaseDir);
    const filtered = results.filter((c): c is ChartProvider => c !== null);
    return filtered.reduce<Record<string, ChartProvider>>((result, chart) => {
      result[chart.identifier] = chart;
      return result;
    }, {});
  } catch (err) {
    console.error(
      `Error reading charts directory ${chartBaseDir}:${err instanceof Error ? err.message : String(err)}`
    );
    return {};
  }
}

async function findChartsRecursive(currentDir: string): Promise<(ChartProvider | null)[]> {
  const files = await fs.readdir(currentDir, { withFileTypes: true });
  const results: (ChartProvider | null)[][] = [];

  for (const file of files) {
    const filePath = path.resolve(currentDir, file.name);
    const isMbtilesFile = file.name.match(/\.mbtiles$/i);
    const isDirectory = file.isDirectory();

    if (isMbtilesFile) {
      const chart = await openMbtilesFile(filePath, file.name);
      results.push([chart]);
    } else if (isDirectory) {
      if (file.name.startsWith('.') || file.name === 'node_modules') {
        results.push([]);
        continue;
      }

      const chartInfo = await directoryToMapInfo(filePath, file.name);
      if (chartInfo) {
        results.push([chartInfo]);
      } else {
        const subResults = await findChartsRecursive(filePath);
        results.push(subResults);
      }
    } else {
      results.push([]);
    }
  }

  return results.flat();
}

async function openMbtilesFile(file: string, filename: string): Promise<ChartProvider | null> {
  try {
    const reader = await openMbtiles(file);
    const metadata = reader.getInfo();

    if (!metadata || Object.keys(metadata).length === 0 || metadata.bounds === undefined) {
      reader.close();
      return null;
    }

    const identifier = filename.replace(/\.mbtiles$/i, '');

    const vectorLayers = metadata.vector_layers ? parseVectorLayers(metadata.vector_layers) : [];

    const data: ChartProvider = {
      _fileFormat: 'mbtiles',
      _filePath: file,
      _mbtilesHandle: reader,
      _flipY: false,

      identifier,
      name: metadata.name ?? metadata.id ?? identifier,
      description: metadata.description ?? '',
      bounds: metadata.bounds,
      minzoom: metadata.minzoom,
      maxzoom: metadata.maxzoom,
      format: metadata.format ?? 'png',
      type: metadata.type === 'overlay' ? 'tilelayer' : (metadata.type ?? 'tilelayer'),
      scale: parseInt(metadata.scale ?? '', 10) || 250000,

      v1: {
        tilemapUrl: `~tilePath~/${identifier}/{z}/{x}/{y}`,
        chartLayers: vectorLayers
      },

      v2: {
        url: `~tilePath~/${identifier}/{z}/{x}/{y}`,
        layers: vectorLayers
      }
    };
    return data;
  } catch (e) {
    console.error(`Error loading chart ${file}`, e instanceof Error ? e.message : String(e));
    return null;
  }
}

function parseVectorLayers(layers: VectorLayer[]): string[] {
  return layers.map((l) => l.id);
}

async function directoryToMapInfo(file: string, identifier: string): Promise<ChartProvider | null> {
  let info: Partial<ChartProvider> | null = null;

  const tilemapResource = path.join(file, 'tilemapresource.xml');
  const metadataJson = path.join(file, 'metadata.json');

  try {
    await fs.stat(tilemapResource);
    info = await parseTilemapResource(tilemapResource);
  } catch {
    try {
      await fs.stat(metadataJson);
      info = await parseMetadataJson(metadataJson);
    } catch {
      return null;
    }
  }

  try {
    if (info) {
      if (!info.format) {
        console.error(`Missing format metadata for chart ${identifier}`);
        return null;
      }

      info.identifier = identifier;
      info._fileFormat = 'directory';
      info._filePath = file;

      info.v1 = {
        tilemapUrl: `~tilePath~/${identifier}/{z}/{x}/{y}`,
        chartLayers: []
      };

      info.v2 = {
        url: `~tilePath~/${identifier}/{z}/{x}/{y}`,
        layers: []
      };

      return info as ChartProvider;
    }
    return null;
  } catch (e) {
    console.error(`Error getting charts from ${file}`, e instanceof Error ? e.message : String(e));
    return null;
  }
}

async function parseTilemapResource(tilemapResource: string): Promise<Partial<ChartProvider>> {
  const data = await fs.readFile(tilemapResource);
  const parsed = (await parseStringPromise(data)) as TilemapXml;
  const result = parsed.TileMap;
  const name = result?.Title?.[0];
  const format = result?.TileFormat?.[0]?.$?.extension;
  const scale = result?.Metadata?.[0]?.$?.scale;
  const bbox = result?.BoundingBox?.[0]?.$;

  const tileSets = result?.TileSets?.[0]?.TileSet ?? [];
  const zoomLevels = tileSets
    .map((set) => parseInt(set.$?.href ?? ''))
    .filter((n) => Number.isFinite(n));

  return {
    _flipY: true,
    name: name ?? '',
    description: name ?? '',
    bounds: bbox
      ? [
          parseFloat(bbox.minx ?? '0'),
          parseFloat(bbox.miny ?? '0'),
          parseFloat(bbox.maxx ?? '0'),
          parseFloat(bbox.maxy ?? '0')
        ]
      : undefined,
    minzoom: zoomLevels.length > 0 ? Math.min(...zoomLevels) : undefined,
    maxzoom: zoomLevels.length > 0 ? Math.max(...zoomLevels) : undefined,
    format: format ?? '',
    type: 'tilelayer',
    scale: parseInt(scale ?? '') || 250000,
    identifier: '',
    _filePath: ''
  };
}

async function parseMetadataJson(metadataJsonPath: string): Promise<Partial<ChartProvider>> {
  const txt = await fs.readFile(metadataJsonPath, { encoding: 'utf8' });
  const metadata = JSON.parse(txt) as Record<string, unknown>;

  function parseBounds(bounds: unknown): number[] | undefined {
    if (typeof bounds === 'string') {
      return bounds.split(',').map((bound) => parseFloat(bound.trim()));
    } else if (Array.isArray(bounds) && bounds.length === 4) {
      return bounds as number[];
    } else {
      return undefined;
    }
  }

  return {
    _flipY: false,
    name: (metadata.name as string | undefined) ?? (metadata.id as string | undefined) ?? '',
    description: (metadata.description as string | undefined) ?? '',
    bounds: parseBounds(metadata.bounds),
    minzoom: parseIntIfNotUndefined(metadata.minzoom),
    maxzoom: parseIntIfNotUndefined(metadata.maxzoom),
    format: (metadata.format as string | undefined) ?? '',
    type:
      metadata.type === 'overlay'
        ? 'tilelayer'
        : ((metadata.type as string | undefined) ?? 'tilelayer'),
    scale: parseInt(typeof metadata.scale === 'string' ? metadata.scale : '', 10) || 250000,
    identifier: '',
    _filePath: ''
  };
}

function parseIntIfNotUndefined(val: unknown): number | undefined {
  const parsed = parseInt(String(val));
  return Number.isFinite(parsed) ? parsed : undefined;
}
