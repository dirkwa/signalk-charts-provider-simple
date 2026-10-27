/**
 * The container toolchain for S-57 ENC and land basemaps
 * (conversion-backend.ts): GDAL, tippecanoe and tile-join in the
 * charts-toolbox image, run as helper jobs through signalk-container.
 *
 * s57-converter.ts owns each conversion (its progress record, output name,
 * metadata patches) and calls in here once `chooseConversionBackend` picked
 * the container toolchain, which also pulled the image and checked that the
 * conversion's folders can be mounted.
 */

import fs from 'fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import zlib from 'zlib';
import type { S57BucketProgress, S57ConversionOptions, StatusCallback } from '../types.js';
import { getCpuBudget } from './concurrency.js';
import { makeContainerWritable, shellQuote, withOutputChmod } from './container-fs.js';
import { CHARTS_TOOLBOX_IMAGE } from './container-images.js';
import { resolveJobPaths, runJob as runContainerJob } from './container-jobs.js';
import type { JobBindResolution } from './container-jobs.js';
import { CONVERSION_ABORTED_MESSAGE, type ConversionReport } from './conversion-backend.js';
import { throwJobFailure } from './job-failure.js';
import {
  BAND_MAX_ZOOM,
  BAND_MIN_ZOOM,
  bandClampedMaxzoom,
  exportFileParts,
  groupCellsByBand,
  highestBandForFiles
} from './s57-band.js';
import {
  COMPLETE_MARKER_PREFIX,
  EXPORT_ERROR_FILE_BASENAME,
  SKIP_LAYERS,
  cellFiles,
  exportErrorReport,
  geojsonContentSize
} from './s57-export-files.js';
import { scaminMinzoom } from './s57-scamin.js';

// Stop the pipeline when a container job was killed by an abort signal
// (signalk-container >= 1.16.0). Checked before the exit-code check, since a
// killed job's exit code is meaningless.
function throwIfJobCancelled(result: { status?: string }): void {
  if (result.status === 'cancelled') {
    throw new Error(CONVERSION_ABORTED_MESSAGE);
  }
}

/**
 * Translate host paths into the mounts of one job, as `prefix` (the path
 * inside the container) and `source` (what is mounted) per container path.
 * The prefix carries a subPath when SignalK is on a named volume that covers
 * a parent directory: the whole volume is mounted and the job navigates in.
 */
async function resolveMounts(
  paths: Record<string, string>,
  what: string,
  report: ConversionReport
): Promise<Record<string, JobBindResolution & { prefix: string }>> {
  const resolved = await resolveJobPaths(paths, (cp, ap) => {
    report.log(
      `Cannot mount ${cp} ← ${ap}: path is not reachable from the SignalK container runtime.`
    );
  });
  if (!resolved) {
    throw new Error(
      `${what} paths are not reachable from the container runtime. ` +
        'Move the chart directory under app.getDataDirPath() or extend the SignalK ' +
        'container bind/volume to cover it.'
    );
  }
  return Object.fromEntries(
    Object.entries(resolved).map(([cp, r]) => [
      cp,
      { ...r, prefix: r.subPath ? `${cp}/${r.subPath}` : cp }
    ])
  );
}

const logLines =
  (report: ConversionReport) =>
  (line: string): void => {
    report.log(line);
  };

/**
 * Link (or, across file systems, copy) each cell and its update files into
 * `destDir`, flat. The export script finds cells with `find`, so it then sees
 * exactly these. Hardlinks keep IO cheap and — unlike symlinks — survive
 * being bind-mounted into a container, where a symlink's absolute host
 * target does not exist. Cell names must be unique (s57-converter keeps one
 * cell of each name).
 */
function stageCells(cells: readonly string[], destDir: string): void {
  fs.mkdirSync(destDir, { recursive: true });
  for (const cell of cells) {
    const stem = path.basename(cell, path.extname(cell));
    for (const file of cellFiles(cell)) {
      // Under the cell's own name: GDAL looks for its updates by that name.
      const dest = path.join(destDir, `${stem}${path.extname(file)}`);
      try {
        fs.linkSync(file, dest);
      } catch {
        fs.copyFileSync(file, dest);
      }
    }
  }
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
  /** Write `${COMPLETE_MARKER_PREFIX}<cell>` for each cell exported without an error. */
  markComplete?: boolean;
}

/**
 * Container path the export script writes per-file ogr2ogr stderr to,
 * for the default `/output` mount.  The script computes the actual
 * path from `outputPrefix` so it stays correct when SignalK is on a
 * named volume that needs a `/output/<subPath>` prefix; this constant
 * still reflects the bind-mount default and is exported for tests.
 */
export const EXPORT_ERRORS_LOG = `/output/${EXPORT_ERROR_FILE_BASENAME}`;

