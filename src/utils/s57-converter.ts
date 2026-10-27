import fs from 'fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import unzipper from 'unzipper';
import type {
  ConversionProgress,
  ConversionProgressMap,
  DebugFunction,
  S57BucketProgress,
  S57ConversionOptions,
  S57ConversionResult,
  StatusCallback
} from '../types.js';
import { sanitizeChartFilename } from './catalog-title.js';
import { getCpuBudget } from './concurrency.js';
import {
  CONVERSION_ABORTED_MESSAGE,
  chooseConversionBackend,
  describeBackend,
  fallbackNote,
  type ConversionBackend,
  type ConversionReport
} from './conversion-backend.js';
import { MAX_CONVERSION_LOG_LINES } from './conversion-log.js';
import { setConversionResult } from './conversion-progress.js';
import {
  extractLocalChartSource,
  isS57Cell,
  isS57Update,
  type LocalChartSource
} from './local-chart-source.js';
import { patchS57Mbtiles, setMbtilesDisplayName } from './mbtiles-metadata.js';
import { addRasterOverviews } from './raster-pyramid.js';
import { BAND_MAX_ZOOM, BAND_MIN_ZOOM, detectEncBand, exportFileParts } from './s57-band.js';
import {
  exportCellsInContainer,
  rasterizeLandInContainer,
  tileS57InContainer
} from './s57-container.js';
import {
  COMPLETE_MARKER_PREFIX,
  EXPORT_ERROR_FILE_BASENAME,
  SKIP_LAYERS,
  exportErrorReport,
  gatherCellUpdates,
  geojsonContentSize
} from './s57-export-files.js';
import { extractTarArchive } from './tar-extract.js';
import { buildVectorMbtiles, type TileSource } from './vector-tiler.js';
import {
  PoolAbortedError,
  TaskFailedError,
  forEachConcurrent,
  withWorkerPool,
  type WorkerPool
} from './worker-pool.js';

export { CONVERSION_ABORTED_MESSAGE, COMPLETE_MARKER_PREFIX, EXPORT_ERROR_FILE_BASENAME };

// A cancelled pool rejects its tasks with PoolAbortedError; surface that as
// the one cancellation message callers know.
function asCancellation(err: unknown): unknown {
  return err instanceof PoolAbortedError ? new Error(CONVERSION_ABORTED_MESSAGE) : err;
}

const conversionProgress: ConversionProgressMap = {};
const MAX_LOG_LINES = MAX_CONVERSION_LOG_LINES;

let debug: DebugFunction = () => {};

export function initS57Converter(debugFn: DebugFunction): void {
  debug = debugFn || (() => {});
}

export function getConversionProgress(chartNumber: string): ConversionProgress | null {
  return conversionProgress[chartNumber] ?? null;
}

export function getAllConversionProgress(): ConversionProgressMap {
  return { ...conversionProgress };
}

export function setConversionFailed(chartNumber: string, message: string): void {
  setConversionResult(conversionProgress, chartNumber, 'failed', message);
}

/** Forget a conversion's progress and log, once its caller has kept what it needs. */
export function clearConversionProgress(chartNumber: string): void {
  delete conversionProgress[chartNumber];
}

export function setConversionCompleted(chartNumber: string, message: string): void {
  setConversionResult(conversionProgress, chartNumber, 'completed', message);
}

async function extractZip(zipPath: string, targetDir: string): Promise<string[]> {
  await fs
    .createReadStream(zipPath)
    .pipe(unzipper.Extract({ path: targetDir }))
    .promise();

  const allFiles: string[] = [];
  const scan = (dir: string): void => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        scan(fullPath);
      } else {
        allFiles.push(fullPath);
      }
    }
  };
  scan(targetDir);
  return allFiles;
}

function findEncFiles(dir: string): string[] {
  const files: string[] = [];
  const scan = (d: string): void => {
    const entries = fs.readdirSync(d, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(d, entry.name);
      if (entry.isDirectory()) {
        scan(fullPath);
      } else if (entry.name.endsWith('.000') && !entry.name.startsWith('._')) {
        files.push(fullPath);
      }
    }
  };
  scan(dir);
  return files;
}

/**
 * Keep one cell of each name. GDAL writes a cell's layers to files named
 * after the cell, so two copies of a cell (a folder beside its own ZIP, say)
 * would write the same files; the first copy found is kept.
 */
function uniqueCells(cells: readonly string[]): { kept: string[]; duplicates: string[] } {
  const seen = new Set<string>();
  const kept: string[] = [];
  const duplicates: string[] = [];
  for (const cell of cells) {
    const name = path.basename(cell).toUpperCase();
    if (seen.has(name)) {
      duplicates.push(cell);
    } else {
      seen.add(name);
      kept.push(cell);
    }
  }
  return { kept, duplicates };
}

