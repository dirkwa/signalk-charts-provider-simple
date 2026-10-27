/**
 * Which toolchain converts a chart.
 *
 * The container toolchain is preferred: GDAL, tippecanoe and tile-join in the
 * charts-toolbox image, run through the `signalk-container` plugin. GDAL
 * compiled to WebAssembly (gdal3.js) with the built-in vector tiler, inside
 * the Signal K process, takes over whenever the container toolchain cannot
 * run: signalk-container is not installed or found no runtime, the image is
 * missing and cannot be pulled (a boat offline), or a folder the conversion
 * uses cannot be mounted into the helper container. The choice is made once
 * per conversion, before it writes anything, so a fallback never meets a
 * half-finished container run.
 *
 * The plugin's `conversionEngine` setting can pin either toolchain: pinned to
 * the container, a conversion it cannot run fails with the reason instead of
 * falling back.
 */

import { CHARTS_TOOLBOX_IMAGE } from './container-images.js';
import { ensureImage, resolveJobPaths } from './container-jobs.js';
import { settledContainerManager } from './container-manager.js';
import { gdalBuildId } from './gdal-wasm.js';

export type ConversionBackend = 'container' | 'wasm';

// Message thrown when an in-progress conversion is cancelled: at a stage
// boundary, or mid-stage when the abort signal kills the container job
// (signalk-container >= 1.16.0) or terminates the worker threads. Callers
// (the Custom Catalogs flow) detect cancellation via their own flag, so this
// is just a recognizable stop signal.
export const CONVERSION_ABORTED_MESSAGE = 'Conversion cancelled';
export type ConversionEnginePreference = 'auto' | ConversionBackend;

let preference: ConversionEnginePreference = 'auto';

export function setConversionEnginePreference(value: string | undefined): void {
  preference = value === 'container' || value === 'wasm' ? value : 'auto';
}

export function getConversionEnginePreference(): ConversionEnginePreference {
  return preference;
}

/**
 * The build whose GDAL wrote a backend's output: the chart-set cache keys
 * each cell's GeoJSON by it, so a cell read by the other toolchain is read
 * again.
 */
export function backendBuildId(backend: ConversionBackend): string {
  return backend === 'container' ? CHARTS_TOOLBOX_IMAGE : gdalBuildId();
}

/** A short name for the conversion log and the Convert tab. */
export function describeBackend(backend: ConversionBackend): string {
  return backend === 'container'
    ? 'container toolchain (GDAL and tippecanoe)'
    : `built-in GDAL (WebAssembly, ${gdalBuildId()})`;
}

/**
 * Progress and log sinks a toolchain reports a conversion through. The
 * converters own the conversion's progress record; a toolchain only writes
 * to it through these.
 */
export interface ConversionReport {
  log: (text: string) => void;
  progress: (status: string, message: string) => void;
  /** Replace the progress message, keeping the status. */
  message: (text: string) => void;
  debug: (msg: string) => void;
}

export interface BackendChoice {
  backend: ConversionBackend;
  /** Why the container toolchain was passed over, when it was preferred. */
  fallbackReason?: string;
}

export interface ChooseBackendOptions {
  /** Host directories the container toolchain would mount. */
  mountPaths: readonly string[];
  /** Called before the charts-toolbox image is checked (and maybe pulled). */
  onCheckingImage?: () => void;
  debug?: (msg: string) => void;
}

/** Why the container toolchain cannot run this conversion, or null when it can. */
async function containerUnavailableReason(opts: ChooseBackendOptions): Promise<string | null> {
  const manager = await settledContainerManager();
  if (!manager?.getRuntime()) {
    return 'signalk-container is not installed or found no container runtime';
  }
  opts.onCheckingImage?.();
  try {
    await ensureImage(CHARTS_TOOLBOX_IMAGE, opts.debug);
  } catch (err) {
    return `the ${CHARTS_TOOLBOX_IMAGE} image is not available (${
      err instanceof Error ? err.message : String(err)
    })`;
  }
  let unreachable: string | null = null;
  try {
    const mounts = Object.fromEntries(opts.mountPaths.map((p, i) => [`/mnt${String(i)}`, p]));
    const resolved = await resolveJobPaths(mounts, (_containerPath, absPath) => {
      unreachable = absPath;
    });
    if (!resolved) {
      return `${unreachable ?? 'a conversion folder'} cannot be mounted into the helper container`;
    }
  } catch (err) {
    return `the conversion folders could not be resolved for the helper container (${
      err instanceof Error ? err.message : String(err)
    })`;
  }
  return null;
}

/**
 * Pick the toolchain for one conversion. Never throws when the setting is
 * `auto`; pinned to `container`, throws with the reason it cannot run.
 */
export async function chooseConversionBackend(opts: ChooseBackendOptions): Promise<BackendChoice> {
  const pinned = preference;
  if (pinned === 'wasm') {
    return { backend: 'wasm' };
  }
  const reason = await containerUnavailableReason(opts);
  if (reason === null) {
    return { backend: 'container' };
  }
  if (pinned === 'container') {
    throw new Error(
      `Chart conversion is set to use the container toolchain, but ${reason}. ` +
        'Install signalk-container from the App Store, or set the conversion engine to automatic.'
    );
  }
  return { backend: 'wasm', fallbackReason: reason };
}

/** The log line a fallback leaves, so the user sees which toolchain ran and why. */
export function fallbackNote(choice: BackendChoice): string | null {
  return choice.fallbackReason
    ? `Container toolchain not used: ${choice.fallbackReason}. Converting with ${describeBackend('wasm')}.`
    : null;
}
