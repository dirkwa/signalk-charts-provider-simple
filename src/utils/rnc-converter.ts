import { execFile, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import unzipper from 'unzipper';
import type {
  ConversionProgress,
  ConversionProgressMap,
  RncConversionResult,
  StatusCallback,
  DebugFunction
} from '../types';

const GDAL_IMAGE = 'ghcr.io/osgeo/gdal:alpine-small-latest';

function podmanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.LISTEN_FDS;
  delete env.LISTEN_PID;
  delete env.LISTEN_FDNAMES;
  return env;
}

const conversionProgress: ConversionProgressMap = {};
const MAX_LOG_LINES = 100;

let debug: DebugFunction = () => {};

export function initRncConverter(debugFn: DebugFunction): void {
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

function checkGdalImage(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('podman', ['image', 'exists', GDAL_IMAGE], { env: podmanEnv() }, (error) => {
      resolve(!error);
    });
  });
}

function pullGdalImage(): Promise<void> {
  return new Promise((resolve, reject) => {
    debug('Pulling GDAL image...');
    execFile('podman', ['pull', GDAL_IMAGE], { timeout: 300000, env: podmanEnv() }, (error, _stdout, stderr) => {
      if (error) {
        reject(new Error(`Failed to pull GDAL image: ${stderr || error.message}`));
      } else {
        debug('GDAL image pulled successfully');
        resolve();
      }
    });
  });
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

function setConvertProgress(chartNumber: string, status: string, message: string): void {
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

export function convertKapToMbtiles(
  kapFile: string,
  outputDir: string,
  chartNumber: string
): Promise<string> {
  const baseName = path.basename(kapFile, path.extname(kapFile));
  const outputFile = path.join(outputDir, `${baseName}.mbtiles`);
  const kapDir = path.dirname(kapFile);

  return new Promise((resolve, reject) => {
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
      timeout: 0,
      env: podmanEnv()
    });

    let output = '';

    child.stdout.on('data', (data: Buffer) => {
      output += data.toString();
      appendLog(chartNumber, data.toString().trim());
    });

    child.stderr.on('data', (data: Buffer) => {
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

      addOverviews(outputFile, chartNumber)
        .then(() => resolve(outputFile))
        .catch(() => {
          debug(`Warning: failed to add overviews for ${baseName}`);
          resolve(outputFile);
        });
    });

    child.on('error', (err) => {
      reject(new Error(`Failed to start podman: ${err.message}`));
    });
  });
}

function addOverviews(mbtilesFile: string, chartNumber: string): Promise<void> {
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

    const child = execFile('podman', args, { timeout: 300000, env: podmanEnv() }, (error, _stdout, stderr) => {
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

export async function processRncZip(
  zipPath: string,
  chartsDir: string,
  chartNumber: string,
  onStatus: StatusCallback | null
): Promise<RncConversionResult> {
  const statusFn = onStatus ?? (() => {});
  const { checkPodman } = await import('./s57-converter');

  const tmpDir = path.join(path.dirname(zipPath), `rnc_${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  if (chartNumber) {
    conversionProgress[chartNumber] = {
      status: 'starting',
      message: 'Starting RNC conversion...',
      log: []
    };
  }

  try {
    statusFn('checking', 'Checking Podman availability...');
    const podman = await checkPodman();
    if (!podman.available) {
      throw new Error('Podman is not installed. RNC chart conversion requires Podman.');
    }

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

    statusFn('extracting', 'Extracting BSB chart files from ZIP...');
    if (chartNumber) {
      conversionProgress[chartNumber].status = 'extracting';
      conversionProgress[chartNumber].message = 'Extracting BSB files...';
    }
    let extracted: string[];
    try {
      extracted = await extractZip(zipPath, tmpDir);
    } catch (zipErr) {
      throw new Error(
        `Downloaded file is not a valid ZIP archive (${zipErr instanceof Error ? zipErr.message : String(zipErr)}). The server may have returned an error page instead.`
      );
    }
    debug(`Extracted ${extracted.length} files from ZIP`);

    if (extracted.length === 0) {
      throw new Error('No files found in ZIP archive');
    }

    const kapFiles = extracted.filter(
      (f) => f.toLowerCase().endsWith('.kap') || f.toLowerCase().endsWith('.bsb')
    );

    if (kapFiles.length === 0) {
      throw new Error('No .kap or .bsb files found in ZIP archive');
    }

    debug(`Found ${kapFiles.length} BSB chart file(s) to convert`);
    appendLog(chartNumber, `Found ${kapFiles.length} BSB chart file(s)`);

    statusFn('converting', `Converting ${kapFiles.length} BSB chart(s) to MBTiles...`);
    if (chartNumber) {
      conversionProgress[chartNumber].status = 'converting';
    }

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

    const kapDir = path.dirname(kapFiles[0]);

    const mbtilesFiles = await new Promise<string[]>((resolve, reject) => {
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
        { stdio: ['ignore', 'pipe', 'pipe'], env: podmanEnv() }
      );

      child.stdout.on('data', (data: Buffer) => {
        const text = data.toString().trim();
        if (text) {
          appendLog(chartNumber, text);
          const match = text.match(/PROGRESS: Converting (\S+)/);
          if (match && chartNumber && conversionProgress[chartNumber]) {
            conversionProgress[chartNumber].message = `Converting ${match[1]}...`;
          }
        }
      });

      child.stderr.on('data', (data: Buffer) => {
        const text = data.toString().trim();
        if (text) {
          appendLog(chartNumber, text);
        }
      });

      child.on('close', (code) => {
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

    if (chartNumber) {
      delete conversionProgress[chartNumber];
    }

    return { mbtilesFiles };
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
      debug(`Warning: failed to clean up temp dir ${tmpDir}`);
    }
  }
}

export async function processPilotTar(
  tarPath: string,
  chartsDir: string,
  chartNumber: string,
  onStatus: StatusCallback | null
): Promise<RncConversionResult> {
  const statusFn = onStatus ?? (() => {});
  const { checkPodman } = await import('./s57-converter');

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
    const podman = await checkPodman();
    if (!podman.available) {
      throw new Error('Podman is not installed.');
    }

    statusFn('pulling', 'Checking GDAL image...');
    const imageExists = await checkGdalImage();
    if (!imageExists) {
      await pullGdalImage();
    }

    statusFn('extracting', 'Extracting pilot chart archive...');
    setConvertProgress(chartNumber, 'extracting', 'Extracting .tar.xz archive...');

    await new Promise<void>((resolve, reject) => {
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
        { timeout: 120000, env: podmanEnv() },
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

    const kapFiles: string[] = [];
    const findKap = (dir: string): void => {
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

    statusFn('converting', `Converting ${kapFiles.length} chart(s)...`);
    setConvertProgress(chartNumber, 'converting', `Converting ${kapFiles.length} chart(s)...`);

    const mbtilesFiles = await new Promise<string[]>((resolve, reject) => {
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
        { stdio: ['ignore', 'pipe', 'pipe'], env: podmanEnv() }
      );

      child.stdout.on('data', (data: Buffer) => {
        const text = data.toString().trim();
        if (text) {
          appendLog(chartNumber, text);
          const match = text.match(/PROGRESS: Converting (\S+)/);
          if (match) {
            setConvertProgress(chartNumber, 'converting', `Converting ${match[1]}...`);
          }
        }
      });
      child.stderr.on('data', (data: Buffer) => {
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
      // ignore
    }
  }
}