function appendLog(chartNumber: string, text: string): void {
  if (!chartNumber || !text) {
    return;
  }
  if (!conversionProgress[chartNumber]) {
    conversionProgress[chartNumber] = { status: 'converting', message: '', log: [] };
  }
  const log = conversionProgress[chartNumber].log;
  const lines = text.split(/\r|\n/).filter((l) => l.trim());
  log.push(...lines);
  if (log.length > MAX_LOG_LINES) {
    log.splice(0, log.length - MAX_LOG_LINES);
  }
}

function setProgress(chartNumber: string, status: string, message: string): void {
  if (!chartNumber) {
    return;
  }
  if (!conversionProgress[chartNumber]) {
    conversionProgress[chartNumber] = { status, message, log: [] };
  } else {
    conversionProgress[chartNumber].status = status;
    conversionProgress[chartNumber].message = message;
  }
}

/** The sinks a toolchain reports `chartNumber`'s conversion through. */
function reporter(chartNumber: string): ConversionReport {
  return {
    log: (text) => {
      appendLog(chartNumber, text);
    },
    progress: (status, message) => {
      setProgress(chartNumber, status, message);
    },
    message: (text) => {
      if (chartNumber && conversionProgress[chartNumber]) {
        conversionProgress[chartNumber].message = text;
      }
    },
    debug: (msg) => {
      debug(msg);
    }
  };
}

/**
 * The toolchain for one conversion: `preset` when the caller chose already
 * (a chart set picks one for its whole run), otherwise the container one
 * when it can mount `mountPaths`, else the WebAssembly fallback. The choice
 * and any fallback reason go to the conversion log.
 */
async function pickBackend(
  chartNumber: string,
  preset: ConversionBackend | undefined,
  mountPaths: readonly string[],
  statusFn: StatusCallback
): Promise<ConversionBackend> {
  if (preset) {
    return preset;
  }
  const choice = await chooseConversionBackend({
    mountPaths,
    debug: (msg) => {
      debug(msg);
    },
    onCheckingImage: () => {
      statusFn('pulling', 'Checking container image...');
      setProgress(chartNumber, 'pulling', 'Checking charts-toolbox image...');
    }
  });
  const note = fallbackNote(choice);
  if (note) {
    debug(note);
    appendLog(chartNumber, note);
  }
  appendLog(chartNumber, `Conversion engine: ${describeBackend(choice.backend)}`);
  return choice.backend;
}

/**
 * The `name` metadata row the tiler writes into the output MBTiles, so the
 * file is born with a sensible name even when the post-conversion metadata
 * patch (best-effort, never throws) fails; the patch only ever refines it to
 * the cleaned catalog title.
 *
 * Mirrors the fallback the patcher uses (`S-57 <chartNumber>`) so an
 * un-patched file matches a patched one's `name` when no displayName exists.
 */
function wantedMbtilesName(chartNumber: string, displayName: string | undefined): string {
  const trimmed = displayName?.trim();
  return trimmed ? trimmed : `S-57 ${chartNumber || 'ENC'}`;
}

/**
 * Decide the on-disk `.mbtiles` filename for a freshly converted chart.
 *
 * Catalogs (NL_IENC, etc.) hand us sequential chart numbers like "1",
 * "2", "3" — meaningless when the user later sees `1.mbtiles` in their
 * chart directory.  When the catalog also supplied a human-friendly
 * `displayName` (cleanCatalogTitle output, e.g. "Waddenzee met Diepte
 * 2026 - Week 18"), use that as the filename basis instead.
 *
 * Falls back to `<chartNumber>.mbtiles` when no displayName is provided
 * (manual upload path) or sanitizes to nothing.  Suffixes a numeric
 * counter on collisions so re-running a conversion against the same
 * catalog entry doesn't overwrite an existing chart silently.
 */
export function chooseOutputFilename(opts: {
  chartsDir: string;
  displayName: string | undefined;
  chartNumber: string;
  fileExists?: (path: string) => boolean;
}): string {
  const exists = opts.fileExists ?? fs.existsSync;
  // Sanitize both inputs up-front: the chartNumber feeds both the base
  // (when displayName is absent) and the collision suffix.  A malformed
  // catalog with a chartNumber like "../../evil" would otherwise turn
  // the candidate into a path-traversal escape and write the .mbtiles
  // somewhere outside chartsDir.  Catalog values are typically integers
  // and pass sanitization unchanged, so this is a safety net rather
  // than a behaviour change.
  const sanitized = opts.displayName ? sanitizeChartFilename(opts.displayName) : '';
  const safeChartNumber = sanitizeChartFilename(opts.chartNumber);
  const base = sanitized || safeChartNumber || 'enc-chart';

  const candidate = `${base}.mbtiles`;
  if (!exists(path.join(opts.chartsDir, candidate))) {
    return candidate;
  }

  // Collision: try chartNumber-suffixed first (informative), then a counter.
  // Catalog flow re-runs against the same chartNumber are the common case,
  // so users immediately see "this is from chart entry 1, take 2" via
  // the suffix instead of getting `Waddenzee_met_Diepte_2026-Week_18-2.mbtiles`.
  if (sanitized && safeChartNumber && safeChartNumber !== sanitized) {
    const numbered = `${base}-${safeChartNumber}.mbtiles`;
    if (!exists(path.join(opts.chartsDir, numbered))) {
      return numbered;
    }
  }
  for (let i = 2; i < 1000; i += 1) {
    const counted = `${base}-${i}.mbtiles`;
    if (!exists(path.join(opts.chartsDir, counted))) {
      return counted;
    }
  }
  // Pathological: 1000 collisions.  Fall through to a timestamped name
  // so we never silently overwrite.
  return `${base}-${Date.now()}.mbtiles`;
}

