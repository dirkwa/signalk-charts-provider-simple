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
 * exhaust inodes long before it exhausts disk.
 *
 * The size budget is enforced twice, and both halves are load-bearing.
 * `unzipper` reports the central directory's `uncompressedSize` per entry, so
 * an archive that *admits* it is too big is rejected before a single byte is
 * written. But those declared sizes are attacker-controlled: a DEFLATE entry
 * can claim 1 KB and decompress to gigabytes. So `writeEntry` also counts
 * bytes as they stream and aborts the moment the running total passes the
 * budget — checking only after an entry finished would mean the disk already
 * took the hit.
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

interface ZipEntry {
  path: string;
  type: string;
  uncompressedSize?: number;
  stream(): NodeJS.ReadableStream;
}

/**
 * Open an archive, keep its file entries, and reject it outright if the
 * central directory already declares more than the budget allows. Shared by
 * both extractors so their limit handling can't drift apart.
 */
async function openAndValidate(
  zipPath: string,
  limits: ExtractLimits
): Promise<{ files: ZipEntry[]; bounds: Required<ExtractLimits> }> {
  const bounds = {
    maxTotalBytes: limits.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES,
    maxEntries: limits.maxEntries ?? DEFAULT_MAX_ENTRIES
  };
  const directory = await unzipper.Open.file(zipPath);
  const files = directory.files.filter((f) => f.type === 'File') as unknown as ZipEntry[];
  assertWithinLimits(files, bounds);
  return { files, bounds };
}

/**
 * Stream one entry to `target`, aborting the moment the running total passes
 * `budget.remaining`.
 *
 * The cap has to be enforced *during* the write, not after it. A DEFLATE
 * entry can declare a tiny `uncompressedSize` in the central directory and
 * still decompress to gigabytes, so `assertWithinLimits`'s pre-flight check
 * on declared sizes is necessary but not sufficient — checking again only
 * once the entry is fully on disk would mean the disk is already full by the
 * time we complain. A partially written file is removed on abort so a
 * rejected archive leaves nothing behind.
 *
 * Returns the number of bytes written.
 */
async function writeEntry(entry: ZipEntry, target: string, remaining: number): Promise<number> {
  fs.mkdirSync(path.dirname(target), { recursive: true });

  let written = 0;
  try {
    await new Promise<void>((resolve, reject) => {
      const source = entry.stream();
      const sink = fs.createWriteStream(target);
      let settled = false;

      const fail = (err: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        // Stop pulling bytes immediately; without this the source keeps
        // decompressing into a sink we no longer care about.
        source.unpipe(sink);
        (source as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
        sink.destroy();
        reject(err);
      };

      source.on('data', (chunk: Buffer) => {
        written += chunk.length;
        if (written > remaining) {
          fail(
            new ZipLimitError(
              `archive expanded past the uncompressed-size limit while extracting ${entry.path}`
            )
          );
        }
      });
      source.on('error', fail);
      sink.on('error', fail);
      sink.on('finish', () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      });

      source.pipe(sink);
    });
  } catch (err) {
    // Don't leave a truncated file where a chart is supposed to be.
    try {
      fs.rmSync(target, { force: true });
    } catch {
      // Best-effort: the caller is already failing this archive.
    }
    throw err;
  }

  return written;
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
  const { files, bounds } = await openAndValidate(zipPath, limits);

  let written = 0;
  let bytesWritten = 0;
  for (const entry of files) {
    const target = path.join(destDir, entry.path);
    // Zip-slip guard: never write outside destDir, regardless of entry path.
    if (!isWithinBase(target, destDir)) {
      continue;
    }
    bytesWritten += await writeEntry(entry, target, bounds.maxTotalBytes - bytesWritten);
    written += 1;
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
  const { files: allFiles, bounds } = await openAndValidate(zipPath, limits);

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

    // Collisions are tracked case-insensitively even though the extracted
    // name keeps its original casing. `Chart.mbtiles` and `chart.mbtiles`
    // are two distinct entries in the archive but the same file on Windows
    // and macOS, so keying on the exact basename would let the second
    // silently overwrite the first — and `files` would then name a chart
    // that no longer exists.
    let name = base;
    if (used.has(name.toLowerCase())) {
      const ext = path.extname(base);
      const stem = path.basename(base, ext);
      let n = 2;
      while (used.has(`${stem}-${n}${ext}`.toLowerCase())) {
        n += 1;
      }
      name = `${stem}-${n}${ext}`;
    }
    used.add(name.toLowerCase());

    const target = path.join(destDir, name);
    bytesWritten += await writeEntry(entry, target, bounds.maxTotalBytes - bytesWritten);
    files.push(name);

    progress.onEntry?.(files.length, mbtiles.length, name);
  }

  return { files, skipped };
}
