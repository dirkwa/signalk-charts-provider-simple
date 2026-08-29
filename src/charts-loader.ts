import path from 'path';
import { promises as fs } from 'fs';
import { parseStringPromise } from 'xml2js';
import { open as openMbtiles } from './utils/mbtiles-reader.js';
import type { MBTilesReader } from './utils/mbtiles-reader.js';
import type {
  ChartProvider,
  RepairableChart,
  RepairableDerived,
  TilemapXml,
  VectorLayer
} from './types.js';

const KNOWN_CHART_TYPES = new Set(['tilelayer', 's-57', 'mapstylejson', 'tilejson', 'wms', 'wmts']);

// S-57 object-class layer names that only ever appear in ENC-derived vector
// tiles. Freeboard only applies its land/depth S-57 style when the served
// chart type is `S-57`; a chart whose `type=S-57` metadata row failed to get
// written (e.g. the post-conversion patch couldn't open the file read-write
// under Docker/rootful-podman — issue #157) still carries these layers, so we
// can recognize it as S-57 from the tile schema and style it correctly instead
// of serving it as a generic, unstyled vector tilelayer (freeboard-sk #436).
const S57_LAYER_MARKERS = ['LNDARE', 'DEPARE', 'DEPCNT', 'COALNE', 'SOUNDG'];

function looksLikeS57(format: string | undefined, layerIds: string[]): boolean {
  if ((format ?? '').toLowerCase() !== 'pbf') {
    return false;
  }
  return layerIds.some((id) => S57_LAYER_MARKERS.includes(id));
}

function resolveChartType(
  metadataType: string | undefined,
  format?: string,
  layerIds: string[] = []
): string {
  if (metadataType && KNOWN_CHART_TYPES.has(metadataType.toLowerCase())) {
    return metadataType;
  }
  // The metadata `type` is missing or unrecognized (tippecanoe's default
  // `overlay`, or an un-patched file). Recover the S-57 type from the tile
  // schema so the chart still gets its proper style; otherwise fall back to a
  // plain tilelayer.
  if (looksLikeS57(format, layerIds)) {
    return 'S-57';
  }
  return 'tilelayer';
}

export async function findCharts(chartBaseDir: string): Promise<Record<string, ChartProvider>> {
  // A directory-read failure must reject so callers can tell a failed scan
  // apart from an empty-but-readable directory — swallowing it here used to
  // make an unreadable charts directory look like "zero charts, success".
  // Individual chart files that fail to open are still skipped
  // (openMbtilesFile returns null), so one corrupt .mbtiles cannot fail
  // the walk.
  //
  // The walk opens a sqlite handle per chart as it goes, and an unreadable
  // SUBdirectory throws after earlier charts already have theirs. Those
  // handles never reach a caller, so nothing else can close them — and on
  // Windows each one locks its .mbtiles. Release them here before
  // rethrowing; the rejection itself is the contract and must survive.
  const opened: ChartProvider[] = [];
  try {
    const results = await findChartsRecursive(chartBaseDir, opened);
    const filtered = results.filter((c): c is ChartProvider => c !== null);
    return filtered.reduce<Record<string, ChartProvider>>((result, chart) => {
      result[chart.identifier] = chart;
      return result;
    }, {});
  } catch (err) {
    for (const chart of opened) {
      try {
        chart._mbtilesHandle?.close();
      } catch {
        // Already closed — nothing to release.
      }
    }
    throw err;
  }
}