/**
 * Export every layer of every cell to `<LAYER>__<cell>.geojson` in
 * `geojsonDir` (`<LAYER>.geojson` for a lone cell, unless `perCell`), one
 * cell per worker at a time. One unreadable layer or cell is logged, not
 * fatal: a 60-cell bundle still converts when one cell is damaged.
 *
 * With `perCell` (the chart-set cache, which keeps output per cell), every
 * output is named after its cell and each cell exported without an error
 * gets an empty `${COMPLETE_MARKER_PREFIX}<cell>` file, so a partial export
 * is never kept as complete.
 */
async function exportAllLayersToGeoJSON(
  encFiles: readonly string[],
  geojsonDir: string,
  chartNumber: string,
  pool: WorkerPool,
  onPercent?: (pct: number) => void,
  perCell = false
): Promise<void> {
  const multiFile = perCell || encFiles.length > 1;
  const errorLog = path.join(geojsonDir, EXPORT_ERROR_FILE_BASENAME);
  fs.writeFileSync(errorLog, '');
  let done = 0;
  await forEachConcurrent(encFiles, pool.size, async (cell) => {
    const name = path.basename(cell, path.extname(cell));
    let result;
    try {
      result = await pool.run({
        op: 's57-cell',
        cell,
        outDir: geojsonDir,
        multiFile,
        skipLayers: SKIP_LAYERS
      });
    } catch (err) {
      if (!(err instanceof TaskFailedError)) {
        throw err;
      }
      // The worker died on this cell (a GDAL abort); the pool replaced it.
      result = { files: 0, complete: false, errors: [...err.log, `${name}: ${err.message}`] };
    }
    done++;
    appendLog(chartNumber, `PROGRESS: Processing ${name} (${done}/${encFiles.length})`);
    setProgress(chartNumber, 'converting', `Exporting ${name}...`);
    onPercent?.((done / encFiles.length) * 100);
    if (result.errors.length > 0) {
      fs.appendFileSync(errorLog, result.errors.join('\n') + '\n');
    }
    if (perCell && result.complete) {
      fs.writeFileSync(path.join(geojsonDir, `${COMPLETE_MARKER_PREFIX}${name}`), '');
    }
  });

  // Per-cell failures don't fail the export, so finishing doesn't mean any
  // output landed. If nothing usable came out, surface a sample of what GDAL
  // reported, so the user sees the actual error instead of just the
  // downstream "No valid GeoJSON layers" message.
  surfaceExportErrorsIfEmpty(geojsonDir, chartNumber);
}

function surfaceExportErrorsIfEmpty(geojsonDir: string, chartNumber: string): void {
  for (const line of exportErrorReport(
    geojsonDir,
    'Check that the chart files are readable by the Signal K server.'
  )) {
    appendLog(chartNumber, line);
  }
}

/** A band's zoom range within the user's: the band's native scales, clamped. */
export function bandZoomRange(
  band: number | null,
  userMinzoom: number,
  userMaxzoom: number
): { minzoom: number; maxzoom: number } {
  if (band === null) {
    return { minzoom: userMinzoom, maxzoom: userMaxzoom };
  }
  return {
    minzoom: Math.max(userMinzoom, BAND_MIN_ZOOM[band] ?? userMinzoom),
    maxzoom: Math.min(userMaxzoom, BAND_MAX_ZOOM[band] ?? userMaxzoom)
  };
}

/**
 * Turn a directory of GDAL exports (`<LAYER>__<cell>.geojson[.gz]`, or
 * `<LAYER>.geojson` for a lone cell) into tiler sources: one per layer and
 * IHO band, shown at that band's zooms within the user's range. A band-5
 * harbour cell's features thus never crowd the overview zooms, and a band-2
 * cell's coarse coastline never draws over a harbour plan, in one pass over
 * the whole bundle. Cells whose names don't follow the IHO convention (IENC,
 * hand-named) use the user's range. Within it, a feature with a SCAMIN
 * starts at the zoom S-52 shows it at (s57-scamin.ts). Empty exports are
 * skipped.
 */
