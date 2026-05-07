const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { chooseOutputFilename } = require('../dist/utils/s57-converter');

// Build a `fileExists` stub that says "yes" for the listed paths and "no"
// for everything else.  Lets us drive the collision logic without
// touching disk.
function existsIn(paths) {
  const set = new Set(paths);
  return (p) => set.has(p);
}

describe('chooseOutputFilename', () => {
  const chartsDir = '/charts';

  it('uses the displayName-derived basename when no collision', () => {
    const got = chooseOutputFilename({
      chartsDir,
      displayName: 'Waddenzee met Diepte 2026 - Week 18',
      chartNumber: '1',
      fileExists: existsIn([])
    });
    assert.strictEqual(got, 'Waddenzee_met_Diepte_2026_-_Week_18.mbtiles');
  });

  it('falls back to chartNumber when displayName is missing', () => {
    const got = chooseOutputFilename({
      chartsDir,
      displayName: undefined,
      chartNumber: '1',
      fileExists: existsIn([])
    });
    assert.strictEqual(got, '1.mbtiles');
  });

  it('falls back to chartNumber when displayName sanitizes to empty', () => {
    const got = chooseOutputFilename({
      chartsDir,
      displayName: '   ',
      chartNumber: '1',
      fileExists: existsIn([])
    });
    assert.strictEqual(got, '1.mbtiles');
  });

  it('falls back to "enc-chart" when both displayName and chartNumber are empty', () => {
    const got = chooseOutputFilename({
      chartsDir,
      displayName: '',
      chartNumber: '',
      fileExists: existsIn([])
    });
    assert.strictEqual(got, 'enc-chart.mbtiles');
  });

  it('on collision, suffixes with the chartNumber for an informative filename', () => {
    const taken = path.join(chartsDir, 'Waddenzee_met_Diepte_2026_-_Week_18.mbtiles');
    const got = chooseOutputFilename({
      chartsDir,
      displayName: 'Waddenzee met Diepte 2026 - Week 18',
      chartNumber: '1',
      fileExists: existsIn([taken])
    });
    assert.strictEqual(got, 'Waddenzee_met_Diepte_2026_-_Week_18-1.mbtiles');
  });

  it('on chartNumber-suffix collision too, falls through to a counter', () => {
    const taken = [
      path.join(chartsDir, 'Waddenzee_met_Diepte_2026_-_Week_18.mbtiles'),
      path.join(chartsDir, 'Waddenzee_met_Diepte_2026_-_Week_18-1.mbtiles')
    ];
    const got = chooseOutputFilename({
      chartsDir,
      displayName: 'Waddenzee met Diepte 2026 - Week 18',
      chartNumber: '1',
      fileExists: existsIn(taken)
    });
    assert.strictEqual(got, 'Waddenzee_met_Diepte_2026_-_Week_18-2.mbtiles');
  });

  it('counter increments past 2 when -2 is also taken', () => {
    const taken = [
      path.join(chartsDir, 'Foo.mbtiles'),
      path.join(chartsDir, 'Foo-bar.mbtiles'),
      path.join(chartsDir, 'Foo-2.mbtiles'),
      path.join(chartsDir, 'Foo-3.mbtiles')
    ];
    const got = chooseOutputFilename({
      chartsDir,
      displayName: 'Foo',
      chartNumber: 'bar',
      fileExists: existsIn(taken)
    });
    assert.strictEqual(got, 'Foo-4.mbtiles');
  });

  it('sanitizes a hostile chartNumber used as the base (no displayName)', () => {
    // Path-traversal protection: with displayName absent, the base is
    // derived from chartNumber.  A hostile or malformed catalog with
    // chartNumber='../../evil' must NOT yield a filename that escapes
    // chartsDir when path.join'd.
    const got = chooseOutputFilename({
      chartsDir,
      displayName: undefined,
      chartNumber: '../../evil',
      fileExists: existsIn([])
    });
    assert.ok(!got.includes('/'), `filename leaked separator: ${got}`);
    assert.ok(!got.includes('\\'), `filename leaked separator: ${got}`);
    assert.ok(!got.includes('..'), `filename leaked traversal: ${got}`);
    // sanitizeChartFilename strips the leading '----' (slashes + dots all
    // become dashes, then leading-dash trim) leaving 'evil'.
    assert.strictEqual(got, 'evil.mbtiles');
  });

  it('sanitizes a hostile chartNumber suffix (path separators stripped)', () => {
    // CR-flagged regression: a malformed chartNumber containing '/' or '\\'
    // would otherwise embed a directory component into the chosen filename,
    // and the post-conversion existsSync(outputPath) check would fail with
    // "tippecanoe completed but output file not found" — confusing diagnostic
    // for what's actually a chartNumber sanitization issue.
    const taken = [path.join(chartsDir, 'Foo.mbtiles')];
    const got = chooseOutputFilename({
      chartsDir,
      displayName: 'Foo',
      chartNumber: 'evil/../bar',
      fileExists: existsIn(taken)
    });
    assert.ok(!got.includes('/'), `filename leaked separator: ${got}`);
    assert.ok(!got.includes('\\'), `filename leaked separator: ${got}`);
    // sanitizeChartFilename collapses 'evil/../bar' → 'evil----bar': four
    // characters match [/\\.] (slash, dot, dot, slash) and each becomes a
    // dash.  Leading/trailing trim isn't triggered.  The regex below uses
    // `-+` so it accepts any number of dashes — the assertion is "dash-
    // joined and safe", not the exact dash count.
    assert.match(got, /^Foo-evil-+bar\.mbtiles$/);
  });

  it('manual upload (no displayName, chartNumber-only) still avoids overwrite', () => {
    const taken = [path.join(chartsDir, 'manual-upload.mbtiles')];
    const got = chooseOutputFilename({
      chartsDir,
      displayName: undefined,
      chartNumber: 'manual-upload',
      fileExists: existsIn(taken)
    });
    // No displayName → `base` is derived from chartNumber, so `base ===
    // safeChartNumber` and the chartNumber-suffix branch is skipped.
    // Counter therefore falls through to `-2`.
    assert.strictEqual(got, 'manual-upload-2.mbtiles');
  });
});
