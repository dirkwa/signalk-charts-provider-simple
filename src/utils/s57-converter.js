const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const unzipper = require('unzipper');

const S57_TILER_IMAGE = 'docker.io/wdantuma/s57-tiler:latest';

// In-memory progress tracking: chartNumber -> { status, message, map, zoom, percent, log }
const conversionProgress = {};
const MAX_LOG_LINES = 200;

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
 * Check if the s57-tiler image is available locally
 */
function checkS57TilerImage() {
  return new Promise((resolve) => {
    execFile('podman', ['image', 'exists', S57_TILER_IMAGE], (error) => {
      resolve(!error);
    });
  });
}

/**
 * Pull the s57-tiler image
 */
function pullS57TilerImage() {
  return new Promise((resolve, reject) => {
    debug('Pulling s57-tiler image...');
    execFile('podman', ['pull', S57_TILER_IMAGE], { timeout: 300000 }, (error, _stdout, stderr) => {
      if (error) {
        reject(new Error(`Failed to pull s57-tiler image: ${stderr || error.message}`));
      } else {
        debug('s57-tiler image pulled successfully');
        resolve();
      }
    });
  });
}

/**
 * Extract a ZIP file to a target directory
 * Returns array of extracted file paths
 */
function extractZip(zipPath, targetDir) {
  return new Promise((resolve, reject) => {
    const extractedFiles = [];

    fs.createReadStream(zipPath)
      .pipe(unzipper.Parse())
      .on('entry', (entry) => {
        const fileName = entry.path;
        const type = entry.type;

        if (type === 'File') {
          const targetPath = path.join(targetDir, path.basename(fileName));
          extractedFiles.push(targetPath);

          const writeStream = fs.createWriteStream(targetPath);
          entry.pipe(writeStream);
        } else {
          entry.autodrain();
        }
      })
      .on('finish', () => resolve(extractedFiles))
      .on('error', reject);
  });
}

/**
 * Parse s57-tiler output line to extract progress info.
 * Example: "Dataset: app, Map: 2W7D1870, Zoom: 14, Processed: 50 %"
 */
function parseProgressLine(line) {
  // s57-tiler uses \r-separated inline progress — split and take last segment
  const segments = line.split(/\s{4,}/);
  const last = segments[segments.length - 1].trim();
  const match = last.match(/Map:\s*(\S+),\s*Zoom:\s*(\d+),\s*Processed:\s*(\d+)\s*%/);
  if (match) {
    return { map: match[1], zoom: parseInt(match[2]), percent: parseInt(match[3]) };
  }
  return null;
}

/**
 * Convert S-57 ENC files to vector tiles using s57-tiler in Podman.
 * Streams progress via conversionProgress tracking.
 *
 * @param {string} encDir - Directory containing extracted ENC files
 * @param {string} outputDir - Charts directory where tiles will be written
 * @param {string} chartNumber - Chart number for progress tracking
 * @param {object} options - Optional: { minzoom, maxzoom }
 * @returns {Promise<{chartDirs: string[]}>} Chart directories created
 */
