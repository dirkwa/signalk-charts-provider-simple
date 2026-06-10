/**
 * Custom NOAA ENC catalogs.
 *
 * A "custom catalog" is a user-named bundle of NOAA band-4 coverage areas
 * selected on a map. Each is persisted as JSON under
 * `<dataDir>/custom-catalogs/<id>.json`. Downloading a custom catalog fetches
 * all selected band-4 ENCs plus the overlapping band-3 and band-5 ENCs and
 * runs the S-57 pipeline once to produce a single MBTiles chart named after
 * the catalog.
 *
 * This module owns persistence, safe-id derivation (no path traversal),
 * freshness/update evaluation, and the per-catalog progress used by the
 * download-and-convert flow. The geometry / inclusion math lives in
 * `noaa-enc-footprints.ts`; this module consumes a `FootprintIndex` rather
 * than fetching it, so persistence stays unit-testable without network.
 */

import fs from 'fs';
import path from 'path';
import type { ConversionProgress, DebugFunction } from '../types.js';
import { sanitizeChartFilename } from './catalog-title.js';
import { isWithinBase } from './path-safety.js';
import { computeInclusion, coverageByBox, type FootprintIndex } from './noaa-enc-footprints.js';

export const CUSTOM_CATALOG_SCHEMA_VERSION = 1;
const CATALOG_DIR_NAME = 'custom-catalogs';
const MAX_LOG_LINES = 200;

export type CustomCatalogStatus = 'empty' | 'out_of_date' | 'downloaded' | 'converted';

export type CustomCatalogPhase =
  | 'preparing'
  | 'downloading'
  | 'converting'
  | 'joining'
  | 'completed'
  | 'cancelling'
  | 'cancelled'
  | 'failed';

/** Structured progress that drives the Custom Catalogs UI (two bars + map). */
export interface CustomCatalogProgressDetail {
  phase: CustomCatalogPhase;
  /** Overall (conversion) bar, 0–100. */
  overallPercent: number;
  /** Current-step label, e.g. "Downloading 42/106" or "Band 4 — tiles". */
  sectionLabel: string;
  /** Current-step bar, 0–100; -1 = indeterminate. */
  sectionPercent: number;
  /** Included chart ids staged so far — lets the map flip areas red→yellow. */
  downloadedChartIds: string[];
  /**
   * Per selected band-4 box, the chart ids (band-4 + nested band-5) that
   * count toward that box's download-fill. Set once at run start; lets the
   * map fill each box bottom-to-top by its own completed fraction.
   */
  coverageByBox?: Record<string, string[]>;
}

export interface CustomCatalog {
  schemaVersion: number;
  /** Safe slug; also the JSON filename stem and the API `:id`. */
  id: string;
  name: string;
  selectedBand: 4;
  selectedBand4ChartIds: string[];
  includedChartIds: string[];
  /** chartId → `enc_ed_up` snapshot captured at last download. */
  chartVersions: Record<string, string>;
  downloadedChartIds: string[];
  /** Chart-path-relative `.mbtiles` filename, or null before first convert. */
  convertedChartPath: string | null;
  status: CustomCatalogStatus;
  createdAt: string;
  updatedAt: string;
  lastDownloadedAt: string | null;
  lastConvertedAt: string | null;
}

let dataDir = '';
let debug: DebugFunction = () => {};

// Per-catalog progress for the whole download→convert flow. The S-57
// converter keeps its own per-band log keyed by the same id; the status/log
// route merges the two so the user sees both the download phase and the
// detailed conversion log.
const catalogProgress: Record<string, ConversionProgress> = {};
// Structured progress (phase + bars + per-chart download state) for the UI.
const catalogDetail: Record<string, CustomCatalogProgressDetail> = {};
// Catalogs with an in-flight download/convert. Guards against a second
// concurrent run of the same catalog.
const busyCatalogs = new Set<string>();
// Catalogs whose in-flight run the user asked to cancel.
const cancelRequested = new Set<string>();