export function planTileSources(
  geojsonDir: string,
  userMinzoom: number,
  userMaxzoom: number
): TileSource[] {
  const sources = new Map<string, TileSource>();
  for (const file of fs.readdirSync(geojsonDir).sort()) {
    if (!file.endsWith('.geojson') && !file.endsWith('.geojson.gz')) {
      continue;
    }
    const fullPath = path.join(geojsonDir, file);
    if (geojsonContentSize(fullPath) <= 100) {
      continue;
    }
    const { layer, cell } = exportFileParts(file);
    const band = cell !== null ? detectEncBand(cell) : null;
    const { minzoom, maxzoom } = bandZoomRange(band, userMinzoom, userMaxzoom);
    if (minzoom > maxzoom) {
      continue;
    }
    const key = `${layer}/${String(minzoom)}/${String(maxzoom)}`;
    const source = sources.get(key) ?? { layer, minzoom, maxzoom, files: [], scamin: true };
    source.files.push(fullPath);
    sources.set(key, source);
  }
  return [...sources.values()];
}

export const _testInternals = {
  surfaceExportErrorsIfEmpty,
  uniqueCells,
  wantedMbtilesName,
  SKIP_LAYERS
};

/**
 * Run GDAL on every cell under `encDir`, writing one `<LAYER>__<cell>.geojson`
 * per layer and cell into `geojsonDir`, without making tiles. The chart-set
 * cache keeps this output per cell, so an update runs GDAL only on the cells
 * that changed. Progress and errors go to `chartNumber`'s conversion log.
 * `backend` is the toolchain the chart set's run chose, whose GDAL build keys
 * the cache; without it one is chosen here.
 */
export async function exportS57CellsToGeoJSON(
  encDir: string,
  geojsonDir: string,
  chartNumber: string,
  signal?: AbortSignal,
  backend?: ConversionBackend
): Promise<void> {
  const encFiles = findEncFiles(encDir);
  if (encFiles.length === 0) {
    throw new Error('No S-57 ENC files (.000) found in the chart data');
  }
  fs.mkdirSync(geojsonDir, { recursive: true });
  // A fresh log, so it holds only what this export reports.
  conversionProgress[chartNumber] = { status: 'converting', message: '', log: [] };
  const chosen = await pickBackend(chartNumber, backend, [encDir, geojsonDir], () => {});
  appendLog(chartNumber, `Exporting ${encFiles.length} changed cell(s) to GeoJSON...`);
  if (chosen === 'container') {
    await exportCellsInContainer(encDir, geojsonDir, chartNumber, reporter(chartNumber), {
      multiFile: true,
      perCell: true,
      signal
    });
    return;
  }
  try {
    await withWorkerPool(getCpuBudget().workersPerJob, signal, (pool) =>
      exportAllLayersToGeoJSON(encFiles, geojsonDir, chartNumber, pool, undefined, true)
    );
  } catch (err) {
    throw asCancellation(err);
  }
}

/**
 * Convert a directory tree of already-extracted S-57 ENC cells (`.000`
 * files, possibly nested) into a single vector MBTiles. This is the reusable
 * core of the conversion pipeline: `processS57Zip` extracts one ZIP and
 * delegates here, and the Custom Catalogs flow extracts many ENC archives
 * into one combined tree and converts it in a single pass so the output is
 * one `.mbtiles` per chart set.
 *
 * Two stages: GDAL exports each cell's layers to GeoJSON, then the tiles are
 * built with each IHO band at its own zooms. The container toolchain runs
 * GDAL and tippecanoe in the charts-toolbox image (s57-container.ts); its
 * WebAssembly fallback runs GDAL and the vector tiler on the conversion's
 * worker threads (see planTileSources). `options.backend` pins the
 * toolchain; otherwise conversion-backend.ts picks one.
 *
 * `encDir` is treated as read-only input. All conversion scratch is created
 * under `scratchParent` (defaulting to the parent of `encDir`) and removed on
 * the way out, so the caller's input tree is never mutated.
 */
