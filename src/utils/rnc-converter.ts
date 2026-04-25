import fs from 'fs';
import path from 'path';
import unzipper from 'unzipper';
import { checkContainerRuntime, imageExists, pullImage, runContainer } from './container-runtime';
import type {
  ConversionProgress,
  ConversionProgressMap,
  RncConversionResult,
  StatusCallback,
  DebugFunction
} from '../types';

const GDAL_IMAGE = 'ghcr.io/osgeo/gdal:alpine-small-latest';

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

async function ensureGdalImage(): Promise<void> {
  if (await imageExists(GDAL_IMAGE)) {
    return;
  }
  debug('Pulling GDAL image...');
  await pullImage(GDAL_IMAGE, (msg) => debug(msg));
  debug('GDAL image pulled successfully');
}

export async function convertKapToMbtiles(
  kapFile: string,
  outputDir: string,
  chartNumber: string
): Promise<string> {
  const baseName = path.basename(kapFile, path.extname(kapFile));
  const outputFile = path.join(outputDir, `${baseName}.mbtiles`);
  const kapDir = path.dirname(kapFile);

  const result = await runContainer({
    image: GDAL_IMAGE,
    cmd: [
      'gdal_translate',
      '-of',
      'MBTiles',
      '-co',
      'TILE_FORMAT=PNG',
      `/input/${path.basename(kapFile)}`,
      `/output/${baseName}.mbtiles`
    ],
    binds: [`${kapDir}:/input:ro`, `${outputDir}:/output`],
    onStdoutLine: (line) => appendLog(chartNumber, line),
    onStderrLine: (line) => appendLog(chartNumber, line)
  });

  if (result.exitCode !== 0) {
    throw new Error(`gdal_translate failed (exit ${result.exitCode})`);
  }
  if (!fs.existsSync(outputFile)) {
    throw new Error(`gdal_translate succeeded but output file not found: ${outputFile}`);
  }

  try {
    await addOverviews(outputFile, chartNumber);
  } catch {
    debug(`Warning: failed to add overviews for ${baseName}`);
  }
  return outputFile;
}

async function addOverviews(mbtilesFile: string, chartNumber: string): Promise<void> {
  const dir = path.dirname(mbtilesFile);
  const name = path.basename(mbtilesFile);

  appendLog(chartNumber, `Adding overview zoom levels for ${name}...`);

  const result = await runContainer({
    image: GDAL_IMAGE,
    cmd: ['gdaladdo', '-r', 'average', `/data/${name}`, '2', '4', '8', '16'],
    binds: [`${dir}:/data`],
    onStdoutLine: (line) => appendLog(chartNumber, line),
    onStderrLine: (line) => appendLog(chartNumber, line)
  });

  if (result.exitCode !== 0) {
    appendLog(chartNumber, `Warning: gdaladdo failed (exit ${result.exitCode})`);
    throw new Error(`gdaladdo exit ${result.exitCode}`);
  }
  appendLog(chartNumber, `Overviews added for ${name}`);
}