async function findChartsRecursive(
  currentDir: string,
  /** Every provider opened so far, so a throw mid-walk can still close them. */
  opened: ChartProvider[]
): Promise<(ChartProvider | null)[]> {
  const files = await fs.readdir(currentDir, { withFileTypes: true });
  const results: (ChartProvider | null)[][] = [];

  for (const file of files) {
    const filePath = path.resolve(currentDir, file.name);
    const isMbtilesFile = file.name.match(/\.mbtiles$/i);
    const isDirectory = file.isDirectory();

    if (isMbtilesFile) {
      const chart = await openMbtilesFile(filePath, file.name);
      if (chart) {
        opened.push(chart);
      }
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
        const subResults = await findChartsRecursive(filePath, opened);
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

    // Advertise a non-256 tile size so clients build the raster source on
    // the right grid. We only read PNG dimensions (getTilePixelSize) and
    // only carry the field when it isn't the conventional 256, keeping the
    // common case's descriptor unchanged.
    const tileSize = readTileSize(metadata.format, reader);

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
      type: resolveChartType(metadata.type, metadata.format, vectorLayers),
      scale: parseInt(metadata.scale ?? '', 10) || 250000,
      ...(tileSize !== undefined ? { tileSize } : {}),

      v1: {
        tilemapUrl: `~tilePath~/${identifier}/{z}/{x}/{y}`,
        chartLayers: vectorLayers
      },

      v2: {
        url: `~tilePath~/${identifier}/{z}/{x}/{y}`,
        layers: vectorLayers,
        ...(tileSize !== undefined ? { tileSize } : {})
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
    type: resolveChartType(metadata.type as string | undefined),
    scale: parseInt(typeof metadata.scale === 'string' ? metadata.scale : '', 10) || 250000,
    identifier: '',
    _filePath: ''
  };
}

function parseIntIfNotUndefined(val: unknown): number | undefined {
  const parsed = parseInt(String(val));
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Detect a non-default raster tile size for the chart descriptor. Returns a
 * value only for raster formats (png/jpg/webp or unset, which defaults to
 * png) when the detected size isn't the conventional 256; vector (pbf) and
 * 256px charts get undefined so the descriptor stays minimal.
 */
function readTileSize(format: string | undefined, reader: MBTilesReader): number | undefined {
  if (format === 'pbf') {
    return undefined;
  }
  const size = reader.getTilePixelSize();
  if (size === undefined || size === 256) {
    return undefined;
  }
  return size;
}

/**
 * Find MBTiles that `findCharts` drops because `metadata.bounds` is missing
 * but that have a valid tile pyramid — i.e. they can be repaired by
 * deriving the missing metadata from the tiles table. Directories and
 * already-loadable charts are not returned. The returned `relativePath` is
 * the wire id the repair route expects (mirrors the rename flow's
 * `chartPath`).
 */
export async function findRepairableCharts(chartBaseDir: string): Promise<RepairableChart[]> {
  try {
    const results = await findRepairableRecursive(chartBaseDir, chartBaseDir);
    return results.filter((c): c is RepairableChart => c !== null);
  } catch (err) {
    console.error(
      `Error scanning for repairable charts in ${chartBaseDir}: ${err instanceof Error ? err.message : String(err)}`
    );
    return [];
  }
}

async function findRepairableRecursive(
  currentDir: string,
  baseDir: string
): Promise<(RepairableChart | null)[]> {
  const files = await fs.readdir(currentDir, { withFileTypes: true });
  const results: (RepairableChart | null)[][] = [];

  for (const file of files) {
    const filePath = path.resolve(currentDir, file.name);

    if (file.name.match(/\.mbtiles$/i)) {
      results.push([await inspectMbtilesForRepair(filePath, file.name, baseDir)]);
    } else if (file.isDirectory()) {
      if (file.name.startsWith('.') || file.name === 'node_modules') {
        results.push([]);
        continue;
      }
      results.push(await findRepairableRecursive(filePath, baseDir));
    } else {
      results.push([]);
    }
  }

  return results.flat();
}

/**
 * Mirror of `openMbtilesFile` with the load gate inverted: a chart is
 * repairable when its metadata table is non-empty, `bounds` is missing, and
 * it has tiles to derive bounds from. Anything that already loads (has
 * bounds) or can't be fixed (no tiles) returns null. The read-only reader is
 * always closed before returning.
 */
async function inspectMbtilesForRepair(
  file: string,
  filename: string,
  baseDir: string
): Promise<RepairableChart | null> {
  let reader: MBTilesReader | null = null;
  try {
    reader = await openMbtiles(file);
    const metadata = reader.getInfo();

    // Already loadable, or no metadata at all — not our case.
    if (
      !metadata ||
      Object.keys(metadata).length === 0 ||
      metadata.bounds !== undefined ||
      !reader.hasTiles()
    ) {
      return null;
    }

    const bounds = reader.deriveBoundsFromTiles();
    const zoom = reader.getZoomRangeFromTiles();
    if (!bounds || !zoom) {
      // Tiles present but unreadable extent — can't synthesize bounds.
      return null;
    }

    const format = reader.sniffFormatFromTiles() ?? metadata.format ?? 'png';
    const tileSize = readTileSize(format, reader);

    const identifier = filename.replace(/\.mbtiles$/i, '');
    const derived: RepairableDerived = {
      bounds,
      minzoom: zoom.minzoom,
      maxzoom: zoom.maxzoom,
      format,
      ...(tileSize !== undefined ? { tileSize } : {})
    };

    return {
      identifier,
      filePath: file,
      relativePath: path.relative(baseDir, file),
      name: metadata.name ?? metadata.id ?? identifier,
      reason: 'missing_bounds',
      hasTiles: true,
      derived
    };
  } catch (e) {
    console.error(
      `Error inspecting chart for repair ${file}`,
      e instanceof Error ? e.message : String(e)
    );
    return null;
  } finally {
    reader?.close();
  }
}
