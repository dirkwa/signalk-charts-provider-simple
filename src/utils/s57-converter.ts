import https from 'https';
import fs from 'fs';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import unzipper from 'unzipper';
import { getCpuBudget } from './concurrency.js';
import {
  ensureImage as ensureContainerImage,
  resolveJobPaths,
  runJob as runContainerJob
} from './container-jobs.js';
import { getContainerManager } from './container-manager.js';
import {
  BAND_MAX_ZOOM,
  BAND_MIN_ZOOM,
  bandClampedMaxzoom,
  groupCellsByBand,
  highestBandForFiles
} from './s57-band.js';
import { patchS57Mbtiles, setMbtilesDisplayName } from './mbtiles-metadata.js';
import { sanitizeChartFilename } from './catalog-title.js';
import type {
  ConversionProgress,
  ConversionProgressMap,
  S57ConversionResult,
  S57ConversionOptions,
  StatusCallback,
  DebugFunction
} from '../types.js';

// Single combined image: GDAL + tippecanoe + tile-join + helpers.
// Replaced two upstream-pulled images (`osgeo/gdal:alpine-small-latest`
// + `ghcr.io/dirkwa/.../tippecanoe`) with one toolbox image so a fresh
// `signalk-container` host pays one image pull instead of two.  Pinned
// to an explicit `:VERSION` tag (the toolbox build workflow refuses to
// overwrite it), so the tag is permanent for any host that pulled it.
// Bumping = bump `docker/charts-toolbox/VERSION` AND this constant
// together; one-step refresh.
const CHARTS_TOOLBOX_IMAGE = 'ghcr.io/dirkwa/signalk-charts-provider-simple/charts-toolbox:1.0.0';

const conversionProgress: ConversionProgressMap = {};
const MAX_LOG_LINES = 100;

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
  conversionProgress[chartNumber] = {
    status: 'failed',
    message,
    log: conversionProgress[chartNumber]?.log ?? []
  };
  setTimeout(() => {
    delete conversionProgress[chartNumber];
  }, 300000);
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

interface ExportScriptOptions {
  multiFile: boolean;
  /** xargs -P fan-out for the per-layer ogr2ogr loop. 1 = sequential. */
  parallelism: number;
  skipLayers: string[];
  /**
   * Container path the input ENC files are reachable at.  Normally `/input`
   * for bind-mounted SignalK deployments where signalk-container can
   * subpath-bind the host filesystem.  When SignalK is on a named volume
   * the runtime layer mounts the whole volume at `/input` and this prefix
   * becomes `/input/<subPath>` to navigate to the actual ENC dir inside.
   * Defaults to `/input` for backwards compat with existing tests.
   */
  inputPrefix?: string;
  /** Container path the GeoJSON output dir is reachable at. */
  outputPrefix?: string;
}

// Path inside the container where per-file ogr2ogr stderr is captured.
// Without this, ogr2ogr failures get swallowed (they used to redirect to
// /dev/null) and a "the export ran but produced nothing" outcome is
// indistinguishable from "every chart failed for the same reason".
// Surfaced into the user-visible conversion log when zero output files
// land in /output.
const EXPORT_ERROR_FILE_BASENAME = '.export-errors.log';
/**
 * Container path the export script writes per-file ogr2ogr stderr to,
 * for the default `/output` mount.  The script computes the actual
 * path from `outputPrefix` so it stays correct when SignalK is on a
 * named volume that needs a `/output/<subPath>` prefix; this constant
 * still reflects the bind-mount default and is exported for tests.
 */
export const EXPORT_ERRORS_LOG = `/output/${EXPORT_ERROR_FILE_BASENAME}`;
const EXPORT_ERROR_SAMPLE_LINES = 10;

// Build the shell script that runs inside the GDAL container. Extracted as a
// pure function so it's testable and so the parallelism knob is visible.
//
// When parallelism > 1, the per-layer loop uses `xargs -P` and the per-layer
// body runs in a child shell that receives $enc, $name, $multi as positional
// args (so chart names with spaces / shell metacharacters can't escape into
// the command). When parallelism === 1, the script keeps the simpler
// sequential `for layer` form — same behaviour as before this option existed.
export function buildExportScript(opts: ExportScriptOptions): string {
  const skipPattern = opts.skipLayers.join('|');
  const parallel = Math.max(1, Math.floor(opts.parallelism));
  const multiBranch = opts.multiFile ? '${layer}_${name}' : '${layer}';
  const inDir = opts.inputPrefix ?? '/input';
  const outDir = opts.outputPrefix ?? '/output';
  const errLog = `${outDir}/${EXPORT_ERROR_FILE_BASENAME}`;

  if (parallel === 1) {
    return `
set -e
: > ${errLog}
count=$(find ${inDir} -name '*.000' ! -name '._*' -type f | wc -l)
i=0
find ${inDir} -name '*.000' ! -name '._*' -type f -print0 | while IFS= read -r -d '' enc; do
  i=$((i + 1))
  name=$(basename "$enc" .000)
  echo "PROGRESS: Processing $name ($i/$count)"
  layers=$(ogrinfo -so "$enc" 2>>${errLog} | grep -E '^[0-9]+:' | awk -F': ' '{print $2}' | awk '{print $1}')
  for layer in $layers; do
    case "$layer" in ${skipPattern}) continue ;; esac
    outname="${multiBranch}"
    if [ "$layer" = "SOUNDG" ]; then
      ogr2ogr -f GeoJSON -oo SPLIT_MULTIPOINT=YES -oo ADD_SOUNDG_DEPTH=YES \\
        "${outDir}/$outname.geojson" "$enc" "$layer" 2>>${errLog} || true
    else
      ogr2ogr -f GeoJSON "${outDir}/$outname.geojson" "$enc" "$layer" 2>>${errLog} || true
    fi
  done
done
echo "PROGRESS: Export complete"
`;
  }

  // Parallel branch: fan out per-layer ogr2ogr via xargs -P.
  // The inner sh -c receives layer / enc / name / multi as positional args
  // so we don't smuggle untrusted strings through shell quoting.
  const multiArg = opts.multiFile ? '1' : '0';
  return `
set -e
: > ${errLog}
count=$(find ${inDir} -name '*.000' ! -name '._*' -type f | wc -l)
i=0
find ${inDir} -name '*.000' ! -name '._*' -type f -print0 | while IFS= read -r -d '' enc; do
  i=$((i + 1))
  name=$(basename "$enc" .000)
  echo "PROGRESS: Processing $name ($i/$count)"
  layers=$(ogrinfo -so "$enc" 2>>${errLog} | grep -E '^[0-9]+:' | awk -F': ' '{print $2}' | awk '{print $1}')
  printf '%s\\n' $layers | xargs -P ${parallel} -I '{}' sh -c '
    layer="$1"
    enc="$2"
    name="$3"
    multi="$4"
    case "$layer" in ${skipPattern}) exit 0 ;; esac
    if [ "$multi" = "1" ]; then outname="\${layer}_\${name}"; else outname="$layer"; fi
    if [ "$layer" = "SOUNDG" ]; then
      ogr2ogr -f GeoJSON -oo SPLIT_MULTIPOINT=YES -oo ADD_SOUNDG_DEPTH=YES \\
        "${outDir}/\${outname}.geojson" "$enc" "$layer" 2>>${errLog} || true
    else
      ogr2ogr -f GeoJSON "${outDir}/\${outname}.geojson" "$enc" "$layer" 2>>${errLog} || true
    fi
  ' _ '{}' "$enc" "$name" "${multiArg}"
done
echo "PROGRESS: Export complete"
`;
}

