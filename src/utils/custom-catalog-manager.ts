/**
 * Chart sets (the ENC Charts tab).
 *
 * A chart set is a user-named bundle of ENC units picked on a map (see
 * `docs/enc-index.md`). Each is persisted as JSON under
 * `<dataDir>/custom-catalogs/<id>.json`. Downloading a set fetches every
 * cell its units bring in and runs the S-57 pipeline once to produce a
 * single MBTiles chart named after the set.
 *
 * This module owns persistence (including the migration of sets saved by
 * the NOAA Charts tab), safe-id derivation (no path traversal),
 * freshness/update evaluation, and the per-set progress used by the
 * download-and-convert flow. Which cells a set holds comes from
 * `enc-chart-set.ts`; this module takes that resolution as input, so
 * persistence stays unit-testable without network.
 */

import fs from 'fs';
import path from 'path';
import type { ConversionProgress, DebugFunction } from '../types.js';
import { sanitizeChartFilename } from './catalog-title.js';
import { isWithinBase } from './path-safety.js';
import type { ChartSetResolution } from './enc-chart-set.js';

/**
 * Version 2 adds `selectedUnitIds` and keeps every version 1 field as it
 * was, so an older plugin still opens a version 2 set and shows its NOAA
 * part.
 */
export const CUSTOM_CATALOG_SCHEMA_VERSION = 2;
const CATALOG_DIR_NAME = 'custom-catalogs';
export const MAX_CATALOG_MANAGER_LOG_LINES = 200;
const MAX_LOG_LINES = MAX_CATALOG_MANAGER_LOG_LINES;

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
  /** Cells staged so far — lets the map flip units red→yellow. */
  downloadedChartIds: string[];
  /**
   * Per selected unit, the cells (its `statusCells`) that count toward its
   * download-fill. Set once at run start; lets the map fill each unit
   * bottom-to-top by its own completed fraction.
   */
  coverageByBox?: Record<string, string[]>;
}

export interface CustomCatalog {
  schemaVersion: number;
  /** Safe slug; also the JSON filename stem and the API `:id`. */
  id: string;
  name: string;
  selectedBand: 4;
  /** Selected NOAA units (band-4 boxes), the field older versions read. */
  selectedBand4ChartIds: string[];
  /** Selected units of every other source: S-57 cell names. */
  selectedUnitIds: string[];
  /** Cell names baked into the output. */
  includedChartIds: string[];
  /** Cell name → version snapshot captured at last download. */
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
  let parsed: Partial<CustomCatalog>;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<CustomCatalog>;
  } catch {
    return null;
  }
  const catalog = normalizeCatalog(parsed, id);
  if (needsMigration(parsed)) {
    migrateInPlace(file, catalog);
  }
  return catalog;
}

/** A set saved before version 2 (the NOAA Charts tab), or with no version at all. */
function needsMigration(parsed: Partial<CustomCatalog>): boolean {
  return (
    typeof parsed.schemaVersion !== 'number' || parsed.schemaVersion < CUSTOM_CATALOG_SCHEMA_VERSION
  );
}

/**
 * Rewrite a version 1 set as version 2 on first read. Version 2 only adds
 * fields, so the selection, the per-cell version snapshot, the status and
 * the output file name carry over unchanged: nothing is downloaded or
 * rebuilt, and a set that was current stays current. `updatedAt` is kept,
 * since the user changed nothing. A failed write is retried on the next
 * read; the set is served from memory either way.
 */
