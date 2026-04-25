import type { ServerAPI } from '@signalk/server-api';
import type { Request, Response, IRouter } from 'express';
import type { MBTilesReader } from './utils/mbtiles-reader';

// ---- Plugin Configuration ----

export interface PluginConfig {
  chartPath: string;
}

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

export type CatalogCategory = 'mbtiles' | 'ienc' | 'rnc' | 'general';

export interface CatalogRegistryEntry {
  file: string;
  label: string;
  category: CatalogCategory;
}

export interface CatalogRegistryInfo extends CatalogRegistryEntry {
  chartCount: number | null;
  cachedAt: string | null;
}

export interface CatalogChart {
  number: string;
  title: string;
  format: string;
  zipfile_location: string;
  zipfile_datetime_iso8601: string;
}

export interface CatalogHeader {
  title: string;
  dateCreated: string;
  dateValid: string;
}

export interface CatalogData {
  fetchedAt: string;
  catalogFile: string;
  header: CatalogHeader;
  charts: CatalogChart[];
}

export interface CatalogInstall {
  catalogFile: string;
  zipfile_datetime_iso8601: string;
  installedAt: string;
  zipfile_location: string;
}

export type CatalogInstallsMap = Record<string, CatalogInstall>;

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
}

export interface ContainerRuntimeStatus {
  available: boolean;
  version: string | null;
  socketPath: string | null;
  engine: 'docker' | 'podman' | null;
}

/** @deprecated use ContainerRuntimeStatus */
export type PodmanStatus = ContainerRuntimeStatus;

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
