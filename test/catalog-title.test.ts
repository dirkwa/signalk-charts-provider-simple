import { describe, it } from 'node:test';
import assert from 'node:assert';

import { cleanCatalogTitle, sanitizeChartFilename } from '../dist/utils/catalog-title.js';

describe('cleanCatalogTitle', () => {
  it('strips trailing size + index from a hyphen-separated NL IENC title', () => {
    assert.strictEqual(
      cleanCatalogTitle('Zeeland met Diepte - 2026 - Week 19 - 47 MB (0)'),
      'Zeeland met Diepte - 2026 - Week 19'
    );
  });

  it('strips an en-dash size suffix glued to the previous word', () => {
    // 'Week 18– 25 MB (1)' — en-dash with no leading space.
    assert.strictEqual(
      cleanCatalogTitle('Waddenzee met Diepte 2026 - Week 18– 25 MB (1)'),
      'Waddenzee met Diepte 2026 - Week 18'
    );
  });

  it('strips a trailing index when no size suffix is present', () => {
    assert.strictEqual(
      cleanCatalogTitle('Port of Rotterdam 2026-04-21 (2)'),
      'Port of Rotterdam 2026-04-21'
    );
  });

  it('preserves mid-title parens (e.g. "excl Zeeland, Waddenzee")', () => {
    // The trailing (3) gets stripped; the mid-title (excl ...) must stay.
    assert.strictEqual(
      cleanCatalogTitle('Nederland (excl Zeeland, Waddenzee) 2026-02-19 - 46MB (3)'),
      'Nederland (excl Zeeland, Waddenzee) 2026-02-19'
    );
  });

  it('strips a no-space size suffix like "46MB"', () => {
    assert.strictEqual(
      cleanCatalogTitle('Nederland 2026-02-19 - 46MB (3)'),
      'Nederland 2026-02-19'
    );
  });

  it('strips just the trailing index when title has no size suffix', () => {
    assert.strictEqual(
      cleanCatalogTitle('20260216_U7Inland_Closed Edition_NL (4)'),
      '20260216_U7Inland_Closed Edition_NL'
    );
  });

  it('handles em-dash size separator', () => {
    assert.strictEqual(cleanCatalogTitle('Some Chart 2026 — 25 MB (5)'), 'Some Chart 2026');
  });

  it('returns the input unchanged when it has no recognised suffix', () => {
    assert.strictEqual(cleanCatalogTitle('Pure Chart Name 2026'), 'Pure Chart Name 2026');
  });

  it('preserves year/week identity markers', () => {
    // The cleaner must NOT strip "2026 - Week 19" — that's part of the chart.
    const result = cleanCatalogTitle('Foo 2026 - Week 19 - 10 MB (0)');
    assert.ok(result.includes('2026'));
    assert.ok(result.includes('Week 19'));
  });

  it('returns empty string for empty/whitespace input', () => {
    assert.strictEqual(cleanCatalogTitle(''), '');
    assert.strictEqual(cleanCatalogTitle('   '), '');
  });

  it('returns empty string for non-string input (defensive)', () => {
    // Explicitly testing the runtime guard: TS callers can't pass
    // these directly, but the helper still defends against parsed-JSON
    // payloads where the type assertion was wrong upstream.
    assert.strictEqual(cleanCatalogTitle(undefined as unknown as string), '');
    assert.strictEqual(cleanCatalogTitle(null as unknown as string), '');
    assert.strictEqual(cleanCatalogTitle(42 as unknown as string), '');
  });

  it('does not strip a (N) that appears mid-title', () => {
    assert.strictEqual(
      cleanCatalogTitle('Chart (special edition) 2026'),
      'Chart (special edition) 2026'
    );
  });
});

describe('sanitizeChartFilename', () => {
  it('replaces spaces with underscores', () => {
    assert.strictEqual(
      sanitizeChartFilename('Waddenzee met Diepte 2026 - Week 18'),
      'Waddenzee_met_Diepte_2026_-_Week_18'
    );
  });

  it('collapses runs of whitespace', () => {
    assert.strictEqual(sanitizeChartFilename('Foo   Bar\tBaz'), 'Foo_Bar_Baz');
  });

  it('replaces path separators with dashes', () => {
    assert.strictEqual(sanitizeChartFilename('NL/Inland\\Foo'), 'NL-Inland-Foo');
  });

  it('replaces dots with dashes (no extension confusion mid-name)', () => {
    assert.strictEqual(
      sanitizeChartFilename('Port of Rotterdam 2026.04.21'),
      'Port_of_Rotterdam_2026-04-21'
    );
  });

  it('drops control characters', () => {
    assert.strictEqual(sanitizeChartFilename('Foo\x00Bar\x1fBaz'), 'FooBarBaz');
  });

  it('preserves common safe punctuation (parens, dashes, brackets)', () => {
    assert.strictEqual(
      sanitizeChartFilename('Nederland (excl Zeeland, Waddenzee) 2026'),
      'Nederland_(excl_Zeeland,_Waddenzee)_2026'
    );
  });

  it('trims leading and trailing punctuation', () => {
    assert.strictEqual(sanitizeChartFilename('  -.--__Foo Bar__--.-  '), 'Foo_Bar');
  });

  it('caps length at 100 chars and trims trailing punctuation after the cut', () => {
    const long = 'A'.repeat(120);
    const got = sanitizeChartFilename(long);
    assert.strictEqual(got.length, 100);
    assert.ok(got.endsWith('A'));
  });

  it('returns empty string for empty / whitespace / non-string', () => {
    assert.strictEqual(sanitizeChartFilename(''), '');
    assert.strictEqual(sanitizeChartFilename('   '), '');
    assert.strictEqual(sanitizeChartFilename(undefined as unknown as string), '');
    assert.strictEqual(sanitizeChartFilename(null as unknown as string), '');
    assert.strictEqual(sanitizeChartFilename(42 as unknown as string), '');
  });

  it('returns empty string when only unsafe characters remain after sanitization', () => {
    // Just whitespace and control chars → nothing left after collapse + trim.
    assert.strictEqual(sanitizeChartFilename('\x00 \x01\x02\x03'), '');
  });
});