export async function processS57Directory(
  encDir: string,
  chartsDir: string,
  chartNumber: string,
  onStatus: StatusCallback | null,
  options: S57ConversionOptions = {},
  scratchParent?: string
): Promise<S57ConversionResult> {
  const statusFn = onStatus ?? (() => {});
  const tmpDir = path.join(scratchParent ?? path.dirname(encDir), `s57out_${Date.now()}`);
  const geojsonDir = path.join(tmpDir, 'geojson');
  fs.mkdirSync(geojsonDir, { recursive: true });

  if (chartNumber) {
    conversionProgress[chartNumber] = {
      status: 'starting',
      message: 'Starting conversion...',
      log: []
    };
  }

  // Cooperative cancel between stages; the abort signal stops a stage
  // mid-way by killing its container job or terminating its workers.
  const abortIfRequested = (): void => {
    if (options.isAborted?.() || options.signal?.aborted) {
      throw new Error(CONVERSION_ABORTED_MESSAGE);
    }
  };

  try {
    const { kept: encFiles, duplicates } = uniqueCells(options.cells ?? findEncFiles(encDir));
    if (encFiles.length === 0) {
      throw new Error('No S-57 ENC files (.000) found in the chart data');
    }
    debug(`Found ${encFiles.length} ENC files`);
    appendLog(chartNumber, `Found ${encFiles.length} ENC files`);
    for (const cell of duplicates) {
      appendLog(chartNumber, `Skipping ${cell}: a cell of the same name is already included`);
    }

    const outputName = chooseOutputFilename({
      chartsDir,
      displayName: options.displayName,
      chartNumber
    });
    const outputPath = path.join(chartsDir, outputName);
    const backend = await pickBackend(chartNumber, options.backend, [tmpDir, chartsDir], statusFn);
    abortIfRequested();

    if (backend === 'container') {
      await tileS57InContainer({
        encFiles,
        tmpDir,
        outputPath,
        label: chartNumber || 'enc',
        mbtilesName: wantedMbtilesName(chartNumber, options.displayName),
        options,
        report: reporter(chartNumber),
        statusFn
      });
    } else {
      await tileS57WithWasm(
        encFiles,
        tmpDir,
        geojsonDir,
        outputPath,
        chartNumber,
        options,
        statusFn
      );
    }

    if (!fs.existsSync(outputPath)) {
      throw new Error('Tiling completed but output file not found');
    }

    // Set `type=S-57` so Signal K + chart consumers identify the file
    // correctly. The patcher logs to BOTH the conversion log (visible in the
    // UI) and server stdout, so a failure (sqlite locks, …) is never silent.
    const patchResult = await patchS57Mbtiles(outputPath, chartNumber, {
      onMessage: (msg) => {
        debug(msg);
        appendLog(chartNumber, msg);
      }
    });
    if (!patchResult.ok) {
      const banner = `[charts-provider] WARNING: ${patchResult.message} (${outputName})`;
      console.warn(banner);
    }

    // Optional second patch: when the caller (catalog flow) supplied a
    // human-friendly label, overwrite the `name` row that
    // patchS57Mbtiles just wrote with the cleaned catalog title, and set
    // `description` to the full original title for provenance. Manual
    // uploads leave displayName undefined and keep the patcher's
    // `S-57 <chartNumber>` default. Trim before both the guard and the
    // value so a whitespace-only label falls through to the fallback
    // instead of overwriting it with blanks (mirrors wantedMbtilesName).
    const displayName = options.displayName?.trim();
    if (displayName) {
      const dnResult = await setMbtilesDisplayName(
        outputPath,
        displayName,
        options.displayDescription,
        {
          onMessage: (msg) => {
            debug(msg);
            appendLog(chartNumber, msg);
          }
        }
      );
      if (!dnResult.ok) {
        const banner = `[charts-provider] WARNING: ${dnResult.message} (${outputName})`;
        console.warn(banner);
      }
    }

    const size = (fs.statSync(outputPath).size / (1024 * 1024)).toFixed(1);
    const doneMsg = `Created ${outputName} (${size} MB)`;
    statusFn('completed', doneMsg);
    appendLog(chartNumber, `Done: ${outputName} (${size} MB)`);

    if (chartNumber) {
      setConversionCompleted(chartNumber, doneMsg);
    }

    return { mbtilesFile: outputName };
  } catch (caught) {
    const err = asCancellation(caught);
    if (chartNumber) {
      setConversionFailed(
        chartNumber,
        (err instanceof Error ? err.message : String(err)) || 'Conversion failed'
      );
    }
    throw err;
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      debug(`Warning: failed to clean up ${tmpDir}`);
    }
  }
}

/**
 * Tile S-57 cells into `outputPath` with the WebAssembly toolchain: GDAL
 * exports each cell on the conversion's worker threads, then the vector
 * tiler builds every band in one pass.
 */
