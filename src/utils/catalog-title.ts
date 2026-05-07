/**
 * Strip the noise suffixes that catalog vendors append to chart titles, so
 * the result is a clean human label suitable for the MBTiles `name` row.
 *
 * Real-world examples observed in NL_IENC_Catalog.json:
 *   'Zeeland met Diepte - 2026 - Week 19 - 47 MB (0)'
 *   'Waddenzee met Diepte 2026 - Week 18– 25 MB (1)'         (en-dash, no space)
 *   'Port of Rotterdam 2026-04-21 (2)'                       (no size suffix)
 *   'Nederland (excl Zeeland, Waddenzee) 2026-02-19 - 46MB (3)'  (mid-title parens)
 *   '20260216_U7Inland_Closed Edition_NL (4)'                (no size, trailing index)
 *
 * Stripped:
 *   - Trailing `(N)` only when it sits at the very end (so 'excl Zeeland, Waddenzee'
 *     mid-title is preserved).
 *   - Trailing size pattern: optional dash/en-dash/em-dash + digits + optional
 *     space + MB.
 *
 * NOT stripped: year/week markers ('2026 - Week 19'), parens-with-text inside
 * the title, anything else. Those are part of the chart identity.
 *
 * Pure helper, no side effects. Returns the trimmed cleaned string. If the
 * input is empty/whitespace, returns an empty string.
 */
export function cleanCatalogTitle(raw: string): string {
  if (typeof raw !== 'string') {
    return '';
  }
  let s = raw.trim();
  if (s === '') {
    return '';
  }

  // Strip trailing index ` (N)` only at the very end.
  s = s.replace(/\s*\(\d+\)\s*$/, '');

  // Strip trailing size: optional [-–—] followed by digits, optional space, MB.
  // Only at the very end after the index has been removed.
  s = s.replace(/\s*[-–—]?\s*\d+\s*MB\s*$/i, '');

  return s.trim();
}

/**
 * Turn a (cleaned) catalog title into a filesystem-safe basename for the
 * output `.mbtiles` file, so users see e.g. `Waddenzee_met_Diepte_2026-Week_18.mbtiles`
 * in their chart directory instead of the catalog's sequential index
 * (`1.mbtiles`, `2.mbtiles`, …) which is meaningless out of context.
 *
 * Rules:
 *   - All whitespace runs collapse to single underscores (no spaces in filenames).
 *   - Path separators (/, \) and `.` are replaced with `-` so the result
 *     can never escape its directory or accidentally trigger an extension
 *     change.
 *   - Any control / non-printable character is dropped.
 *   - Other punctuation is preserved as-is — modern filesystems handle
 *     dashes, parens, brackets fine.
 *   - Result is trimmed of leading/trailing dashes, dots, and underscores.
 *   - Capped at 100 chars to stay well below filesystem limits even after
 *     `.mbtiles` and any collision suffix the caller appends.
 *
 * Returns the empty string when the input is empty / sanitizes to nothing
 * (caller falls back to chartNumber or another label).
 */
export function sanitizeChartFilename(title: string): string {
  if (typeof title !== 'string') {
    return '';
  }
  let s = title.trim();
  if (s === '') {
    return '';
  }

  // Whitespace runs → single underscore.
  s = s.replace(/\s+/g, '_');

  // Path separators and dots → dash.  Dots especially must go: an extension
  // boundary in the middle of a chart name would confuse downstream tools
  // (and our own /\.mbtiles$/ regex if we ever round-trip through it).
  s = s.replace(/[/\\.]/g, '-');

  // Drop control / non-printable.
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[\x00-\x1f\x7f]/g, '');

  // Trim noisy leading/trailing punctuation.
  s = s.replace(/^[-._]+|[-._]+$/g, '');

  if (s.length > 100) {
    s = s.slice(0, 100).replace(/[-._]+$/g, '');
  }

  return s;
}
