/**
 * Shared, zip-slip-safe ZIP extraction.
 *
 * Two callers with two different needs:
 *
 * - `extractZipSafely` preserves the archive's directory structure. The
 *   S-57 pipeline needs that: an ENC cell is a `.000` file plus sibling
 *   updates and a catalog, and flattening them breaks the conversion.
 * - `extractMbtilesFromZip` pulls only `.mbtiles` entries out and flattens
 *   them to bare basenames. Chart uploads want the files, not the uploader's
 *   folder layout, and a flattened basename is structurally immune to
 *   zip-slip (there is no path left to traverse with).
 *
 * Both enforce the same abuse limits, because a ZIP is attacker-controlled
 * input even when it arrives from an authenticated admin: a 1 MB archive can
 * expand to terabytes (zip bomb), and an archive with a million entries can
 * exhaust inodes long before it exhausts disk. `unzipper` reports the
 * central directory's `uncompressedSize` per entry, so both budgets are
 * checked *before* any bytes are written, and the running total is checked
 * again as it grows.
 */

import fs from 'fs';
import path from 'path';
import unzipper from 'unzipper';
import { isWithinBase } from './path-safety.js';

/**
 * Reject archives that would expand past this on disk. Set high enough that
 * a legitimate multi-GB chart bundle (6 GB single-chart archives are normal,
 * and a folder of them is normal too) never trips it, while still capping
 * the classic zip bomb, where a few MB claim to expand to terabytes.
 */
export const DEFAULT_MAX_TOTAL_BYTES = 100 * 1024 * 1024 * 1024;

/** Reject archives with more entries than this. */
export const DEFAULT_MAX_ENTRIES = 10000;

export interface ExtractLimits {
  maxTotalBytes?: number;
  maxEntries?: number;
}

export interface ExtractProgress {
  /** Called after each entry is written, with 1-based counts. */
  onEntry?: (done: number, total: number, name: string) => void;
}

export class ZipLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipLimitError';
  }
}

function assertWithinLimits(
  entries: { uncompressedSize?: number }[],
  limits: Required<ExtractLimits>
): void {
  if (entries.length > limits.maxEntries) {
    throw new ZipLimitError(
      `archive has ${entries.length} entries, over the ${limits.maxEntries} limit`
    );
  }
  let declaredTotal = 0;
  for (const entry of entries) {
    declaredTotal += entry.uncompressedSize ?? 0;
  }
  if (declaredTotal > limits.maxTotalBytes) {
    throw new ZipLimitError(
      `archive declares ${declaredTotal} uncompressed bytes, over the ${limits.maxTotalBytes} limit`
    );
  }
}

async function writeEntry(
  entry: { stream(): NodeJS.ReadableStream },
  target: string
): Promise<void> {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  await new Promise<void>((resolve, reject) => {
    entry
      .stream()
      .pipe(fs.createWriteStream(target))
      .on('finish', () => resolve())
      .on('error', reject);
  });
}

/**
 * Extract every file entry into `destDir`, preserving the archive's internal
 * directory structure. Entries that would resolve outside `destDir` are
 * skipped rather than treated as fatal — a stray absolute path in an
 * otherwise good ENC archive shouldn't lose the whole bundle.
 *
 * Returns the number of files written.
 */
export async function extractZipSafely(
  zipPath: string,
  destDir: string,
  limits: ExtractLimits = {}
): Promise<number> {
  const bounds = {
    maxTotalBytes: limits.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES,
    maxEntries: limits.maxEntries ?? DEFAULT_MAX_ENTRIES
  };
  const directory = await unzipper.Open.file(zipPath);
  const files = directory.files.filter((f) => f.type === 'File');
  assertWithinLimits(files, bounds);

  let written = 0;
  let bytesWritten = 0;
  for (const entry of files) {
    const target = path.join(destDir, entry.path);
    // Zip-slip guard: never write outside destDir, regardless of entry path.
    if (!isWithinBase(target, destDir)) {
      continue;
    }
    await writeEntry(entry, target);
    written += 1;
    // Re-check against actual bytes on disk: the central directory's
    // declared sizes are attacker-controlled and can understate reality.
    bytesWritten += fs.statSync(target).size;
    if (bytesWritten > bounds.maxTotalBytes) {
      throw new ZipLimitError(
        `archive expanded past the ${bounds.maxTotalBytes} byte limit while extracting`
      );
    }
  }
  return written;
}

export interface MbtilesExtractResult {
  /** Basenames written into destDir, in archive order. */
  files: string[];
  /** File entries in the archive that were not `.mbtiles`. */
  skipped: number;
}

/**
 * Extract only `.mbtiles` entries from `zipPath` into `destDir`, flattened to
 * bare basenames. Name collisions (`a/chart.mbtiles` and `b/chart.mbtiles`)
 * are disambiguated with a `-2`, `-3`, … suffix rather than silently
 * overwriting, matching how the download manager handles the same case.
 *
 * Matching is case-insensitive: charts hand-copied from Windows commonly
 * arrive as `FOO.MBTILES`, and the loader's discovery already tolerates that.
 */
export async function extractMbtilesFromZip(
  zipPath: string,
  destDir: string,
  limits: ExtractLimits = {},
  progress: ExtractProgress = {}
): Promise<MbtilesExtractResult> {
  const bounds = {
    maxTotalBytes: limits.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES,
    maxEntries: limits.maxEntries ?? DEFAULT_MAX_ENTRIES
  };
  const directory = await unzipper.Open.file(zipPath);
  const allFiles = directory.files.filter((f) => f.type === 'File');
  assertWithinLimits(allFiles, bounds);

  const mbtiles = allFiles.filter((f) => /\.mbtiles$/i.test(f.path));
  const skipped = allFiles.length - mbtiles.length;

  fs.mkdirSync(destDir, { recursive: true });

  const files: string[] = [];
  const used = new Set<string>();
  let bytesWritten = 0;

  for (const entry of mbtiles) {
    // Flatten: the basename cannot traverse, so this is zip-slip-safe by
    // construction. Guard the degenerate cases anyway — an entry path of
    // `..` or `foo/` yields a basename that isn't a usable filename.
    const base = path.basename(entry.path);
    if (base === '' || base === '.' || base === '..') {
      continue;
    }

    let name = base;
    if (used.has(name)) {
      const ext = path.extname(base);
      const stem = path.basename(base, ext);
      let n = 2;
      while (used.has(`${stem}-${n}${ext}`)) {
        n += 1;
      }
      name = `${stem}-${n}${ext}`;
    }
    used.add(name);

    const target = path.join(destDir, name);
    await writeEntry(entry, target);
    files.push(name);

    bytesWritten += fs.statSync(target).size;
    if (bytesWritten > bounds.maxTotalBytes) {
      throw new ZipLimitError(
        `archive expanded past the ${bounds.maxTotalBytes} byte limit while extracting`
      );
    }

    progress.onEntry?.(files.length, mbtiles.length, name);
  }

  return { files, skipped };
}