// Build the shell script that runs inside the GDAL container. Extracted as a
// pure function so it's testable and so the parallelism knob is visible.
//
// When parallelism > 1, the per-layer loop uses `xargs -P` and the per-layer
// body runs in a child shell that receives $enc, $name, $multi as positional
// args (so chart names with spaces / shell metacharacters can't escape into
// the command). When parallelism === 1, the script keeps the simpler
// sequential `for layer` form — same behaviour as before this option existed.
function buildExportScript(opts: ExportScriptOptions): string {
  const skipPattern = opts.skipLayers.join('|');
  const parallel = Math.max(1, Math.floor(opts.parallelism));
  // `<LAYER>__<cell>`: see EXPORT_NAME_SEPARATOR for why two underscores.
  const multiBranch = opts.multiFile ? '${layer}__${name}' : '${layer}';
  const inDir = opts.inputPrefix ?? '/input';
  const outDir = opts.outputPrefix ?? '/output';
  const errLog = `${outDir}/${EXPORT_ERROR_FILE_BASENAME}`;
  // With markComplete, a cell whose ogrinfo and every ogr2ogr succeeded gets
  // an empty `${COMPLETE_MARKER_PREFIX}<cell>` file beside its output, so a
  // caller keeping the output can tell a complete export from a partial one.
  const markComplete = opts.markComplete
    ? `  if [ "$failed" = 0 ]; then : > "${outDir}/${COMPLETE_MARKER_PREFIX}$name"; fi\n`
    : '';

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
  failed=0
  info=$(ogrinfo -so "$enc" 2>>${errLog}) || failed=1
  layers=$(printf '%s\\n' "$info" | grep -E '^[0-9]+:' | awk -F': ' '{print $2}' | awk '{print $1}')
  for layer in $layers; do
    case "$layer" in ${skipPattern}) continue ;; esac
    outname="${multiBranch}"
    if [ "$layer" = "SOUNDG" ]; then
      ogr2ogr -f GeoJSON -oo SPLIT_MULTIPOINT=YES -oo ADD_SOUNDG_DEPTH=YES \\
        "${outDir}/$outname.geojson" "$enc" "$layer" 2>>${errLog} || failed=1
    else
      ogr2ogr -f GeoJSON "${outDir}/$outname.geojson" "$enc" "$layer" 2>>${errLog} || failed=1
    fi
  done
${markComplete}done
echo "PROGRESS: Export complete"
`;
  }

  // Parallel branch: fan out per-layer ogr2ogr via xargs -P.
  // The inner sh -c receives layer / enc / name / multi as positional args
  // so we don't smuggle untrusted strings through shell quoting. A failed
  // ogr2ogr exits its inner shell with 1 (never 255, which would stop xargs
  // early), so xargs fails and marks the cell; it never stops the export.
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
  failed=0
  info=$(ogrinfo -so "$enc" 2>>${errLog}) || failed=1
  layers=$(printf '%s\\n' "$info" | grep -E '^[0-9]+:' | awk -F': ' '{print $2}' | awk '{print $1}')
  printf '%s\\n' $layers | xargs -P ${parallel} -I '{}' sh -c '
    layer="$1"
    enc="$2"
    name="$3"
    multi="$4"
    case "$layer" in ${skipPattern}) exit 0 ;; esac
    if [ "$multi" = "1" ]; then outname="\${layer}__\${name}"; else outname="$layer"; fi
    if [ "$layer" = "SOUNDG" ]; then
      ogr2ogr -f GeoJSON -oo SPLIT_MULTIPOINT=YES -oo ADD_SOUNDG_DEPTH=YES \\
        "${outDir}/\${outname}.geojson" "$enc" "$layer" 2>>${errLog} || exit 1
    else
      ogr2ogr -f GeoJSON "${outDir}/\${outname}.geojson" "$enc" "$layer" 2>>${errLog} || exit 1
    fi
  ' _ '{}' "$enc" "$name" "${multiArg}" || failed=1
${markComplete}done
echo "PROGRESS: Export complete"
`;
}

// Said when the export produced nothing and GDAL reported nothing either.
const NO_EXPORT_ERRORS_HINT =
  'This usually means the GDAL container could not read /input — check chart-path host bind mounts and SELinux/AppArmor labels.';

function surfaceExportErrorsIfEmpty(geojsonDir: string, report: ConversionReport): void {
  for (const line of exportErrorReport(geojsonDir, NO_EXPORT_ERRORS_HINT)) {
    report.log(line);
  }
}

/**
 * Run GDAL in the charts-toolbox image on every cell under `encDir`, writing
 * `<LAYER>__<cell>.geojson` (`<LAYER>.geojson` without `multiFile`) into
 * `geojsonDir`. One unreadable layer or cell is logged, not fatal. With
 * `perCell` (the chart-set cache) every output is named after its cell and
 * each cell exported without an error is marked complete.
 */
export async function exportCellsInContainer(
  encDir: string,
  geojsonDir: string,
  label: string,
  report: ConversionReport,
  opts: { multiFile: boolean; perCell?: boolean; signal?: AbortSignal }
): Promise<void> {
  const parallelism = getCpuBudget().gdalExportParallelism;
  fs.mkdirSync(geojsonDir, { recursive: true });
  makeContainerWritable(geojsonDir);
  const mounts = await resolveMounts(
    { '/input': encDir, '/output': geojsonDir },
    'Chart conversion',
    report
  );

  const script = buildExportScript({
    multiFile: opts.multiFile || opts.perCell === true,
    parallelism,
    skipLayers: SKIP_LAYERS,
    inputPrefix: mounts['/input'].prefix,
    outputPrefix: mounts['/output'].prefix,
    markComplete: opts.perCell
  });

  const result = await runContainerJob({
    image: CHARTS_TOOLBOX_IMAGE,
    label: `gdal-export-${label}`,
    // bash, not sh.  The toolbox image's `/bin/sh` is dash on Ubuntu,
    // which doesn't accept `read -r -d ''` (a bash-ism we use to consume
    // `find -print0` output safely).
    command: ['bash', '-c', script],
    inputs: { '/input': mounts['/input'].source },
    outputs: { '/output': mounts['/output'].source },
    // Cap the helper at the budgeted parallelism — without this the
    // xargs -P fan-out can saturate every core regardless of the
    // budget setting.
    resources: { cpus: parallelism },
    signal: opts.signal,
    onStdoutLine: (line) => {
      report.log(line);
      const match = /PROGRESS: Processing (\S+)/.exec(line);
      if (match?.[1]) {
        report.progress('converting', `Exporting ${match[1]}...`);
      }
    },
    onStderrLine: logLines(report)
  });

  throwIfJobCancelled(result);

  if (result.exitCode !== 0) {
    // A structural export failure (find/ogrinfo/bash) may still have written
    // per-file ogr2ogr stderr before dying; surface that alongside the
    // container log tail so an empty /input and a per-chart parse error are
    // distinguishable.
    surfaceExportErrorsIfEmpty(geojsonDir, report);
    throwJobFailure(result, `gdal-export-${label}`, report.log);
  }

  // The export script swallows non-zero exits from per-file ogr2ogr calls
  // (one bad chart shouldn't kill a 60-chart bundle), so a clean exit
  // doesn't mean any output landed.
  surfaceExportErrorsIfEmpty(geojsonDir, report);
}

