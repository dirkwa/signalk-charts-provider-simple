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