function convertS57ToTiles(encDir, outputDir, chartNumber, options = {}) {
  const minzoom = options.minzoom || 9;
  // maxzoom 16 needed so navigation aids (LIGHTS, DAYMAR, buoys) pass the SCAMIN
  // filter in s57-tiler. At zoom 14 (~1:22,800) features with SCAMIN=22000 are excluded.
  // Zoom 16 (~1:5,700) ensures all features are included.
  const maxzoom = options.maxzoom || 16;

  return new Promise((resolve, reject) => {
    const args = [
      'run',
      '--rm',
      '-v',
      `${encDir}:/app/enc:ro,Z`,
      '-v',
      `${outputDir}:/app/output:Z`,
      S57_TILER_IMAGE,
      '/app/s57-tiler',
      '--in',
      '/app/enc',
      '--out',
      '/app/output',
      '--minzoom',
      String(minzoom),
      '--maxzoom',
      String(maxzoom)
    ];

    debug(`Running: podman ${args.join(' ')}`);

    const child = spawn('podman', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 0
    });

    let stderrData = '';

    child.stdout.on('data', (data) => {
      const text = data.toString();
      const progress = parseProgressLine(text);
      if (chartNumber) {
        if (!conversionProgress[chartNumber]) {
          conversionProgress[chartNumber] = { status: 'converting', message: '', log: [] };
        }
        // Append raw output as log lines
        const lines = text
          .split(/\r|\n/)
          .map((l) => l.replace(/\s{4,}/g, '\n').trim())
          .filter((l) => l);
        const log = conversionProgress[chartNumber].log || [];
        log.push(...lines);
        // Keep only the last N lines
        if (log.length > MAX_LOG_LINES) {
          log.splice(0, log.length - MAX_LOG_LINES);
        }
        conversionProgress[chartNumber].log = log;

        if (progress) {
          conversionProgress[chartNumber].status = 'converting';
          conversionProgress[chartNumber].message =
            `Map ${progress.map}, Zoom ${progress.zoom}: ${progress.percent}%`;
          conversionProgress[chartNumber].map = progress.map;
          conversionProgress[chartNumber].zoom = progress.zoom;
          conversionProgress[chartNumber].percent = progress.percent;
        }
      }
    });

    child.stderr.on('data', (data) => {
      stderrData += data.toString();
      if (chartNumber && conversionProgress[chartNumber]) {
        const log = conversionProgress[chartNumber].log || [];
        log.push(`[stderr] ${data.toString().trim()}`);
        if (log.length > MAX_LOG_LINES) {
          log.splice(0, log.length - MAX_LOG_LINES);
        }
        conversionProgress[chartNumber].log = log;
      }
    });

    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`s57-tiler exited with code ${code}: ${stderrData}`));
        return;
      }

      // Find what chart directories were created (they contain metadata.json)
      try {
        const entries = fs.readdirSync(outputDir, { withFileTypes: true });
        const chartDirs = entries
          .filter((e) => e.isDirectory())
          .filter((e) => {
            const metadataPath = path.join(outputDir, e.name, 'metadata.json');
            return fs.existsSync(metadataPath);
          })
          .map((e) => e.name);

        debug(`s57-tiler created ${chartDirs.length} chart(s): ${chartDirs.join(', ')}`);
        resolve({ chartDirs });
      } catch (scanError) {
        reject(new Error(`Failed to scan output directory: ${scanError.message}`));
      }
    });

    child.on('error', (err) => {
      reject(new Error(`Failed to start podman: ${err.message}`));
    });
  });
}

/**
 * Full pipeline: Download ZIP → extract → convert S-57 → produce tiles in charts dir.
 *
 * @param {string} zipPath - Path to the downloaded ZIP file
 * @param {string} chartsDir - The plugin's charts directory
 * @param {string} chartNumber - Chart number for progress tracking
 * @param {function} onStatus - Status callback: (status, message) => void
 * @returns {Promise<{chartDirs: string[]}>} Chart directories created
 */