async function tileS57WithWasm(
  encFiles: readonly string[],
  tmpDir: string,
  geojsonDir: string,
  outputPath: string,
  chartNumber: string,
  options: S57ConversionOptions,
  statusFn: StatusCallback
): Promise<void> {
  const userMinzoom = options.minzoom ?? 9;
  const userMaxzoom = options.maxzoom ?? 16;
  const workers = getCpuBudget().workersPerJob;
  const emit = (stage: S57BucketProgress['stage'], bucketPercent: number): void => {
    options.onProgress?.({
      stage,
      bucketIndex: 1,
      bucketCount: 1,
      bucketLabel: 'Charts',
      bucketPercent
    });
  };
  await withWorkerPool(workers, options.signal, async (pool) => {
    statusFn('converting', 'Converting S-57 layers to GeoJSON...');
    emit('export', options.geojsonFor ? -1 : 0);
    if (options.geojsonFor) {
      appendLog(chartNumber, `Using the kept GeoJSON of ${encFiles.length} cell(s)`);
      await options.geojsonFor(encFiles, geojsonDir);
    } else {
      setProgress(chartNumber, 'converting', `Exporting ${encFiles.length} ENC files...`);
      appendLog(
        chartNumber,
        `Exporting ${encFiles.length} ENC file(s) with GDAL (WebAssembly), ${workers} worker(s)`
      );
      await exportAllLayersToGeoJSON(encFiles, geojsonDir, chartNumber, pool, (pct) => {
        emit('export', pct);
      });
    }
    if (options.isAborted?.() || options.signal?.aborted) {
      throw new Error(CONVERSION_ABORTED_MESSAGE);
    }

    const sources = planTileSources(geojsonDir, userMinzoom, userMaxzoom);
    if (sources.length === 0) {
      throw new Error('No valid GeoJSON layers to process');
    }
    logBandPlan(chartNumber, sources, userMinzoom, userMaxzoom);

    statusFn('converting', 'Generating vector tiles...');
    setProgress(chartNumber, 'converting', 'Generating vector tiles...');
    emit('tiles', 0);
    const result = await buildVectorMbtiles({
      sources,
      output: outputPath,
      scratchDir: path.join(tmpDir, 'tiles'),
      pool,
      name: wantedMbtilesName(chartNumber, options.displayName),
      description: options.displayDescription,
      signal: options.signal,
      log: (msg) => {
        appendLog(chartNumber, msg);
      },
      onPercent: (pct) => {
        if (chartNumber && conversionProgress[chartNumber]) {
          conversionProgress[chartNumber].message = `Generating tiles: ${pct}%`;
        }
        emit('tiles', pct);
      }
    });
    appendLog(
      chartNumber,
      `Wrote ${result.tiles} tiles (z${result.minzoom}-z${result.maxzoom}) from ${result.features} features`
    );
  });
}

/**
 * Log which layers show from which zoom, per band, so users can see why
 * low-zoom features differ by band. Counts plus a sample of layer names —
 * full lists would be noisy (a state bundle has ~40 layers per band).
 */
function logBandPlan(
  chartNumber: string,
  sources: readonly TileSource[],
  userMinzoom: number,
  userMaxzoom: number
): void {
  const byRange = new Map<string, Set<string>>();
  for (const s of sources) {
    const key = `z${s.minzoom}-z${s.maxzoom}`;
    const layers = byRange.get(key) ?? new Set<string>();
    layers.add(s.layer);
    byRange.set(key, layers);
  }
  appendLog(
    chartNumber,
    `Zoom plan (user requested z${userMinzoom}-z${userMaxzoom}, clamped per IHO band):`
  );
  for (const [range, layers] of [...byRange.entries()].sort()) {
    const list = [...layers];
    const sample = list.slice(0, 6).join(', ');
    const more = list.length > 6 ? ', …' : '';
    appendLog(chartNumber, `  ${range}: ${list.length} layers (${sample}${more})`);
  }
}

/**
 * Extract a single S-57 ENC ZIP into a scratch tree and convert it to one
 * vector MBTiles. Thin wrapper over {@link processS57Directory}: it owns the
 * ZIP-specific extraction step (and its "not a valid ZIP archive" error
 * surface), then hands the extracted `enc/` tree to the shared pipeline.
 */
export async function processS57Zip(
  zipPath: string,
  chartsDir: string,
  chartNumber: string,
  onStatus: StatusCallback | null,
  options: S57ConversionOptions = {}
): Promise<S57ConversionResult> {
  const statusFn = onStatus ?? (() => {});
  const tmpDir = path.join(path.dirname(zipPath), `s57_${Date.now()}`);
  const encDir = path.join(tmpDir, 'enc');
  fs.mkdirSync(encDir, { recursive: true });

  if (chartNumber) {
    conversionProgress[chartNumber] = {
      status: 'extracting',
      message: 'Extracting ENC files...',
      log: []
    };
  }

  try {
    statusFn('extracting', 'Extracting ENC files...');
    setProgress(chartNumber, 'extracting', 'Extracting ENC files...');
    let extracted: string[];
    try {
      extracted = await extractZip(zipPath, encDir);
    } catch (zipErr) {
      throw new Error(
        `Downloaded file is not a valid ZIP archive (${zipErr instanceof Error ? zipErr.message : String(zipErr)}). The server may have returned an error page instead.`,
        { cause: zipErr }
      );
    }
    debug(`Extracted ${extracted.length} files from ZIP`);

    if (extracted.length === 0) {
      throw new Error('No files found in ZIP archive');
    }

    // Delegate to the shared pipeline. `tmpDir` is the scratch parent, so the
    // pipeline's scratch lands alongside `enc/` and is cleaned up together
    // with it by the finally below.
    return await processS57Directory(encDir, chartsDir, chartNumber, onStatus, options, tmpDir);
  } catch (err) {
    // processS57Directory already records its own failures; this also covers
    // the extraction phase (invalid/empty ZIP) before delegation. Idempotent
    // — both land on the same terminal 'failed' state.
    if (chartNumber) {
      setConversionFailed(
        chartNumber,
        (err instanceof Error ? err.message : String(err)) || 'Conversion failed'
      );
    }
    throw err;
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      debug(`Warning: failed to clean up ${tmpDir}`);
    }
  }
}

