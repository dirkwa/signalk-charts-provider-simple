/**
 * Discovery and access for the running `signalk-container` plugin's
 * manager API.  The runtime layer of this plugin (GDAL exports,
 * tippecanoe, basemap pipelines) is delegated to that plugin starting
 * with chart-provider 2.0; it transparently resolves bind / named-volume
 * sources for the SignalK data dir, which is the structural fix for the
 * "Signal K in Docker with mismatched binds" failure mode that 1.x
 * worked around with a probe + startup warning.
 *
 * The integration follows the documented pattern: signalk-container
 * publishes its API on `(globalThis as any).__signalk_containerManager`
 * once its own `start()` runs.  Plugin load order is not deterministic,
 * so we wait up to ~30 s for the global to appear before giving up and
 * letting the plugin show a `setPluginError` so the user can install
 * the dependency.
 */

/**
 * Subset of `signalk-container`'s `ContainerManagerApi` that
 * chart-provider actually calls.  We don't depend on signalk-container
 * for types because importing from a peer-dep would mean shipping
 * its source tree under our `node_modules/`, which the App Store's
 * `--ignore-scripts` install model handles awkwardly.  The type below
 * matches the published 1.0.0 surface; if signalk-container evolves
 * in a backwards-incompatible way our peerDependencies range will
 * surface the mismatch.
 */
/**
 * Subset of signalk-container's ContainerResourceLimits we use.  The
 * full type has more fields (cpuShares, cpusetCpus, memoryReservation,
 * etc.); we only declare what chart-provider actually sets so the
 * shim stays minimal.  Available in signalk-container >= 1.2.0 on
 * ContainerJobConfig.
 */
export interface ContainerResourceLimits {
  /** Hard CPU cap (CFS quota).  e.g. 1.5 = 1.5 cores. */
  cpus?: number | null;
  /** Hard memory cap, e.g. "512m", "2g". */
  memory?: string | null;
}

export interface ContainerJobConfig {
  image: string;
  command: string[];
  inputs?: Record<string, string>;
  outputs?: Record<string, string>;
  env?: Record<string, string>;
  timeout?: number;
  onProgress?: (msg: string) => void;
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
  /**
   * Cgroup limits applied to the helper container.  Available in
   * signalk-container >= 1.2.0.  Without this, jobs run with no
   * kernel-enforced ceiling and can saturate every core regardless
   * of any in-process thread cap.
   */
  resources?: ContainerResourceLimits;
  label?: string;
}

export interface ContainerJobResult {
  status: 'pending' | 'pulling' | 'running' | 'completed' | 'failed';
  exitCode?: number;
  log: string[];
  error?: string;
}

export interface ContainerRuntimeInfo {
  runtime: 'podman' | 'docker';
  version: string;
}

export interface ContainerMountResolution {
  /** Source for the `-v <source>:<dest>` flag: host path or volume name. */
  source: string;
  /**
   * Path inside the mounted source where the original abs path lives.
   * Empty string when the source already corresponds to absPath (the
   * common bind-mount case).  Non-empty when SignalK is on a named
   * volume and the consumer must navigate into it from the mount root.
   */
  subPath: string;
}

export interface ContainerManagerApi {
  getRuntime(): ContainerRuntimeInfo | null;
  pullImage(image: string, onProgress?: (msg: string) => void): Promise<void>;
  imageExists(image: string): Promise<boolean>;
  runJob(config: ContainerJobConfig): Promise<ContainerJobResult>;
  /**
   * Returns the source (named volume name or absolute host path) that
   * backs `app.getDataDirPath()` in the current deployment.  Use this
   * value as the LEFT side of a `-v <source>:<dest>` mount when handing
   * paths-under-dataDir to `runJob`'s `inputs`/`outputs`.  Bare-metal
   * SignalK gets `dataDir` itself, in-container gets either a named
   * volume or the resolved host path.  Null when the runtime hasn't
   * been initialised yet.
   */
  resolveSignalkDataMount(): Promise<string | null>;
  /**
   * Translate an arbitrary absolute path into the `(source, subPath)`
   * pair needed to mount it into a managed container.  See the
   * signalk-container plugin-developer-guide for the resolution rules
   * across bare-metal / bind / named-volume topologies.  Null when no
   * mount covers the path.  Available in signalk-container >= 1.1.0.
   */
  resolveHostPath(absPath: string): Promise<ContainerMountResolution | null>;
}

let resolvedManager: ContainerManagerApi | null = null;

/**
 * Wait for `signalk-container` to publish its manager on globalThis,
 * up to a 30-second budget.  Calls `onWaitingStatus` once the first
 * cycle elapses without finding the manager so the user sees what's
 * happening on the plugin's status line.
 *
 * Resolves with the manager once `getRuntime()` returns a non-null
 * runtime; resolves with null if the budget expires.  We don't reject
 * because the caller wants to fall through to `setPluginError` rather
 * than crash the plugin.
 */
export async function waitForContainerManager(opts: {
  budgetMs?: number;
  pollIntervalMs?: number;
  onWaitingStatus?: () => void;
}): Promise<ContainerManagerApi | null> {
  const budgetMs = opts.budgetMs ?? 30000;
  const pollIntervalMs = opts.pollIntervalMs ?? 1000;
  const deadline = Date.now() + budgetMs;
  let signalledWait = false;

  while (Date.now() < deadline) {
    const candidate = (globalThis as { __signalk_containerManager?: ContainerManagerApi })
      .__signalk_containerManager;
    if (candidate && candidate.getRuntime()) {
      resolvedManager = candidate;
      return candidate;
    }
    if (!signalledWait) {
      opts.onWaitingStatus?.();
      signalledWait = true;
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  return null;
}

/**
 * Return the manager last resolved by `waitForContainerManager`, or
 * null if discovery hasn't run / has failed.  Converters use this as
 * a synchronous accessor; they're only called after `start()` has
 * already populated the slot.
 */
export function getContainerManager(): ContainerManagerApi | null {
  return resolvedManager;
}

/** Test helper. */
export function _resetContainerManagerForTests(): void {
  resolvedManager = null;
}
