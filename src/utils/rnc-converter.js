const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const unzipper = require('unzipper');

const GDAL_IMAGE = 'ghcr.io/osgeo/gdal:alpine-small-latest';

// In-memory progress tracking: chartNumber -> { status, message, log }
const conversionProgress = {};
const MAX_LOG_LINES = 100;

let debug = () => {};

function initRncConverter(debugFn) {
  debug = debugFn || (() => {});
}

function getConversionProgress(chartNumber) {
  return conversionProgress[chartNumber] || null;
}

function getAllConversionProgress() {
  return { ...conversionProgress };
}

/**
 * Check if the GDAL image is available locally
 */
function checkGdalImage() {
  return new Promise((resolve) => {
    execFile('podman', ['image', 'exists', GDAL_IMAGE], (error) => {
      resolve(!error);
    });
  });
}

/**
 * Pull the GDAL image
 */
function pullGdalImage() {
  return new Promise((resolve, reject) => {
    debug('Pulling GDAL image...');
    execFile('podman', ['pull', GDAL_IMAGE], { timeout: 300000 }, (error, _stdout, stderr) => {
      if (error) {
        reject(new Error(`Failed to pull GDAL image: ${stderr || error.message}`));
      } else {
        debug('GDAL image pulled successfully');
        resolve();
      }
    });
  });
}

/**
 * Extract a ZIP file to a target directory
 * Returns array of extracted file paths
 */
async function extractZip(zipPath, targetDir) {
  // Extract preserving directory structure, then collect all files
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
 * Convert a single BSB .kap file to MBTiles using GDAL in Podman.
 *
 * @param {string} kapFile - Full path to .kap file
 * @param {string} outputDir - Directory where .mbtiles will be written
 * @param {string} chartNumber - For progress tracking
 * @returns {Promise<string>} Path to the created .mbtiles file
 */
function convertKapToMbtiles(kapFile, outputDir, chartNumber) {
  const baseName = path.basename(kapFile, path.extname(kapFile));
  const outputFile = path.join(outputDir, `${baseName}.mbtiles`);
  const kapDir = path.dirname(kapFile);

  return new Promise((resolve, reject) => {
    // gdal_translate -of MBTiles -co TILE_FORMAT=PNG input.kap output.mbtiles
    const args = [
      'run',
      '--rm',
      '-v',
      `${kapDir}:/input:ro,Z`,
      '-v',
      `${outputDir}:/output:Z`,
      GDAL_IMAGE,
      'gdal_translate',
      '-of',
      'MBTiles',
      '-co',
      'TILE_FORMAT=PNG',
      `/input/${path.basename(kapFile)}`,
      `/output/${baseName}.mbtiles`
    ];

    debug(`Running: podman ${args.join(' ')}`);

    const child = spawn('podman', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 0
    });

    let output = '';

    child.stdout.on('data', (data) => {
      output += data.toString();
      appendLog(chartNumber, data.toString().trim());
    });

    child.stderr.on('data', (data) => {
      output += data.toString();
      appendLog(chartNumber, data.toString().trim());
    });

    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`gdal_translate failed (exit ${code}): ${output}`));
        return;
      }

      if (!fs.existsSync(outputFile)) {
        reject(new Error(`gdal_translate succeeded but output file not found: ${outputFile}`));
        return;
      }

      // Run gdaladdo to add overviews (zoom levels) for better performance
      addOverviews(outputFile, chartNumber)
        .then(() => resolve(outputFile))
        .catch(() => {
          // Overviews are optional, proceed without them
          debug(`Warning: failed to add overviews for ${baseName}`);
          resolve(outputFile);
        });
    });

    child.on('error', (err) => {
      reject(new Error(`Failed to start podman: ${err.message}`));
    });
  });
}

/**
 * Add overview zoom levels to an MBTiles file using gdaladdo
 */
