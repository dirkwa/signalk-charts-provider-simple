import https from 'https';
import fs from 'fs';
import path from 'path';
import unzipper from 'unzipper';
import { getCpuBudget } from './concurrency';
import {
  checkContainerRuntime,
  imageExists as runtimeImageExists,
  pullImage as runtimePullImage,
  runContainer
} from './container-runtime';
import { BAND_MIN_ZOOM, bandClampedMaxzoom, highestBandForFiles } from './s57-band';
import { patchS57Mbtiles } from './mbtiles-metadata';
import type {
  ConversionProgress,
  ConversionProgressMap,
  S57ConversionResult,
  S57ConversionOptions,
  StatusCallback,
  DebugFunction
} from '../types';

const GDAL_IMAGE = 'ghcr.io/osgeo/gdal:alpine-small-latest';
const TIPPECANOE_IMAGE = 'ghcr.io/dirkwa/signalk-charts-provider-simple/tippecanoe';

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

async function ensureImage(image: string): Promise<void> {
  if (await runtimeImageExists(image)) {
    return;
  }
  debug(`Pulling image: ${image}`);
  await runtimePullImage(image, (msg) => debug(msg));
  debug(`Image pulled: ${image}`);
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

interface ExportScriptOptions {
  multiFile: boolean;
  /** xargs -P fan-out for the per-layer ogr2ogr loop. 1 = sequential. */
  parallelism: number;
  skipLayers: string[];
}

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

  if (parallel === 1) {
    return `
set -e
count=$(find /input -name '*.000' ! -name '._*' -type f | wc -l)
i=0
find /input -name '*.000' ! -name '._*' -type f -print0 | while IFS= read -r -d '' enc; do
  i=$((i + 1))
  name=$(basename "$enc" .000)
  echo "PROGRESS: Processing $name ($i/$count)"
  layers=$(ogrinfo -so "$enc" 2>/dev/null | grep -E '^[0-9]+:' | awk -F': ' '{print $2}' | awk '{print $1}')
  for layer in $layers; do
    case "$layer" in ${skipPattern}) continue ;; esac
    outname="${multiBranch}"
    if [ "$layer" = "SOUNDG" ]; then
      ogr2ogr -f GeoJSON -oo SPLIT_MULTIPOINT=YES -oo ADD_SOUNDG_DEPTH=YES \\
        "/output/$outname.geojson" "$enc" "$layer" 2>/dev/null || true
    else
      ogr2ogr -f GeoJSON "/output/$outname.geojson" "$enc" "$layer" 2>/dev/null || true
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
count=$(find /input -name '*.000' ! -name '._*' -type f | wc -l)
i=0
find /input -name '*.000' ! -name '._*' -type f -print0 | while IFS= read -r -d '' enc; do
  i=$((i + 1))
  name=$(basename "$enc" .000)
  echo "PROGRESS: Processing $name ($i/$count)"
  layers=$(ogrinfo -so "$enc" 2>/dev/null | grep -E '^[0-9]+:' | awk -F': ' '{print $2}' | awk '{print $1}')
  printf '%s\\n' $layers | xargs -P ${parallel} -I '{}' sh -c '
    layer="$1"
    enc="$2"
    name="$3"
    multi="$4"
    case "$layer" in ${skipPattern}) exit 0 ;; esac
    if [ "$multi" = "1" ]; then outname="\${layer}_\${name}"; else outname="$layer"; fi
    if [ "$layer" = "SOUNDG" ]; then
      ogr2ogr -f GeoJSON -oo SPLIT_MULTIPOINT=YES -oo ADD_SOUNDG_DEPTH=YES \\
        "/output/\${outname}.geojson" "$enc" "$layer" 2>/dev/null || true
    else
      ogr2ogr -f GeoJSON "/output/\${outname}.geojson" "$enc" "$layer" 2>/dev/null || true
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

  const script = buildExportScript({ multiFile, parallelism, skipLayers });

  const result = await runContainer({
    image: GDAL_IMAGE,
    phase: 'gdal-export',
    job: chartNumber,
    cmd: ['sh', '-c', script],
    binds: [`${encDir}:/input:ro`, `${geojsonDir}:/output`],
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
function buildLayerArgs(layers: readonly ConsolidatedLayer[]): string[] {
  const args: string[] = [];
  for (const { file } of layers) {
    const rel = path.basename(file);
    const layer = path.basename(rel, '.geojson');
    args.push('-L', `${layer}:/input/${rel}`);
  }
  return args;
}

export const _testInternals = {
  consolidateGeoJSONByLayer,
  buildExportScript,
  bandClampedMaxzoom,
  buildLayerArgs
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
  const layerArgs = buildLayerArgs(mergedLayers);

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

  const result = await runContainer({
    image: TIPPECANOE_IMAGE,
    phase: 'tippecanoe',
    job: chartNumber,
    cmd: [
      'tippecanoe',
      '-o',
      `/output/${path.basename(outputMbtiles)}`,
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
    binds: [`${mergedDir}:/input:ro`, `${path.dirname(outputMbtiles)}:/output`],
    env: [`TIPPECANOE_MAX_THREADS=${tippecanoeThreads}`],
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
    const runtime = await checkContainerRuntime();
    if (!runtime.available) {
      throw new Error(
        'No Docker- or Podman-compatible socket reachable. S-57 conversion needs a container runtime API.'
      );
    }

    statusFn('pulling', 'Checking container images...');
    setProgress(chartNumber, 'pulling', 'Checking GDAL image...');
    if (!(await runtimeImageExists(GDAL_IMAGE))) {
      setProgress(chartNumber, 'pulling', 'Pulling GDAL image...');
      await ensureImage(GDAL_IMAGE);
    }
    setProgress(chartNumber, 'pulling', 'Checking tippecanoe image...');
    if (!(await runtimeImageExists(TIPPECANOE_IMAGE))) {
      setProgress(chartNumber, 'pulling', 'Pulling tippecanoe image...');
      await ensureImage(TIPPECANOE_IMAGE);
    }

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

    statusFn('converting', 'Converting S-57 layers to GeoJSON...');
    setProgress(chartNumber, 'converting', `Exporting ${encFiles.length} ENC files...`);
    appendLog(chartNumber, `Exporting ${encFiles.length} ENC files in single GDAL container...`);

    await exportAllLayersToGeoJSON(encDir, encFiles, geojsonDir, chartNumber);

    statusFn('converting', 'Generating vector tiles...');
    setProgress(chartNumber, 'converting', 'Generating vector tiles with tippecanoe...');

    // Clamp tippecanoe's maxzoom to the IHO band ceiling. Most tippecanoe time
    // is spent at the highest zooms; if the source charts only have band-3
    // (coastal) precision, asking for z16 emits 4 zoom levels of tiles that
    // can't be backed by real feature precision.
    const userMaxzoom = options.maxzoom ?? 16;
    const encBasenames = encFiles.map((f) => path.basename(f));
    const clamp = bandClampedMaxzoom(encBasenames, userMaxzoom);
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

    const outputName = `${chartNumber || 'enc-chart'}.mbtiles`;
    const outputPath = path.join(chartsDir, outputName);
    await runTippecanoe(geojsonDir, outputPath, chartNumber, effectiveOptions);

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

  const runtime = await checkContainerRuntime();
  if (!runtime.available) {
    throw new Error('No Docker- or Podman-compatible socket reachable.');
  }
  if (!(await runtimeImageExists(GDAL_IMAGE))) {
    setProgress(chartNumber, 'pulling', 'Pulling GDAL image...');
    await ensureImage(GDAL_IMAGE);
  }

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

  appendLog(chartNumber, 'Rasterizing shapefile...');
  const rasterizeResult = await runContainer({
    image: GDAL_IMAGE,
    phase: 'gdal-rasterize',
    job: chartNumber,
    cmd: [
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
      `/input/GSHHS_shp/${resolution}/GSHHS_${resolution}_L1.shp`,
      '/work/world.tif'
    ],
    binds: [`${shpDir}:/input:ro`, `${tmpDir}:/work`],
    onStdoutLine: (line) => appendLog(chartNumber, line),
    onStderrLine: (line) => appendLog(chartNumber, line)
  });
  if (rasterizeResult.exitCode !== 0) {
    throw new Error(`gdal_rasterize failed (exit ${rasterizeResult.exitCode})`);
  }

  setProgress(chartNumber, 'converting', 'Creating MBTiles...');
  appendLog(chartNumber, 'Creating MBTiles...');
  const translateResult = await runContainer({
    image: GDAL_IMAGE,
    phase: 'gdal-translate',
    job: chartNumber,
    cmd: [
      'gdal_translate',
      '-of',
      'MBTiles',
      '-co',
      'TILE_FORMAT=PNG',
      '/work/world.tif',
      `/output/${outputName}`
    ],
    binds: [`${tmpDir}:/work`, `${chartsDir}:/output`],
    onStdoutLine: (line) => appendLog(chartNumber, line),
    onStderrLine: (line) => appendLog(chartNumber, line)
  });
  if (translateResult.exitCode !== 0) {
    throw new Error(`gdal_translate failed (exit ${translateResult.exitCode})`);
  }

  setProgress(chartNumber, 'converting', 'Adding zoom levels...');
  appendLog(chartNumber, 'Adding overview zoom levels...');
  const overviewResult = await runContainer({
    image: GDAL_IMAGE,
    phase: 'gdaladdo',
    job: chartNumber,
    cmd: [
      'gdaladdo',
      '-r',
      'average',
      `/output/${outputName}`,
      '2',
      '4',
      '8',
      '16',
      '32',
      '64',
      '128',
      '256'
    ],
    binds: [`${chartsDir}:/output`],
    onStdoutLine: (line) => appendLog(chartNumber, line),
    onStderrLine: (line) => appendLog(chartNumber, line)
  });
  if (overviewResult.exitCode !== 0) {
    throw new Error(`gdaladdo failed (exit ${overviewResult.exitCode})`);
  }

  try {
    const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
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
    const runtime = await checkContainerRuntime();
    if (!runtime.available) {
      throw new Error('No Docker- or Podman-compatible socket reachable.');
    }
    if (!(await runtimeImageExists(GDAL_IMAGE))) {
      setProgress(chartNumber, 'pulling', 'Pulling GDAL image...');
      await ensureImage(GDAL_IMAGE);
    }

    setProgress(chartNumber, 'extracting', 'Extracting shapefiles...');
    appendLog(chartNumber, 'Extracting .tar.xz archive...');

    const tarResult = await runContainer({
      image: GDAL_IMAGE,
      phase: 'tar-extract',
      job: chartNumber,
      cmd: ['tar', '-xf', `/archive/${path.basename(tarPath)}`, '-C', '/output'],
      binds: [`${path.dirname(tarPath)}:/archive:ro`, `${tmpDir}:/output`],
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

    appendLog(chartNumber, 'Rasterizing...');
    const rasterizeResult = await runContainer({
      image: GDAL_IMAGE,
      phase: 'gdal-rasterize',
      job: chartNumber,
      cmd: [
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
        `/input/${shpName}`,
        '/work/world.tif'
      ],
      binds: [`${shpDir}:/input:ro`, `${tmpDir}:/work`],
      onStdoutLine: (line) => appendLog(chartNumber, line),
      onStderrLine: (line) => appendLog(chartNumber, line)
    });
    if (rasterizeResult.exitCode !== 0) {
      throw new Error(`gdal_rasterize failed (exit ${rasterizeResult.exitCode})`);
    }

    appendLog(chartNumber, 'Creating MBTiles...');
    const translateResult = await runContainer({
      image: GDAL_IMAGE,
      phase: 'gdal-translate',
      job: chartNumber,
      cmd: [
        'gdal_translate',
        '-of',
        'MBTiles',
        '-co',
        'TILE_FORMAT=PNG',
        '/work/world.tif',
        `/output/${outputName}`
      ],
      binds: [`${tmpDir}:/work`, `${chartsDir}:/output`],
      onStdoutLine: (line) => appendLog(chartNumber, line),
      onStderrLine: (line) => appendLog(chartNumber, line)
    });
    if (translateResult.exitCode !== 0) {
      throw new Error(`gdal_translate failed (exit ${translateResult.exitCode})`);
    }

    appendLog(chartNumber, 'Adding zoom levels...');
    const overviewResult = await runContainer({
      image: GDAL_IMAGE,
      phase: 'gdaladdo',
      job: chartNumber,
      cmd: [
        'gdaladdo',
        '-r',
        'average',
        `/output/${outputName}`,
        '2',
        '4',
        '8',
        '16',
        '32',
        '64',
        '128',
        '256'
      ],
      binds: [`${chartsDir}:/output`],
      onStdoutLine: (line) => appendLog(chartNumber, line),
      onStderrLine: (line) => appendLog(chartNumber, line)
    });
    if (overviewResult.exitCode !== 0) {
      throw new Error(`gdaladdo failed (exit ${overviewResult.exitCode})`);
    }

    try {
      const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
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
