/**
 * The container toolchain for BSB/KAP raster charts (conversion-backend.ts):
 * `gdal_translate` and `gdaladdo` in the charts-toolbox image, run as helper
 * jobs through signalk-container. rnc-converter.ts owns each conversion and
 * calls in here once `chooseConversionBackend` picked the container
 * toolchain.
 */

import fs from 'fs';
import path from 'path';
import { withOutputChmod } from './container-fs.js';
import { CHARTS_TOOLBOX_IMAGE } from './container-images.js';
import { resolveJobPaths, runJob as runContainerJob } from './container-jobs.js';
import { CONVERSION_ABORTED_MESSAGE, type ConversionReport } from './conversion-backend.js';

/** Container path of a resolved mount, with its named-volume subPath. */
const mountPrefix = (root: string, subPath: string): string =>
  subPath ? `${root}/${subPath}` : root;

/**
 * Convert each chart to `<chartsDir>/<outputNames[i]>` at its native zoom and
 * add overview zooms (`gdaladdo` factors 2 to 16), one chart at a time. A
 * chart that fails is logged and skipped. Returns, per chart, whether its
 * MBTiles was written.
 */
export async function convertKapFilesInContainer(
  kapFiles: readonly string[],
  chartsDir: string,
  outputNames: readonly string[],
  label: string,
  report: ConversionReport,
  signal?: AbortSignal
): Promise<boolean[]> {
  const written: boolean[] = [];
  const logLine = (line: string): void => {
    report.log(line);
  };
  for (const [index, kap] of kapFiles.entries()) {
    if (signal?.aborted) {
      throw new Error(CONVERSION_ABORTED_MESSAGE);
    }
    const friendly = path.basename(kap);
    const outputName = outputNames[index];
    report.log(`PROGRESS: Converting ${friendly} (${index + 1}/${kapFiles.length})`);
    report.progress('converting', `Converting ${friendly} (${index + 1}/${kapFiles.length})...`);

    const resolved = await resolveJobPaths(
      { '/input': path.dirname(kap), '/output': chartsDir },
      (cp, ap) => {
        report.log(
          `Cannot mount ${cp} ← ${ap}: path is not reachable from the SignalK container runtime.`
        );
      }
    );
    if (!resolved) {
      report.log(`ERROR: cannot convert ${friendly}: its folder cannot be mounted`);
      written.push(false);
      continue;
    }
    const containerInput = `${mountPrefix('/input', resolved['/input'].subPath)}/${friendly}`;
    const containerOutput = `${mountPrefix('/output', resolved['/output'].subPath)}/${outputName}`;

    const translateResult = await runContainerJob({
      image: CHARTS_TOOLBOX_IMAGE,
      label: `gdal-translate-${label}`,
      // chmod the output here, on the mandatory step that creates the file —
      // not only on the optional gdaladdo overview step below. gdaladdo
      // failure is tolerated (a warning, then the metadata is still patched),
      // and its withOutputChmod is skipped by `set -e` when the tool fails —
      // which would leave the file 0o644 and the patch failing with "attempt
      // to write a readonly database".
      command: withOutputChmod(
        [
          'gdal_translate',
          '-of',
          'MBTiles',
          '-co',
          'TILE_FORMAT=PNG',
          containerInput,
          containerOutput
        ],
        containerOutput
      ),
      inputs: { '/input': resolved['/input'].source },
      outputs: { '/output': resolved['/output'].source },
      // Single-process GDAL stage; one core is enough.
      resources: { cpus: 1 },
      signal,
      onStdoutLine: logLine,
      onStderrLine: logLine
    });
    const outputPath = path.join(chartsDir, outputName);
    if (translateResult.exitCode !== 0) {
      report.log(`ERROR: gdal_translate failed for ${friendly}`);
      fs.rmSync(outputPath, { force: true });
      written.push(false);
      continue;
    }

    const overviewResult = await runContainerJob({
      image: CHARTS_TOOLBOX_IMAGE,
      label: `gdaladdo-${label}`,
      command: withOutputChmod(
        ['gdaladdo', '-r', 'average', containerOutput, '2', '4', '8', '16'],
        containerOutput
      ),
      outputs: { '/output': resolved['/output'].source },
      resources: { cpus: 1 },
      signal,
      onStdoutLine: logLine,
      onStderrLine: logLine
    });
    if (overviewResult.exitCode !== 0) {
      report.log(`Warning: gdaladdo failed for ${friendly}`);
    } else {
      report.log(`Overviews added for ${outputName}`);
    }
    written.push(fs.existsSync(outputPath));
  }
  return written;
}