function addOverviews(mbtilesFile, chartNumber) {
  const dir = path.dirname(mbtilesFile);
  const name = path.basename(mbtilesFile);

  return new Promise((resolve, reject) => {
    const args = [
      'run',
      '--rm',
      '-v',
      `${dir}:/data:Z`,
      GDAL_IMAGE,
      'gdaladdo',
      '-r',
      'average',
      `/data/${name}`,
      '2',
      '4',
      '8',
      '16'
    ];

    appendLog(chartNumber, `Adding overview zoom levels for ${name}...`);

    const child = execFile('podman', args, { timeout: 300000 }, (error, _stdout, stderr) => {
      if (error) {
        appendLog(chartNumber, `Warning: gdaladdo failed: ${stderr || error.message}`);
        reject(error);
      } else {
        appendLog(chartNumber, `Overviews added for ${name}`);
        resolve();
      }
    });

    child.on('error', reject);
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
 * Full pipeline: Download ZIP → extract → convert BSB/KAP → MBTiles.
 *
 * @param {string} zipPath - Path to the downloaded ZIP file
 * @param {string} chartsDir - The plugin's charts directory where .mbtiles will go
 * @param {string} chartNumber - For progress tracking
 * @param {function} onStatus - Status callback
 * @returns {Promise<{mbtilesFiles: string[]}>} Created .mbtiles filenames
 */
async function processRncZip(zipPath, chartsDir, chartNumber, onStatus) {
  const statusFn = onStatus || (() => {});
  const { checkPodman } = require('./s57-converter');

  // Create temp dir for extracted BSB files
  const tmpDir = path.join(path.dirname(zipPath), `rnc_${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  // Initialize progress tracking
  if (chartNumber) {
    conversionProgress[chartNumber] = {
      status: 'starting',
      message: 'Starting RNC conversion...',
      log: []
    };
  }

  try {
    // Step 1: Check Podman
    statusFn('checking', 'Checking Podman availability...');
    const podman = await checkPodman();
    if (!podman.available) {
      throw new Error('Podman is not installed. RNC chart conversion requires Podman.');
    }

    // Step 2: Check/pull GDAL image
    statusFn('pulling', 'Checking GDAL image...');
    const imageExists = await checkGdalImage();
    if (!imageExists) {
      statusFn('pulling', 'Pulling GDAL image (first time only)...');
      if (chartNumber) {
        conversionProgress[chartNumber].status = 'pulling';
        conversionProgress[chartNumber].message = 'Pulling GDAL image...';
      }
      await pullGdalImage();
    }

    // Step 3: Extract ZIP
    statusFn('extracting', 'Extracting BSB chart files from ZIP...');
    if (chartNumber) {
      conversionProgress[chartNumber].status = 'extracting';
      conversionProgress[chartNumber].message = 'Extracting BSB files...';
    }
    let extracted;
    try {
      extracted = await extractZip(zipPath, tmpDir);
    } catch (zipErr) {
      throw new Error(
        `Downloaded file is not a valid ZIP archive (${zipErr.message}). The server may have returned an error page instead.`
      );
    }
    debug(`Extracted ${extracted.length} files from ZIP`);

    if (extracted.length === 0) {
      throw new Error('No files found in ZIP archive');
    }

    // Find .kap files (BSB raster chart format)
    const kapFiles = extracted.filter(
      (f) => f.toLowerCase().endsWith('.kap') || f.toLowerCase().endsWith('.bsb')
    );

    if (kapFiles.length === 0) {
      throw new Error('No .kap or .bsb files found in ZIP archive');
    }

    debug(`Found ${kapFiles.length} BSB chart file(s) to convert`);
    appendLog(chartNumber, `Found ${kapFiles.length} BSB chart file(s)`);

    // Step 4: Convert each .kap to .mbtiles
    statusFn('converting', `Converting ${kapFiles.length} BSB chart(s) to MBTiles...`);
    if (chartNumber) {
      conversionProgress[chartNumber].status = 'converting';
    }

    const mbtilesFiles = [];
    for (let i = 0; i < kapFiles.length; i++) {
      const kap = kapFiles[i];
      const name = path.basename(kap);
      if (chartNumber) {
        conversionProgress[chartNumber].message =
          `Converting ${name} (${i + 1}/${kapFiles.length})...`;
      }
      appendLog(chartNumber, `Converting ${name}...`);

      try {
        const mbtiles = await convertKapToMbtiles(kap, chartsDir, chartNumber);
        mbtilesFiles.push(path.basename(mbtiles));
        appendLog(chartNumber, `Done: ${path.basename(mbtiles)}`);
      } catch (err) {
        debug(`Failed to convert ${name}: ${err.message}`);
        appendLog(chartNumber, `Error converting ${name}: ${err.message}`);
        // Continue with remaining files
      }
    }

    if (mbtilesFiles.length === 0) {
      throw new Error('No charts were successfully converted');
    }

    statusFn('completed', `Converted ${mbtilesFiles.length} chart(s) to MBTiles`);

    // Clean up progress on success
    if (chartNumber) {
      delete conversionProgress[chartNumber];
    }

    return { mbtilesFiles };
  } catch (err) {
    // Keep error in progress so frontend can display it
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
    // Clean up temp dir
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_e) {
      debug(`Warning: failed to clean up temp dir ${tmpDir}`);
    }
  }
}

module.exports = {
  initRncConverter,
  checkGdalImage,
  pullGdalImage,
  convertKapToMbtiles,
  processRncZip,
  getConversionProgress,
  getAllConversionProgress,
  GDAL_IMAGE
};