async function processS57Zip(zipPath, chartsDir, chartNumber, onStatus) {
  const statusFn = onStatus || (() => {});

  // Create temp dir for extracted ENC files
  const tmpDir = path.join(path.dirname(zipPath), `enc_${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  // Initialize progress tracking
  if (chartNumber) {
    conversionProgress[chartNumber] = {
      status: 'starting',
      message: 'Starting conversion...'
    };
  }

  try {
    // Step 1: Check Podman
    statusFn('checking', 'Checking Podman availability...');
    const podman = await checkPodman();
    if (!podman.available) {
      throw new Error(
        'Podman is not installed. S-57 chart conversion requires Podman to run the s57-tiler container.'
      );
    }

    // Step 2: Check/pull image
    statusFn('pulling', 'Checking s57-tiler image...');
    const imageExists = await checkS57TilerImage();
    if (!imageExists) {
      statusFn('pulling', 'Pulling s57-tiler image (first time only)...');
      if (chartNumber) {
        conversionProgress[chartNumber] = {
          status: 'pulling',
          message: 'Pulling s57-tiler image...'
        };
      }
      await pullS57TilerImage();
    }

    // Step 3: Extract ZIP
    statusFn('extracting', 'Extracting ENC files from ZIP...');
    if (chartNumber) {
      conversionProgress[chartNumber] = {
        status: 'extracting',
        message: 'Extracting ENC files...'
      };
    }
    const extracted = await extractZip(zipPath, tmpDir);
    debug(`Extracted ${extracted.length} files from ZIP`);

    if (extracted.length === 0) {
      throw new Error('No files found in ZIP archive');
    }

    // Step 4: Convert
    statusFn('converting', 'Converting S-57 to vector tiles...');
    const result = await convertS57ToTiles(tmpDir, chartsDir, chartNumber);

    if (result.chartDirs.length === 0) {
      throw new Error(
        's57-tiler produced no charts. The ZIP may not contain valid S-57 ENC files.'
      );
    }

    // Step 5: Create merged metadata.json at the group directory level.
    // This makes the group appear as a single chart in Signal K and Freeboard-SK
    // instead of dozens of individual ENC cells.
    createMergedMetadata(chartsDir, result.chartDirs, chartNumber);

    statusFn('completed', `Converted ${result.chartDirs.length} chart(s) successfully`);
    return result;
  } finally {
    // Clean up progress tracking
    if (chartNumber) {
      delete conversionProgress[chartNumber];
    }
    // Clean up temp dir
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_e) {
      debug(`Warning: failed to clean up temp dir ${tmpDir}`);
    }
  }
}

/**
 * Create a merged metadata.json at the group directory level.
 * Combines bounds and zoom levels from all ENC cell subdirectories.
 * This makes charts-loader.js treat the group as a single chart.
 *
 * @param {string} groupDir - e.g., S-57/AT-269/
 * @param {string[]} chartDirs - e.g., ['2W7D1870', '2W7D1880', ...]
 * @param {string} chartNumber - e.g., '269'
 */
function createMergedMetadata(groupDir, chartDirs, chartNumber) {
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  let minZoom = Infinity;
  let maxZoom = -Infinity;
  let cellCount = 0;

  for (const dir of chartDirs) {
    const metaPath = path.join(groupDir, dir, 'metadata.json');
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
      if (meta.bounds && meta.bounds.length === 4) {
        minLon = Math.min(minLon, meta.bounds[0]);
        minLat = Math.min(minLat, meta.bounds[1]);
        maxLon = Math.max(maxLon, meta.bounds[2]);
        maxLat = Math.max(maxLat, meta.bounds[3]);
      }
      if (meta.minzoom !== undefined) {
        minZoom = Math.min(minZoom, meta.minzoom);
      }
      if (meta.maxzoom !== undefined) {
        maxZoom = Math.max(maxZoom, meta.maxzoom);
      }
      cellCount++;
    } catch (_e) {
      // skip unreadable cells
    }
  }

  if (cellCount === 0) {
    return;
  }

  const merged = {
    id: chartNumber || path.basename(groupDir),
    name: `S-57 ${chartNumber || path.basename(groupDir)} (${cellCount} cells)`,
    description: `Merged from ${cellCount} ENC cells`,
    type: 'S-57',
    format: 'pbf',
    minzoom: minZoom === Infinity ? 9 : minZoom,
    maxzoom: maxZoom === -Infinity ? 14 : maxZoom,
    bounds: [
      minLon === Infinity ? 0 : minLon,
      minLat === Infinity ? 0 : minLat,
      maxLon === -Infinity ? 0 : maxLon,
      maxLat === -Infinity ? 0 : maxLat
    ],
    _s57Cells: chartDirs
  };

  const mergedPath = path.join(groupDir, 'metadata.json');
  fs.writeFileSync(mergedPath, JSON.stringify(merged, null, 2), 'utf-8');
  debug(
    `Created merged metadata.json for ${chartNumber}: ${cellCount} cells, bounds [${merged.bounds}]`
  );
}

module.exports = {
  initS57Converter,
  checkPodman,
  checkS57TilerImage,
  pullS57TilerImage,
  convertS57ToTiles,
  processS57Zip,
  getConversionProgress,
  getAllConversionProgress,
  S57_TILER_IMAGE
};
