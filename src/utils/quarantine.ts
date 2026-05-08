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
 * Promote every file the converter produced from the quarantine
 * dir into `targetDir` (subfolder under chartPath). Failure is
 * **all-or-nothing**: if any file fails to move, every file that
 * was already moved this call is rolled back to the quarantine and
 * any pre-existing live file we displaced is restored. Without that,
 * a multi-file RNC/Pilot batch could end up half-promoted — a
 * partial chart set in chartPath defeats the quarantine guarantee.
 *
 * Pre-existing files in `targetDir` whose names collide with a
 * promoted filename are preserved by moving the original aside to a
 * sibling `<filename>.replaced-<ts>` first; on success those backups
 * are removed, on failure they're moved back into place. Without
 * this step, a failed multi-file promotion could leave the user's
 * previously working chart deleted with no replacement (the new file
 * was rolled back to quarantine, but the old file we overwrote en
 * route is gone).
 *
 * Each `filename` must be a plain basename (no `..`, no separators,
 * not absolute). The helper is the trust boundary between converter
 * output and the live chart directory; a converter that returns
 * `../foo.mbtiles` would otherwise write outside `targetDir`.
 */
export async function promoteQuarantine(
  quarantineDir: string,
  filenames: string[],
  targetDir: string
): Promise<void> {
  // Validate first: refuse to start any moves if any name is unsafe.
  for (const filename of filenames) {
    if (
      filename === '' ||
      path.basename(filename) !== filename ||
      filename.includes('..') ||
      path.isAbsolute(filename)
    ) {
      throw new Error(`Invalid promoted filename: ${JSON.stringify(filename)}`);
    }
  }

  await fs.promises.mkdir(targetDir, { recursive: true });

  // Phase 1: for any target filename that already exists, move the
  // current live file aside to a backup path in the same dir. Same-dir
  // keeps the rename atomic (no EXDEV), and on success we just rm the
  // backup; on failure we rename it back into place.
  const backupSuffix = `.replaced-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const backups: { live: string; backup: string }[] = [];
  for (const filename of filenames) {
    const livePath = path.join(targetDir, filename);
    let exists = false;
    try {
      await fs.promises.access(livePath, fs.constants.F_OK);
      exists = true;
    } catch {
      exists = false;
    }
    if (exists) {
      const backupPath = `${livePath}${backupSuffix}`;
      await fs.promises.rename(livePath, backupPath);
      backups.push({ live: livePath, backup: backupPath });
    }
  }

  const moved: { from: string; to: string }[] = [];
  try {
    for (const filename of filenames) {
      const from = path.join(quarantineDir, filename);
      const to = path.join(targetDir, filename);
      try {
        await fs.promises.rename(from, to);
      } catch (err) {
        // EXDEV = cross-device link. Different filesystems → copy+unlink.
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'EXDEV') {
          throw err;
        }
        await fs.promises.copyFile(from, to);
        await fs.promises.unlink(from);
      }
      moved.push({ from, to });
    }
  } catch (err) {
    // Roll back in two phases:
    //   1) Move each successfully promoted file back to the quarantine
    //      dir so the live chart library doesn't keep a partial set.
    //   2) Restore any pre-existing originals from `backups` so an
    //      attempted upgrade that failed doesn't take out the working
    //      chart the user had before.
    // Best-effort throughout — a rollback failure is logged but we
    // still throw the original error so the caller knows the promotion
    // didn't succeed.
    for (const { from, to } of moved) {
      try {
        await fs.promises.rename(to, from);
      } catch {
        try {
          await fs.promises.copyFile(to, from);
          await fs.promises.unlink(to);
        } catch (rollbackErr) {
          console.warn(
            `[charts-provider] promoteQuarantine rollback failed for ${to}: ${
              rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)
            }`
          );
        }
      }
    }
    for (const { live, backup } of backups) {
      try {
        await fs.promises.rename(backup, live);
      } catch (restoreErr) {
        console.warn(
          `[charts-provider] promoteQuarantine could not restore pre-existing ${live} from ${backup}: ${
            restoreErr instanceof Error ? restoreErr.message : String(restoreErr)
          }`
        );
      }
    }
    throw err;
  }

  // Promotion succeeded — drop the backups of replaced originals.
  // Best-effort: a leftover .replaced-* file is cosmetic, never
  // load-bearing for the live chart library.
  for (const { backup } of backups) {
    try {
      await fs.promises.unlink(backup);
    } catch (cleanupErr) {
      console.warn(
        `[charts-provider] promoteQuarantine could not delete backup ${backup}: ${
          cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)
        }`
      );
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