async function exportAllLayersToGeoJSON(
  encDir: string,
  encFiles: string[],
  geojsonDir: string,
  chartNumber: string
): Promise<void> {
  const skipLayers = ['DSID', 'C_AGGR', 'C_ASSO', 'Generic'];
  const multiFile = encFiles.length > 1;
  const parallelism = getCpuBudget().gdalExportParallelism;

  // Translate the absolute host paths into (source, subPath) pairs the
  // signalk-container runtime layer can mount.  The subPath is non-empty
  // when SignalK is on a named volume that covers a parent directory;
  // in that case we mount the whole volume at /input or /output and the
  // export script reads from /input/<subPath>, writes to /output/<subPath>.
  const resolved = await resolveJobPaths({ '/input': encDir, '/output': geojsonDir }, (cp, ap) =>
    appendLog(
      chartNumber,
      `Cannot mount ${cp} ← ${ap}: path is not reachable from the SignalK container runtime.`
    )
  );
  if (!resolved) {
    throw new Error(
      'Chart conversion paths are not reachable from the container runtime. ' +
        'Move the chart directory under app.getDataDirPath() or extend the SignalK ' +
        'container bind/volume to cover it.'
    );
  }

  const inputPrefix = resolved['/input'].subPath
    ? `/input/${resolved['/input'].subPath}`
    : '/input';
  const outputPrefix = resolved['/output'].subPath
    ? `/output/${resolved['/output'].subPath}`
    : '/output';

  const script = buildExportScript({
    multiFile,
    parallelism,
    skipLayers,
    inputPrefix,
    outputPrefix
  });

  const result = await runContainerJob({
    image: CHARTS_TOOLBOX_IMAGE,
    label: `gdal-export-${chartNumber}`,
    // bash, not sh.  The toolbox image's `/bin/sh` is dash on
    // Ubuntu, which doesn't accept `read -r -d ''` (a bash-ism we
    // use to consume `find -print0` output safely).  Earlier alpine
    // images linked `/bin/sh` to BusyBox `ash`, which did accept
    // `-d` — that's why the script worked there and silently
    // failed here with `sh: read: Illegal option -d` once the
    // converter switched to the toolbox image.  The toolbox image
    // ships bash 5.x at `/usr/bin/bash`; invoking via PATH lookup
    // works the same way `sh` did.
    command: ['bash', '-c', script],
    inputs: { '/input': resolved['/input'].source },
    outputs: { '/output': resolved['/output'].source },
    // Cap the helper at the budgeted parallelism — without this the
    // xargs -P fan-out can saturate every core regardless of the
    // budget setting.  gdalExportParallelism mirrors what we already
    // pass to xargs, so this just enforces the same ceiling at the
    // kernel cgroup level.
    resources: { cpus: parallelism },
    onStdoutLine: (line) => {
      appendLog(chartNumber, line);
      const match = line.match(/PROGRESS: Processing (\S+)/);
      if (match?.[1]) {
        setProgress(chartNumber, 'converting', `Exporting ${match[1]}...`);
      }
    },
    onStderrLine: (line) => appendLog(chartNumber, line)
  });

  if (result.exitCode !== 0) {
    throw new Error(`GDAL export failed with exit code ${result.exitCode}`);
  }

  // The export script swallows non-zero exits from per-file ogr2ogr calls
  // (one bad chart shouldn't kill a 60-chart bundle), so a clean exit
  // doesn't mean any output landed. If nothing usable came out, surface
  // a sample of the per-file stderr the script captured, so the user
  // sees the actual GDAL error instead of just the downstream
  // "No valid GeoJSON layers" message.
  surfaceExportErrorsIfEmpty(geojsonDir, chartNumber);
}

function surfaceExportErrorsIfEmpty(geojsonDir: string, chartNumber: string): void {
  let hasUsableOutput = false;
  try {
    for (const f of fs.readdirSync(geojsonDir)) {
      if (!f.endsWith('.geojson')) {
        continue;
      }
      if (fs.statSync(path.join(geojsonDir, f)).size > 100) {
        hasUsableOutput = true;
        break;
      }
    }
  } catch {
    return;
  }
  if (hasUsableOutput) {
    return;
  }

  const errorFile = path.join(geojsonDir, EXPORT_ERROR_FILE_BASENAME);
  let raw: string;
  try {
    raw = fs.readFileSync(errorFile, 'utf8');
  } catch {
    appendLog(
      chartNumber,
      'GDAL export produced no usable layers and no per-file errors were captured. ' +
        'This usually means the GDAL container could not read /input — check chart-path host bind mounts and SELinux/AppArmor labels.'
    );
    return;
  }
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) {
    appendLog(
      chartNumber,
      'GDAL export produced no usable layers and the captured error log was empty.'
    );
    return;
  }
  appendLog(
    chartNumber,
    `GDAL export ran but produced no usable GeoJSON layers. First ${Math.min(EXPORT_ERROR_SAMPLE_LINES, lines.length)} of ${lines.length} captured ogr2ogr/ogrinfo error line(s):`
  );
  for (const line of lines.slice(0, EXPORT_ERROR_SAMPLE_LINES)) {
    appendLog(chartNumber, `  ${line}`);
  }
  if (lines.length > EXPORT_ERROR_SAMPLE_LINES) {
    appendLog(
      chartNumber,
      `  ... ${lines.length - EXPORT_ERROR_SAMPLE_LINES} more error line(s) suppressed.`
    );
  }
}

// One row per merged layer. `sourceFiles` are the per-chart GeoJSON filenames
// (basenames, e.g. 'HRBFAC_US5MA1SK.geojson') that fed the merge — kept for
// caller diagnostics (per-band log line). Per-feature minzoom is already
// stamped onto features inside the merged file via `tippecanoe.minzoom`.
type ConsolidatedLayer = { file: string; sourceFiles: string[] };

