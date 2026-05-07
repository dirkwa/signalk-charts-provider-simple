import fs from 'fs';
import path from 'path';
import unzipper from 'unzipper';
import {
  ensureImage as ensureContainerImage,
  resolveJobPaths,
  runJob as runContainerJob
} from './container-jobs.js';
import { getContainerManager } from './container-manager.js';
import { setMbtilesType } from './mbtiles-metadata.js';
import type {
  ConversionProgress,
  ConversionProgressMap,
  RncConversionResult,
  StatusCallback,
  DebugFunction
} from '../types.js';

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

export async function convertKapToMbtiles(
  kapFile: string,
  outputDir: string,
  chartNumber: string
): Promise<string> {
  const baseName = path.basename(kapFile, path.extname(kapFile));
  const outputFile = path.join(outputDir, `${baseName}.mbtiles`);
  const kapDir = path.dirname(kapFile);

  const resolved = await resolveJobPaths({ '/input': kapDir, '/output': outputDir }, (cp, ap) =>
    appendLog(
      chartNumber,
      `Cannot mount ${cp} ← ${ap}: path is not reachable from the SignalK container runtime.`
    )
  );
  if (!resolved) {
    throw new Error(
      'KAP conversion paths are not reachable from the container runtime. ' +
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

  const result = await runContainerJob({
    image: GDAL_IMAGE,
    label: `gdal-translate-${chartNumber || baseName}`,
    command: [
      'gdal_translate',
      '-of',
      'MBTiles',
      '-co',
      'TILE_FORMAT=PNG',
      `${inputPrefix}/${path.basename(kapFile)}`,
      `${outputPrefix}/${baseName}.mbtiles`
    ],
    inputs: { '/input': resolved['/input'].source },
    outputs: { '/output': resolved['/output'].source },
    // Single-process GDAL stage; one core is enough.
    resources: { cpus: 1 },
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

  const resolved = await resolveJobPaths({ '/data': dir });
  if (!resolved) {
    throw new Error(`gdaladdo: ${dir} is not reachable from the container runtime.`);
  }
  const dataPrefix = resolved['/data'].subPath ? `/data/${resolved['/data'].subPath}` : '/data';

  const result = await runContainerJob({
    image: GDAL_IMAGE,
    label: `gdaladdo-${chartNumber || name}`,
    command: ['gdaladdo', '-r', 'average', `${dataPrefix}/${name}`, '2', '4', '8', '16'],
    outputs: { '/data': resolved['/data'].source },
    // Single-process; one core is enough.
    resources: { cpus: 1 },
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
    const manager = getContainerManager();
    if (!manager) {
      throw new Error(
        'signalk-container plugin is required for chart conversion. ' +
          'Install it from the App Store and restart Signal K.'
      );
    }

    statusFn('pulling', 'Checking GDAL image...');
    if (chartNumber) {
      conversionProgress[chartNumber].status = 'pulling';
      conversionProgress[chartNumber].message = 'Checking GDAL image...';
    }
    await ensureContainerImage(GDAL_IMAGE, (msg) => debug(msg));

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

    // Resolve the two host paths once for the whole loop — tmpDir and
    // chartsDir don't change per-file.
    const resolved = await resolveJobPaths({ '/input': tmpDir, '/output': chartsDir }, (cp, ap) =>
      appendLog(
        chartNumber,
        `Cannot mount ${cp} ← ${ap}: path is not reachable from the SignalK container runtime.`
      )
    );
    if (!resolved) {
      throw new Error(
        'BSB conversion paths are not reachable from the container runtime. ' +
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

    const mbtilesFiles: string[] = [];
    let i = 0;
    for (const kap of kapFiles) {
      i += 1;
      const relInput = path.relative(tmpDir, kap);
      const baseName = path.basename(kap, path.extname(kap));
      const outputName = `${baseName}.mbtiles`;
      const containerInput = `${inputPrefix}/${relInput}`;
      const containerOutput = `${outputPrefix}/${outputName}`;

      const friendly = path.basename(kap);
      appendLog(chartNumber, `PROGRESS: Converting ${friendly} (${i}/${kapFiles.length})`);
      if (chartNumber && conversionProgress[chartNumber]) {
        conversionProgress[chartNumber].message =
          `Converting ${friendly} (${i}/${kapFiles.length})...`;
      }

      const translateResult = await runContainerJob({
        image: GDAL_IMAGE,
        label: `gdal-translate-${baseName}`,
        command: [
          'gdal_translate',
          '-of',
          'MBTiles',
          '-co',
          'TILE_FORMAT=PNG',
          containerInput,
          containerOutput
        ],
        inputs: { '/input': resolved['/input'].source },
        outputs: { '/output': resolved['/output'].source },
        // Single-process GDAL stage; one core is enough.
        resources: { cpus: 1 },
        onStdoutLine: (line) => appendLog(chartNumber, line),
        onStderrLine: (line) => appendLog(chartNumber, line)
      });
      if (translateResult.exitCode !== 0) {
        appendLog(chartNumber, `ERROR: gdal_translate failed for ${friendly}`);
        continue;
      }

      const overviewResult = await runContainerJob({
        image: GDAL_IMAGE,
        label: `gdaladdo-${baseName}`,
        command: ['gdaladdo', '-r', 'average', containerOutput, '2', '4', '8', '16'],
        outputs: { '/output': resolved['/output'].source },
        // Single-process; one core is enough.
        resources: { cpus: 1 },
        onStdoutLine: (line) => appendLog(chartNumber, line),
        onStderrLine: (line) => appendLog(chartNumber, line)
      });
      if (overviewResult.exitCode !== 0) {
        appendLog(chartNumber, `Warning: gdaladdo failed for ${friendly}`);
      }

      const tagResult = await setMbtilesType(path.join(chartsDir, outputName), 'tilelayer', {
        onMessage: (msg) => appendLog(chartNumber, msg)
      });
      if (!tagResult.ok) {
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
    const manager = getContainerManager();
    if (!manager) {
      throw new Error(
        'signalk-container plugin is required for chart conversion. ' +
          'Install it from the App Store and restart Signal K.'
      );
    }

    statusFn('pulling', 'Checking GDAL image...');
    await ensureContainerImage(GDAL_IMAGE, (msg) => debug(msg));

    statusFn('extracting', 'Extracting pilot chart archive...');
    setConvertProgress(chartNumber, 'extracting', 'Extracting .tar.xz archive...');

    // Resolve the archive (input) and tmpDir (output) paths.  The
    // per-file kap loop below resolves tmpDir + chartsDir separately
    // so the tar step's mounts don't include chartsDir prematurely.
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
        'Pilot chart conversion paths are not reachable from the container runtime. ' +
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
      image: GDAL_IMAGE,
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

    // Resolve once: tmpDir as the input mount, chartsDir as the output
    // mount.  Same per-iteration prefix-substitution pattern used for
    // BSB/KAP and S-57 processing.
    const convResolved = await resolveJobPaths(
      { '/input': tmpDir, '/output': chartsDir },
      (cp, ap) =>
        appendLog(
          chartNumber,
          `Cannot mount ${cp} ← ${ap}: path is not reachable from the SignalK container runtime.`
        )
    );
    if (!convResolved) {
      throw new Error(
        'Pilot chart conversion paths are not reachable from the container runtime. ' +
          'Move the chart directory under app.getDataDirPath() or extend the SignalK ' +
          'container bind/volume to cover it.'
      );
    }
    const inputPrefix = convResolved['/input'].subPath
      ? `/input/${convResolved['/input'].subPath}`
      : '/input';
    const outputPrefix = convResolved['/output'].subPath
      ? `/output/${convResolved['/output'].subPath}`
      : '/output';

    const mbtilesFiles: string[] = [];
    let i = 0;
    for (const kap of kapFiles) {
      i += 1;
      const relInput = path.relative(tmpDir, kap);
      const baseName = path.basename(kap, path.extname(kap));
      const outputName = `${baseName}.mbtiles`;
      const containerInput = `${inputPrefix}/${relInput}`;
      const containerOutput = `${outputPrefix}/${outputName}`;
      const friendly = path.basename(kap);

      appendLog(chartNumber, `PROGRESS: Converting ${friendly} (${i}/${kapFiles.length})`);
      setConvertProgress(
        chartNumber,
        'converting',
        `Converting ${friendly} (${i}/${kapFiles.length})...`
      );

      const translateResult = await runContainerJob({
        image: GDAL_IMAGE,
        label: `gdal-translate-${baseName}`,
        command: [
          'gdal_translate',
          '-of',
          'MBTiles',
          '-co',
          'TILE_FORMAT=PNG',
          containerInput,
          containerOutput
        ],
        inputs: { '/input': convResolved['/input'].source },
        outputs: { '/output': convResolved['/output'].source },
        // Single-process GDAL stage; one core is enough.
        resources: { cpus: 1 },
        onStdoutLine: (line) => appendLog(chartNumber, line),
        onStderrLine: (line) => appendLog(chartNumber, line)
      });
      if (translateResult.exitCode !== 0) {
        appendLog(chartNumber, `ERROR: gdal_translate failed for ${friendly}`);
        continue;
      }

      const overviewResult = await runContainerJob({
        image: GDAL_IMAGE,
        label: `gdaladdo-${baseName}`,
        command: ['gdaladdo', '-r', 'average', containerOutput, '2', '4', '8', '16'],
        outputs: { '/output': convResolved['/output'].source },
        // Single-process; one core is enough.
        resources: { cpus: 1 },
        onStdoutLine: (line) => appendLog(chartNumber, line),
        onStderrLine: (line) => appendLog(chartNumber, line)
      });
      if (overviewResult.exitCode !== 0) {
        appendLog(chartNumber, `Warning: gdaladdo failed for ${friendly}`);
      }

      const tagResult = await setMbtilesType(path.join(chartsDir, outputName), 'tilelayer', {
        onMessage: (msg) => appendLog(chartNumber, msg)
      });
      if (!tagResult.ok) {
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
