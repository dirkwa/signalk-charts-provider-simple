/**
 * Download and stage the NOAA ENC ZIPs for a custom catalog.
 *
 * Each included chart id is fetched from `https://charts.noaa.gov/ENCs/<id>.zip`
 * into a staging directory, then extracted into one combined ENC input tree
 * (`encDir`). The S-57 pipeline (`processS57Directory`) then converts the
 * whole tree in a single pass, producing one MBTiles per custom catalog.
 *
 * Extraction is zip-slip-safe: each entry's resolved target is checked
 * against `encDir` before any bytes are written, mirroring the path-safety
 * posture of the rest of the plugin. A single chart that fails to download or
 * extract is logged and skipped rather than failing the whole bundle — a
 * region of dozens of cells shouldn't be lost to one expired URL.
 */

import fs from 'fs';
import http from 'http';
import https from 'https';
import path from 'path';
import unzipper from 'unzipper';
import { isWithinBase } from './path-safety.js';
import { noaaEncZipUrl } from './noaa-enc-footprints.js';

export interface EncDownloadHooks {
  /** Called before each chart download with 1-based progress. */
  onProgress?: (done: number, total: number, chartId: string) => void;
  /** Called after a chart's ZIP has downloaded and extracted successfully. */
  onStaged?: (chartId: string) => void;
  onLog?: (line: string) => void;
  /** Return true to abort the remaining downloads (e.g. plugin stopping). */
  isAborted?: () => boolean;
}

export interface EncDownloadResult {
  /** Chart ids whose ZIP downloaded and extracted successfully. */
  staged: string[];
  failed: { chartId: string; error: string }[];
}

const REQUEST_TIMEOUT_MS = 60000;

function downloadToFile(url: string, dest: string, redirectsLeft = 5): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const req = protocol.get(url, { timeout: REQUEST_TIMEOUT_MS }, (response) => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        if (redirectsLeft <= 0) {
          reject(new Error('too many redirects'));
          return;
        }
        // Resolve against the current URL so a relative Location follows
        // correctly instead of failing as a bare path.
        const next = new URL(response.headers.location, url).toString();
        downloadToFile(next, dest, redirectsLeft - 1)
          .then(resolve)
          .catch(reject);
        return;
      }
      if (status !== 200) {
        response.resume();
        reject(new Error(`HTTP ${status}`));
        return;
      }
      const file = fs.createWriteStream(dest);
      response.pipe(file);
      file.on('finish', () => file.close(() => resolve()));
      file.on('error', (err) => {
        fs.unlink(dest, () => {});
        reject(err);
      });
      response.on('error', (err) => {
        file.destroy();
        fs.unlink(dest, () => {});
        reject(err);
      });
    });
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('request timed out'));
    });
    req.on('error', reject);
  });
}

async function extractZipSafely(zipPath: string, destDir: string): Promise<number> {
  const directory = await unzipper.Open.file(zipPath);
  let written = 0;
  for (const entry of directory.files) {
    if (entry.type !== 'File') {
      continue;
    }
    const target = path.join(destDir, entry.path);
    // Zip-slip guard: never write outside destDir, regardless of entry path.
    if (!isWithinBase(target, destDir)) {
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    await new Promise<void>((resolve, reject) => {
      entry
        .stream()
        .pipe(fs.createWriteStream(target))
        .on('finish', () => resolve())
        .on('error', reject);
    });
    written += 1;
  }
  return written;
}

export async function downloadAndExtractEncs(
  includedChartIds: readonly string[],
  encDir: string,
  stagingDir: string,
  hooks: EncDownloadHooks = {}
): Promise<EncDownloadResult> {
  fs.mkdirSync(encDir, { recursive: true });
  fs.mkdirSync(stagingDir, { recursive: true });

  const staged: string[] = [];
  const failed: { chartId: string; error: string }[] = [];
  const total = includedChartIds.length;

  let done = 0;
  for (const chartId of includedChartIds) {
    if (hooks.isAborted?.()) {
      break;
    }
    done += 1;
    hooks.onProgress?.(done, total, chartId);
    const url = noaaEncZipUrl(chartId);
    const zipPath = path.join(stagingDir, `${chartId}.zip`);
    try {
      await downloadToFile(url, zipPath);
      const count = await extractZipSafely(zipPath, encDir);
      if (count === 0) {
        throw new Error('archive contained no files');
      }
      staged.push(chartId);
      hooks.onStaged?.(chartId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failed.push({ chartId, error: msg });
      hooks.onLog?.(`WARN: ${chartId} skipped (${msg})`);
    } finally {
      try {
        fs.rmSync(zipPath, { force: true });
      } catch {
        // best effort
      }
    }
  }

  return { staged, failed };
}