export async function processRncZip(
  zipPath: string,
  chartsDir: string,
  chartNumber: string,
  onStatus: StatusCallback | null
): Promise<RncConversionResult> {
  const statusFn = onStatus ?? (() => {});

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
    statusFn('checking', 'Checking container runtime...');
    const runtime = await checkContainerRuntime();
    if (!runtime.available) {
      throw new Error(
        'No Docker- or Podman-compatible socket reachable. RNC chart conversion needs a container runtime API.'
      );
    }

    statusFn('pulling', 'Checking GDAL image...');
    if (!(await imageExists(GDAL_IMAGE))) {
      statusFn('pulling', 'Pulling GDAL image (first time only)...');
      if (chartNumber) {
        conversionProgress[chartNumber].status = 'pulling';
        conversionProgress[chartNumber].message = 'Pulling GDAL image...';
      }
      await ensureGdalImage();
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

    const mbtilesFiles: string[] = [];
    let i = 0;
    for (const kap of kapFiles) {
      i += 1;
      const relInput = path.relative(tmpDir, kap);
      const baseName = path.basename(kap, path.extname(kap));
      const outputName = `${baseName}.mbtiles`;
      const containerInput = `/input/${relInput}`;
      const containerOutput = `/output/${outputName}`;

      const friendly = path.basename(kap);
      appendLog(chartNumber, `PROGRESS: Converting ${friendly} (${i}/${kapFiles.length})`);
      if (chartNumber && conversionProgress[chartNumber]) {
        conversionProgress[chartNumber].message =
          `Converting ${friendly} (${i}/${kapFiles.length})...`;
      }

      const translateResult = await runContainer({
        image: GDAL_IMAGE,
        cmd: [
          'gdal_translate',
          '-of',
          'MBTiles',
          '-co',
          'TILE_FORMAT=PNG',
          containerInput,
          containerOutput
        ],
        binds: [`${tmpDir}:/input:ro`, `${chartsDir}:/output`],
        onStdoutLine: (line) => appendLog(chartNumber, line),
        onStderrLine: (line) => appendLog(chartNumber, line)
      });
      if (translateResult.exitCode !== 0) {
        appendLog(chartNumber, `ERROR: gdal_translate failed for ${friendly}`);
        continue;
      }

      const overviewResult = await runContainer({
        image: GDAL_IMAGE,
        cmd: ['gdaladdo', '-r', 'average', containerOutput, '2', '4', '8', '16'],
        binds: [`${chartsDir}:/output`],
        onStdoutLine: (line) => appendLog(chartNumber, line),
        onStderrLine: (line) => appendLog(chartNumber, line)
      });
      if (overviewResult.exitCode !== 0) {
        appendLog(chartNumber, `Warning: gdaladdo failed for ${friendly}`);
      }

      const tagResult = await runContainer({
        image: GDAL_IMAGE,
        cmd: [
          'sqlite3',
          containerOutput,
          "INSERT OR REPLACE INTO metadata (name, value) VALUES ('type', 'tilelayer')"
        ],
        binds: [`${chartsDir}:/output`],
        onStdoutLine: (line) => appendLog(chartNumber, line),
        onStderrLine: (line) => appendLog(chartNumber, line)
      });
      if (tagResult.exitCode !== 0) {
        appendLog(chartNumber, `Warning: failed to set tilelayer metadata for ${friendly}`);
      }

      if (fs.existsSync(path.join(chartsDir, outputName))) {
        mbtilesFiles.push(outputName);
      }
    }

    if (mbtilesFiles.length === 0) {
      throw new Error('No charts converted');
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
    const runtime = await checkContainerRuntime();
    if (!runtime.available) {
      throw new Error('No Docker- or Podman-compatible socket reachable.');
    }

    statusFn('pulling', 'Checking GDAL image...');
    await ensureGdalImage();

    statusFn('extracting', 'Extracting pilot chart archive...');
    setConvertProgress(chartNumber, 'extracting', 'Extracting .tar.xz archive...');

    const tarResult = await runContainer({
      image: GDAL_IMAGE,
      cmd: ['tar', '-xf', `/archive/${path.basename(tarPath)}`, '-C', '/output'],
      binds: [`${path.dirname(tarPath)}:/archive:ro`, `${tmpDir}:/output`],
      onStdoutLine: (line) => appendLog(chartNumber, line),
      onStderrLine: (line) => appendLog(chartNumber, line)
    });
    if (tarResult.exitCode !== 0) {
      throw new Error(`tar extraction failed (exit ${tarResult.exitCode})`);
    }

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

    const mbtilesFiles: string[] = [];
    let i = 0;
    for (const kap of kapFiles) {
      i += 1;
      const relInput = path.relative(tmpDir, kap);
      const baseName = path.basename(kap, path.extname(kap));
      const outputName = `${baseName}.mbtiles`;
      const containerInput = `/input/${relInput}`;
      const containerOutput = `/output/${outputName}`;
      const friendly = path.basename(kap);

      appendLog(chartNumber, `PROGRESS: Converting ${friendly} (${i}/${kapFiles.length})`);
      setConvertProgress(
        chartNumber,
        'converting',
        `Converting ${friendly} (${i}/${kapFiles.length})...`
      );

      const translateResult = await runContainer({
        image: GDAL_IMAGE,
        cmd: [
          'gdal_translate',
          '-of',
          'MBTiles',
          '-co',
          'TILE_FORMAT=PNG',
          containerInput,
          containerOutput
        ],
        binds: [`${tmpDir}:/input:ro`, `${chartsDir}:/output`],
        onStdoutLine: (line) => appendLog(chartNumber, line),
        onStderrLine: (line) => appendLog(chartNumber, line)
      });
      if (translateResult.exitCode !== 0) {
        appendLog(chartNumber, `ERROR: gdal_translate failed for ${friendly}`);
        continue;
      }

      const overviewResult = await runContainer({
        image: GDAL_IMAGE,
        cmd: ['gdaladdo', '-r', 'average', containerOutput, '2', '4', '8', '16'],
        binds: [`${chartsDir}:/output`],
        onStdoutLine: (line) => appendLog(chartNumber, line),
        onStderrLine: (line) => appendLog(chartNumber, line)
      });
      if (overviewResult.exitCode !== 0) {
        appendLog(chartNumber, `Warning: gdaladdo failed for ${friendly}`);
      }

      const tagResult = await runContainer({
        image: GDAL_IMAGE,
        cmd: [
          'sqlite3',
          containerOutput,
          "INSERT OR REPLACE INTO metadata (name, value) VALUES ('type', 'tilelayer')"
        ],
        binds: [`${chartsDir}:/output`],
        onStdoutLine: (line) => appendLog(chartNumber, line),
        onStderrLine: (line) => appendLog(chartNumber, line)
      });
      if (tagResult.exitCode !== 0) {
        appendLog(chartNumber, `Warning: failed to set tilelayer metadata for ${friendly}`);
      }

      if (fs.existsSync(path.join(chartsDir, outputName))) {
        mbtilesFiles.push(outputName);
      }
    }

    if (mbtilesFiles.length === 0) {
      throw new Error('No charts converted');
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
