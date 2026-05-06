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