/**
 * Convert the S-57 cells of a folder or ZIP on the server's disk (see
 * local-chart-source.ts) to one vector MBTiles. Its archives are extracted
 * under `workDir`, which the caller removes; the source is only read.
 */
export async function processS57Local(
  source: LocalChartSource,
  workDir: string,
  chartsDir: string,
  chartNumber: string,
  onStatus: StatusCallback | null,
  options: S57ConversionOptions = {}
): Promise<S57ConversionResult> {
  conversionProgress[chartNumber] = {
    status: 'extracting',
    message: 'Reading the chart folder...',
    log: []
  };
  let cells: string[];
  try {
    const found = await extractLocalChartSource(
      source,
      isS57Cell,
      workDir,
      (zip, index, count) => {
        const message = `Extracting ${path.basename(zip)} (${String(index)}/${String(count)})...`;
        onStatus?.('extracting', message);
        setProgress(chartNumber, 'extracting', message);
      },
      isS57Update,
      options.signal
    );
    const gathered = gatherCellUpdates(found.files, found.companions, workDir);
    cells = gathered.cells;
    if (gathered.withUpdates.length > 0) {
      appendLog(
        chartNumber,
        `Applying updates kept apart from their cells to ${gathered.withUpdates.join(', ')}`
      );
    }
  } catch (err) {
    if (options.signal?.aborted) {
      setConversionFailed(chartNumber, CONVERSION_ABORTED_MESSAGE);
      throw new Error(CONVERSION_ABORTED_MESSAGE, { cause: err });
    }
    setConversionFailed(
      chartNumber,
      `Extracting the ZIP files failed: ${err instanceof Error ? err.message : String(err)}`
    );
    throw err;
  }
  return processS57Directory(
    source.root,
    chartsDir,
    chartNumber,
    onStatus,
    { ...options, cells },
    workDir
  );
}

// Overview zooms below a basemap's native zoom: what gdaladdo's 2…256
// factors gave.
const BASEMAP_OVERVIEW_LEVELS = 8;

/**
 * Burn a land-polygon shapefile into a world raster (sand on sea blue) and
 * tile it into a PNG MBTiles at `outputPath`, with overview zooms.
 */
async function rasterizeLandToMbtiles(opts: {
  shp: string;
  workDir: string;
  outputPath: string;
  width: number;
  chartNumber: string;
  pool: WorkerPool;
}): Promise<void> {
  const { chartNumber, pool } = opts;
  const worldTif = path.join(opts.workDir, 'world.tif');
  const logGdal = (lines: readonly string[]): void => {
    for (const line of lines) {
      appendLog(chartNumber, line);
    }
  };

  appendLog(chartNumber, 'Rasterizing shapefile...');
  const rasterized = await pool.run({
    op: 'gdal-rasterize',
    source: { path: opts.shp },
    dst: worldTif,
    args: [
      '-burn',
      '240',
      '-burn',
      '230',
      '-burn',
      '208',
      '-init',
      '168',
      '-init',
      '212',
      '-init',
      '230',
      '-a_srs',
      'EPSG:4326',
      '-te',
      '-180',
      '-85.05',
      '180',
      '85.05',
      '-ts',
      String(opts.width),
      String(Math.round(opts.width / 2)),
      '-ot',
      'Byte',
      '-of',
      'GTiff',
      '-co',
      'COMPRESS=LZW',
      // For the high and full shapefile basemaps the raster is past 4 GB
      // uncompressed, and even compressed may outgrow a classic TIFF; GDAL
      // only switches to BigTIFF unasked when it can tell an uncompressed
      // file needs it.
      '-co',
      'BIGTIFF=IF_SAFER'
    ]
  });
  logGdal(rasterized.log);

  setProgress(chartNumber, 'converting', 'Creating MBTiles...');
  appendLog(chartNumber, 'Creating MBTiles...');
  const translated = await pool.run({
    op: 'gdal-translate',
    source: { path: worldTif },
    dst: opts.outputPath,
    args: ['-of', 'MBTiles', '-co', 'TILE_FORMAT=PNG']
  });
  logGdal(translated.log);

  setProgress(chartNumber, 'converting', 'Adding zoom levels...');
  appendLog(chartNumber, 'Adding overview zoom levels...');
  const added = await addRasterOverviews(opts.outputPath, BASEMAP_OVERVIEW_LEVELS, pool);
  appendLog(chartNumber, `Added ${added} overview tiles`);
}

