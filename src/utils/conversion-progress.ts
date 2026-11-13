import type { ConversionProgress, ConversionProgressMap } from '../types.js';

// How long a finished entry (and its log) stays around for polling before
// being deleted — deleting it the instant the job ends would make the next
// poll see the job vanish before the final message is ever read.
const RESULT_RETENTION_MS = 300000;

export function setConversionResult(
  progress: ConversionProgressMap,
  chartNumber: string,
  status: 'failed' | 'completed',
  message: string
): void {
  const entry: ConversionProgress = {
    status,
    message,
    log: progress[chartNumber]?.log ?? []
  };
  progress[chartNumber] = entry;
  // Only clear the entry if it's still the one this timer was scheduled for
  // — a retry started in the meantime replaces it with a new object (and
  // schedules its own cleanup), so a stale timer must not delete that one.
  setTimeout(() => {
    if (progress[chartNumber] === entry) {
      delete progress[chartNumber];
    }
  }, RESULT_RETENTION_MS).unref();
}

export type ProgressSummary = Omit<ConversionProgress, 'log'>;

// Status routes are open to read-only users; the log, with its server
// paths, is served only by the readwrite log routes.
export function withoutLog(progress: ConversionProgress | null): ProgressSummary | null {
  return progress && { status: progress.status, message: progress.message };
}

export function progressWithoutLogs(
  progress: ConversionProgressMap
): Record<string, ProgressSummary> {
  return Object.fromEntries(
    Object.entries(progress).map(([chartNumber, entry]) => [
      chartNumber,
      { status: entry.status, message: entry.message }
    ])
  );
}
