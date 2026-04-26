import os from 'os';

export type CpuBudgetPreset = 'single-core' | 'half' | 'all';

export interface ResolvedBudget {
  /** Max number of conversion jobs that can run at the same time. */
  maxConcurrentConversions: number;
  /** TIPPECANOE_MAX_THREADS env passed to each tippecanoe container. */
  tippecanoeThreadsPerJob: number;
  /** Width of the xargs -P fan-out used for parallel ogr2ogr in the GDAL export stage. */
  gdalExportParallelism: number;
}

const cpuCount = (): number => Math.max(1, os.cpus().length);

function resolveBudget(preset: CpuBudgetPreset, cpus: number): ResolvedBudget {
  const safe = Math.max(1, cpus);
  switch (preset) {
    case 'single-core':
      return {
        maxConcurrentConversions: 1,
        tippecanoeThreadsPerJob: 1,
        gdalExportParallelism: 1
      };
    case 'all':
      // One full-throttle job. Multi-bundle uploads queue serially; each
      // single bundle uses every core in both stages.
      return {
        maxConcurrentConversions: 1,
        tippecanoeThreadsPerJob: safe,
        gdalExportParallelism: safe
      };
    case 'half':
    default: {
      // Today's behaviour: cpus/2 jobs in parallel, each tippecanoe gets
      // floor(cpus / max-jobs) threads. GDAL export reuses the per-job ceiling.
      const max = Math.max(1, Math.floor(safe / 2));
      const perJob = Math.max(1, Math.floor(safe / max));
      return {
        maxConcurrentConversions: max,
        tippecanoeThreadsPerJob: perJob,
        gdalExportParallelism: perJob
      };
    }
  }
}

let current: ResolvedBudget = resolveBudget('half', cpuCount());

/** Apply a budget preset. Called from the plugin's start() with the user's setting. */
export function setCpuBudget(preset: CpuBudgetPreset | undefined | null): void {
  current = resolveBudget(preset ?? 'half', cpuCount());
}

/** Read the currently applied budget. Each call returns the live values, so
 *  call sites pick up budget changes between conversions. */
export function getCpuBudget(): ResolvedBudget {
  return current;
}

/** For tests: pure function over a synthetic CPU count. */
export function _computeBudgetForTests(preset: CpuBudgetPreset, cpus: number): ResolvedBudget {
  return resolveBudget(preset, cpus);
}
