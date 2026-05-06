import fs from 'fs';

/**
 * Best-effort detection of "the Signal K server process is itself running
 * inside a container" — independent of any container *runtime* we use to
 * launch chart conversions.
 *
 * Why this matters: when Signal K is in a container and the chart-conversion
 * pipeline talks to the host docker daemon via socket pass-through
 * (`/var/run/docker.sock`), every bind path the plugin generates is a
 * container-internal path. The host docker daemon resolves those paths
 * against the host filesystem and silently mounts an empty directory if
 * they don't exist there — leading to GDAL containers that exit cleanly
 * after ~37 ms with no output, and conversions that "do nothing" with no
 * actionable error. Surfacing the detection up front turns a confusing
 * silent failure into a startup warning the user can act on.
 *
 * Signals checked, ordered by reliability:
 *   1. `/.dockerenv` — written by docker on every container, never on host.
 *   2. `/run/.containerenv` — podman's equivalent.
 *   3. `/proc/1/cgroup` — line containing `docker` / `containerd` / `kubepods`
 *      means PID 1 is in a managed cgroup, i.e. a container.
 *
 * Returns `null` when none match (we're on the host, or detection failed
 * — both treated the same way: no warning).
 */
export function detectContainerRuntime(): 'docker' | 'podman' | 'unknown-container' | null {
  try {
    if (fs.existsSync('/.dockerenv')) {
      return 'docker';
    }
  } catch {
    // ignored — fall through to next signal
  }
  try {
    if (fs.existsSync('/run/.containerenv')) {
      return 'podman';
    }
  } catch {
    // ignored — fall through to next signal
  }
  try {
    const cgroup = fs.readFileSync('/proc/1/cgroup', 'utf8');
    if (/\b(docker|containerd|kubepods|libpod)\b/i.test(cgroup)) {
      return 'unknown-container';
    }
  } catch {
    // /proc/1/cgroup unreadable — give up, assume host
  }
  return null;
}
