import os from 'os';

const cpuCount = Math.max(1, os.cpus().length);

export const MAX_CONCURRENT_CONVERSIONS = Math.max(1, Math.floor(cpuCount / 2));

export const TIPPECANOE_THREADS_PER_JOB = Math.max(
  1,
  Math.floor(cpuCount / MAX_CONCURRENT_CONVERSIONS)
);
