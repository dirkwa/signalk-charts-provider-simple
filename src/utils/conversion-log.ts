/**
 * Cap on how many lines of per-chart conversion log output are retained in
 * memory (s57-converter.ts, rnc-converter.ts) and the default number of
 * lines returned by the log-polling routes in index.ts. Single source of
 * truth so the routes never truncate a response below what's actually
 * being stored.
 */
export const MAX_CONVERSION_LOG_LINES = 1000;

/**
 * Resolve the `tail` query param for a log-polling route into the number of
 * trailing lines to return. Falls back to `fallback` (which callers set to the
 * maximum number of lines that route can have stored) for anything that isn't a
 * positive integer — missing, non-numeric, `0`, or negative. Negative values
 * are rejected rather than passed through, since `slice(-tail)` would otherwise
 * flip meaning and drop the newest lines instead of tailing.
 */
export function resolveLogTail(raw: unknown, fallback: number): number {
  const parsed = parseInt(String(raw), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