/**
 * Rasterize a land shapefile into a basemap MBTiles with the toolchain
 * conversion-backend.ts picks for it.
 */
async function rasterizeLand(opts: {
  shp: string;
  workDir: string;
  outputPath: string;
  width: number;
  chartNumber: string;
  statusFn: StatusCallback;
}): Promise<void> {
  const { chartNumber } = opts;
  const backend = await pickBackend(
    chartNumber,
    undefined,
    [path.dirname(opts.shp), opts.workDir, path.dirname(opts.outputPath)],
    opts.statusFn
  );
  setProgress(chartNumber, 'converting', 'Rasterizing land polygons...');
  if (backend === 'container') {
    await rasterizeLandInContainer({ ...opts, label: chartNumber, report: reporter(chartNumber) });
    return;
  }
  await withWorkerPool(getCpuBudget().workersPerJob, undefined, (pool) =>
    rasterizeLandToMbtiles({ ...opts, pool })
  );
}

/** Overwrite metadata rows; best-effort. */
function setRasterMetadata(file: string, rows: Record<string, string>): void {
  try {
    const db = new DatabaseSync(file);
    try {
      db.exec('BEGIN');
      for (const [name, value] of Object.entries(rows)) {
        db.prepare('DELETE FROM metadata WHERE name = ?').run(name);
        db.prepare('INSERT INTO metadata (name, value) VALUES (?, ?)').run(name, value);
      }
      db.exec('COMMIT');
    } finally {
      db.close();
    }
  } catch {
    debug(`Warning: failed to set metadata of ${path.basename(file)}`);
  }
}

export async function processShpBasemap(
  tarPath: string,
  chartsDir: string,
  chartNumber: string,
  onStatus: StatusCallback | null
): Promise<S57ConversionResult> {
  const statusFn = onStatus ?? (() => {});
  const tmpDir = path.join(path.dirname(tarPath), `shpbasemap_${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  if (chartNumber) {
    conversionProgress[chartNumber] = {
      status: 'starting',
      message: 'Starting basemap conversion...',
      log: []
    };
  }

  try {
    setProgress(chartNumber, 'extracting', 'Extracting shapefiles...');
    appendLog(chartNumber, 'Extracting archive...');
    const extracted = await extractTarArchive(tarPath, tmpDir);

    const shapefiles = extracted
      .filter((f) => f.endsWith('.shp') && !path.basename(f).startsWith('._'))
      .sort();
    const landShp =
      shapefiles.find((f) => path.basename(f).includes('L1')) ??
      shapefiles.find((f) => path.basename(f).includes('land')) ??
      shapefiles[0];

    if (!landShp) {
      throw new Error('No .shp files found in archive');
    }

    debug(`Found shapefile: ${landShp}`);
    appendLog(chartNumber, `Found: ${path.basename(landShp)}`);

    const resMap: Record<string, { size: number; label: string }> = {
      basemap_c: { size: 8192, label: 'Crude' },
      basemap_l: { size: 16384, label: 'Low' },
      basemap_i: { size: 32768, label: 'Medium' },
      basemap_h: { size: 65536, label: 'High' },
      basemap_f: { size: 131072, label: 'Full' }
    };
    const res = resMap[chartNumber] ?? { size: 32768, label: 'Medium' };

    setProgress(chartNumber, 'converting', `Rasterizing (${res.label})...`);
    appendLog(chartNumber, `Rasterizing at ${res.size}px width...`);

    const outputName = `osm-basemap-${chartNumber.replace('basemap_', '')}.mbtiles`;
    const outputPath = path.join(chartsDir, outputName);

    await rasterizeLand({
      shp: landShp,
      workDir: tmpDir,
      outputPath,
      width: res.size,
      chartNumber,
      statusFn
    });

    setRasterMetadata(outputPath, {
      name: `OSM Basemap (${res.label})`,
      type: 'tilelayer',
      format: 'png'
    });

    const size = (fs.statSync(outputPath).size / (1024 * 1024)).toFixed(1);
    const doneMsg = `Basemap installed (${size} MB)`;
    statusFn('completed', doneMsg);
    appendLog(chartNumber, `Done: ${outputName} (${size} MB)`);

    if (chartNumber) {
      setConversionCompleted(chartNumber, doneMsg);
    }
    return { mbtilesFile: outputName };
  } catch (err) {
    if (chartNumber) {
      setConversionFailed(
        chartNumber,
        (err instanceof Error ? err.message : String(err)) || 'Conversion failed'
      );
    }
    throw err;
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}
