import https from 'https';
import fs from 'fs';
import path from 'path';
import unzipper from 'unzipper';
import { TIPPECANOE_THREADS_PER_JOB } from './concurrency';
import {
  checkContainerRuntime,
  imageExists as runtimeImageExists,
  pullImage as runtimePullImage,
  runContainer
} from './container-runtime';
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

async function exportAllLayersToGeoJSON(
  encDir: string,
  encFiles: string[],
  geojsonDir: string,
  chartNumber: string
): Promise<void> {
  const skipLayers = ['DSID', 'C_AGGR', 'C_ASSO', 'Generic'];
  const multiFile = encFiles.length > 1;

  const script = `
set -e
count=$(find /input -name '*.000' ! -name '._*' -type f | wc -l)
i=0
find /input -name '*.000' ! -name '._*' -type f -print0 | while IFS= read -r -d '' enc; do
  i=$((i + 1))
  name=$(basename "$enc" .000)
  echo "PROGRESS: Processing $name ($i/$count)"
  layers=$(ogrinfo -so "$enc" 2>/dev/null | grep -E '^[0-9]+:' | awk -F': ' '{print $2}' | awk '{print $1}')
  for layer in $layers; do
    case "$layer" in ${skipLayers.join('|')}) continue ;; esac
    outname="${multiFile ? '${layer}_${name}' : '${layer}'}"
    ogr2ogr -f GeoJSON "/output/$outname.geojson" "$enc" "$layer" 2>/dev/null || true
  done
done
echo "PROGRESS: Export complete"
`;

  const result = await runContainer({
    image: GDAL_IMAGE,
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

async function runTippecanoe(
  geojsonDir: string,
  outputMbtiles: string,
  chartNumber: string,
  options: S57ConversionOptions = {}
): Promise<void> {
  const minzoom = options.minzoom ?? 9;
  const maxzoom = options.maxzoom ?? 16;

  const files = fs.readdirSync(geojsonDir).filter((f) => f.endsWith('.geojson'));
  const layerArgs: string[] = [];
  for (const file of files) {
    const fullPath = path.join(geojsonDir, file);
    const size = fs.statSync(fullPath).size;
    if (size <= 100) {
      continue;
    }

    const base = path.basename(file, '.geojson');
    const layer = base.replace(/_[A-Za-z0-9]+$/, '');
    layerArgs.push('-L', `${layer}:/input/${file}`);
  }

  if (layerArgs.length === 0) {
    throw new Error('No valid GeoJSON layers to process');
  }

  debug(
    `Running tippecanoe with ${layerArgs.length / 2} layers, zoom ${minzoom}-${maxzoom}, ${TIPPECANOE_THREADS_PER_JOB} threads`
  );

  const result = await runContainer({
    image: TIPPECANOE_IMAGE,
    cmd: [
      'tippecanoe',
      '-o',
      `/output/${path.basename(outputMbtiles)}`,
      '-z',
      String(maxzoom),
      '-Z',
      String(minzoom),
      '--no-tile-size-limit',
      '--force',
      ...layerArgs
    ],
    binds: [`${geojsonDir}:/input:ro`, `${path.dirname(outputMbtiles)}:/output`],
    env: [`TIPPECANOE_MAX_THREADS=${TIPPECANOE_THREADS_PER_JOB}`],
    onStdoutLine: (line) => {
      appendLog(chartNumber, line);
      const match = line.match(/(\d+\.\d+)%/);
      if (match && chartNumber && conversionProgress[chartNumber]) {
        const pct = parseFloat(match[1]);
        conversionProgress[chartNumber].message = `Generating tiles: ${Math.round(pct)}%`;
      }
    },
    onStderrLine: (line) => appendLog(chartNumber, line)
  });

  if (result.exitCode !== 0) {
    throw new Error(`tippecanoe failed with exit code ${result.exitCode}`);
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

    const outputName = `${chartNumber || 'enc-chart'}.mbtiles`;
    const outputPath = path.join(chartsDir, outputName);
    await runTippecanoe(geojsonDir, outputPath, chartNumber, options);

    if (!fs.existsSync(outputPath)) {
      throw new Error('tippecanoe completed but output file not found');
    }

    try {
      const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
      const db = new DatabaseSync(outputPath);
      db.prepare("INSERT OR REPLACE INTO metadata (name, value) VALUES ('type', 'S-57')").run();
      db.prepare("INSERT OR REPLACE INTO metadata (name, value) VALUES ('name', ?)").run(
        `S-57 ${chartNumber || 'ENC'}`
      );
      db.close();
      debug(`Set MBTiles type=S-57 for ${outputName}`);
    } catch (metaErr) {
      debug(
        `Warning: failed to patch MBTiles metadata: ${metaErr instanceof Error ? metaErr.message : String(metaErr)}`
      );
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

  const script = `
set -e
echo "Rasterizing shapefile..."
gdal_rasterize \
  -burn 240 -burn 230 -burn 208 \
  -init 168 -init 212 -init 230 \
  -a_srs EPSG:4326 \
  -te -180 -85.05 180 85.05 \
  -ts ${rasterSize} ${Math.round(rasterSize / 2)} \
  -ot Byte \
  -of GTiff \
  -co COMPRESS=LZW \
  /input/GSHHS_shp/${resolution}/GSHHS_${resolution}_L1.shp /work/world.tif
echo "Creating MBTiles..."
gdal_translate \
  -of MBTiles \
  -co TILE_FORMAT=PNG \
  /work/world.tif /output/${outputName}
echo "Adding overview zoom levels..."
gdaladdo -r average /output/${outputName} 2 4 8 16 32 64 128 256
echo "DONE"
`;

  const result = await runContainer({
    image: GDAL_IMAGE,
    cmd: ['sh', '-c', script],
    binds: [`${shpDir}:/input:ro`, `${tmpDir}:/work`, `${chartsDir}:/output`],
    onStdoutLine: (line) => {
      appendLog(chartNumber, line);
      if (line.includes('Creating MBTiles')) {
        setProgress(chartNumber, 'converting', 'Creating MBTiles...');
      } else if (line.includes('Adding overview')) {
        setProgress(chartNumber, 'converting', 'Adding zoom levels...');
      }
    },
    onStderrLine: (line) => appendLog(chartNumber, line)
  });

  if (result.exitCode !== 0) {
    throw new Error(`GDAL rasterization failed (exit ${result.exitCode})`);
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

    setProgress(chartNumber, 'extracting', 'Extracting shapefiles...');
    appendLog(chartNumber, 'Extracting .tar.xz archive...');

    const tarResult = await runContainer({
      image: GDAL_IMAGE,
      cmd: ['sh', '-c', `tar -xf /archive/${path.basename(tarPath)} -C /output && echo DONE`],
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

    const script = `
set -e
echo "Rasterizing..."
gdal_rasterize \
  -burn 240 -burn 230 -burn 208 \
  -init 168 -init 212 -init 230 \
  -a_srs EPSG:4326 \
  -te -180 -85.05 180 85.05 \
  -ts ${res.size} ${Math.round(res.size / 2)} \
  -ot Byte -of GTiff -co COMPRESS=LZW \
  /input/${shpName} /work/world.tif
echo "Creating MBTiles..."
gdal_translate -of MBTiles -co TILE_FORMAT=PNG /work/world.tif /output/${outputName}
echo "Adding zoom levels..."
gdaladdo -r average /output/${outputName} 2 4 8 16 32 64 128 256
echo "DONE"
`;
    const result = await runContainer({
      image: GDAL_IMAGE,
      cmd: ['sh', '-c', script],
      binds: [`${shpDir}:/input:ro`, `${tmpDir}:/work`, `${chartsDir}:/output`],
      onStdoutLine: (line) => appendLog(chartNumber, line),
      onStderrLine: (line) => appendLog(chartNumber, line)
    });

    if (result.exitCode !== 0) {
      throw new Error(`GDAL rasterization failed (exit ${result.exitCode})`);
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