function migrateInPlace(file: string, catalog: CustomCatalog): void {
  try {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(catalog, null, 2));
    fs.renameSync(tmp, file);
    debug(`Migrated chart set ${catalog.id} to version ${String(catalog.schemaVersion)}`);
  } catch (err) {
    debug(
      `Could not migrate chart set ${catalog.id}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : [];
}

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).filter((e): e is [string, string] => typeof e[1] === 'string')
  );
}

// Coerce a parsed JSON object into a fully-populated CustomCatalog, filling
// any field a hand-edited / older file might be missing. The on-disk id
// (filename) wins over any `id` inside the file. A file from a newer
// version keeps its version number, so it is not migrated; saving it from
// this version still drops the fields this version does not know.
function normalizeCatalog(parsed: Partial<CustomCatalog>, id: string): CustomCatalog {
  const now = new Date().toISOString();
  return {
    schemaVersion:
      typeof parsed.schemaVersion === 'number'
        ? Math.max(parsed.schemaVersion, CUSTOM_CATALOG_SCHEMA_VERSION)
        : CUSTOM_CATALOG_SCHEMA_VERSION,
    id,
    name: typeof parsed.name === 'string' && parsed.name.trim() !== '' ? parsed.name : id,
    selectedBand: 4,
    selectedBand4ChartIds: stringList(parsed.selectedBand4ChartIds),
    selectedUnitIds: stringList(parsed.selectedUnitIds),
    includedChartIds: stringList(parsed.includedChartIds),
    chartVersions: stringRecord(parsed.chartVersions),
    downloadedChartIds: stringList(parsed.downloadedChartIds),
    convertedChartPath:
      typeof parsed.convertedChartPath === 'string' ? parsed.convertedChartPath : null,
    status: isStatus(parsed.status) ? parsed.status : 'empty',
    createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : now,
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : now,
    lastDownloadedAt: typeof parsed.lastDownloadedAt === 'string' ? parsed.lastDownloadedAt : null,
    lastConvertedAt: typeof parsed.lastConvertedAt === 'string' ? parsed.lastConvertedAt : null
  };
}

/** The number of units a set has selected, from every source. */
export function selectedUnitCount(
  catalog: Pick<CustomCatalog, 'selectedBand4ChartIds' | 'selectedUnitIds'>
): number {
  return catalog.selectedBand4ChartIds.length + catalog.selectedUnitIds.length;
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
    selectedUnitIds: [],
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
  /** The status to display, accounting for staleness. */
  effectiveStatus: CustomCatalogStatus;
}

/**
 * Evaluate whether a set's converted output is still current against the
 * ENC index, resolved for the set's selection. A set is out of date if a
 * selected unit is no longer published, the cells its units bring in
 * changed, any of those cells changed version, or the expected MBTiles
 * output is missing. The same rule applies to every source: each cell's
 * version in the index against the snapshot taken at download.
 */
export function evaluateFreshness(
  catalog: CustomCatalog,
  resolution: ChartSetResolution,
  chartFileExists: (relPath: string) => boolean
): FreshnessResult {
  const reasons: string[] = [];

  if (resolution.missingSelected.length > 0) {
    reasons.push(`No longer published: ${resolution.missingSelected.join(', ')}`);
  }
  if (resolution.unreadableSelected.length > 0) {
    reasons.push(`Needs a newer plugin version: ${resolution.unreadableSelected.join(', ')}`);
  }

  // Coverage set changed (a NOAA box overlap brought in or dropped a cell, or
  // the selection changed). A set never downloaded has nothing to compare.
  const storedSet = new Set(catalog.includedChartIds);
  const changed =
    storedSet.size !== resolution.includedChartIds.length ||
    resolution.includedChartIds.some((id) => !storedSet.has(id));
  if (changed && (catalog.lastDownloadedAt !== null || catalog.includedChartIds.length > 0)) {
    reasons.push('Coverage set changed');
  }

  for (const id of resolution.includedChartIds) {
    const stored = catalog.chartVersions[id];
    const cur = resolution.chartVersions[id];
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
  if (selectedUnitCount(catalog) === 0) {
    effectiveStatus = 'empty';
  } else if (upToDate) {
    effectiveStatus = 'converted';
  } else if (catalog.status === 'downloaded' && reasons.length === 0) {
    effectiveStatus = 'downloaded';
  } else {
    effectiveStatus = 'out_of_date';
  }

  return { upToDate, reasons, effectiveStatus };
}

/** Per selected unit: is what's baked into the MBTiles still current? */
export type BoxState = 'up_to_date' | 'needs_refresh';

/**
 * Compute, for each selected unit, whether the versions baked into the
 * built MBTiles still match the index for that unit's `statusCells` (for a
 * NOAA box: its band-4 cell and the band-5 cells nested in it).
 *
 * A unit is `up_to_date` only when the set is cleanly converted, its
 * MBTiles is present on disk, AND every status cell matches the baked
 * snapshot. It is `needs_refresh` otherwise — never built, a cancelled or
 * failed build (status no longer `converted`), the output file missing, a
 * changed version, a unit no longer published, or a new status cell.
 *
 * Version-driven, so it doesn't depend on the downloaded *source* archives
 * still being on disk (those are cleaned up after conversion). It does
 * require the built *output* MBTiles, since a missing chart genuinely
 * needs a rebuild.
 */
export function boxStatesForCatalog(
  catalog: CustomCatalog,
  resolution: ChartSetResolution,
  mbtilesPresent: boolean
): Record<string, BoxState> {
  const baked = catalog.chartVersions;
  // `chartVersions` is also written at download time (before conversion), so on
  // a cancelled/failed run it can claim current versions that aren't actually
  // baked in. Gating on a clean 'converted' status + a present output file
  // ensures those runs show red, not a false green.
  const built = catalog.status === 'converted' && mbtilesPresent;

  const result: Record<string, BoxState> = {};
  for (const unitId of [...catalog.selectedBand4ChartIds, ...catalog.selectedUnitIds]) {
    const cov = resolution.coverageByUnit[unitId] ?? [];
    let fresh = built && cov.length > 0;
    for (const cell of fresh ? cov : []) {
      const bakedVersion = baked[cell];
      const currentVersion = resolution.chartVersions[cell];
      // New cell not in the build, or a changed version → this unit is stale.
      if (
        bakedVersion === undefined ||
        (currentVersion !== undefined && currentVersion !== bakedVersion)
      ) {
        fresh = false;
        break;
      }
    }
    result[unitId] = fresh ? 'up_to_date' : 'needs_refresh';
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

// Per-run abort controller. The flow registers one at start; cancel aborts it
// to kill the in-flight container job (signalk-container >= 1.16.0). The
// cancelRequested flag remains the boundary-cancel signal and the way the flow
// distinguishes a cancel from a genuine failure.
const abortControllers = new Map<string, AbortController>();

/** Register the run's abort controller so a cancel can fire its signal. */
export function registerCatalogAbort(id: string, controller: AbortController): void {
  abortControllers.set(id, controller);
}

/** Request cancellation of an in-flight run; no-op when not busy. */
export function requestCatalogCancel(id: string): boolean {
  if (!busyCatalogs.has(id)) {
    return false;
  }
  cancelRequested.add(id);
  // Kill the in-flight container job immediately where supported; the boundary
  // check (isCatalogCancelRequested) covers older signalk-container.
  abortControllers.get(id)?.abort();
  return true;
}

export function isCatalogCancelRequested(id: string): boolean {
  return cancelRequested.has(id);
}

export function clearCatalogCancel(id: string): void {
  cancelRequested.delete(id);
  abortControllers.delete(id);
}
