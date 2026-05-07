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