// One row per merged layer. `sourceFiles` are the per-chart GeoJSON filenames
// (basenames, e.g. 'HRBFAC__US5MA1SK.geojson') that fed the merge — kept for
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
// hand-named) get no band floor and fall back to the global `-Z`.
//
// A feature's own SCAMIN can raise its minzoom further (see
// `scaminMinzoom`), capped at `maxzoom` so the feature still reaches the
// deepest tiles that clients overzoom.
function consolidateGeoJSONByLayer(
  geojsonDir: string,
  userMinzoom: number,
  maxzoom = 16
): ConsolidatedLayer[] {
  // `.geojson.gz` is what the chart-set cache keeps; it reads the same.
  const files = fs
    .readdirSync(geojsonDir)
    .filter((f) => f.endsWith('.geojson') || f.endsWith('.geojson.gz'));
  const readSource = (file: string): string => {
    const bytes = fs.readFileSync(path.join(geojsonDir, file));
    return (file.endsWith('.gz') ? zlib.gunzipSync(bytes) : bytes).toString('utf8');
  };

  // Group by layer name. The export script writes `<LAYER>__<cell>.geojson`
  // for multi-chart bundles and `<LAYER>.geojson` for single-chart ones.
  const layerGroups = new Map<string, string[]>();
  for (const file of files) {
    // An empty FeatureCollection.
    if (geojsonContentSize(path.join(geojsonDir, file)) <= 100) {
      continue;
    }
    const { layer } = exportFileParts(file);
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
    try {
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
          parsed = JSON.parse(readSource(source)) as {
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
          const scaminZoom = scaminMinzoom(flattened);
          const minzoomCandidates = [featureMinzoom, scaminZoom].filter(
            (z): z is number => z !== null
          );
          const stamped =
            minzoomCandidates.length > 0
              ? withTippecanoeMinzoom(
                  flattened,
                  Math.min(maxzoom, Math.max(userMinzoom, ...minzoomCandidates))
                )
              : flattened;
          fs.writeSync(handle, JSON.stringify(stamped));
          first = false;
        }
      }
      fs.writeSync(handle, '\n]}\n');
    } finally {
      fs.closeSync(handle);
    }
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

// Basename for the per-job layer manifest, written into the mounted /input
// dir alongside the consolidated GeoJSON.
const TIPPECANOE_LAYER_MANIFEST = '.tippecanoe-layers';

// One `layerName:/input/file.geojson` line per consolidated layer — the same
// pairs `-L` would take, as a newline-delimited file the container reads.
// `inputPrefix` defaults to `/input`; it changes to `/input/<subPath>` when
// SignalK is on a named volume that covers a parent dir of the scratch.
function buildLayerManifest(
  layers: readonly ConsolidatedLayer[],
  inputPrefix: string = '/input'
): string {
  return (
    layers
      .map(({ file }) => {
        const rel = path.basename(file);
        const layer = path.basename(rel, '.geojson');
        return `${layer}:${inputPrefix}/${rel}`;
      })
      .join('\n') + '\n'
  );
}

// Build the tippecanoe invocation as a small `bash -c` script that reads the
// `-L` layer pairs from the manifest at runtime, instead of inlining them into
// argv. A large bundle has 100+ layers, so inlining produced a 200+ element
// container `Cmd` (a multi-KB createContainer body) that old podman's
// docker-compat socket rejects with `write EPIPE` (issue #132). Reading them
// from a file keeps argv at a constant 3 elements regardless of layer count —
// the same shape the GDAL export step already uses successfully.
function buildTippecanoeCommand(
  fixedArgs: readonly string[],
  manifestContainerPath: string
): string[] {
  // Single-quote for the shell so paths/flags with spaces survive
  // word-splitting (the manifest path can carry a named-volume subPath, and
  // chart dirs commonly contain spaces).
  const sq = shellQuote;
  const quoted = fixedArgs.map(sq).join(' ');
  // The `-o <path>` pair gives us the container-side output path to chmod
  // once tippecanoe is done — see withOutputChmod for why.
  const outputIndex = fixedArgs.indexOf('-o');
  const outputContainerPath = outputIndex >= 0 ? fixedArgs[outputIndex + 1] : undefined;
  const script = [
    'set -e',
    'layers=()',
    `while IFS= read -r line; do`,
    '  [ -n "$line" ] && layers+=(-L "$line")',
    `done < ${sq(manifestContainerPath)}`,
    `tippecanoe ${quoted} "\${layers[@]}"`,
    ...(outputContainerPath ? [`chmod 666 ${sq(outputContainerPath)}`] : [])
  ].join('\n');
  return ['bash', '-c', script];
}

/**
 * Best-effort, synchronous overwrite of the `name` metadata row. Used by the
 * tile-join single-input degenerate path, where no container job runs to bake
 * the name in via `-n`. DELETE-then-INSERT (not INSERT OR REPLACE) because
 * tippecanoe's `metadata` table has no UNIQUE constraint on `name`, so REPLACE
 * would append a second row rather than overwrite. The DELETE + INSERT run in
 * a transaction so a throwing INSERT can't leave the file with the old `name`
 * deleted and no replacement (mirrors setMbtilesDisplayName). Never throws —
 * the post-conversion patch is the authoritative pass.
 */
function stampMbtilesName(outputPath: string, name: string): void {
  try {
    const db = new DatabaseSync(outputPath);
    let inTransaction = false;
    try {
      db.exec('BEGIN TRANSACTION');
      inTransaction = true;
      db.exec("DELETE FROM metadata WHERE name = 'name'");
      db.prepare("INSERT INTO metadata (name, value) VALUES ('name', ?)").run(name);
      db.exec('COMMIT');
      inTransaction = false;
    } finally {
      if (inTransaction) {
        try {
          db.exec('ROLLBACK');
        } catch {
          /* already closed / rolled back */
        }
      }
      db.close();
    }
  } catch {
    /* best-effort; patchS57Mbtiles/setMbtilesDisplayName run afterward */
  }
}

export const _testInternals = {
  consolidateGeoJSONByLayer,
  scaminMinzoom,
  buildExportScript,
  bandClampedMaxzoom,
  buildLayerManifest,
  buildTippecanoeCommand,
  withOutputChmod,
  TIPPECANOE_LAYER_MANIFEST,
  surfaceExportErrorsIfEmpty,
  stampMbtilesName,
  stageCells
};

async function runTippecanoe(
  geojsonDir: string,
  outputMbtiles: string,
  label: string,
  report: ConversionReport,
  zoom: { minzoom: number; maxzoom: number },
  signal: AbortSignal | undefined,
  onTilePercent?: (pct: number) => void,
  // The `name` metadata row to bake in. Set only for the final output of a
  // conversion (single-pass); per-band intermediates leave it undefined since
  // tile-join sets the final name.
  mbtilesName?: string
): Promise<void> {
  const { minzoom, maxzoom } = zoom;

  // Merge per-chart-per-layer GeoJSON into one file per layer before invoking
  // tippecanoe. A typical NOAA bundle of 4 charts × ~30 layers used to mean
  // 120 -L args; consolidating drops that to ~30.
  const mergedLayers = consolidateGeoJSONByLayer(geojsonDir, minzoom, maxzoom);
  if (mergedLayers.length === 0) {
    throw new Error('No valid GeoJSON layers to process');
  }
  const mergedDir = path.dirname(mergedLayers[0].file);
  const mounts = await resolveMounts(
    { '/input': mergedDir, '/output': path.dirname(outputMbtiles) },
    'Tippecanoe input/output',
    report
  );
  const inputPrefix = mounts['/input'].prefix;
  const outputPrefix = mounts['/output'].prefix;
  // Write the layer list into the mounted /input dir; tippecanoe reads it at
  // runtime so the container Cmd stays small (see buildTippecanoeCommand).
  fs.writeFileSync(
    path.join(mergedDir, TIPPECANOE_LAYER_MANIFEST),
    buildLayerManifest(mergedLayers, inputPrefix)
  );
  const manifestContainerPath = `${inputPrefix}/${TIPPECANOE_LAYER_MANIFEST}`;

  // Log per-band layer breakdown so users can see why low-zoom features differ
  // by band. Counts plus a sample of layer names — full lists would be noisy
  // (a state bundle has ~40 layers per band).
  const byBand = new Map<number | null, string[]>();
  for (const { file, sourceFiles } of mergedLayers) {
    const b = highestBandForFiles(sourceFiles);
    const list = byBand.get(b) ?? [];
    list.push(path.basename(file, '.geojson'));
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
    report.log(
      `Band ${band ?? 'unknown'}: ${layers.length} layers from z${effectiveFloor} (${sample}${more})`
    );
  }

  const tippecanoeThreads = getCpuBudget().tippecanoeThreadsPerJob;
  report.debug(
    `Running tippecanoe with ${mergedLayers.length} consolidated layers, zoom ${minzoom}-${maxzoom}, ${tippecanoeThreads} threads`
  );

  const handleTippecanoeLine = (line: string): void => {
    report.log(line);
    const match = /(\d+(?:\.\d+)?)%/.exec(line);
    if (match) {
      const pct = parseFloat(match[1]);
      report.message(`Generating tiles: ${Math.round(pct)}%`);
      onTilePercent?.(pct);
    }
  };

  const result = await runContainerJob({
    image: CHARTS_TOOLBOX_IMAGE,
    label: `tippecanoe-${label}`,
    command: buildTippecanoeCommand(
      [
        '-o',
        `${outputPrefix}/${path.basename(outputMbtiles)}`,
        // Bake the `name` metadata row so it never defaults to the `/output/`
        // container path (issue #151). Omitted for per-band intermediates.
        ...(mbtilesName ? ['-n', mbtilesName] : []),
        '-z',
        String(maxzoom),
        '-Z',
        String(minzoom),
        '--no-tile-size-limit',
        '--no-feature-limit',
        '--detect-shared-borders',
        // Preserve coastline detail end-to-end. Tippecanoe's defaults
        // aggressively simplify and drop tiny polygons at high zooms, which
        // destroys the coastline indentations that define marina basins,
        // inland lagoons, and narrow harbour features. A larger tile buffer
        // (80, default 5) keeps polygon edges that hug a tile boundary intact.
        '--no-simplification',
        '--no-tiny-polygon-reduction',
        '--buffer=80',
        '--force'
      ],
      manifestContainerPath
    ),
    inputs: { '/input': mounts['/input'].source },
    outputs: { '/output': mounts['/output'].source },
    env: { TIPPECANOE_MAX_THREADS: String(tippecanoeThreads) },
    // Cap the helper at the budgeted thread count.  Without this the
    // env var only limits tippecanoe's worker threads — the kernel
    // scheduler still gives each worker its own core.
    resources: { cpus: tippecanoeThreads },
    signal,
    onStdoutLine: handleTippecanoeLine,
    onStderrLine: handleTippecanoeLine
  });

  throwIfJobCancelled(result);
  if (result.exitCode !== 0) {
    throwJobFailure(result, 'tippecanoe', report.log);
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
  label: string,
  report: ConversionReport,
  onPercent: ((pct: number) => void) | undefined,
  signal: AbortSignal | undefined,
  // The `name` metadata row to bake into the joined output, so it never
  // defaults to the `/output/` container path (issue #151).
  mbtilesName: string
): Promise<void> {
  if (inputMbtiles.length === 0) {
    throw new Error('runTileJoin called with no inputs');
  }
  if (inputMbtiles.length === 1) {
    // Degenerate case — every band but one was skipped (user maxzoom below
    // the remaining bands' floors). Move the single intermediate into place.
    // Fall back to copy+unlink across filesystems (chartPath on a USB mount
    // is the realistic case where rename returns EXDEV).
    if (signal?.aborted) {
      throw new Error(CONVERSION_ABORTED_MESSAGE);
    }
    try {
      fs.renameSync(inputMbtiles[0], outputMbtiles);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EXDEV') {
        throw err;
      }
      fs.copyFileSync(inputMbtiles[0], outputMbtiles);
      fs.unlinkSync(inputMbtiles[0]);
    }
    // No tile-join ran, so the moved intermediate still carries its
    // per-band tippecanoe `name` (the `/output/` default).
    stampMbtilesName(outputMbtiles, mbtilesName);
    onPercent?.(100);
    return;
  }

  // All intermediate `.mbtiles` live in the per-conversion tmpDir; the
  // final output lands in `chartsDir` (in-progress quarantine subdir).
  const inputDir = path.dirname(inputMbtiles[0]);
  for (const f of inputMbtiles) {
    if (path.dirname(f) !== inputDir) {
      throw new Error(`tile-join inputs must share a parent dir: ${f}`);
    }
  }
  const mounts = await resolveMounts(
    { '/input': inputDir, '/output': path.dirname(outputMbtiles) },
    'tile-join',
    report
  );
  const inputArgs = inputMbtiles.map((f) => `${mounts['/input'].prefix}/${path.basename(f)}`);
  const containerOutput = `${mounts['/output'].prefix}/${path.basename(outputMbtiles)}`;
  const tippecanoeThreads = getCpuBudget().tippecanoeThreadsPerJob;

  report.log(
    `Combining ${inputMbtiles.length} per-band tile sets into ${path.basename(outputMbtiles)}...`
  );
  report.debug(`Running tile-join on ${inputMbtiles.length} inputs`);

  // tile-join gives no usable streaming progress (it block-buffers its tile
  // coordinates to stderr until exit). Instead watch the output MBTiles grow
  // on disk: its final size is ~the sum of the inputs (per-band
  // intermediates have disjoint zoom ranges, so almost nothing dedupes).
  // Cap at 99%; snap to 100 once the job exits.
  const expectedBytes = inputMbtiles.reduce((sum, f) => {
    try {
      return sum + fs.statSync(f).size;
    } catch {
      return sum;
    }
  }, 0);
  let lastPct = 0;
  const pollOutputSize = (): void => {
    if (!onPercent || expectedBytes <= 0) {
      return;
    }
    let size: number;
    try {
      size = fs.statSync(outputMbtiles).size;
    } catch {
      return; // output not created yet
    }
    const pct = Math.min(99, Math.round((size / expectedBytes) * 100));
    if (pct > lastPct) {
      lastPct = pct;
      onPercent(pct);
    }
  };
  const sizeTimer = setInterval(pollOutputSize, 1000);

  // tile-join's coordinate lines all arrive in one burst at exit; keep them out
  // of the conversion log, but surface anything else (e.g. errors).
  const tileLineRe = /^\s*\d+\/\d+\/\d+/;
  const handleTileJoinLine = (line: string): void => {
    if (!tileLineRe.test(line)) {
      report.log(line);
    }
  };

  let result: Awaited<ReturnType<typeof runContainerJob>>;
  try {
    result = await runContainerJob({
      image: CHARTS_TOOLBOX_IMAGE,
      label: `tile-join-${label}`,
      command: withOutputChmod(
        [
          'tile-join',
          '-o',
          containerOutput,
          '-n',
          mbtilesName,
          '--no-tile-size-limit',
          '--force',
          ...inputArgs
        ],
        containerOutput
      ),
      inputs: { '/input': mounts['/input'].source },
      outputs: { '/output': mounts['/output'].source },
      env: { TIPPECANOE_MAX_THREADS: String(tippecanoeThreads) },
      resources: { cpus: tippecanoeThreads },
      signal,
      onStdoutLine: handleTileJoinLine,
      onStderrLine: handleTileJoinLine
    });
  } finally {
    clearInterval(sizeTimer);
  }

  throwIfJobCancelled(result);
  if (result.exitCode !== 0) {
    throwJobFailure(result, 'tile-join', report.log);
  }
  onPercent?.(100);
}

export interface ContainerS57Tiling {
  /** The cells to convert, one of each name. */
  encFiles: readonly string[];
  /** Scratch for this conversion, removed by the caller. */
  tmpDir: string;
  outputPath: string;
  /** Labels the helper jobs (`<stage>-<label>`), which orphan reaping parses. */
  label: string;
  /** The `name` metadata row to bake into the output. */
  mbtilesName: string;
  options: S57ConversionOptions;
  report: ConversionReport;
  statusFn: StatusCallback;
}

/**
 * Fill one bucket's GeoJSON dir: from the caller's `geojsonFor` when it has
 * the output already, otherwise by running GDAL on the bucket's cells, staged
 * into a bucket-scoped dir so the export only sees this bucket.
 */
async function geojsonForBucket(
  t: ContainerS57Tiling,
  cells: readonly string[],
  bucketEncDir: string,
  bucketGeojsonDir: string
): Promise<void> {
  if (t.options.geojsonFor) {
    await t.options.geojsonFor(cells, bucketGeojsonDir);
    return;
  }
  stageCells(cells, bucketEncDir);
  await exportCellsInContainer(bucketEncDir, bucketGeojsonDir, t.label, t.report, {
    multiFile: cells.length > 1,
    signal: t.options.signal
  });
}

/**
 * Per-band orchestrator: bucket the cells, run a separate
 * export → consolidate → tippecanoe pipeline for each band into its
 * own intermediate `.mbtiles`, then `tile-join` them into the final
 * output. Bands with no cells in the bundle are skipped.
 *
 * For the unbanded bucket (cells whose filenames don't match the IHO
 * Annex E convention — IENC, hand-named, custom producers) tippecanoe
 * runs over the user-requested zooms; that intermediate joins the rest
 * at the end.
 *
 * Each band's tippecanoe drop / coalesce / simplification heuristics see
 * only same-scale features: a sparse band-3 cell can no longer push a
 * dense band-5 harbour cell into the drop-densest pass.
 */
async function runPerBandPipeline(t: ContainerS57Tiling): Promise<void> {
  const { options, report, tmpDir } = t;
  const grouping = groupCellsByBand(t.encFiles);
  const userMinzoom = options.minzoom ?? 9;
  const userMaxzoom = options.maxzoom ?? 16;

  report.log(
    `Per-band pipeline: bands=[${grouping.bands.join(', ')}]` +
      (grouping.unbanded.length > 0 ? ` + ${grouping.unbanded.length} unbanded cell(s)` : '')
  );

  const intermediates: string[] = [];
  let bandIndex = 0;
  const totalBuckets = grouping.bands.length + (grouping.unbanded.length > 0 ? 1 : 0);

  // Structured progress for the Custom Catalogs UI. No-op when the caller
  // didn't pass an onProgress (upload / single-chart catalog flows).
  const emitBucket = (
    stage: S57BucketProgress['stage'],
    label: string,
    bucketPercent: number
  ): void => {
    options.onProgress?.({
      stage,
      bucketIndex: bandIndex,
      bucketCount: totalBuckets,
      bucketLabel: label,
      bucketPercent
    });
  };
  // Cooperative cancel at the next bucket boundary — the only cancel path on
  // signalk-container < 1.16.0, which cannot kill a running job.
  const abortIfRequested = (): void => {
    if (options.isAborted?.() || options.signal?.aborted) {
      throw new Error(CONVERSION_ABORTED_MESSAGE);
    }
  };

  const runBucket = async (
    cells: readonly string[],
    key: string,
    bucketLabel: string,
    prefix: string,
    zoom: { minzoom: number; maxzoom: number },
    tilesNote: string
  ): Promise<void> => {
    const bucketEncDir = path.join(tmpDir, `enc-${key}`);
    const bucketGeojsonDir = path.join(tmpDir, `geojson-${key}`);
    report.progress('converting', `${prefix} Exporting ${cells.length} cell(s)...`);
    report.log(
      options.geojsonFor
        ? `${prefix} Using the kept GeoJSON of ${cells.length} cell(s)`
        : `${prefix} Exporting ${cells.length} cell(s) to GeoJSON...`
    );
    emitBucket('export', bucketLabel, -1);
    fs.mkdirSync(bucketGeojsonDir, { recursive: true });
    makeContainerWritable(bucketGeojsonDir);
    await geojsonForBucket(t, cells, bucketEncDir, bucketGeojsonDir);

    report.progress(
      'converting',
      `${prefix} Generating tiles z${zoom.minzoom}-z${zoom.maxzoom}...`
    );
    report.log(`${prefix} Tippecanoe z${zoom.minzoom}-z${zoom.maxzoom}${tilesNote}`);
    emitBucket('tiles', bucketLabel, 0);
    const bucketMbtiles = path.join(tmpDir, `band-${key}.mbtiles`);
    await runTippecanoe(
      bucketGeojsonDir,
      bucketMbtiles,
      t.label,
      report,
      zoom,
      options.signal,
      (pct) => {
        emitBucket('tiles', bucketLabel, pct);
      }
    );
    intermediates.push(bucketMbtiles);
  };

  for (const band of grouping.bands) {
    bandIndex += 1;
    abortIfRequested();
    const cells = grouping.byBand.get(band) ?? [];
    const bandFloor = BAND_MIN_ZOOM[band] ?? userMinzoom;
    const bandCeiling = BAND_MAX_ZOOM[band] ?? userMaxzoom;
    const bandMinzoom = Math.max(userMinzoom, bandFloor);
    const bandMaxzoom = Math.min(userMaxzoom, bandCeiling);

    if (bandMinzoom > bandMaxzoom) {
      // User asked for z<bandFloor, which leaves this band with an
      // empty zoom range. Skip — tippecanoe would error and the band
      // wouldn't contribute anything visible anyway.
      report.log(
        `Band ${band}: skipped (user maxzoom z${userMaxzoom} below band floor z${bandFloor})`
      );
      continue;
    }

    // Surface the per-band clamp; both a floor-raise and a ceiling-clamp can
    // apply to the same band.
    const clampNotes: string[] = [];
    if (bandMinzoom > userMinzoom) {
      clampNotes.push(`raised to band floor z${bandFloor}`);
    }
    if (bandMaxzoom < userMaxzoom) {
      clampNotes.push(`clamped to band ceiling z${bandCeiling}`);
    }
    const clampNote = clampNotes.length > 0 ? `, ${clampNotes.join('; ')}` : '';
    report.log(
      `Band ${band}: z${bandMinzoom}-z${bandMaxzoom} (user requested z${userMinzoom}-z${userMaxzoom}${clampNote})`
    );
    await runBucket(
      cells,
      `band-${band}`,
      `Band ${band}`,
      `[band ${band} ${bandIndex}/${totalBuckets}]`,
      { minzoom: bandMinzoom, maxzoom: bandMaxzoom },
      ''
    );
  }

  if (grouping.unbanded.length > 0) {
    bandIndex += 1;
    abortIfRequested();
    await runBucket(
      grouping.unbanded,
      'unbanded',
      'Other charts',
      `[unbanded ${bandIndex}/${totalBuckets}]`,
      { minzoom: userMinzoom, maxzoom: userMaxzoom },
      ' (user-requested)'
    );
  }

  if (intermediates.length === 0) {
    throw new Error(
      'Per-band pipeline produced no intermediate tile sets — every band was skipped.'
    );
  }

  abortIfRequested();
  report.progress('converting', 'Combining per-band tile sets...');
  const emitJoin = (bucketPercent: number): void => {
    options.onProgress?.({
      stage: 'join',
      bucketIndex: totalBuckets,
      bucketCount: totalBuckets,
      bucketLabel: 'Combining',
      bucketPercent
    });
  };
  emitJoin(0);
  await runTileJoin(
    intermediates,
    t.outputPath,
    t.label,
    report,
    emitJoin,
    options.signal,
    t.mbtilesName
  );
}

/**
 * Tile S-57 cells into `outputPath` with the container toolchain. A bundle
 * with cells of more than one IHO band (or banded and unbanded cells) runs
 * one tippecanoe per band and tile-joins the results; a single-bucket bundle
 * runs one tippecanoe, its maxzoom clamped to the band's ceiling.
 */
export async function tileS57InContainer(t: ContainerS57Tiling): Promise<void> {
  const { options, report, tmpDir, encFiles } = t;
  makeContainerWritable(tmpDir);
  const grouping = groupCellsByBand(encFiles);
  const bucketCount = grouping.bands.length + (grouping.unbanded.length > 0 ? 1 : 0);

  if (bucketCount >= 2) {
    t.statusFn('converting', 'Running per-band conversion pipeline...');
    report.log(
      `Per-band pipeline selected: ${bucketCount} bucket(s) ` +
        `[bands ${grouping.bands.join(', ') || '(none)'}` +
        `${grouping.unbanded.length > 0 ? ` + ${grouping.unbanded.length} unbanded` : ''}]`
    );
    await runPerBandPipeline(t);
    return;
  }

  const emit = (stage: S57BucketProgress['stage'], bucketPercent: number): void => {
    options.onProgress?.({
      stage,
      bucketIndex: 1,
      bucketCount: 1,
      bucketLabel: 'Charts',
      bucketPercent
    });
  };
  const geojsonDir = path.join(tmpDir, 'geojson');
  fs.mkdirSync(geojsonDir, { recursive: true });
  makeContainerWritable(geojsonDir);

  t.statusFn('converting', 'Converting S-57 layers to GeoJSON...');
  report.progress('converting', `Exporting ${encFiles.length} ENC files...`);
  emit('export', -1);
  if (options.geojsonFor) {
    report.log(`Using the kept GeoJSON of ${encFiles.length} cell(s)`);
    await options.geojsonFor(encFiles, geojsonDir);
  } else {
    report.log(`Single-pass pipeline: ${encFiles.length} ENC file(s) in one GDAL container`);
    const encDir = path.join(tmpDir, 'enc');
    stageCells(encFiles, encDir);
    await exportCellsInContainer(encDir, geojsonDir, t.label, report, {
      multiFile: encFiles.length > 1,
      signal: options.signal
    });
  }
  if (options.isAborted?.() || options.signal?.aborted) {
    throw new Error(CONVERSION_ABORTED_MESSAGE);
  }

  t.statusFn('converting', 'Generating vector tiles...');
  report.progress('converting', 'Generating vector tiles with tippecanoe...');
  emit('tiles', 0);

  // Clamp tippecanoe's maxzoom to the IHO band ceiling. Most tippecanoe time
  // is spent at the highest zooms; if the only bucket is band-3 (coastal),
  // asking for z16 emits 4 zoom levels of tiles that can't be backed by real
  // feature precision.
  const userMaxzoom = options.maxzoom ?? 16;
  const clamp = bandClampedMaxzoom(
    encFiles.map((f) => path.basename(f)),
    userMaxzoom
  );
  if (clamp.highestBand !== null && clamp.effective < userMaxzoom) {
    report.log(
      `Detected IHO bands [${clamp.bands.join(', ')}] (highest = ${clamp.highestBand}) ` +
        `→ tippecanoe maxzoom clamped to z${clamp.effective} (was z${userMaxzoom})`
    );
  } else if (clamp.highestBand === null) {
    report.log(
      `No IHO band detected (likely IENC or non-conforming filenames); using user maxzoom z${userMaxzoom}`
    );
  }
  await runTippecanoe(
    geojsonDir,
    t.outputPath,
    t.label,
    report,
    { minzoom: options.minzoom ?? 9, maxzoom: clamp.effective },
    options.signal,
    (pct) => {
      emit('tiles', pct);
    },
    t.mbtilesName
  );
}

/**
 * Burn a land-polygon shapefile into a world raster (sand on sea blue) and
 * tile it into a PNG MBTiles at `outputPath`, with overview zooms down from
 * its native zoom (`gdaladdo` factors 2 to 256), in the charts-toolbox image.
 */
export async function rasterizeLandInContainer(opts: {
  shp: string;
  workDir: string;
  outputPath: string;
  width: number;
  label: string;
  report: ConversionReport;
}): Promise<void> {
  const { report, label } = opts;
  const outputName = path.basename(opts.outputPath);
  makeContainerWritable(opts.workDir);
  const mounts = await resolveMounts(
    {
      '/input': path.dirname(opts.shp),
      '/work': opts.workDir,
      '/output': path.dirname(opts.outputPath)
    },
    'Basemap conversion',
    report
  );
  const work = mounts['/work'].prefix;
  const output = `${mounts['/output'].prefix}/${outputName}`;

  report.log('Rasterizing shapefile...');
  const rasterizeResult = await runContainerJob({
    image: CHARTS_TOOLBOX_IMAGE,
    label: `gdal-rasterize-${label}`,
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
      String(opts.width),
      String(Math.round(opts.width / 2)),
      '-ot',
      'Byte',
      '-of',
      'GTiff',
      '-co',
      'COMPRESS=LZW',
      // From GSHHG's intermediate resolution up (and the high and full
      // shapefile basemaps) the raster is past 4 GB uncompressed, and even
      // compressed may outgrow a classic TIFF; GDAL only switches to BigTIFF
      // unasked when it can tell an uncompressed file needs it.
      '-co',
      'BIGTIFF=IF_SAFER',
      `${mounts['/input'].prefix}/${path.basename(opts.shp)}`,
      `${work}/world.tif`
    ],
    inputs: { '/input': mounts['/input'].source },
    outputs: { '/work': mounts['/work'].source },
    // gdal_rasterize is single-process; one core is enough.
    resources: { cpus: 1 },
    onStdoutLine: logLines(report),
    onStderrLine: logLines(report)
  });
  if (rasterizeResult.exitCode !== 0) {
    throwJobFailure(rasterizeResult, 'gdal_rasterize', report.log);
  }

  report.progress('converting', 'Creating MBTiles...');
  report.log('Creating MBTiles...');
  const translateResult = await runContainerJob({
    image: CHARTS_TOOLBOX_IMAGE,
    label: `gdal-translate-${label}`,
    command: [
      'gdal_translate',
      '-of',
      'MBTiles',
      '-co',
      'TILE_FORMAT=PNG',
      `${work}/world.tif`,
      output
    ],
    inputs: { '/work': mounts['/work'].source },
    outputs: { '/output': mounts['/output'].source },
    resources: { cpus: 1 },
    onStdoutLine: logLines(report),
    onStderrLine: logLines(report)
  });
  if (translateResult.exitCode !== 0) {
    throwJobFailure(translateResult, 'gdal_translate', report.log);
  }

  report.progress('converting', 'Adding zoom levels...');
  report.log('Adding overview zoom levels...');
  const overviewResult = await runContainerJob({
    image: CHARTS_TOOLBOX_IMAGE,
    label: `gdaladdo-${label}`,
    command: withOutputChmod(
      ['gdaladdo', '-r', 'average', output, '2', '4', '8', '16', '32', '64', '128', '256'],
      output
    ),
    outputs: { '/output': mounts['/output'].source },
    resources: { cpus: 1 },
    onStdoutLine: logLines(report),
    onStderrLine: logLines(report)
  });
  if (overviewResult.exitCode !== 0) {
    throwJobFailure(overviewResult, 'gdaladdo', report.log);
  }
}