export function initCustomCatalogManager(dir: string, debugFn: DebugFunction): void {
  dataDir = dir;
  debug = debugFn || (() => {});
  try {
    fs.mkdirSync(catalogsDir(), { recursive: true });
  } catch (err) {
    debug(
      `Failed to create custom-catalogs dir: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

function catalogsDir(): string {
  return path.join(dataDir, CATALOG_DIR_NAME);
}

/**
 * Derive a filesystem-safe slug from a catalog name. Result matches
 * `^[A-Za-z0-9_-]+$` so it can never escape the catalogs dir or collide with
 * path separators. Falls back to `catalog` when the name sanitizes to nothing.
 */
export function slugifyCatalogName(name: string): string {
  const slug = name
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^A-Za-z0-9_-]/g, '')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 80);
  return slug || 'catalog';
}

/** A request `:id` is only valid if it is exactly the safe-slug shape. */
export function isValidCatalogId(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,80}$/.test(id);
}

function catalogFilePath(id: string): string | null {
  if (!isValidCatalogId(id)) {
    return null;
  }
  const file = path.join(catalogsDir(), `${id}.json`);
  // Defence in depth: even a slug-shaped id is re-checked against the base.
  if (!isWithinBase(file, catalogsDir())) {
    return null;
  }
  return file;
}

/** Output `.mbtiles` basename for a catalog (chart-path-relative). */
export function catalogMbtilesName(catalog: Pick<CustomCatalog, 'name' | 'id'>): string {
  const base = sanitizeChartFilename(catalog.name) || catalog.id;
  return `${base}.mbtiles`;
}

export function listCustomCatalogs(): CustomCatalog[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(catalogsDir());
  } catch {
    return [];
  }
  const catalogs: CustomCatalog[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) {
      continue;
    }
    const id = entry.slice(0, -'.json'.length);
    const cat = getCustomCatalog(id);
    if (cat) {
      catalogs.push(cat);
    }
  }
  catalogs.sort((a, b) => a.name.localeCompare(b.name));
  return catalogs;
}

export function getCustomCatalog(id: string): CustomCatalog | null {
  const file = catalogFilePath(id);
  if (!file) {
    return null;
  }
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw) as Partial<CustomCatalog>;
    return normalizeCatalog(parsed, id);
  } catch {
    return null;
  }
}

// Coerce a parsed JSON object into a fully-populated CustomCatalog, filling
// any field a hand-edited / older file might be missing. The on-disk id
// (filename) wins over any `id` inside the file.
function normalizeCatalog(parsed: Partial<CustomCatalog>, id: string): CustomCatalog {
  const now = new Date().toISOString();
  return {
    schemaVersion: parsed.schemaVersion ?? CUSTOM_CATALOG_SCHEMA_VERSION,
    id,
    name: typeof parsed.name === 'string' && parsed.name.trim() !== '' ? parsed.name : id,
    selectedBand: 4,
    selectedBand4ChartIds: Array.isArray(parsed.selectedBand4ChartIds)
      ? parsed.selectedBand4ChartIds.filter((x): x is string => typeof x === 'string')
      : [],
    includedChartIds: Array.isArray(parsed.includedChartIds)
      ? parsed.includedChartIds.filter((x): x is string => typeof x === 'string')
      : [],
    chartVersions:
      parsed.chartVersions && typeof parsed.chartVersions === 'object' ? parsed.chartVersions : {},
    downloadedChartIds: Array.isArray(parsed.downloadedChartIds)
      ? parsed.downloadedChartIds.filter((x): x is string => typeof x === 'string')
      : [],
    convertedChartPath:
      typeof parsed.convertedChartPath === 'string' ? parsed.convertedChartPath : null,
    status: isStatus(parsed.status) ? parsed.status : 'empty',
    createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : now,
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : now,
    lastDownloadedAt: typeof parsed.lastDownloadedAt === 'string' ? parsed.lastDownloadedAt : null,
    lastConvertedAt: typeof parsed.lastConvertedAt === 'string' ? parsed.lastConvertedAt : null
  };
}

function isStatus(s: unknown): s is CustomCatalogStatus {
  return s === 'empty' || s === 'out_of_date' || s === 'downloaded' || s === 'converted';
}

/**
 * Create a new empty catalog with a unique slug derived from `name`. Throws
 * with a 400-friendly message if the name is blank.
 */
export function createCustomCatalog(name: string): CustomCatalog {
  const trimmed = name.trim();
  if (trimmed === '') {
    throw new Error('Catalog name must not be empty');
  }
  const base = slugifyCatalogName(trimmed);
  let id = base;
  for (let i = 2; fs.existsSync(path.join(catalogsDir(), `${id}.json`)); i += 1) {
    id = `${base}-${i}`;
  }
  const now = new Date().toISOString();
  const catalog: CustomCatalog = {
    schemaVersion: CUSTOM_CATALOG_SCHEMA_VERSION,
    id,
    name: trimmed,
    selectedBand: 4,
    selectedBand4ChartIds: [],
    includedChartIds: [],
    chartVersions: {},
    downloadedChartIds: [],
    convertedChartPath: null,
    status: 'empty',
    createdAt: now,
    updatedAt: now,
    lastDownloadedAt: null,
    lastConvertedAt: null
  };
  saveCustomCatalog(catalog);
  return catalog;
}

export function saveCustomCatalog(catalog: CustomCatalog): void {
  const file = catalogFilePath(catalog.id);
  if (!file) {
    throw new Error(`Invalid catalog id: ${catalog.id}`);
  }
  catalog.updatedAt = new Date().toISOString();
  fs.mkdirSync(catalogsDir(), { recursive: true });
  // Atomic write: temp file + rename so a crash mid-write can't truncate the
  // catalog JSON.
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(catalog, null, 2));
  fs.renameSync(tmp, file);
}

export function deleteCustomCatalog(id: string): boolean {
  const file = catalogFilePath(id);
  if (!file || !fs.existsSync(file)) {
    return false;
  }
  fs.unlinkSync(file);
  // Drop ALL in-memory state for this id so a recreated chart set with the
  // same slug can't inherit the prior run's progress/detail/cancel flags.
  delete catalogProgress[id];
  delete catalogDetail[id];
  busyCatalogs.delete(id);
  cancelRequested.delete(id);
  return true;
}

// ---- Freshness / update detection ----

export interface FreshnessResult {
  upToDate: boolean;
  reasons: string[];
  recomputed: ReturnType<typeof computeInclusion>;
  /** The status to display, accounting for staleness. */
  effectiveStatus: CustomCatalogStatus;
}

/**
 * Evaluate whether a catalog's converted output is still current against the
 * live footprint index. A catalog is out of date if any selected band-4 chart
 * vanished or changed edition, the recomputed coverage set changed, any
 * included chart changed edition, or the expected MBTiles output is missing.
 */
export function evaluateFreshness(
  catalog: CustomCatalog,
  index: FootprintIndex,
  chartFileExists: (relPath: string) => boolean
): FreshnessResult {
  const recomputed = computeInclusion(index.all, catalog.selectedBand4ChartIds);
  const reasons: string[] = [];

  if (recomputed.missingSelected.length > 0) {
    reasons.push(`No longer published: ${recomputed.missingSelected.join(', ')}`);
  }

  // Selected band-4 edition drift vs. the snapshot taken at last download.
  for (const id of catalog.selectedBand4ChartIds) {
    const cur = index.byChartId.get(id);
    const stored = catalog.chartVersions[id];
    if (cur && stored && cur.encEdUp !== stored) {
      reasons.push(`Updated edition: ${id}`);
    }
  }

  // Coverage set changed (overlap brought in / dropped a band-3/5 cell).
  const storedSet = new Set(catalog.includedChartIds);
  const changed =
    storedSet.size !== recomputed.includedChartIds.length ||
    recomputed.includedChartIds.some((id) => !storedSet.has(id));
  if (changed) {
    reasons.push('Coverage set changed');
  }

  // Any included chart's edition changed.
  for (const id of recomputed.includedChartIds) {
    const stored = catalog.chartVersions[id];
    const cur = recomputed.chartVersions[id];
    if (stored && cur && stored !== cur) {
      reasons.push(`Updated edition: ${id}`);
    }
  }

  const mbtilesPresent =
    catalog.convertedChartPath !== null && chartFileExists(catalog.convertedChartPath);
  if (catalog.convertedChartPath !== null && !mbtilesPresent) {
    reasons.push('Converted chart file is missing');
  }

  const upToDate = catalog.status === 'converted' && reasons.length === 0 && mbtilesPresent;

  let effectiveStatus: CustomCatalogStatus;
  if (catalog.selectedBand4ChartIds.length === 0) {
    effectiveStatus = 'empty';
  } else if (upToDate) {
    effectiveStatus = 'converted';
  } else if (catalog.status === 'downloaded' && reasons.length === 0) {
    effectiveStatus = 'downloaded';
  } else {
    effectiveStatus = 'out_of_date';
  }

  // A selected band-4 chart is also in the recomputed included set, so an
  // edition change can be pushed by both loops above — de-dupe for display.
  return { upToDate, reasons: [...new Set(reasons)], recomputed, effectiveStatus };
}

/** Per selected band-4 box: is what's baked into the MBTiles still current? */
export type BoxState = 'up_to_date' | 'needs_refresh';

/**
 * Compute, for each selected band-4 box, whether the chart edition baked into
 * the built MBTiles still matches the current NOAA editions for that box's
 * charts (its band-4 cell + the band-5 cells nested in it).
 *
 * `needs_refresh` when: the catalog was never built; a chart in the box's
 * current coverage has a newer `enc_ed_up` than the snapshot taken at build
 * time; or NOAA has added a new cell to the box since the build. `up_to_date`
 * only when every covered chart matches the baked snapshot.
 *
 * This is driven entirely by the edition snapshot persisted in the chart-set
 * JSON, so it is independent of whether the downloaded source ZIPs still exist
 * on disk (they are cleaned up after conversion by design).
 */
export function boxStatesForCatalog(
  catalog: CustomCatalog,
  index: FootprintIndex
): Record<string, BoxState> {
  const coverage = coverageByBox(index.all, catalog.selectedBand4ChartIds);
  const baked = catalog.chartVersions;
  const built = catalog.convertedChartPath !== null;

  const result: Record<string, BoxState> = {};
  for (const boxId of catalog.selectedBand4ChartIds) {
    if (!built) {
      result[boxId] = 'needs_refresh';
      continue;
    }
    const cov = coverage[boxId] ?? [];
    let fresh = cov.length > 0;
    for (const chartId of cov) {
      const bakedEdition = baked[chartId];
      const currentEdition = index.byChartId.get(chartId)?.encEdUp;
      // New cell not in the build, or a drifted edition → this box is stale.
      if (
        bakedEdition === undefined ||
        (currentEdition !== undefined && currentEdition !== bakedEdition)
      ) {
        fresh = false;
        break;
      }
    }
    result[boxId] = fresh ? 'up_to_date' : 'needs_refresh';
  }
  return result;
}

// ---- Per-catalog progress (download + convert) ----

export function isCatalogBusy(id: string): boolean {
  return busyCatalogs.has(id);
}

export function setCatalogBusy(id: string, busy: boolean): void {
  if (busy) {
    busyCatalogs.add(id);
  } else {
    busyCatalogs.delete(id);
  }
}

export function getCatalogProgress(id: string): ConversionProgress | null {
  return catalogProgress[id] ?? null;
}

export function setCatalogProgress(id: string, status: string, message: string): void {
  const existing = catalogProgress[id];
  if (existing) {
    existing.status = status;
    existing.message = message;
  } else {
    catalogProgress[id] = { status, message, log: [] };
  }
}

export function appendCatalogLog(id: string, text: string): void {
  if (!text) {
    return;
  }
  const progress = catalogProgress[id] ?? { status: 'downloading', message: '', log: [] };
  catalogProgress[id] = progress;
  const lines = text.split(/\r|\n/).filter((l) => l.trim());
  progress.log.push(...lines);
  if (progress.log.length > MAX_LOG_LINES) {
    progress.log.splice(0, progress.log.length - MAX_LOG_LINES);
  }
}

export function setCatalogFailed(id: string, message: string): void {
  const existing = catalogProgress[id];
  catalogProgress[id] = {
    status: 'failed',
    message,
    log: existing?.log ?? []
  };
  // Keep the failure visible long enough for the user to read the log, then
  // drop it so a stale error doesn't shadow a later retry.
  setTimeout(() => {
    if (catalogProgress[id]?.status === 'failed') {
      delete catalogProgress[id];
    }
  }, 300000);
}

export function clearCatalogProgress(id: string): void {
  delete catalogProgress[id];
  delete catalogDetail[id];
}

// ---- Structured progress detail ----

export function getCatalogDetail(id: string): CustomCatalogProgressDetail | null {
  return catalogDetail[id] ?? null;
}

export function setCatalogDetail(id: string, detail: Partial<CustomCatalogProgressDetail>): void {
  const existing: CustomCatalogProgressDetail = catalogDetail[id] ?? {
    phase: 'preparing',
    overallPercent: 0,
    sectionLabel: '',
    sectionPercent: -1,
    downloadedChartIds: []
  };
  catalogDetail[id] = { ...existing, ...detail };
}

// ---- Cancellation ----

/** Request cancellation of an in-flight run; no-op when not busy. */
export function requestCatalogCancel(id: string): boolean {
  if (!busyCatalogs.has(id)) {
    return false;
  }
  cancelRequested.add(id);
  return true;
}

export function isCatalogCancelRequested(id: string): boolean {
  return cancelRequested.has(id);
}

export function clearCatalogCancel(id: string): void {
  cancelRequested.delete(id);
}
