import fs from 'fs';
import path from 'path';

export const MARKER_FILENAME = '.charts-provider-marker.json';

export interface ContainerHints {
  /** Whether well-known container indicator files exist on the running filesystem. */
  isLikelyContainer: boolean;
  /** $HOME at startup, useful when comparing host vs in-container paths. `null` when unset. */
  homeEnv: string | null;
  /** Effective UID, useful when explaining permission mismatches. `null` on platforms without `process.getuid` (Windows). */
  uid: number | null;
}

export interface ChartPathMarker {
  version: string;
  chartPath: string;
  writtenAt: string;
  containerHints: ContainerHints;
}

// Detect whether the plugin is running inside a Docker / Podman container by
// looking for the well-known indicator files those runtimes drop into the
// container filesystem. Best-effort — a wrapped runtime that hides them won't
// be flagged. Used only for marker diagnostics, not for behaviour gating.
export function detectContainerHints(): ContainerHints {
  let isLikelyContainer = false;
  try {
    isLikelyContainer = fs.existsSync('/.dockerenv') || fs.existsSync('/run/.containerenv');
  } catch {
    isLikelyContainer = false;
  }
  // Use `null` (not `undefined`) for missing values so JSON.stringify keeps
  // the keys in the marker file. The marker is a documented schema —
  // tooling consumers shouldn't have to handle "key sometimes absent" on
  // platforms where the value can't be obtained (Windows lacks
  // `process.getuid`; `$HOME` may be unset in stripped environments).
  const uid: number | null = typeof process.getuid === 'function' ? process.getuid() : null;
  const homeEnv: string | null = process.env.HOME ?? null;
  return {
    isLikelyContainer,
    homeEnv,
    uid
  };
}

// Write a small marker JSON file at the resolved chart path so users can
// confirm whether the plugin is writing where they expect (especially under
// Docker/Podman bind mounts). The marker contains the chart path, plugin
// version, last-startup timestamp, and a few container hints.
//
// If the host can see this file at <chartPath>/.charts-provider-marker.json,
// the bind mount is wired correctly. If they can't, the plugin is writing to
// a path inside the container that isn't surfaced to the host.
//
// Best-effort: failures are reported via the optional `onError` callback and
// then swallowed — this is purely diagnostic and must never block startup.
export function writeChartPathMarker(
  chartPath: string,
  version: string,
  options: {
    now?: Date;
    onError?: (msg: string) => void;
  } = {}
): string | null {
  const markerPath = path.join(chartPath, MARKER_FILENAME);
  const marker: ChartPathMarker = {
    version,
    chartPath,
    writtenAt: (options.now ?? new Date()).toISOString(),
    containerHints: detectContainerHints()
  };
  try {
    fs.writeFileSync(markerPath, JSON.stringify(marker, null, 2) + '\n');
    return markerPath;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    options.onError?.(`Failed to write chart path marker: ${message}`);
    return null;
  }
}
