/**
 * Conversion quarantine: helpers that let a conversion write into a
 * scratch directory and atomically promote the result(s) to the live
 * `chartPath`. A Signal K crash during conversion leaves a stale dir
 * inside `<dataDir>/in-progress/`; `sweepStaleQuarantineDirs()` wipes
 * any leftover at startup so the user's chart library is never
 * polluted with half-built `.mbtiles` files.
 *
 * Design notes:
 *
 * - One subdir per chart number (`<dataDir>/in-progress/<chartNumber>/`).
 *   Multiple concurrent conversions of the same chartNumber can't
 *   collide because `cpuBudget.maxConcurrentConversions` is 1, but the
 *   subdir layout still keeps things tidy under inspection.
 *
 * - `promote()` uses `fs.promises.rename` first (atomic when both
 *   sides are on the same filesystem) and falls back to copy+unlink
 *   when the user has set `chartPath` to a different mount (USB/NFS).
 *
 * - The promotion target dir (subfolder under chartPath) is created
 *   recursively; the converter itself doesn't need to know how the
 *   final landing location is shaped.
 */

import fs from 'fs';
import path from 'path';

const QUARANTINE_ROOT_NAME = 'in-progress';

/**
 * Resolve `<dataDir>/in-progress/<chartNumber>/` and create it. Idempotent.
 * Returns the absolute path so the caller can pass it as the converter's
 * `chartsDir` argument and the converter writes there instead of into the
 * live chart library.
 */
export function makeQuarantineDir(dataDir: string, chartNumber: string): string {
  const dir = path.join(dataDir, QUARANTINE_ROOT_NAME, sanitizeIdSegment(chartNumber));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Atomically move every file the converter produced from the quarantine
 * dir into `targetDir` (subfolder under chartPath). Returns the array of
 * absolute paths the files now live at — converters that report a
 * `mbtilesFile` / `mbtilesFiles[]` field can map back through this.
 *
 * On promotion failure (rename + copy both fail), the quarantine is
 * left in place — the next startup sweep cleans it up. The error
 * propagates so the catalog flow records the conversion as failed.
 */
export async function promoteQuarantine(
  quarantineDir: string,
  filenames: string[],
  targetDir: string
): Promise<void> {
  await fs.promises.mkdir(targetDir, { recursive: true });
  for (const filename of filenames) {
    const from = path.join(quarantineDir, filename);
    const to = path.join(targetDir, filename);
    try {
      await fs.promises.rename(from, to);
    } catch (err) {
      // EXDEV = cross-device link. Different filesystems → copy+unlink.
      // Other errors (EBUSY, EACCES) re-raise; the caller turns it
      // into a conversion failure.
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EXDEV') {
        throw err;
      }
      await fs.promises.copyFile(from, to);
      await fs.promises.unlink(from);
    }
  }
}

/**
 * Best-effort cleanup of the quarantine subdir. Called whether the
 * conversion succeeded or failed — on success any non-promoted
 * leftovers (intermediate files, logs) get cleaned up; on failure
 * the half-built artifacts are dropped before they can pollute
 * anything.
 */
export function cleanupQuarantineDir(quarantineDir: string): void {
  try {
    fs.rmSync(quarantineDir, { recursive: true, force: true });
  } catch {
    // Quarantine may have already been swept by the startup
    // pass (concurrent conversion + restart edge case); not an
    // error worth surfacing.
  }
}

/**
 * Wipe every subdir under `<dataDir>/in-progress/` at startup.
 * Anything in there is from a prior server lifecycle that didn't
 * complete, so the contents are by definition stale and unsafe to
 * promote.
 *
 * Returns the count of dirs swept so callers can log it.
 */
export function sweepStaleQuarantineDirs(dataDir: string): number {
  const root = path.join(dataDir, QUARANTINE_ROOT_NAME);
  if (!fs.existsSync(root)) {
    return 0;
  }
  let swept = 0;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      try {
        fs.rmSync(path.join(root, entry.name), { recursive: true, force: true });
        swept += 1;
      } catch {
        // Best-effort. Permissions / locked file shouldn't block
        // plugin start; the user can clean up by hand if needed.
      }
    }
  }
  return swept;
}

/**
 * Sanitize a chartNumber for use as a path segment. Catalog chart
 * numbers are typically integers or short alphanumerics; this is a
 * defensive guard against anything weird in user-uploaded ZIPs.
 */
function sanitizeIdSegment(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'unnamed';
}