// Group per-chart-per-layer GeoJSON files into one merged file per layer.
// Tippecanoe runs faster with fewer -L args (one merged file per layer) than
// with N×M args (one per chart × layer). Streams the output so a multi-state
// bundle's largest layer doesn't have to fit in memory at once.
//
// Each emitted feature carries a `tippecanoe.minzoom` extension property
// derived from its source chart's IHO band: tippecanoe respects the
// per-feature `tippecanoe.minzoom` extension and won't emit the feature
// below that zoom. (Tippecanoe's `-L` JSON form does NOT support per-layer
// minzoom — silently ignored — so we MUST set it per-feature.) Source
// charts that don't follow the IHO Annex E filename convention (IENC,
// hand-named) get no extension property and fall back to the global `-Z`.
function consolidateGeoJSONByLayer(geojsonDir: string, userMinzoom: number): ConsolidatedLayer[] {
  const files = fs.readdirSync(geojsonDir).filter((f) => f.endsWith('.geojson'));

  // Group by layer name. The export script writes 'LAYER_CHART.geojson' for
  // multi-chart bundles and 'LAYER.geojson' for single-chart. Many S-57 layer
  // names contain underscores (M_COVR, M_QUAL, M_NPUB, M_NSYS, M_PROP, …),
  // and S-57 layer names are uppercase letters and underscores only — no
  // digits. NOAA chart IDs (US3CO100, US5MA1SK) always contain digits. So
  // strip the trailing '_<id>' suffix only when that tail looks like a chart
  // ID (contains a digit); otherwise the basename is already the layer name.
  const layerGroups = new Map<string, string[]>();
  for (const file of files) {
    const fullPath = path.join(geojsonDir, file);
    if (fs.statSync(fullPath).size <= 100) {
      continue;
    }
    const base = path.basename(file, '.geojson');
    const underscore = base.lastIndexOf('_');
    const tailLooksLikeChartId = underscore !== -1 && /\d/.test(base.slice(underscore + 1));
    const layer = tailLooksLikeChartId ? base.slice(0, underscore) : base;
    const list = layerGroups.get(layer) ?? [];
    list.push(file);
    layerGroups.set(layer, list);
  }

  const mergedDir = path.join(geojsonDir, '.merged');
  fs.mkdirSync(mergedDir, { recursive: true });

  const consolidated: ConsolidatedLayer[] = [];
  for (const [layer, sources] of layerGroups) {
    const out = path.join(mergedDir, `${layer}.geojson`);
    const handle = fs.openSync(out, 'w');
    fs.writeSync(handle, '{"type":"FeatureCollection","features":[\n');
    let first = true;
    for (const source of sources) {
      // Per-source-chart band → per-feature minzoom. Files in this source
      // share a band because they all come from the same chart cell, so the
      // band lookup is one-shot per source file.
      const band = highestBandForFiles([source]);
      const bandFloor = band !== null ? BAND_MIN_ZOOM[band] : null;
      const featureMinzoom = bandFloor !== null ? Math.max(userMinzoom, bandFloor) : null;

      let parsed: { features?: unknown[] };
      try {
        parsed = JSON.parse(fs.readFileSync(path.join(geojsonDir, source), 'utf8')) as {
          features?: unknown[];
        };
      } catch {
        continue;
      }
      const features = parsed.features ?? [];
      for (const feat of features) {
        if (!first) {
          fs.writeSync(handle, ',\n');
        }
        const flattened = flattenListProperties(feat);
        const stamped =
          featureMinzoom !== null ? withTippecanoeMinzoom(flattened, featureMinzoom) : flattened;
        fs.writeSync(handle, JSON.stringify(stamped));
        first = false;
      }
    }
    fs.writeSync(handle, '\n]}\n');
    fs.closeSync(handle);
    consolidated.push({ file: out, sourceFiles: sources });
  }

  return consolidated;
}

// MVT properties must be scalar (string|number|bool). GDAL emits S-57 list
// attributes (COLOUR, STATUS, COLPAT, CATLIT, CATSPM, …) as JSON arrays;
// tippecanoe then stringifies them as `["3"]`, which client decoders that
// split on `,` can't read. Convert arrays to comma-separated strings so
// downstream code can treat them uniformly.
function flattenListProperties(feature: unknown): unknown {
  if (typeof feature !== 'object' || feature === null) {
    return feature;
  }
  const f = feature as Record<string, unknown>;
  const props = f.properties;
  if (typeof props !== 'object' || props === null) {
    return feature;
  }
  const p = props as Record<string, unknown>;
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p)) {
    if (Array.isArray(v)) {
      out[k] = v.join(',');
      changed = true;
    } else {
      out[k] = v;
    }
  }
  return changed ? { ...f, properties: out } : feature;
}

// Stamp tippecanoe.minzoom on a single feature without mutating the input.
// Preserves any existing `tippecanoe` extension fields if the source already
// set them (rare for ogr2ogr output, but harmless to support).
function withTippecanoeMinzoom(feature: unknown, minzoom: number): unknown {
  if (typeof feature !== 'object' || feature === null) {
    return feature;
  }
  const f = feature as Record<string, unknown>;
  const existing =
    typeof f.tippecanoe === 'object' && f.tippecanoe !== null
      ? (f.tippecanoe as Record<string, unknown>)
      : {};
  return { ...f, tippecanoe: { ...existing, minzoom } };
}

// Build tippecanoe `-L NAME:FILE` args (the simple form). Per-layer minzoom
// is *not* settable via `-L` JSON — tippecanoe silently ignores `minzoom`
// fields there. Per-band minzoom is therefore stamped onto each feature in
// the consolidator (see `consolidateGeoJSONByLayer`), and tippecanoe honors
// `feature.tippecanoe.minzoom` natively. This function is just the
// container-relative path stitching.
//
// `inputPrefix` defaults to `/input` for backwards compat with existing
// tests; it changes to `/input/<subPath>` when SignalK is on a named
// volume that covers a parent dir of the merged-GeoJSON scratch.
function buildLayerArgs(
  layers: readonly ConsolidatedLayer[],
  inputPrefix: string = '/input'
): string[] {
  const args: string[] = [];
  for (const { file } of layers) {
    const rel = path.basename(file);
    const layer = path.basename(rel, '.geojson');
    args.push('-L', `${layer}:${inputPrefix}/${rel}`);
  }
  return args;
}

export const _testInternals = {
  consolidateGeoJSONByLayer,
  buildExportScript,
  bandClampedMaxzoom,
  buildLayerArgs,
  surfaceExportErrorsIfEmpty
};

