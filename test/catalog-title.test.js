const { describe, it } = require('node:test');
const assert = require('node:assert');

const { cleanCatalogTitle } = require('../dist/utils/catalog-title');

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
    assert.strictEqual(cleanCatalogTitle(undefined), '');
    assert.strictEqual(cleanCatalogTitle(null), '');
    assert.strictEqual(cleanCatalogTitle(42), '');
  });

  it('does not strip a (N) that appears mid-title', () => {
    assert.strictEqual(
      cleanCatalogTitle('Chart (special edition) 2026'),
      'Chart (special edition) 2026'
    );
  });
});
