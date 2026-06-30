/**
 * Cap on how many lines of per-chart conversion log output are retained in
 * memory (s57-converter.ts, rnc-converter.ts) and the default number of
 * lines returned by the log-polling routes in index.ts. Single source of
 * truth so the routes never truncate a response below what's actually
 * being stored.
 */
export const MAX_CONVERSION_LOG_LINES = 1000;