async function runTippecanoe(
  geojsonDir: string,
  outputMbtiles: string,
  chartNumber: string,
  options: S57ConversionOptions = {}
): Promise<void> {
  const minzoom = options.minzoom ?? 9;
  const maxzoom = options.maxzoom ?? 16;

  // Merge per-chart-per-layer GeoJSON into one file per layer before invoking
  // tippecanoe. A typical NOAA bundle of 4 charts × ~30 layers used to mean
  // 120 -L args; consolidating drops that to ~30 and cuts tippecanoe's I/O
  // setup proportionally.
  const mergedLayers = consolidateGeoJSONByLayer(geojsonDir, minzoom);
  if (mergedLayers.length === 0) {
    throw new Error('No valid GeoJSON layers to process');
  }
  const mergedDir = path.dirname(mergedLayers[0].file);
  const outputDirHost = path.dirname(outputMbtiles);

  // Translate the absolute host paths into (source, subPath) pairs
  // that signalk-container can mount, regardless of how SignalK is
  // deployed.  See exportAllLayersToGeoJSON for the same pattern.
  const resolved = await resolveJobPaths(
    { '/input': mergedDir, '/output': outputDirHost },
    (cp, ap) =>
      appendLog(
        chartNumber,
        `Cannot mount ${cp} ← ${ap}: path is not reachable from the SignalK container runtime.`
      )
  );
  if (!resolved) {
    throw new Error(
      'Tippecanoe input/output paths are not reachable from the container runtime. ' +
        'Move the chart directory under app.getDataDirPath() or extend the SignalK ' +
        'container bind/volume to cover it.'
    );
  }
  const inputPrefix = resolved['/input'].subPath
    ? `/input/${resolved['/input'].subPath}`
    : '/input';
  const outputPrefix = resolved['/output'].subPath
    ? `/output/${resolved['/output'].subPath}`
    : '/output';
  const layerArgs = buildLayerArgs(mergedLayers, inputPrefix);

  // Log per-band layer breakdown so users can see why low-zoom features differ
  // by band. Counts plus a sample of layer names — full lists would be noisy
  // (a state bundle has ~40 layers per band).
  const byBand = new Map<number | null, string[]>();
  for (const { file, sourceFiles } of mergedLayers) {
    const b = highestBandForFiles(sourceFiles);
    const layer = path.basename(file, '.geojson');
    const list = byBand.get(b) ?? [];
    list.push(layer);
    byBand.set(b, list);
  }
  const sortedBands = [...byBand.entries()].sort(
    ([a], [b]) => (a ?? Number.POSITIVE_INFINITY) - (b ?? Number.POSITIVE_INFINITY)
  );
  for (const [band, layers] of sortedBands) {
    const floor = band !== null ? BAND_MIN_ZOOM[band] : minzoom;
    const effectiveFloor = Math.max(minzoom, floor);
    const sample = layers.slice(0, 6).join(', ');
    const more = layers.length > 6 ? `, …` : '';
    appendLog(
      chartNumber,
      `Band ${band ?? 'unknown'}: ${layers.length} layers from z${effectiveFloor} (${sample}${more})`
    );
  }

  const tippecanoeThreads = getCpuBudget().tippecanoeThreadsPerJob;
  debug(
    `Running tippecanoe with ${layerArgs.length / 2} consolidated layers, zoom ${minzoom}-${maxzoom}, ${tippecanoeThreads} threads`
  );

  const handleTippecanoeLine = (line: string): void => {
    appendLog(chartNumber, line);
    const match = line.match(/(\d+(?:\.\d+)?)%/);
    if (match && chartNumber && conversionProgress[chartNumber]) {
      const pct = parseFloat(match[1]);
      conversionProgress[chartNumber].message = `Generating tiles: ${Math.round(pct)}%`;
    }
  };

  const result = await runContainerJob({
    image: CHARTS_TOOLBOX_IMAGE,
    label: `tippecanoe-${chartNumber}`,
    command: [
      'tippecanoe',
      '-o',
      `${outputPrefix}/${path.basename(outputMbtiles)}`,
      '-z',
      String(maxzoom),
      '-Z',
      String(minzoom),
      '--no-tile-size-limit',
      '--no-feature-limit',
      '--detect-shared-borders',
      // Preserve coastline detail end-to-end. Tippecanoe's defaults aggressively
      // simplify and drop tiny polygons at high zooms, which destroys the
      // coastline indentations that define marina basins, inland lagoons, and
      // narrow harbour features. Empirically the basin-as-land issue some NOAA
      // bundles exhibit at z16 (Michigan City Outer Basin, Lake Worth) goes
      // away when these defaults are off — the basin coastline is in the
      // source data, simplification was destroying it. Larger tile buffer
      // (80, default 5) keeps polygon edges that hug a tile boundary intact.
      '--no-simplification',
      '--no-tiny-polygon-reduction',
      '--buffer=80',
      '--force',
      ...layerArgs
    ],
    inputs: { '/input': resolved['/input'].source },
    outputs: { '/output': resolved['/output'].source },
    env: { TIPPECANOE_MAX_THREADS: String(tippecanoeThreads) },
    // Cap the helper at the budgeted thread count.  Without this the
    // env var only limits tippecanoe's worker threads — the kernel
    // scheduler still gives each worker its own core, so on a multi-
    // core box "half" budget feels indistinguishable from "all".
    resources: { cpus: tippecanoeThreads },
    onStdoutLine: handleTippecanoeLine,
    onStderrLine: handleTippecanoeLine
  });

  if (result.exitCode !== 0) {
    throw new Error(`tippecanoe failed with exit code ${result.exitCode}`);
  }

  // Best-effort cleanup of the merged dir.
  try {
    fs.rmSync(mergedDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

/**
 * Run `tile-join` over a list of per-band intermediate `.mbtiles` files
 * to produce the final, single output `.mbtiles`. Layers with the same
 * name across inputs are merged (default tile-join behaviour); per-band
 * minzoom regimes are preserved because each input was tippecanoe'd
 * with its own `-Z` so its tiles only exist at zooms ≥ that band's
 * floor.
 *
 * `--no-tile-size-limit` mirrors the per-band tippecanoe flag so a
 * mid-zoom band with bursty feature density doesn't get its tiles
 * truncated post-hoc by tile-join.
 */
async function runTileJoin(
  inputMbtiles: readonly string[],
  outputMbtiles: string,
  chartNumber: string
): Promise<void> {
  if (inputMbtiles.length === 0) {
    throw new Error('runTileJoin called with no inputs');
  }
  if (inputMbtiles.length === 1) {
    // Degenerate case — runPerBandPipeline can legitimately end up
    // here when every band but one was skipped (user maxzoom below the
    // remaining bands' floors). Move the single intermediate into
    // place so the rest of the pipeline doesn't have to special-case.
    // Fall back to copy+unlink across filesystems (chartPath on a USB
    // mount is the realistic case where rename returns EXDEV).
    try {
      fs.renameSync(inputMbtiles[0], outputMbtiles);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EXDEV') {
        throw err;
      }
      fs.copyFileSync(inputMbtiles[0], outputMbtiles);
      fs.unlinkSync(inputMbtiles[0]);
    }
    return;
  }

  // All intermediate `.mbtiles` live in the per-conversion tmpDir; the
  // final output lands in `chartsDir` (in-progress quarantine subdir).
  // These are always distinct, so we mount `/input` (intermediates,
  // read-only) and `/output` (final mbtiles) separately.
  const inputDir = path.dirname(inputMbtiles[0]);
  const outputDir = path.dirname(outputMbtiles);
  for (const f of inputMbtiles) {
    if (path.dirname(f) !== inputDir) {
      throw new Error(`tile-join inputs must share a parent dir: ${f}`);
    }
  }

  const resolved = await resolveJobPaths({ '/input': inputDir, '/output': outputDir }, (cp, ap) =>
    appendLog(
      chartNumber,
      `Cannot mount ${cp} ← ${ap}: path is not reachable from the SignalK container runtime.`
    )
  );
  if (!resolved) {
    throw new Error(
      'tile-join paths are not reachable from the container runtime. ' +
        'Move the chart directory under app.getDataDirPath() or extend the SignalK ' +
        'container bind/volume to cover it.'
    );
  }
  const inputPrefix = resolved['/input'].subPath
    ? `/input/${resolved['/input'].subPath}`
    : '/input';
  const outputPrefix = resolved['/output'].subPath
    ? `/output/${resolved['/output'].subPath}`
    : '/output';

  const inputArgs = inputMbtiles.map((f) => `${inputPrefix}/${path.basename(f)}`);
  const tippecanoeThreads = getCpuBudget().tippecanoeThreadsPerJob;

  appendLog(
    chartNumber,
    `Joining ${inputMbtiles.length} per-band tile sets into ${path.basename(outputMbtiles)}...`
  );
  debug(`Running tile-join on ${inputMbtiles.length} inputs`);

  const handleTileJoinLine = (line: string): void => {
    appendLog(chartNumber, line);
  };

  const result = await runContainerJob({
    image: CHARTS_TOOLBOX_IMAGE,
    label: `tile-join-${chartNumber}`,
    command: [
      'tile-join',
      '-o',
      `${outputPrefix}/${path.basename(outputMbtiles)}`,
      '--no-tile-size-limit',
      '--force',
      ...inputArgs
    ],
    inputs: { '/input': resolved['/input'].source },
    outputs: { '/output': resolved['/output'].source },
    env: { TIPPECANOE_MAX_THREADS: String(tippecanoeThreads) },
    resources: { cpus: tippecanoeThreads },
    onStdoutLine: handleTileJoinLine,
    onStderrLine: handleTileJoinLine
  });

  if (result.exitCode !== 0) {
    throw new Error(`tile-join failed with exit code ${result.exitCode}`);
  }
}

/**
 * Per-band orchestrator: bucket the cells, run a separate
 * export → consolidate → tippecanoe pipeline for each band into its
 * own intermediate `.mbtiles`, then `tile-join` them into the final
 * output. Bands with no cells in the bundle are skipped.
 *
 * For the unbanded bucket (cells whose filenames don't match the IHO
 * Annex E convention — IENC, hand-named, custom producers) we run the
 * same single-pass tippecanoe the legacy code path used, with the
 * user-requested -Z/-z; that intermediate joins the rest at the end.
 *
 * The win over single-pass is that each band's tippecanoe drop /
 * coalesce / simplification heuristics see only same-scale features:
 * a sparse band-3 cell can no longer push a dense band-5 harbour cell
 * into the drop-densest pass, and per-band tile-size budgets stop
 * one band from squeezing another's tiles.
 */
async function runPerBandPipeline(
  encDir: string,
  encFiles: readonly string[],
  tmpDir: string,
  chartNumber: string,
  options: S57ConversionOptions,
  outputMbtiles: string
): Promise<void> {
  const grouping = groupCellsByBand(encFiles);
  const userMinzoom = options.minzoom ?? 9;
  const userMaxzoom = options.maxzoom ?? 16;

  appendLog(
    chartNumber,
    `Per-band pipeline: bands=[${grouping.bands.join(', ')}]` +
      (grouping.unbanded.length > 0 ? ` + ${grouping.unbanded.length} unbanded cell(s)` : '')
  );

  const intermediates: string[] = [];
  let bandIndex = 0;
  const totalBuckets = grouping.bands.length + (grouping.unbanded.length > 0 ? 1 : 0);

  for (const band of grouping.bands) {
    bandIndex += 1;
    const cells = grouping.byBand.get(band) ?? [];
    const bandFloor = BAND_MIN_ZOOM[band] ?? userMinzoom;
    const bandCeiling = BAND_MAX_ZOOM[band] ?? userMaxzoom;
    const bandMinzoom = Math.max(userMinzoom, bandFloor);
    const bandMaxzoom = Math.min(userMaxzoom, bandCeiling);

    if (bandMinzoom > bandMaxzoom) {
      // User asked for z<bandFloor, which leaves this band with an
      // empty zoom range. Skip — tippecanoe would error and the band
      // wouldn't contribute anything visible anyway.
      appendLog(
        chartNumber,
        `Band ${band}: skipped (user maxzoom z${userMaxzoom} below band floor z${bandFloor})`
      );
      continue;
    }

    const bandEncDir = path.join(tmpDir, `enc-band-${band}`);
    const bandGeojsonDir = path.join(tmpDir, `geojson-band-${band}`);
    fs.mkdirSync(bandEncDir, { recursive: true });
    fs.mkdirSync(bandGeojsonDir, { recursive: true });

    // Hardlink each cell into the band-scoped dir so the export
    // script (which walks `find <inDir> -name '*.000'`) only sees
    // this band's cells.  Hardlinks keep IO cheap (no data copy)
    // and — unlike symlinks — survive being bind-mounted into a
    // container: a symlink target pointing at an absolute host
    // path doesn't exist inside the container's filesystem
    // namespace, so `find` would silently miss every cell.  Copy
    // is the fallback for the rare case where tmpDir spans
    // filesystems (e.g. /tmp on tmpfs but the encDir on disk).
    for (const cellPath of cells) {
      const cellRel = path.relative(encDir, cellPath);
      const linkPath = path.join(bandEncDir, cellRel);
      fs.mkdirSync(path.dirname(linkPath), { recursive: true });
      try {
        fs.linkSync(cellPath, linkPath);
      } catch {
        fs.copyFileSync(cellPath, linkPath);
      }
    }

    const bucketProgressPrefix = `[band ${band} ${bandIndex}/${totalBuckets}]`;
    setProgress(
      chartNumber,
      'converting',
      `${bucketProgressPrefix} Exporting ${cells.length} cell(s)...`
    );
    appendLog(
      chartNumber,
      `${bucketProgressPrefix} Exporting ${cells.length} cell(s) to GeoJSON...`
    );
    await exportAllLayersToGeoJSON(bandEncDir, cells, bandGeojsonDir, chartNumber);

    setProgress(
      chartNumber,
      'converting',
      `${bucketProgressPrefix} Generating tiles z${bandMinzoom}-z${bandMaxzoom}...`
    );
    appendLog(chartNumber, `${bucketProgressPrefix} Tippecanoe z${bandMinzoom}-z${bandMaxzoom}`);
    const bandMbtiles = path.join(tmpDir, `band-${band}.mbtiles`);
    await runTippecanoe(bandGeojsonDir, bandMbtiles, chartNumber, {
      ...options,
      minzoom: bandMinzoom,
      maxzoom: bandMaxzoom
    });
    intermediates.push(bandMbtiles);
  }

  if (grouping.unbanded.length > 0) {
    bandIndex += 1;
    const unbandedEncDir = path.join(tmpDir, 'enc-unbanded');
    const unbandedGeojsonDir = path.join(tmpDir, 'geojson-unbanded');
    fs.mkdirSync(unbandedEncDir, { recursive: true });
    fs.mkdirSync(unbandedGeojsonDir, { recursive: true });
    // Hardlink (not symlink) — see the band-loop above for the
    // why: bind-mounted absolute symlink targets don't resolve
    // inside the helper container.
    for (const cellPath of grouping.unbanded) {
      const cellRel = path.relative(encDir, cellPath);
      const linkPath = path.join(unbandedEncDir, cellRel);
      fs.mkdirSync(path.dirname(linkPath), { recursive: true });
      try {
        fs.linkSync(cellPath, linkPath);
      } catch {
        fs.copyFileSync(cellPath, linkPath);
      }
    }

    const bucketProgressPrefix = `[unbanded ${bandIndex}/${totalBuckets}]`;
    setProgress(
      chartNumber,
      'converting',
      `${bucketProgressPrefix} Exporting ${grouping.unbanded.length} cell(s)...`
    );
    appendLog(
      chartNumber,
      `${bucketProgressPrefix} Exporting ${grouping.unbanded.length} cell(s) to GeoJSON...`
    );
    await exportAllLayersToGeoJSON(
      unbandedEncDir,
      grouping.unbanded,
      unbandedGeojsonDir,
      chartNumber
    );

    setProgress(
      chartNumber,
      'converting',
      `${bucketProgressPrefix} Generating tiles z${userMinzoom}-z${userMaxzoom}...`
    );
    appendLog(
      chartNumber,
      `${bucketProgressPrefix} Tippecanoe z${userMinzoom}-z${userMaxzoom} (user-requested)`
    );
    const unbandedMbtiles = path.join(tmpDir, 'band-unbanded.mbtiles');
    await runTippecanoe(unbandedGeojsonDir, unbandedMbtiles, chartNumber, {
      ...options,
      minzoom: userMinzoom,
      maxzoom: userMaxzoom
    });
    intermediates.push(unbandedMbtiles);
  }

  if (intermediates.length === 0) {
    throw new Error(
      'Per-band pipeline produced no intermediate tile sets — every band was skipped.'
    );
  }

  setProgress(chartNumber, 'converting', 'Joining per-band tile sets...');
  await runTileJoin(intermediates, outputMbtiles, chartNumber);
}

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
  const geojsonDir = path.join(tmpDir, 'geojson');
  fs.mkdirSync(encDir, { recursive: true });
  fs.mkdirSync(geojsonDir, { recursive: true });

  if (chartNumber) {
    conversionProgress[chartNumber] = {
      status: 'starting',
      message: 'Starting conversion...',
      log: []
    };
  }

  try {
    statusFn('checking', 'Checking container runtime...');
    const manager = getContainerManager();
    if (!manager) {
      throw new Error(
        'signalk-container plugin is required for S-57 conversion. ' +
          'Install it from the App Store and restart Signal K.'
      );
    }

    statusFn('pulling', 'Checking container image...');
    setProgress(chartNumber, 'pulling', 'Checking charts-toolbox image...');
    await ensureContainerImage(CHARTS_TOOLBOX_IMAGE, (msg) => debug(msg));

    statusFn('extracting', 'Extracting ENC files...');
    setProgress(chartNumber, 'extracting', 'Extracting ENC files...');
    let extracted: string[];
    try {
      extracted = await extractZip(zipPath, encDir);
    } catch (zipErr) {
      throw new Error(
        `Downloaded file is not a valid ZIP archive (${zipErr instanceof Error ? zipErr.message : String(zipErr)}). The server may have returned an error page instead.`
      );
    }
    debug(`Extracted ${extracted.length} files from ZIP`);

    if (extracted.length === 0) {
      throw new Error('No files found in ZIP archive');
    }

    const encFiles = findEncFiles(encDir);
    if (encFiles.length === 0) {
      throw new Error('No S-57 ENC files (.000) found in ZIP');
    }
    debug(`Found ${encFiles.length} ENC files`);
    appendLog(chartNumber, `Found ${encFiles.length} ENC files`);

    // Choose pipeline. Per-band runs a separate tippecanoe per IHO band
    // and tile-joins the result — each band's drop / coalesce /
    // tile-size budget heuristics see only same-scale features instead
    // of competing across mixed-scale bundles. Triggers when the bundle
    // actually has more than one bucket (≥2 bands, or a band+unbanded
    // mix); single-bucket bundles (one band only, or all-unbanded) fall
    // through to the legacy single-pass code path so we don't pay the
    // tile-join cost when there's nothing to fan out.
    const grouping = groupCellsByBand(encFiles);
    const bucketCount = grouping.bands.length + (grouping.unbanded.length > 0 ? 1 : 0);
    const usePerBand = bucketCount >= 2;

    const userMaxzoom = options.maxzoom ?? 16;
    const encBasenames = encFiles.map((f) => path.basename(f));
    const clamp = bandClampedMaxzoom(encBasenames, userMaxzoom);

    const outputName = chooseOutputFilename({
      chartsDir,
      displayName: options.displayName,
      chartNumber
    });
    const outputPath = path.join(chartsDir, outputName);

    if (usePerBand) {
      statusFn('converting', 'Running per-band conversion pipeline...');
      appendLog(
        chartNumber,
        `Per-band pipeline selected: ${bucketCount} bucket(s) ` +
          `[bands ${grouping.bands.join(', ') || '(none)'}` +
          `${grouping.unbanded.length > 0 ? ` + ${grouping.unbanded.length} unbanded` : ''}]`
      );
      await runPerBandPipeline(encDir, encFiles, tmpDir, chartNumber, options, outputPath);
    } else {
      statusFn('converting', 'Converting S-57 layers to GeoJSON...');
      setProgress(chartNumber, 'converting', `Exporting ${encFiles.length} ENC files...`);
      appendLog(
        chartNumber,
        `Single-pass pipeline: ${encFiles.length} ENC file(s) in one GDAL container`
      );

      await exportAllLayersToGeoJSON(encDir, encFiles, geojsonDir, chartNumber);

      statusFn('converting', 'Generating vector tiles...');
      setProgress(chartNumber, 'converting', 'Generating vector tiles with tippecanoe...');

      // Clamp tippecanoe's maxzoom to the IHO band ceiling. Most
      // tippecanoe time is spent at the highest zooms; if the only
      // bucket is band-3 (coastal), asking for z16 emits 4 zoom levels
      // of tiles that can't be backed by real feature precision.
      if (clamp.highestBand !== null && clamp.effective < userMaxzoom) {
        const msg =
          `Detected IHO bands [${clamp.bands.join(', ')}] (highest = ${clamp.highestBand}) ` +
          `→ tippecanoe maxzoom clamped to z${clamp.effective} (was z${userMaxzoom})`;
        debug(msg);
        appendLog(chartNumber, msg);
      } else if (clamp.highestBand === null) {
        const msg = `No IHO band detected (likely IENC or non-conforming filenames); using user maxzoom z${userMaxzoom}`;
        debug(msg);
        appendLog(chartNumber, msg);
      }
      const effectiveOptions: S57ConversionOptions = { ...options, maxzoom: clamp.effective };
      await runTippecanoe(geojsonDir, outputPath, chartNumber, effectiveOptions);
    }

    if (!fs.existsSync(outputPath)) {
      throw new Error('tippecanoe completed but output file not found');
    }

    // Overwrite tippecanoe's default `type=overlay` and `name=/output/...` with
    // `type=S-57` so Signal K + chart consumers identify the file correctly.
    // The patcher logs to BOTH the conversion log (visible in the UI) and
    // server stdout — earlier versions only logged to debug() so failures
    // (sqlite locks, node:sqlite unavailable on older Nodes, …) were silent.
    // See docs/reports against 1.11.x bundles still ending up as type=overlay.
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
    // `S-57 <chartNumber>` default.
    if (options.displayName) {
      const dnResult = await setMbtilesDisplayName(
        outputPath,
        options.displayName,
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
    statusFn('completed', `Created ${outputName} (${size} MB)`);
    appendLog(chartNumber, `Done: ${outputName} (${size} MB)`);

    if (chartNumber) {
      delete conversionProgress[chartNumber];
    }

    return { mbtilesFile: outputName };
  } catch (err) {
    if (chartNumber) {
      conversionProgress[chartNumber] = {
        status: 'failed',
        message: (err instanceof Error ? err.message : String(err)) || 'Conversion failed',
        log: conversionProgress[chartNumber]?.log ?? []
      };
      setTimeout(() => {
        delete conversionProgress[chartNumber];
      }, 300000);
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

const GSHHG_URL = 'https://www.ngdc.noaa.gov/mgg/shorelines/data/gshhg/latest/gshhg-shp-2.3.7.zip';

export async function processGshhg(
  tmpDir: string,
  chartsDir: string,
  resolution: string,
  chartNumber: string,
  onStatus: StatusCallback | null
): Promise<S57ConversionResult> {
  const statusFn = onStatus ?? (() => {});
  const resLabels: Record<string, string> = {
    c: 'Crude',
    l: 'Low',
    i: 'Intermediate',
    h: 'High',
    f: 'Full'
  };

  if (!Object.prototype.hasOwnProperty.call(resLabels, resolution)) {
    throw new Error(`Invalid GSHHG resolution: ${resolution}`);
  }

  const manager = getContainerManager();
  if (!manager) {
    throw new Error(
      'signalk-container plugin is required for chart conversion. ' +
        'Install it from the App Store and restart Signal K.'
    );
  }
  setProgress(chartNumber, 'pulling', 'Checking charts-toolbox image...');
  await ensureContainerImage(CHARTS_TOOLBOX_IMAGE, (msg) => debug(msg));

  setProgress(chartNumber, 'converting', 'Downloading GSHHG shapefiles from NOAA...');
  appendLog(
    chartNumber,
    `Downloading GSHHG shapefiles (${resLabels[resolution] ?? resolution})...`
  );

  const zipPath = path.join(tmpDir, 'gshhg-shp.zip');
  await new Promise<void>((resolve, reject) => {
    const file = fs.createWriteStream(zipPath);
    https
      .get(GSHHG_URL, (response) => {
        if (response.statusCode === 301 || response.statusCode === 302) {
          const loc = response.headers.location;
          if (loc) {
            https
              .get(loc, (r2) => {
                r2.pipe(file);
                file.on('finish', () => {
                  file.close(() => resolve());
                });
              })
              .on('error', reject);
            return;
          }
        }
        if (response.statusCode !== 200) {
          reject(new Error(`NOAA returned HTTP ${response.statusCode}`));
          return;
        }
        const totalBytes = parseInt(response.headers['content-length'] ?? '0');
        let downloadedBytes = 0;
        response.on('data', (chunk: Buffer) => {
          downloadedBytes += chunk.length;
          if (totalBytes > 0) {
            const pct = Math.round((downloadedBytes / totalBytes) * 100);
            const mb = (downloadedBytes / (1024 * 1024)).toFixed(1);
            const totalMb = (totalBytes / (1024 * 1024)).toFixed(0);
            setProgress(
              chartNumber,
              'converting',
              `Downloading shapefiles: ${mb}/${totalMb} MB (${pct}%)`
            );
          }
        });
        response.pipe(file);
        file.on('finish', () => {
          file.close(() => resolve());
        });
      })
      .on('error', reject);
  });

  appendLog(chartNumber, 'Download complete. Extracting shapefiles...');
  setProgress(chartNumber, 'converting', 'Extracting shapefiles...');

  const shpDir = path.join(tmpDir, 'shp');
  fs.mkdirSync(shpDir, { recursive: true });

  await fs
    .createReadStream(zipPath)
    .pipe(unzipper.Extract({ path: shpDir }))
    .promise();

  const rasterSizes: Record<string, number> = { c: 8192, l: 16384, i: 65536, h: 131072, f: 262144 };
  const rasterSize = rasterSizes[resolution] ?? 32768;

  appendLog(chartNumber, `Rasterizing land polygons (${rasterSize}px width)...`);
  setProgress(chartNumber, 'converting', 'Rasterizing land polygons...');

  const outputName = `gshhg-basemap-${resolution}.mbtiles`;
  const outputPath = path.join(chartsDir, outputName);

  // Resolve all three host paths up front.  shpDir and tmpDir live under
  // the temp tree (typically inside the data dir or a sibling); chartsDir
  // is the user-configured chart output.  All three need to be reachable
  // from the host runtime, otherwise we surface an actionable error rather
  // than letting the helper container fail with a confusing "no input"
  // exit.
  const resolved = await resolveJobPaths(
    { '/input': shpDir, '/work': tmpDir, '/output': chartsDir },
    (cp, ap) =>
      appendLog(
        chartNumber,
        `Cannot mount ${cp} ← ${ap}: path is not reachable from the SignalK container runtime.`
      )
  );
  if (!resolved) {
    throw new Error(
      'GSHHG conversion paths are not reachable from the container runtime. ' +
        'Move the chart directory under app.getDataDirPath() or extend the SignalK ' +
        'container bind/volume to cover it.'
    );
  }
  const inputPrefix = resolved['/input'].subPath
    ? `/input/${resolved['/input'].subPath}`
    : '/input';
  const workPrefix = resolved['/work'].subPath ? `/work/${resolved['/work'].subPath}` : '/work';
  const outputPrefix = resolved['/output'].subPath
    ? `/output/${resolved['/output'].subPath}`
    : '/output';

  appendLog(chartNumber, 'Rasterizing shapefile...');
  const rasterizeResult = await runContainerJob({
    image: CHARTS_TOOLBOX_IMAGE,
    label: `gdal-rasterize-${chartNumber}`,
    command: [
      'gdal_rasterize',
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
      String(rasterSize),
      String(Math.round(rasterSize / 2)),
      '-ot',
      'Byte',
      '-of',
      'GTiff',
      '-co',
      'COMPRESS=LZW',
      `${inputPrefix}/GSHHS_shp/${resolution}/GSHHS_${resolution}_L1.shp`,
      `${workPrefix}/world.tif`
    ],
    inputs: { '/input': resolved['/input'].source },
    outputs: { '/work': resolved['/work'].source },
    // gdal_rasterize is single-process; one core is enough.
    resources: { cpus: 1 },
    onStdoutLine: (line) => appendLog(chartNumber, line),
    onStderrLine: (line) => appendLog(chartNumber, line)
  });
  if (rasterizeResult.exitCode !== 0) {
    throw new Error(`gdal_rasterize failed (exit ${rasterizeResult.exitCode})`);
  }

  setProgress(chartNumber, 'converting', 'Creating MBTiles...');
  appendLog(chartNumber, 'Creating MBTiles...');
  const translateResult = await runContainerJob({
    image: CHARTS_TOOLBOX_IMAGE,
    label: `gdal-translate-${chartNumber}`,
    command: [
      'gdal_translate',
      '-of',
      'MBTiles',
      '-co',
      'TILE_FORMAT=PNG',
      `${workPrefix}/world.tif`,
      `${outputPrefix}/${outputName}`
    ],
    inputs: { '/work': resolved['/work'].source },
    outputs: { '/output': resolved['/output'].source },
    // Single-process GDAL stage; one core is enough.
    resources: { cpus: 1 },
    onStdoutLine: (line) => appendLog(chartNumber, line),
    onStderrLine: (line) => appendLog(chartNumber, line)
  });
  if (translateResult.exitCode !== 0) {
    throw new Error(`gdal_translate failed (exit ${translateResult.exitCode})`);
  }

  setProgress(chartNumber, 'converting', 'Adding zoom levels...');
  appendLog(chartNumber, 'Adding overview zoom levels...');
  const overviewResult = await runContainerJob({
    image: CHARTS_TOOLBOX_IMAGE,
    label: `gdaladdo-${chartNumber}`,
    command: [
      'gdaladdo',
      '-r',
      'average',
      `${outputPrefix}/${outputName}`,
      '2',
      '4',
      '8',
      '16',
      '32',
      '64',
      '128',
      '256'
    ],
    outputs: { '/output': resolved['/output'].source },
    // Single-process; one core is enough.
    resources: { cpus: 1 },
    onStdoutLine: (line) => appendLog(chartNumber, line),
    onStderrLine: (line) => appendLog(chartNumber, line)
  });
  if (overviewResult.exitCode !== 0) {
    throw new Error(`gdaladdo failed (exit ${overviewResult.exitCode})`);
  }

  try {
    const db = new DatabaseSync(outputPath);
    db.prepare("INSERT OR REPLACE INTO metadata (name, value) VALUES ('name', ?)").run(
      `GSHHG World Basemap (${resLabels[resolution] ?? resolution})`
    );
    db.prepare("INSERT OR REPLACE INTO metadata (name, value) VALUES ('description', ?)").run(
      `Global coastlines and lakes - GSHHG v2.3.7 ${(resLabels[resolution] ?? resolution).toLowerCase()} resolution`
    );
    db.prepare("INSERT OR REPLACE INTO metadata (name, value) VALUES ('type', 'tilelayer')").run();
    db.prepare("INSERT OR REPLACE INTO metadata (name, value) VALUES ('format', 'png')").run();
    db.close();
  } catch {
    debug('Warning: failed to set GSHHG metadata');
  }

  const size = (fs.statSync(outputPath).size / (1024 * 1024)).toFixed(1);
  statusFn('completed', `GSHHG basemap installed (${size} MB)`);
  appendLog(chartNumber, `Done: ${outputName} (${size} MB)`);

  if (chartNumber) {
    delete conversionProgress[chartNumber];
  }

  return { mbtilesFile: outputName };
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
    const manager = getContainerManager();
    if (!manager) {
      throw new Error(
        'signalk-container plugin is required for chart conversion. ' +
          'Install it from the App Store and restart Signal K.'
      );
    }
    setProgress(chartNumber, 'pulling', 'Checking charts-toolbox image...');
    await ensureContainerImage(CHARTS_TOOLBOX_IMAGE, (msg) => debug(msg));

    setProgress(chartNumber, 'extracting', 'Extracting shapefiles...');
    appendLog(chartNumber, 'Extracting .tar.xz archive...');

    // Resolve archive (input) and tmpDir (output) up-front; the rasterize/
    // translate/overview steps reuse the latter as /work.  chartsDir gets
    // resolved separately later because it's not needed by the tar step.
    const archiveDir = path.dirname(tarPath);
    const tarResolved = await resolveJobPaths(
      { '/archive': archiveDir, '/output': tmpDir },
      (cp, ap) =>
        appendLog(
          chartNumber,
          `Cannot mount ${cp} ← ${ap}: path is not reachable from the SignalK container runtime.`
        )
    );
    if (!tarResolved) {
      throw new Error(
        'SHP basemap conversion paths are not reachable from the container runtime. ' +
          'Move the chart directory under app.getDataDirPath() or extend the SignalK ' +
          'container bind/volume to cover it.'
      );
    }
    const archivePrefix = tarResolved['/archive'].subPath
      ? `/archive/${tarResolved['/archive'].subPath}`
      : '/archive';
    const tarOutputPrefix = tarResolved['/output'].subPath
      ? `/output/${tarResolved['/output'].subPath}`
      : '/output';

    const tarResult = await runContainerJob({
      image: CHARTS_TOOLBOX_IMAGE,
      label: `tar-extract-${chartNumber}`,
      command: ['tar', '-xf', `${archivePrefix}/${path.basename(tarPath)}`, '-C', tarOutputPrefix],
      inputs: { '/archive': tarResolved['/archive'].source },
      outputs: { '/output': tarResolved['/output'].source },
      // Tar is single-process; one core is enough.
      resources: { cpus: 1 },
      onStdoutLine: (line) => appendLog(chartNumber, line),
      onStderrLine: (line) => appendLog(chartNumber, line)
    });
    if (tarResult.exitCode !== 0) {
      throw new Error(`tar extraction failed (exit ${tarResult.exitCode})`);
    }

    const findShp = (dir: string, prefix: string | null): string | null => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          const found = findShp(fullPath, prefix);
          if (found) {
            return found;
          }
        } else if (entry.name.endsWith('.shp') && (!prefix || entry.name.includes(prefix))) {
          return fullPath;
        }
      }
      return null;
    };

    const landShp = findShp(tmpDir, 'L1') ?? findShp(tmpDir, 'land') ?? findShp(tmpDir, null);

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
    const shpDir = path.dirname(landShp);
    const shpName = path.basename(landShp);

    // Resolve the three remaining paths: shpDir (extracted shapefile parent),
    // tmpDir (scratch /work for world.tif), chartsDir (final output).
    const rasterResolved = await resolveJobPaths(
      { '/input': shpDir, '/work': tmpDir, '/output': chartsDir },
      (cp, ap) =>
        appendLog(
          chartNumber,
          `Cannot mount ${cp} ← ${ap}: path is not reachable from the SignalK container runtime.`
        )
    );
    if (!rasterResolved) {
      throw new Error(
        'SHP basemap conversion paths are not reachable from the container runtime. ' +
          'Move the chart directory under app.getDataDirPath() or extend the SignalK ' +
          'container bind/volume to cover it.'
      );
    }
    const inputPrefix = rasterResolved['/input'].subPath
      ? `/input/${rasterResolved['/input'].subPath}`
      : '/input';
    const workPrefix = rasterResolved['/work'].subPath
      ? `/work/${rasterResolved['/work'].subPath}`
      : '/work';
    const outputPrefix = rasterResolved['/output'].subPath
      ? `/output/${rasterResolved['/output'].subPath}`
      : '/output';

    appendLog(chartNumber, 'Rasterizing...');
    const rasterizeResult = await runContainerJob({
      image: CHARTS_TOOLBOX_IMAGE,
      label: `gdal-rasterize-${chartNumber}`,
      command: [
        'gdal_rasterize',
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
        String(res.size),
        String(Math.round(res.size / 2)),
        '-ot',
        'Byte',
        '-of',
        'GTiff',
        '-co',
        'COMPRESS=LZW',
        `${inputPrefix}/${shpName}`,
        `${workPrefix}/world.tif`
      ],
      inputs: { '/input': rasterResolved['/input'].source },
      outputs: { '/work': rasterResolved['/work'].source },
      // gdal_rasterize is single-process; one core is enough.
      resources: { cpus: 1 },
      onStdoutLine: (line) => appendLog(chartNumber, line),
      onStderrLine: (line) => appendLog(chartNumber, line)
    });
    if (rasterizeResult.exitCode !== 0) {
      throw new Error(`gdal_rasterize failed (exit ${rasterizeResult.exitCode})`);
    }

    appendLog(chartNumber, 'Creating MBTiles...');
    const translateResult = await runContainerJob({
      image: CHARTS_TOOLBOX_IMAGE,
      label: `gdal-translate-${chartNumber}`,
      command: [
        'gdal_translate',
        '-of',
        'MBTiles',
        '-co',
        'TILE_FORMAT=PNG',
        `${workPrefix}/world.tif`,
        `${outputPrefix}/${outputName}`
      ],
      inputs: { '/work': rasterResolved['/work'].source },
      outputs: { '/output': rasterResolved['/output'].source },
      // Single-process GDAL stage; one core is enough.
      resources: { cpus: 1 },
      onStdoutLine: (line) => appendLog(chartNumber, line),
      onStderrLine: (line) => appendLog(chartNumber, line)
    });
    if (translateResult.exitCode !== 0) {
      throw new Error(`gdal_translate failed (exit ${translateResult.exitCode})`);
    }

    appendLog(chartNumber, 'Adding zoom levels...');
    const overviewResult = await runContainerJob({
      image: CHARTS_TOOLBOX_IMAGE,
      label: `gdaladdo-${chartNumber}`,
      command: [
        'gdaladdo',
        '-r',
        'average',
        `${outputPrefix}/${outputName}`,
        '2',
        '4',
        '8',
        '16',
        '32',
        '64',
        '128',
        '256'
      ],
      outputs: { '/output': rasterResolved['/output'].source },
      // Single-process; one core is enough.
      resources: { cpus: 1 },
      onStdoutLine: (line) => appendLog(chartNumber, line),
      onStderrLine: (line) => appendLog(chartNumber, line)
    });
    if (overviewResult.exitCode !== 0) {
      throw new Error(`gdaladdo failed (exit ${overviewResult.exitCode})`);
    }

    try {
      const db = new DatabaseSync(outputPath);
      db.prepare("INSERT OR REPLACE INTO metadata (name, value) VALUES ('name', ?)").run(
        `OSM Basemap (${res.label})`
      );
      db.prepare(
        "INSERT OR REPLACE INTO metadata (name, value) VALUES ('type', 'tilelayer')"
      ).run();
      db.prepare("INSERT OR REPLACE INTO metadata (name, value) VALUES ('format', 'png')").run();
      db.close();
    } catch {
      debug('Warning: failed to set basemap metadata');
    }

    const size = (fs.statSync(outputPath).size / (1024 * 1024)).toFixed(1);
    statusFn('completed', `Basemap installed (${size} MB)`);
    appendLog(chartNumber, `Done: ${outputName} (${size} MB)`);

    if (chartNumber) {
      delete conversionProgress[chartNumber];
    }
    return { mbtilesFile: outputName };
  } catch (err) {
    if (chartNumber) {
      conversionProgress[chartNumber] = {
        status: 'failed',
        message: (err instanceof Error ? err.message : String(err)) || 'Conversion failed',
        log: conversionProgress[chartNumber]?.log ?? []
      };
      setTimeout(() => delete conversionProgress[chartNumber], 300000);
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
