const { execFile, spawn } = require('child_process');
const https = require('https');
const fs = require('fs');
const path = require('path');
const unzipper = require('unzipper');

const GDAL_IMAGE = 'ghcr.io/osgeo/gdal:alpine-small-latest';
const TIPPECANOE_IMAGE = 'docker.io/klokantech/tippecanoe';

// In-memory progress tracking: chartNumber -> { status, message, log }
const conversionProgress = {};
const MAX_LOG_LINES = 100;

let debug = () => {};

function initS57Converter(debugFn) {
  debug = debugFn || (() => {});
}

function getConversionProgress(chartNumber) {
  return conversionProgress[chartNumber] || null;
}

function getAllConversionProgress() {
  return { ...conversionProgress };
}

/**
 * Check if Podman is available on the system
 */
function checkPodman() {
  return new Promise((resolve) => {
    execFile('podman', ['--version'], (error, stdout) => {
      if (error) {
        resolve({ available: false, version: null });
      } else {
        resolve({ available: true, version: stdout.trim() });
      }
    });
  });
}

/**
 * Check if a container image is available locally
 */
function checkImage(image) {
  return new Promise((resolve) => {
    execFile('podman', ['image', 'exists', image], (error) => {
      resolve(!error);
    });
  });
}

/**
 * Pull a container image
 */
function pullImage(image) {
  return new Promise((resolve, reject) => {
    debug(`Pulling image: ${image}`);
    execFile('podman', ['pull', image], { timeout: 600000 }, (error, _stdout, stderr) => {
      if (error) {
        reject(new Error(`Failed to pull ${image}: ${stderr || error.message}`));
      } else {
        debug(`Image pulled: ${image}`);
        resolve();
      }
    });
  });
}

/**
 * Extract a ZIP preserving directory structure
 */
