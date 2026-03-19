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

    // Step 4: Convert all .kap files in a single GDAL container
    statusFn('converting', `Converting ${kapFiles.length} BSB chart(s) to MBTiles...`);
    if (chartNumber) {
      conversionProgress[chartNumber].status = 'converting';
    }

    // Build shell script that converts all .kap files + adds overviews
    const kapNames = kapFiles.map((f) => path.basename(f));
    const script = kapNames
      .map(
        (name) =>
          `echo "PROGRESS: Converting ${name}" && ` +
          `gdal_translate -of MBTiles -co TILE_FORMAT=PNG "/input/${name}" "/output/${name.replace(/\.[^.]+$/, '.mbtiles')}" 2>/dev/null && ` +
          `gdaladdo -r average "/output/${name.replace(/\.[^.]+$/, '.mbtiles')}" 2 4 8 16 2>/dev/null && ` +
          `sqlite3 "/output/${name.replace(/\.[^.]+$/, '.mbtiles')}" "INSERT OR REPLACE INTO metadata (name, value) VALUES ('type', 'tilelayer')" 2>/dev/null || ` +
          `echo "ERROR: Failed ${name}"`
      )
      .join(' && ');

    // All .kap files should be in the same directory (extracted flat)
    // Find common parent dir
    const kapDir = path.dirname(kapFiles[0]);

    const mbtilesFiles = await new Promise((resolve, reject) => {
      const child = spawn(
        'podman',
        [
          'run',
          '--rm',
          '-v',
          `${kapDir}:/input:ro,Z`,
          '-v',
          `${chartsDir}:/output:Z`,
          GDAL_IMAGE,
          'sh',
          '-c',
          script + ' && echo "PROGRESS: All done"'
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] }
      );

      child.stdout.on('data', (data) => {
        const text = data.toString().trim();
        if (text) {
          appendLog(chartNumber, text);
          const match = text.match(/PROGRESS: Converting (\S+)/);
          if (match && chartNumber && conversionProgress[chartNumber]) {
            conversionProgress[chartNumber].message = `Converting ${match[1]}...`;
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
        // Collect created .mbtiles files
        const created = kapNames
          .map((n) => n.replace(/\.[^.]+$/, '.mbtiles'))
          .filter((n) => fs.existsSync(path.join(chartsDir, n)));
        if (created.length === 0) {
          reject(new Error(`No charts converted (exit ${code})`));
        } else {
          resolve(created);
        }
      });

      child.on('error', (err) => {
        reject(new Error(`Failed to start GDAL: ${err.message}`));
      });
    });

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

/**
 * Process a .tar.xz file containing .kap BSB charts (e.g., Pilot Charts).
 * Extracts using tar inside GDAL container, then converts .kap → MBTiles.
 */
async function processPilotTar(tarPath, chartsDir, chartNumber, onStatus) {
  const statusFn = onStatus || (() => {});
  const { checkPodman } = require('./s57-converter');

  const tmpDir = path.join(path.dirname(tarPath), `pilot_${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  if (chartNumber) {
    conversionProgress[chartNumber] = {
      status: 'starting',
      message: 'Starting Pilot Chart conversion...',
      log: []
    };
  }

  try {
    // Step 1: Check Podman
    const podman = await checkPodman();
    if (!podman.available) {
      throw new Error('Podman is not installed.');
    }

    // Step 2: Check/pull GDAL image
    statusFn('pulling', 'Checking GDAL image...');
    const imageExists = await checkGdalImage();
    if (!imageExists) {
      await pullGdalImage();
    }

    // Step 3: Extract .tar.xz using tar inside GDAL container
    statusFn('extracting', 'Extracting pilot chart archive...');
    setConvertProgress(chartNumber, 'extracting', 'Extracting .tar.xz archive...');

    await new Promise((resolve, reject) => {
      const child = execFile(
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
      child.on('error', reject);
    });

    // Step 4: Find .kap files
    const kapFiles = [];
    const findKap = (dir) => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          findKap(fullPath);
        } else if (entry.name.toLowerCase().endsWith('.kap')) {
          kapFiles.push(fullPath);
        }
      }
    };
    findKap(tmpDir);

    if (kapFiles.length === 0) {
      throw new Error('No .kap files found in archive');
    }

    debug(`Found ${kapFiles.length} .kap files`);
    appendLog(chartNumber, `Found ${kapFiles.length} .kap chart file(s)`);

    // Step 5: Convert all .kap files in a single GDAL container
    statusFn('converting', `Converting ${kapFiles.length} chart(s)...`);
    setConvertProgress(chartNumber, 'converting', `Converting ${kapFiles.length} chart(s)...`);

    // Build script: find all .kap, convert + add overviews
    const mbtilesFiles = await new Promise((resolve, reject) => {
      const script = `
set -e
cd /input
for kap in $(find /input -name '*.kap' -o -name '*.KAP'); do
  name=$(basename "$kap" | sed 's/\\.[^.]*$/.mbtiles/')
  echo "PROGRESS: Converting $(basename $kap)"
  gdal_translate -of MBTiles -co TILE_FORMAT=PNG "$kap" "/output/$name" 2>/dev/null && \
  gdaladdo -r average "/output/$name" 2 4 8 16 2>/dev/null && \
  sqlite3 "/output/$name" "INSERT OR REPLACE INTO metadata (name, value) VALUES ('type', 'tilelayer')" 2>/dev/null || \
  echo "ERROR: Failed $(basename $kap)"
done
echo "PROGRESS: All done"
`;
      const child = spawn(
        'podman',
        [
          'run',
          '--rm',
          '-v',
          `${tmpDir}:/input:ro,Z`,
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
          const match = text.match(/PROGRESS: Converting (\S+)/);
          if (match) {
            setConvertProgress(chartNumber, 'converting', `Converting ${match[1]}...`);
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
        const created = kapFiles
          .map((f) => path.basename(f).replace(/\.[^.]+$/, '.mbtiles'))
          .filter((n) => fs.existsSync(path.join(chartsDir, n)));
        if (created.length === 0) {
          reject(new Error(`No charts converted (exit ${code})`));
        } else {
          resolve(created);
        }
      });
      child.on('error', (err) => reject(new Error(`Failed to start GDAL: ${err.message}`)));
    });

    if (mbtilesFiles.length === 0) {
      throw new Error('No charts were successfully converted');
    }

    statusFn('completed', `Converted ${mbtilesFiles.length} chart(s)`);

    if (chartNumber) {
      delete conversionProgress[chartNumber];
    }

    return { mbtilesFiles };
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
      // ignore
    }
  }
}

function setConvertProgress(chartNumber, status, message) {
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

module.exports = {
  initRncConverter,
  checkGdalImage,
  pullGdalImage,
  convertKapToMbtiles,
  processRncZip,
  processPilotTar,
  getConversionProgress,
  getAllConversionProgress,
  GDAL_IMAGE
};
