import type { ServerAPI } from '@signalk/server-api';
import type { Request, Response, IRouter } from 'express';
import type { MBTilesReader } from './utils/mbtiles-reader.js';

// ---- Plugin Configuration ----
// Runtime-validated via TypeBox in `utils/plugin-config-schema.ts`.
// Re-exported here so existing imports (`from './types.js'`) keep working.

export type { CpuBudgetPreset, PluginConfig } from './utils/plugin-config-schema.js';

// ---- Extended ServerAPI ----
// ServerAPI from @signalk/server-api does not expose app.config or app.get() for route registration.
// The real server object has these properties which plugins rely on.

export interface ServerConfig {
  configPath: string;
  version: string;
  ssl: boolean;
  getExternalPort(): number;
}

export interface ExtendedServerAPI extends ServerAPI {
  config: ServerConfig;
}

// ---- Chart Provider (the core data structure) ----

export interface ChartV1Data {
  tilemapUrl: string;
  chartLayers: string[];
}

export interface ChartV2Data {
  url: string;
  layers: string[];
}

export type ChartFileFormat = 'mbtiles' | 'directory';
export type ChartType = 'tilelayer' | string;

export interface ChartProvider {
  _fileFormat: ChartFileFormat;
  _filePath: string;
  _mbtilesHandle?: MBTilesReader;
  _flipY: boolean;

  identifier: string;
  name: string;
  description: string;
  bounds: number[] | undefined;
  minzoom: number | undefined;
  maxzoom: number | undefined;
  format: string;
  type: ChartType;
  scale: number;

  v1: ChartV1Data;
  v2: ChartV2Data;
}

export interface SanitizedChart {
  identifier: string;
  name: string;
  description: string;
  bounds: number[] | undefined;
  minzoom: number | undefined;
  maxzoom: number | undefined;
  format: string;
  type: ChartType;
  scale: number;
  tilemapUrl?: string;
  chartLayers?: string[];
  url?: string;
  layers?: string[];
}

// ---- MBTiles Metadata ----

export interface MBTilesMetadata {
  name?: string;
  id?: string;
  description?: string;
  bounds?: number[];
  center?: number[];
  minzoom?: number;
  maxzoom?: number;
  format?: string;
  type?: string;
  scale?: string;
  vector_layers?: VectorLayer[];
  [key: string]: unknown;
}

export interface VectorLayer {
  id: string;
  [key: string]: unknown;
}

export interface TileResult {
  data: Buffer;
  headers: Record<string, string>;
}

// ---- Download Manager ----

export type DownloadJobStatus = 'queued' | 'downloading' | 'extracting' | 'completed' | 'failed';

export interface DownloadJobOptions {
  saveRaw?: boolean;
}

export interface DownloadJob {
  id: string;
  url: string;
  originalUrl?: string;
  targetDir: string;
  chartName: string;
  saveRaw: boolean;
  status: DownloadJobStatus;
  progress: number;
  downloadedBytes: number;
  totalBytes: number;
  extractedFiles: string[];
  targetFiles: string[];
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  error?: string;
}

// ---- Catalog Manager ----
// Most catalog types are runtime-validated via TypeBox in
// `utils/catalog-schemas.ts`. Re-exported here so existing imports
// (`from './types.js'`) keep working. `CatalogRegistryInfo` is a UI-only
// shape (built in-memory after registering, never parsed from JSON), so
// it stays a plain interface.

export type {
  CatalogCategory,
  CatalogRegistryEntry,
  CatalogChart,
  CatalogHeader,
  CatalogData,
  CatalogInstall,
  CatalogInstallsMap
} from './utils/catalog-schemas.js';

import type { CatalogRegistryEntry } from './utils/catalog-schemas.js';

export interface CatalogRegistryInfo extends CatalogRegistryEntry {
  chartCount: number | null;
  cachedAt: string | null;
}

export type UrlFormat =
  | 'mbtiles'
  | 'zip'
  | 's57-zip'
  | 'rnc-zip'
  | 'gshhg'
  | 'pilot-tar'
  | 'shp-basemap'
  | 'bsb'
  | 'tar'
  | 'unknown';

export interface UrlClassification {
  supported: boolean;
  format: UrlFormat;
  label: string;
}

export interface CatalogUpdate {
  chartNumber: string;
  catalogFile: string;
  title: string;
  installedDate: string;
  availableDate: string;
  downloadUrl: string;
}

// ---- Conversion Progress ----

export type ConversionStatus =
  | 'starting'
  | 'pulling'
  | 'extracting'
  | 'converting'
  | 'completed'
  | 'failed';

export interface ConversionProgress {
  status: string;
  message: string;
  log: string[];
}

export type ConversionProgressMap = Record<string, ConversionProgress>;

// ---- S-57 / RNC Converter ----

export interface S57ConversionResult {
  mbtilesFile: string;
}

export interface S57ConversionOptions {
  minzoom?: number;
  maxzoom?: number;
  /**
   * Optional human-friendly chart label written into the MBTiles
   * `metadata.name` row after conversion. When the conversion is driven
   * by a catalog click this is the cleaned catalog title; manual
   * uploads leave it undefined and the existing metadata stays in
   * place. See `cleanCatalogTitle` in `utils/catalog-title.ts`.
   */
  displayName?: string;
  /**
   * Optional longer text written into MBTiles `metadata.description`.
   * Typically the full original (un-cleaned) catalog title so chart
   * provenance survives in clients that surface description.
   */
  displayDescription?: string;
}

export interface ContainerRuntimeStatus {
  available: boolean;
  version: string | null;
  socketPath: string | null;
  engine: 'docker' | 'podman' | null;
}

export interface RncConversionResult {
  mbtilesFiles: string[];
}

// ---- File Scanner ----

export interface ScannedChart {
  name: string;
  chartName: string | null;
  size: number | null;
  path: string;
  relativePath: string;
  folder: string;
  dateCreated: number;
  dateModified: number;
  enabled: boolean;
  format?: string;
  type?: string;
  isDirectory?: boolean;
}

// ---- Chart State ----

export interface ChartStateEntry {
  enabled: boolean;
}

export type ChartStateMap = Record<string, ChartStateEntry>;

// ---- Callbacks ----

export type StatusCallback = (status: string, message: string) => void;
export type DebugFunction = (...args: unknown[]) => void;

// ---- XML parsing (tilemapresource.xml) ----

export interface TilemapXml {
  TileMap?: {
    Title?: string[];
    TileFormat?: Array<{ $?: { extension?: string } }>;
    BoundingBox?: Array<{
      $?: { minx?: string; miny?: string; maxx?: string; maxy?: string };
    }>;
    TileSets?: Array<{ TileSet?: Array<{ $?: { href?: string } }> }>;
    Metadata?: Array<{ $?: { scale?: string } }>;
  };
}

// ---- Express route helpers ----

export type { Request, Response, IRouter };