async function extractZip(zipPath, targetDir) {
  await fs
    .createReadStream(zipPath)
    .pipe(unzipper.Extract({ path: targetDir }))
    .promise();

  const allFiles = [];
  const scan = (dir) => {
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

/**
 * Find all .000 ENC files recursively in a directory
 */
function findEncFiles(dir) {
  const files = [];
  const scan = (d) => {
    const entries = fs.readdirSync(d, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(d, entry.name);
      if (entry.isDirectory()) {
        scan(fullPath);
      } else if (entry.name.endsWith('.000')) {
        files.push(fullPath);
      }
    }
  };
  scan(dir);
  return files;
}

/**
 * Export ALL S-57 layers from ALL .000 files to GeoJSON in a single container run.
 * This is much faster than spawning a container per layer.
 */
function exportAllLayersToGeoJSON(encDir, encFiles, geojsonDir, chartNumber) {
  // Build a shell script that finds and processes all .000 files and their layers
  const skipLayers = ['DSID', 'C_AGGR', 'C_ASSO', 'Generic'];
  const multiFile = encFiles.length > 1;

  // Shell script: find all .000 files recursively, export each layer to GeoJSON
  const script = `
set -e
enc_files=$(find /input -name '*.000' -type f)
count=$(echo "$enc_files" | wc -l)
i=0
for enc in $enc_files; do
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

  return new Promise((resolve, reject) => {
    const child = spawn(
      'podman',
      [
        'run',
        '--rm',
        '-v',
        `${encDir}:/input:ro,Z`,
        '-v',
        `${geojsonDir}:/output:Z`,
        GDAL_IMAGE,
        'sh',
        '-c',
        script
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );

    child.stdout.on('data', (data) => {
      const text = data.toString().trim();
      if (text) {
        appendLog(chartNumber, text);
        const match = text.match(/PROGRESS: Processing (\S+)/);
        if (match) {
          setProgress(chartNumber, 'converting', `Exporting ${match[1]}...`);
        }
      }
    });

    child.stderr.on('data', (data) => {
      const text = data.toString().trim();
      if (text) {
        appendLog(chartNumber, text);
      }
    });

    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`GDAL export failed with exit code ${code}`));
      } else {
        resolve();
      }
    });

    child.on('error', (err) => {
      reject(new Error(`Failed to start GDAL container: ${err.message}`));
    });
  });
}

/**
 * Run tippecanoe to combine GeoJSON layers into a single MBTiles
 */
function runTippecanoe(geojsonDir, outputMbtiles, chartNumber, options = {}) {
  const minzoom = options.minzoom || 9;
  const maxzoom = options.maxzoom || 16;

  // Build layer args: group files by layer name
  const files = fs.readdirSync(geojsonDir).filter((f) => f.endsWith('.geojson'));
  const layerArgs = [];
  for (const file of files) {
    const fullPath = path.join(geojsonDir, file);
    const size = fs.statSync(fullPath).size;
    if (size <= 100) {
      continue;
    }

    // Extract layer name (remove _cellname suffix)
    const base = path.basename(file, '.geojson');
    const layer = base.replace(/_[A-Za-z0-9]+$/, '');
    layerArgs.push('-L', `${layer}:/input/${file}`);
  }

  if (layerArgs.length === 0) {
    return Promise.reject(new Error('No valid GeoJSON layers to process'));
  }

  return new Promise((resolve, reject) => {
    const args = [
      'run',
      '--rm',
      '-v',
      `${geojsonDir}:/input:ro,Z`,
      '-v',
      `${path.dirname(outputMbtiles)}:/output:Z`,
      TIPPECANOE_IMAGE,
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
    ];

    debug(`Running tippecanoe with ${layerArgs.length / 2} layers, zoom ${minzoom}-${maxzoom}`);

    const child = spawn('podman', args, {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    child.stdout.on('data', (data) => {
      const text = data.toString().trim();
      if (text) {
        appendLog(chartNumber, text);
      }

      // Parse progress percentage
      const match = text.match(/(\d+\.\d+)%/);
      if (match && chartNumber && conversionProgress[chartNumber]) {
        const pct = parseFloat(match[1]);
        conversionProgress[chartNumber].message = `Generating tiles: ${Math.round(pct)}%`;
      }
    });

    child.stderr.on('data', (data) => {
      const text = data.toString().trim();
      if (text) {
        appendLog(chartNumber, text);
      }
    });

    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`tippecanoe failed with exit code ${code}`));
      } else {
        resolve();
      }
    });

    child.on('error', (err) => {
      reject(new Error(`Failed to start tippecanoe: ${err.message}`));
    });
  });
}

function appendLog(chartNumber, text) {
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

/**
 * Full pipeline: ZIP → extract → ogr2ogr (S-57→GeoJSON) → tippecanoe → MBTiles
 *
 * Produces a SINGLE vector MBTiles file with all S-57 layers from all ENC cells.
 * No cell splitting, no SCAMIN filtering, no black spots.
 *
 * @param {string} zipPath - Path to the downloaded ZIP file
 * @param {string} chartsDir - Directory where the output .mbtiles will be placed
 * @param {string} chartNumber - Chart identifier for tracking
 * @param {function} onStatus - Status callback
 * @param {object} options - { minzoom, maxzoom }
 * @returns {Promise<{mbtilesFile: string}>} Filename of created .mbtiles
 */
async function processS57Zip(zipPath, chartsDir, chartNumber, onStatus, options = {}) {
  const statusFn = onStatus || (() => {});
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
    // Step 1: Check Podman
    statusFn('checking', 'Checking Podman...');
    const podman = await checkPodman();
    if (!podman.available) {
      throw new Error('Podman is not installed.');
    }

    // Step 2: Pull images if needed
    statusFn('pulling', 'Checking container images...');
    setProgress(chartNumber, 'pulling', 'Checking GDAL image...');
    if (!(await checkImage(GDAL_IMAGE))) {
      setProgress(chartNumber, 'pulling', 'Pulling GDAL image...');
      await pullImage(GDAL_IMAGE);
    }
    setProgress(chartNumber, 'pulling', 'Checking tippecanoe image...');
    if (!(await checkImage(TIPPECANOE_IMAGE))) {
      setProgress(chartNumber, 'pulling', 'Pulling tippecanoe image...');
      await pullImage(TIPPECANOE_IMAGE);
    }

    // Step 3: Extract ZIP
    statusFn('extracting', 'Extracting ENC files...');
    setProgress(chartNumber, 'extracting', 'Extracting ENC files...');
    let extracted;
    try {
      extracted = await extractZip(zipPath, encDir);
    } catch (zipErr) {
      throw new Error(
        `Downloaded file is not a valid ZIP archive (${zipErr.message}). The server may have returned an error page instead.`
      );
    }
    debug(`Extracted ${extracted.length} files from ZIP`);

    if (extracted.length === 0) {
      throw new Error('No files found in ZIP archive');
    }

    // Step 4: Find .000 files
    const encFiles = findEncFiles(encDir);
    if (encFiles.length === 0) {
      throw new Error('No S-57 ENC files (.000) found in ZIP');
    }
    debug(`Found ${encFiles.length} ENC files`);
    appendLog(chartNumber, `Found ${encFiles.length} ENC files`);

    // Step 5: Export ALL layers from ALL .000 files in a single container
    statusFn('converting', 'Converting S-57 layers to GeoJSON...');
    setProgress(chartNumber, 'converting', `Exporting ${encFiles.length} ENC files...`);
    appendLog(chartNumber, `Exporting ${encFiles.length} ENC files in single GDAL container...`);

    await exportAllLayersToGeoJSON(encDir, encFiles, geojsonDir, chartNumber);

    // Step 6: Run tippecanoe
    statusFn('converting', 'Generating vector tiles...');
    setProgress(chartNumber, 'converting', 'Generating vector tiles with tippecanoe...');

    const outputName = `${chartNumber || 'enc-chart'}.mbtiles`;
    const outputPath = path.join(chartsDir, outputName);
    await runTippecanoe(geojsonDir, outputPath, chartNumber, options);

    if (!fs.existsSync(outputPath)) {
      throw new Error('tippecanoe completed but output file not found');
    }

    // Patch MBTiles metadata so Freeboard-SK uses S-52 rendering
    try {
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(outputPath);
      db.prepare("INSERT OR REPLACE INTO metadata (name, value) VALUES ('type', 'S-57')").run();
      db.prepare("INSERT OR REPLACE INTO metadata (name, value) VALUES ('name', ?)").run(
        `S-57 ${chartNumber || 'ENC'}`
      );
      db.close();
      debug(`Set MBTiles type=S-57 for ${outputName}`);
    } catch (metaErr) {
      debug(`Warning: failed to patch MBTiles metadata: ${metaErr.message}`);
    }

    const size = (fs.statSync(outputPath).size / (1024 * 1024)).toFixed(1);
    statusFn('completed', `Created ${outputName} (${size} MB)`);
    appendLog(chartNumber, `Done: ${outputName} (${size} MB)`);

    // Clean up progress on success
    if (chartNumber) {
      delete conversionProgress[chartNumber];
    }

    return { mbtilesFile: outputName };
  } catch (err) {
    if (chartNumber) {
      conversionProgress[chartNumber] = {
        status: 'failed',
        message: err.message || 'Conversion failed',
        log: conversionProgress[chartNumber] ? conversionProgress[chartNumber].log || [] : []
      };
      setTimeout(() => {
        delete conversionProgress[chartNumber];
      }, 300000);
    }
    throw err;
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_e) {
      debug(`Warning: failed to clean up ${tmpDir}`);
    }
  }
}

function setProgress(chartNumber, status, message) {
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

const GSHHG_URL = 'https://www.ngdc.noaa.gov/mgg/shorelines/data/gshhg/latest/gshhg-shp-2.3.7.zip';

/**
 * Download and convert GSHHG world basemap to vector MBTiles.
 * Downloads shapefile ZIP from NOAA, extracts land + lakes layers, runs tippecanoe.
 */
async function processGshhg(tmpDir, chartsDir, resolution, chartNumber, onStatus) {
  const statusFn = onStatus || (() => {});
  const resLabels = { c: 'Crude', l: 'Low', i: 'Intermediate', h: 'High', f: 'Full' };

  setProgress(chartNumber, 'converting', 'Downloading GSHHG shapefiles from NOAA...');
  appendLog(chartNumber, `Downloading GSHHG shapefiles (${resLabels[resolution]})...`);

  // Download the shapefile ZIP
  const zipPath = path.join(tmpDir, 'gshhg-shp.zip');
  await new Promise((resolve, reject) => {
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
                  file.close(resolve);
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
        const totalBytes = parseInt(response.headers['content-length'] || '0');
        let downloadedBytes = 0;
        response.on('data', (chunk) => {
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
          file.close(resolve);
        });
      })
      .on('error', reject);
  });

  appendLog(chartNumber, 'Download complete. Extracting shapefiles...');
  setProgress(chartNumber, 'converting', 'Extracting shapefiles...');

  // Extract only the needed resolution
  const shpDir = path.join(tmpDir, 'shp');
  fs.mkdirSync(shpDir, { recursive: true });

  await fs
    .createReadStream(zipPath)
    .pipe(unzipper.Extract({ path: shpDir }))
    .promise();

  // Rasterize shapefiles to MBTiles (raster PNG tiles)
  // Resolution per GSHHG level — higher = more detail but larger file
  const rasterSizes = { c: 8192, l: 16384, i: 65536, h: 131072, f: 262144 };
  const rasterSize = rasterSizes[resolution] || 32768;

  appendLog(chartNumber, `Rasterizing land polygons (${rasterSize}px width)...`);
  setProgress(chartNumber, 'converting', 'Rasterizing land polygons...');

  const outputName = `gshhg-basemap-${resolution}.mbtiles`;
  const outputPath = path.join(chartsDir, outputName);

  await new Promise((resolve, reject) => {
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

    const child = spawn(
      'podman',
      [
        'run',
        '--rm',
        '-v',
        `${shpDir}:/input:ro,Z`,
        '-v',
        `${tmpDir}:/work:Z`,
        '-v',
        `${chartsDir}:/output:Z`,
        GDAL_IMAGE,
        'sh',
        '-c',
        script
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );

    child.stdout.on('data', (data) => {
      const text = data.toString().trim();
      if (text) {
        appendLog(chartNumber, text);
        if (text.includes('Creating MBTiles')) {
          setProgress(chartNumber, 'converting', 'Creating MBTiles...');
        } else if (text.includes('Adding overview')) {
          setProgress(chartNumber, 'converting', 'Adding zoom levels...');
        }
      }
    });

    child.stderr.on('data', (data) => {
      const text = data.toString().trim();
      if (text) {
        appendLog(chartNumber, text);
      }
    });

    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`GDAL rasterization failed (exit ${code})`));
      } else {
        resolve();
      }
    });

    child.on('error', (err) => {
      reject(new Error(`Failed to start GDAL: ${err.message}`));
    });
  });

  // Set metadata for Freeboard-SK raster rendering
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(outputPath);
    db.prepare("INSERT OR REPLACE INTO metadata (name, value) VALUES ('name', ?)").run(
      `GSHHG World Basemap (${resLabels[resolution]})`
    );
    db.prepare("INSERT OR REPLACE INTO metadata (name, value) VALUES ('description', ?)").run(
      `Global coastlines and lakes - GSHHG v2.3.7 ${resLabels[resolution].toLowerCase()} resolution`
    );
    db.prepare("INSERT OR REPLACE INTO metadata (name, value) VALUES ('type', 'tilelayer')").run();
    db.prepare("INSERT OR REPLACE INTO metadata (name, value) VALUES ('format', 'png')").run();
    db.close();
  } catch (_e) {
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

/**
 * Process a .tar.xz containing shapefiles (OSM basemap) into raster MBTiles.
 * Downloads .tar.xz, extracts, finds land .shp, rasterizes to MBTiles.
 *
 * @param {string} tarPath - Path to the downloaded .tar.xz file
 * @param {string} chartsDir - Output directory
 * @param {string} chartNumber - e.g., 'basemap_i'
 * @param {function} onStatus - Status callback
 * @returns {Promise<{mbtilesFile: string}>}
 */
async function processShpBasemap(tarPath, chartsDir, chartNumber, onStatus) {
  const statusFn = onStatus || (() => {});
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
    const podman = await checkPodman();
    if (!podman.available) {
      throw new Error('Podman is not installed.');
    }

    // Extract .tar.xz using GDAL container
    setProgress(chartNumber, 'extracting', 'Extracting shapefiles...');
    appendLog(chartNumber, 'Extracting .tar.xz archive...');

    await new Promise((resolve, reject) => {
      execFile(
        'podman',
        [
          'run',
          '--rm',
          '-v',
          `${path.dirname(tarPath)}:/archive:ro,Z`,
          '-v',
          `${tmpDir}:/output:Z`,
          GDAL_IMAGE,
          'sh',
          '-c',
          `tar -xf /archive/${path.basename(tarPath)} -C /output && echo DONE`
        ],
        { timeout: 120000 },
        (error, _stdout, stderr) => {
          if (error) {
            reject(new Error(`tar extraction failed: ${stderr || error.message}`));
          } else {
            resolve();
          }
        }
      );
    });

    // Find the land polygon shapefile (L1 = land)
    let landShp = null;
    const findShp = (dir, prefix) => {
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
    // Try to find land polygons
    landShp = findShp(tmpDir, 'L1') || findShp(tmpDir, 'land') || findShp(tmpDir, null);

    if (!landShp) {
      throw new Error('No .shp files found in archive');
    }

    debug(`Found shapefile: ${landShp}`);
    appendLog(chartNumber, `Found: ${path.basename(landShp)}`);

    // Determine resolution from chart number
    const resMap = {
      basemap_c: { size: 8192, label: 'Crude' },
      basemap_l: { size: 16384, label: 'Low' },
      basemap_i: { size: 32768, label: 'Medium' },
      basemap_h: { size: 65536, label: 'High' },
      basemap_f: { size: 131072, label: 'Full' }
    };
    const res = resMap[chartNumber] || { size: 32768, label: 'Medium' };

    // Rasterize
    setProgress(chartNumber, 'converting', `Rasterizing (${res.label})...`);
    appendLog(chartNumber, `Rasterizing at ${res.size}px width...`);

    const outputName = `osm-basemap-${chartNumber.replace('basemap_', '')}.mbtiles`;
    const outputPath = path.join(chartsDir, outputName);
    const shpDir = path.dirname(landShp);
    const shpName = path.basename(landShp);

    await new Promise((resolve, reject) => {
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
      const child = spawn(
        'podman',
        [
          'run',
          '--rm',
          '-v',
          `${shpDir}:/input:ro,Z`,
          '-v',
          `${tmpDir}:/work:Z`,
          '-v',
          `${chartsDir}:/output:Z`,
          GDAL_IMAGE,
          'sh',
          '-c',
          script
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] }
      );

      child.stdout.on('data', (data) => {
        const text = data.toString().trim();
        if (text) {
          appendLog(chartNumber, text);
        }
      });
      child.stderr.on('data', (data) => {
        const text = data.toString().trim();
        if (text) {
          appendLog(chartNumber, text);
        }
      });
      child.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`GDAL rasterization failed (exit ${code})`));
        } else {
          resolve();
        }
      });
      child.on('error', (err) => reject(new Error(`Failed to start GDAL: ${err.message}`)));
    });

    // Set metadata
    try {
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(outputPath);
      db.prepare("INSERT OR REPLACE INTO metadata (name, value) VALUES ('name', ?)").run(
        `OSM Basemap (${res.label})`
      );
      db.prepare(
        "INSERT OR REPLACE INTO metadata (name, value) VALUES ('type', 'tilelayer')"
      ).run();
      db.prepare("INSERT OR REPLACE INTO metadata (name, value) VALUES ('format', 'png')").run();
      db.close();
    } catch (_e) {
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
        message: err.message || 'Conversion failed',
        log: conversionProgress[chartNumber] ? conversionProgress[chartNumber].log || [] : []
      };
      setTimeout(() => delete conversionProgress[chartNumber], 300000);
    }
    throw err;
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_e) {
      // ignore
    }
  }
}

module.exports = {
  initS57Converter,
  checkPodman,
  processS57Zip,
  processGshhg,
  processShpBasemap,
  getConversionProgress,
  getAllConversionProgress
};
