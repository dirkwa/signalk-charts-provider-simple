/**
 * Single source of truth for "is this resolved path within the chart
 * root" checks. Several REST handlers compose `path.join(basePath, …)`
 * from user-supplied folder/chart names; without a guard a value like
 * `'../etc/passwd'` would resolve outside the chart root.
 *
 * The check normalizes both sides and uses `startsWith(base + path.sep)
 * || === base`. Bare `startsWith(base)` is wrong: with base
 * `/srv/charts`, it would also accept `/srv/charts-evil/foo`.
 */

import path from 'path';

export function isWithinBase(candidate: string, basePath: string): boolean {
  const normalizedCandidate = path.normalize(candidate);
  // path.normalize preserves a trailing separator if the input had one.
  // Strip it so the equality and `startsWith(base + sep)` checks work
  // regardless of whether the caller passed a trailing slash.
  const normalizedBase = stripTrailingSep(path.normalize(basePath));
  if (normalizedCandidate === normalizedBase) {
    return true;
  }
  return normalizedCandidate.startsWith(normalizedBase + path.sep);
}

function stripTrailingSep(p: string): string {
  if (p.length > 1 && p.endsWith(path.sep)) {
    return p.slice(0, -1);
  }
  return p;
}

export function arePairWithinBase(a: string, b: string, basePath: string): boolean {
  return isWithinBase(a, basePath) && isWithinBase(b, basePath);
}

/**
 * Validate a user-supplied chart name/number before it is used as a
 * write filename. Same intent as the inline guard in `promoteQuarantine`,
 * surfaced as a route-level check so the handlers can answer 400 instead
 * of letting a bad name fail the download job asynchronously.
 *
 * The backslash check is deliberately stricter than POSIX: on the Linux
 * server `\` is an ordinary byte and can't escape the dir, but chart
 * files get copied to and served from Windows hosts, where `\` is a
 * separator — rejecting it keeps a name portable rather than turning into
 * a traversal once the file leaves this machine.
 */
export function validateChartName(name: string): { valid: boolean; reason?: string } {
  if (name === '') {
    return { valid: false, reason: 'must not be empty' };
  }
  if (path.basename(name) !== name || name.includes('\\')) {
    return { valid: false, reason: 'must not contain path separators' };
  }
  if (name.includes('..')) {
    return { valid: false, reason: 'must not contain ".."' };
  }
  if (path.isAbsolute(name)) {
    return { valid: false, reason: 'must not be an absolute path' };
  }
  return { valid: true };
}

/**
 * True when the installer has injected a host charts-folder mount path via the
 * `SIGNALK_CHARTS_HOST_PATH` env var (non-empty after trimming). Single source
 * of truth for "are we defaulting to a mounted host folder" — used by the
 * default-path resolver, the schema description, and the startup access check
 * so they can never disagree.
 */
export function hasHostChartsMountEnv(hostMountEnv: string | undefined): boolean {
  return hostMountEnv !== undefined && hostMountEnv.trim() !== '';
}

/**
 * Resolve the plugin's effective default chart directory.
 *
 * When Signal K runs in a container (signalk-universal-installer), the
 * installer can mount a host folder the user shares with other chart apps
 * (OpenCPN/qtVlm/…) and inject its in-container path via the
 * `SIGNALK_CHARTS_HOST_PATH` env var. When that env is a non-empty path we
 * default to it, so a container user gets the shared host folder with no
 * config — and the chartPath field is never the free-text foot-gun that
 * pointed at an unmounted host path. Otherwise we fall back to the
 * in-data-volume `charts-simple` directory.
 *
 * Pure: takes the env value and the computed fallback explicitly so it is
 * testable without a real container or a Signal K `app`.
 */
export function resolveDefaultChartsPath(
  hostMountEnv: string | undefined,
  inDataVolumeDefault: string
): string {
  if (hasHostChartsMountEnv(hostMountEnv)) {
    return (hostMountEnv as string).trim();
  }
  return inDataVolumeDefault;
}

/**
 * True when `effectivePath` IS the installer-injected host charts mount (the
 * value of `SIGNALK_CHARTS_HOST_PATH`). Used to decide "must already exist,
 * probe-don't-create" vs create-on-demand.
 *
 * Both sides are normalized so a trailing slash, `//`, or `.`/`..` in a
 * user-typed path can't divert the mount into the create-on-demand branch
 * (which would `mkdir` and silently shadow a missing bind mount). Returns false
 * when the env is unset/blank (there is no mount to match).
 */
export function isHostMountPath(effectivePath: string, hostMountEnv: string | undefined): boolean {
  if (!hasHostChartsMountEnv(hostMountEnv)) {
    return false;
  }
  return (
    normalizeForCompare(effectivePath) === normalizeForCompare((hostMountEnv as string).trim())
  );
}

// Normalize a path for equality comparison: collapse `.`/`..`/`//` AND strip a
// trailing separator (path.normalize keeps a trailing slash, so `/a/b/` and
// `/a/b` would otherwise compare unequal — the #150 trailing-slash edge).
function normalizeForCompare(p: string): string {
  return stripTrailingSep(path.normalize(p));
}

/** Verdict of {@link classifyChartDirAccess}. */
export type ChartDirAccess =
  | { ok: true }
  /** The path is the injected host mount but does not exist inside the
   *  container → the bind mount is missing/failed. Do NOT create it (that would
   *  silently shadow the absent mount with an ephemeral in-container dir whose
   *  charts vanish on container recreate). */
  | { ok: false; reason: 'mount-missing' }
  /** The path exists but is not writable (rootless keep-id owns it as a
   *  different uid, a read-only bind, or no space) → an ownership/permission
   *  problem, NOT a missing mount. */
  | { ok: false; reason: 'exists-unwritable' }
  /** A non-mount path (in-data-volume default, or a user-typed path) that the
   *  plugin should create on demand but couldn't. */
  | { ok: false; reason: 'not-writable' };

/**
 * Decide how to treat a chart directory's accessibility, given pre-probed fs
 * facts. Pure (no fs calls) so the branching is unit-testable.
 *
 * The `isHostMount` path is treated as "should already exist" — the installer
 * created the host folder and bind-mounted it — so a missing dir means a
 * missing mount and must surface an error, NOT be `mkdir`-ed (the bug that
 * masks a forgotten mount). A non-mount path keeps create-on-demand semantics.
 *
 * @param isHostMount   resolved path === the injected host mount
 * @param exists        fs.existsSync(path)
 * @param createdOrWritable for a host mount: is it writable? for a non-mount:
 *                          did create-on-demand (mkdir -p) succeed?
 */
export function classifyChartDirAccess(
  isHostMount: boolean,
  exists: boolean,
  createdOrWritable: boolean
): ChartDirAccess {
  if (isHostMount) {
    if (!exists) {
      return { ok: false, reason: 'mount-missing' };
    }
    return createdOrWritable ? { ok: true } : { ok: false, reason: 'exists-unwritable' };
  }
  return createdOrWritable ? { ok: true } : { ok: false, reason: 'not-writable' };
}
