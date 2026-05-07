/**
 * Thin wrapper around `signalk-container`'s `ContainerManagerApi.runJob`
 * that hides the path-translation, image-pull, and result-shape boilerplate
 * the converter modules used to do directly via `container-runtime.ts`.
 *
 * The wrapper exists because every converter call site shares the same
 * shape:
 *   1. Resolve absolute host paths to (source, subPath) pairs that the
 *      runtime can mount, regardless of how SignalK is deployed.
 *   2. Mount each input read-only at a conventional container path like
 *      `/input`, output RW at `/output`.
 *   3. Run the helper container, line-by-line stdout/stderr capture.
 *   4. Return `{ exitCode }` so converter logic can branch on it.
 *
 * `resolveJobPaths` and `runJobWithBinds` keep that shape uniform across
 * the s57-converter / rnc-converter sites and isolate the integration
 * with signalk-container in one place — if the runtime API evolves, only
 * this file changes.
 */

import { getContainerManager } from './container-manager';
import type { ContainerManagerApi, ContainerResourceLimits } from './container-manager';

function requireManager(): ContainerManagerApi {
  const manager = getContainerManager();
  if (!manager) {
    throw new Error(
      'signalk-container plugin is required for chart conversion. ' +
        'Install it from the App Store and restart Signal K.'
    );
  }
  return manager;
}

export interface JobRunOptions {
  image: string;
  /**
   * Command to run inside the helper container.  Path arguments should
   * reference container paths the wrapper composes from `inputs` /
   * `outputs` plus each `JobBindResult.subPath` returned by
   * `resolveJobPaths`.
   */
  command: string[];
  /**
   * Map of conventional container path → resolved host source.  Mounted
   * read-only.  Use `resolveJobPaths` to build this map from absolute
   * host paths; the function handles bind / volume / parent-mount cases.
   */
  inputs?: Record<string, string>;
  /**
   * Map of conventional container path → resolved host source.  Mounted
   * read-write.
   */
  outputs?: Record<string, string>;
  env?: Record<string, string>;
  /** Short label for diagnostics (visible in `ps`, container logs). */
  label?: string;
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
  /**
   * Cgroup limits applied to the helper container — `--cpus`,
   * `--memory`, etc.  Without this, jobs run with no kernel-enforced
   * ceiling and CPU-bound workloads (tippecanoe, GDAL parallel
   * exports) can saturate every core regardless of any in-process
   * thread cap (e.g. TIPPECANOE_MAX_THREADS).  Honored by
   * signalk-container >= 1.2.0; older versions silently ignore.
   */
  resources?: ContainerResourceLimits;
}

export interface JobRunResult {
  exitCode: number;
  /** Combined stdout+stderr lines, in the order they were emitted. */
  log: string[];
}

/**
 * Per-bind resolution result.  The wrapper composes the runJob `inputs`
 * / `outputs` map from the `source` field of each entry, and the caller
 * uses `subPath` to navigate from the conventional mount root to the
 * path it actually wants.  For bind mounts where the runtime can
 * subpath-bind, `subPath` is empty and the consumer's container path is
 * just `/input` (or `/output`); for named volumes where the whole
 * volume must be mounted, `subPath` is non-empty and the consumer
 * appends it: `/input/${subPath}/...`.
 */
export interface JobBindResolution {
  source: string;
  /** Path INSIDE the mounted source where the original abs path lives. */
  subPath: string;
}

/**
 * Resolve a set of absolute host paths into `JobBindResolution`s.
 * Returns null and surfaces an error to the caller's `onMissing` if
 * any path can't be reached from the host runtime — meaning either
 * the SignalK deployment doesn't expose the path at all (e.g. user
 * configured a `chartPath` outside the SignalK data volume), or
 * signalk-container's runtime detection has failed.
 */
export async function resolveJobPaths(
  paths: Record<string, string>,
  onMissing?: (containerPath: string, absPath: string) => void
): Promise<Record<string, JobBindResolution> | null> {
  const manager = requireManager();
  const out: Record<string, JobBindResolution> = {};
  for (const [containerPath, absPath] of Object.entries(paths)) {
    const r = await manager.resolveHostPath(absPath);
    if (!r) {
      onMissing?.(containerPath, absPath);
      return null;
    }
    out[containerPath] = { source: r.source, subPath: r.subPath };
  }
  return out;
}

/**
 * Runs a one-shot job with `inputs` / `outputs` plus the standard
 * line-callbacks.  Wraps `manager.runJob` so converters don't have to
 * import the manager type or re-implement exit-code extraction.  Throws
 * when the manager is missing — caller should have checked at startup.
 */
export async function runJob(opts: JobRunOptions): Promise<JobRunResult> {
  const manager = requireManager();
  const result = await manager.runJob({
    image: opts.image,
    command: opts.command,
    inputs: opts.inputs,
    outputs: opts.outputs,
    env: opts.env,
    label: opts.label,
    onStdoutLine: opts.onStdoutLine,
    onStderrLine: opts.onStderrLine,
    resources: opts.resources
  });
  return {
    exitCode: result.exitCode ?? 1,
    log: result.log
  };
}

/**
 * Convenience: ensure the helper image is present, pulling it if not.
 * Mirrors the old `ensureImage` from this plugin's standalone runtime
 * layer but routes through signalk-container's manager so a single
 * pull-progress UI is reused across plugins.
 */
export async function ensureImage(
  image: string,
  debug: (msg: string) => void = () => {}
): Promise<void> {
  const manager = requireManager();
  if (await manager.imageExists(image)) {
    return;
  }
  debug(`Pulling image: ${image}`);
  await manager.pullImage(image, (msg) => debug(msg));
  debug(`Image pulled: ${image}`);
}
