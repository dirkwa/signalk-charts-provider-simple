// Number of trailing container-log lines to surface on a job failure. A
// failing helper container's death signature (a `set -e` abort, a GDAL
// stderr dump) is always at the END of the log, so we tail rather than head.
const JOB_LOG_TAIL_LINES = 10;

export interface FailedJobResult {
  exitCode: number;
  log: string[];
  error?: string;
  status?: string;
}

/**
 * Surface a helper container's own output, plus signalk-container's error
 * string, into the conversion log before throwing. The converter's exit-code
 * checks used to throw a bare `exit code N` and discard both `result.log` and
 * `result.error`, which made three distinct failures indistinguishable in the
 * UI: a real non-zero GDAL/tippecanoe exit, a synthetic `1` from a thrown
 * `container.wait()`, and an `undefined` exit code coerced to `1` by the
 * runJob wrapper. With the log tail and the runtime error surfaced, the user's
 * conversion log shows which one actually happened.
 *
 * `append` is the caller's per-chart log sink (each converter owns its own
 * `appendLog`). The thrown message is unchanged from the old call sites so any
 * caller matching on it still behaves the same.
 */
export function throwJobFailure(
  result: FailedJobResult,
  label: string,
  append: (text: string) => void
): never {
  if (result.error) {
    append(`${label}: container runtime reported: ${result.error}`);
  }
  const log = result.log ?? [];
  if (log.length === 0) {
    const status = result.status ? `, status ${result.status}` : '';
    append(
      `${label}: container produced no output (exit ${result.exitCode}${status}). ` +
        'The helper container likely failed to start or exited before any log was captured.'
    );
  } else {
    const tail = log.slice(-JOB_LOG_TAIL_LINES);
    append(
      `${label}: exit ${result.exitCode}. Last ${tail.length} of ${log.length} container log line(s):`
    );
    for (const line of tail) {
      append(`  ${line}`);
    }
  }
  throw new Error(`${label} failed with exit code ${result.exitCode}`);
}
