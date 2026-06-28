import type { ServerAPI } from '@signalk/server-api';
import type { IRouter, Request, Response } from 'express';
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
  /**
   * Tile edge length in pixels (256 or 512). Omitted means the
   * conventional 256. Clients that build raster sources (Freeboard-SK's
   * OpenLayers XYZ, MapLibre raster) need this to address 512px tiles on
   * the correct grid; without it a 512px chart renders mis-scaled.
   * Carried on the v2 descriptor only — that's the normalized shape
   * Signal K v2 consumers read.
   */
  tileSize?: number;
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
  /** Detected tile pixel size (256/512) when known; see ChartV2Data.tileSize. */
  tileSize?: number;

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
  tileSize?: number;
}

// ---- Repairable charts ----
// Valid MBTiles that `findCharts` drops because `metadata.bounds` is
// missing (charts-loader's load gate). They have tiles but no usable
// metadata, so they never enter `chartProviders` and have no card in the
// Manage UI. `findRepairableCharts` surfaces them separately so the UI can
// offer a Repair action that derives the missing metadata from the tile
// pyramid and writes it back into the file.

export type RepairReason = 'missing_bounds';

export interface RepairableDerived {
  bounds: number[];
  minzoom: number;
  maxzoom: number;
  format: string;
  tileSize?: number;
}

export interface RepairableChart {
  /** Filename without `.mbtiles` — the `chartProviders` key once repaired. */
  identifier: string;
  /** Absolute path on disk. */
  filePath: string;
  /** Path relative to the chart base — the wire id the repair route POSTs. */
  relativePath: string;
  /** `metadata.name` if present, else the identifier. */
  name: string;
  reason: RepairReason;
  hasTiles: boolean;
  /** What repair would write, also shown as a preview in the UI. */
  derived: RepairableDerived | null;
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
  CatalogChart,
  CatalogData,
  CatalogHeader,
  CatalogInstall,
  CatalogInstallsMap,
  CatalogRegistryEntry
} from './utils/catalog-schemas.js';

import type { CatalogRegistryEntry } from './utils/catalog-schemas.js';

export interface CatalogRegistryInfo extends CatalogRegistryEntry {
  chartCount: number | null;
  cachedAt: string | null;
}

// Result of the last attempt to fetch the catalog index from GitHub. Drives
// UI messaging when the registry is empty or a refresh fails — notably so a
// GitHub rate-limit (HTTP 403, remaining 0) reads as "rate limited, retry at
// X" instead of the wrong "you may be offline".
export type RegistryFetchStatus = 'ok' | 'rate_limited' | 'error' | 'never';

export interface RegistryStatus {
  status: RegistryFetchStatus;
  isRateLimited: boolean;
  remaining: number | null; // x-ratelimit-remaining
  resetAt: number | null; // x-ratelimit-reset, epoch ms
  retryAfter: number | null; // retry-after header, seconds
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  httpStatus: number | null; // null for network/timeout errors
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
  /** Chart-path-relative folder of the installed file, e.g. "Netherlands Inland ENC". '/' means root. */
  installedFolder: string;
}

// ---- Conversion Progress ----

export type ConversionStatus =
  'starting' | 'pulling' | 'extracting' | 'converting' | 'completed' | 'failed';

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

/**
 * Structured per-bucket progress for the multi-band S-57 pipeline. A "bucket"
 * is one IHO band (or the unbanded remainder); the pipeline runs them in
 * sequence, then tile-joins. Consumed by the Custom Catalogs UI to drive its
 * progress bars; the upload / single-chart catalog flows don't pass an
 * `onProgress` and so never see these.
 */
export interface S57BucketProgress {
  /** `export` = GDAL→GeoJSON, `tiles` = tippecanoe, `join` = tile-join. */
  stage: 'export' | 'tiles' | 'join';
  /** 1-based index of the current bucket. */
  bucketIndex: number;
  bucketCount: number;
  /** Human label, e.g. "Band 4" / "Other charts" / "Joining". */
  bucketLabel: string;
  /** 0–100 for `tiles`; -1 (indeterminate) for `export` / `join`. */
  bucketPercent: number;
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
  /**
   * Optional structured progress reporter. Called as the per-band pipeline
   * moves through export → tiles → join for each bucket. Only the Custom
   * Catalogs flow passes this.
   */
  onProgress?: (progress: S57BucketProgress) => void;
  /**
   * Optional cooperative-cancel check. Polled between buckets (and before
   * tile-join) to stop the pipeline at the next boundary — a complement to
   * `signal`, and the only cancel path on signalk-container < 1.16.0.
   */
  isAborted?: () => boolean;
  /**
   * Optional abort signal threaded into every container job. On
   * signalk-container >= 1.16.0 this kills the in-flight job (GDAL,
   * tippecanoe, or tile-join) immediately rather than waiting for a boundary.
   */
  signal?: AbortSignal;
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

export type { IRouter, Request, Response };
