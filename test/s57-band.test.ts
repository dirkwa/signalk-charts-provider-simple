import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  detectEncBand,
  BAND_MAX_ZOOM,
  BAND_MIN_ZOOM,
  bandClampedMaxzoom,
  groupCellsByBand,
  highestBandForFiles
} from '../dist/utils/s57-band.js';

describe('detectEncBand (IHO Annex E filename convention)', () => {
  it('parses NOAA filenames', () => {
    assert.strictEqual(detectEncBand('US3CO100.000'), 3);
    assert.strictEqual(detectEncBand('US5MA1SK.000'), 5);
    assert.strictEqual(detectEncBand('US1AK90M.000'), 1);
    assert.strictEqual(detectEncBand('US6NY12C.000'), 6);
  });

  it('parses non-NOAA national hydrographic offices following the same convention', () => {
    assert.strictEqual(detectEncBand('GB401234.000'), 4);
    assert.strictEqual(detectEncBand('DE521A04.000'), 5);
    assert.strictEqual(detectEncBand('CA2HF7QC.000'), 2);
    assert.strictEqual(detectEncBand('AU3WAFRE.000'), 3);
  });

  it('strips extensions correctly', () => {
    assert.strictEqual(detectEncBand('US3CO100'), 3); // no extension
    assert.strictEqual(detectEncBand('US3CO100.000'), 3); // .000
    assert.strictEqual(detectEncBand('US3CO100.geojson'), 3); // some other ext
  });

  it('returns null for non-conforming filenames', () => {
    assert.strictEqual(detectEncBand(''), null);
    assert.strictEqual(detectEncBand('chart.000'), null);
    assert.strictEqual(detectEncBand('weird-name.000'), null);
    assert.strictEqual(detectEncBand('ENC_AREA1.000'), null);
    assert.strictEqual(detectEncBand('123ABC.000'), null); // pure-digit producer code
    assert.strictEqual(detectEncBand('001.000'), null); // pure-digit producer code (extractChartId artifact)
  });

  it('parses IENC inland bands 7..9', () => {
    // IEHG inland-extension bands. RWS Dutch IENC producer code is `1V`,
    // which leads with a digit — explicitly supported.
    assert.strictEqual(detectEncBand('1V7VAR01.000'), 7);
    assert.strictEqual(detectEncBand('DE7AKxxx.000'), 7);
    assert.strictEqual(detectEncBand('1V8HARB01.000'), 8);
    assert.strictEqual(detectEncBand('1V9BERTH1.000'), 9);
  });

  it('returns null for out-of-range band digits', () => {
    assert.strictEqual(detectEncBand('US0CO100.000'), null);
    // Note: bands 7..9 are valid IENC bands now (see test above).
  });

  it('requires uppercase or numeric producer code (S-57 / IENC)', () => {
    // S-57 + IENC both spec uppercase letters; IENC additionally allows
    // a leading digit (RWS `1V`). Lowercase or mixed case is invalid.
    assert.strictEqual(detectEncBand('us3CO100.000'), null);
    assert.strictEqual(detectEncBand('Us3CO100.000'), null);
    assert.strictEqual(detectEncBand('1v7VAR01.000'), null);
  });
});

describe('BAND_MAX_ZOOM', () => {
  it('matches the IHO documented native chart scales', () => {
    assert.strictEqual(BAND_MAX_ZOOM[1], 8);
    assert.strictEqual(BAND_MAX_ZOOM[2], 10);
    assert.strictEqual(BAND_MAX_ZOOM[3], 12);
    assert.strictEqual(BAND_MAX_ZOOM[4], 14);
    assert.strictEqual(BAND_MAX_ZOOM[5], 16);
    assert.strictEqual(BAND_MAX_ZOOM[6], 18);
  });

  it('covers IENC inland bands 7..9 with IEHG-tuned ceilings', () => {
    assert.strictEqual(BAND_MAX_ZOOM[7], 14); // River
    assert.strictEqual(BAND_MAX_ZOOM[8], 16); // River Harbour
    assert.strictEqual(BAND_MAX_ZOOM[9], 18); // River Berth
  });
});

describe('BAND_MIN_ZOOM', () => {
  it('uses ceiling-minus-4 for every maritime band', () => {
    assert.strictEqual(BAND_MIN_ZOOM[1], 4);
    assert.strictEqual(BAND_MIN_ZOOM[2], 6);
    assert.strictEqual(BAND_MIN_ZOOM[3], 8);
    assert.strictEqual(BAND_MIN_ZOOM[4], 10);
    assert.strictEqual(BAND_MIN_ZOOM[5], 12);
    assert.strictEqual(BAND_MIN_ZOOM[6], 14);
  });

  it('uses a lower floor on band 7 than the IEHG plan suggests so Waddenzee renders at coastal-overview zooms', () => {
    // RWS publishes the Waddenzee — tidal coastal water — as IENC band 7.
    // A z11 floor (ceiling-minus-3 per IEHG) would blank out the chart at
    // z9–z10 where users plan coastal navigation; z9 keeps it visible at
    // a modest overplotting cost on actual rivers.
    assert.strictEqual(BAND_MIN_ZOOM[7], 9);
    assert.strictEqual(BAND_MIN_ZOOM[8], 13);
    assert.strictEqual(BAND_MIN_ZOOM[9], 15);
  });

  it('every band has min < max so tippecanoe gets a non-empty zoom range', () => {
    for (const band of [1, 2, 3, 4, 5, 6, 7, 8, 9] as const) {
      assert.ok(BAND_MIN_ZOOM[band] < BAND_MAX_ZOOM[band], `band ${band}`);
    }
  });
});

describe('highestBandForFiles', () => {
  it('returns the highest band among conforming filenames', () => {
    assert.strictEqual(
      highestBandForFiles(['HRBFAC_US5MA1SK.geojson', 'LNDARE_US3CO100.geojson']),
      5
    );
  });

  it('ignores non-conforming filenames (IENC, hand-named) when others conform', () => {
    assert.strictEqual(highestBandForFiles(['HRBFAC_US5MA1SK.geojson', 'WEIRD_NAME.geojson']), 5);
  });

  it('returns null when nothing conforms', () => {
    assert.strictEqual(highestBandForFiles(['weird.geojson', 'IENC_PASS_001.geojson']), null);
  });

  it('returns null for empty input', () => {
    assert.strictEqual(highestBandForFiles([]), null);
  });

  it('takes the basename so directory-prefixed paths still work', () => {
    assert.strictEqual(highestBandForFiles(['/tmp/enc/HRBFAC_US5MA1SK.geojson']), 5);
  });
});

describe('bandClampedMaxzoom', () => {
  it('clamps single-band-3 bundles to z12 and returns deduped bands', () => {
    const r = bandClampedMaxzoom(['US3CO100.000', 'US3CO200.000', 'US3CO300.000'], 16);
    assert.strictEqual(r.effective, 12);
    assert.strictEqual(r.highestBand, 3);
    // Bands are deduped + sorted for diagnostic stability.
    assert.deepStrictEqual(r.bands, [3]);
  });

  it('returns deduped + sorted bands for log/diagnostic stability', () => {
    // Input order: 5, 3, 3, 5, 4 → output should be [3, 4, 5].
    const r = bandClampedMaxzoom(
      ['US5MA1SK.000', 'US3CO100.000', 'US3CO200.000', 'US5NY1SK.000', 'US4PR1AB.000'],
      16
    );
    assert.deepStrictEqual(r.bands, [3, 4, 5]);
    assert.strictEqual(r.highestBand, 5);
  });

  it('takes the highest band when bundle is mixed', () => {
    const r = bandClampedMaxzoom(['US3CO100.000', 'US5MA1SK.000', 'US3CO200.000'], 16);
    assert.strictEqual(r.effective, 16);
    assert.strictEqual(r.highestBand, 5);
  });

  it('falls back to user-requested maxzoom when no file conforms (IENC)', () => {
    const r = bandClampedMaxzoom(['weird.000', 'IENC_PASS_001.000'], 16);
    assert.strictEqual(r.effective, 16);
    assert.strictEqual(r.highestBand, null);
    assert.deepStrictEqual(r.bands, []);
  });

  it('does not raise the user maxzoom past what they asked for', () => {
    // Band 5 ceiling is z16, but user only asked for z14 — keep z14.
    const r = bandClampedMaxzoom(['US5MA1SK.000'], 14);
    assert.strictEqual(r.effective, 14);
    assert.strictEqual(r.highestBand, 5);
  });

  it('handles paths with directory components by taking the basename', () => {
    const r = bandClampedMaxzoom(
      ['/tmp/enc/US3CO100/US3CO100.000', '/tmp/enc/US3CO200/US3CO200.000'],
      16
    );
    assert.strictEqual(r.effective, 12);
    assert.strictEqual(r.highestBand, 3);
  });

  it('handles Windows-style paths via path.basename', () => {
    // Windows path.basename only strips '\' on win32, but the test confirms
    // forward-slash paths (which path.basename handles cross-platform) work.
    const r = bandClampedMaxzoom(['C:/Users/u/enc/US3CO100/US3CO100.000'], 16);
    assert.strictEqual(r.effective, 12);
    assert.strictEqual(r.highestBand, 3);
  });

  it('mixed conforming + non-conforming uses only the conforming bands', () => {
    // Two NOAA charts + one IENC. Only the NOAA bands count.
    const r = bandClampedMaxzoom(['US3CO100.000', 'US5MA1SK.000', 'IENC_AREA.000'], 16);
    assert.strictEqual(r.effective, 16); // band 5 wins
    assert.strictEqual(r.highestBand, 5);
    assert.deepStrictEqual(r.bands, [3, 5]); // IENC dropped
  });

  it('empty file list falls back', () => {
    const r = bandClampedMaxzoom([], 16);
    assert.strictEqual(r.effective, 16);
    assert.strictEqual(r.highestBand, null);
  });
});

describe('groupCellsByBand', () => {
  it('partitions cells into per-band buckets and returns sorted band list', () => {
    const g = groupCellsByBand([
      '/tmp/enc/US3CO100.000',
      '/tmp/enc/US5MA1SK.000',
      '/tmp/enc/US3CO200.000',
      '/tmp/enc/US5NY1SK.000'
    ]);
    assert.deepStrictEqual(g.bands, [3, 5]);
    assert.deepStrictEqual(g.byBand.get(3), ['/tmp/enc/US3CO100.000', '/tmp/enc/US3CO200.000']);
    assert.deepStrictEqual(g.byBand.get(5), ['/tmp/enc/US5MA1SK.000', '/tmp/enc/US5NY1SK.000']);
    assert.deepStrictEqual(g.unbanded, []);
  });

  it('puts non-conforming filenames in the unbanded bucket', () => {
    const g = groupCellsByBand([
      '/tmp/enc/US3CO100.000',
      '/tmp/enc/IENC_PASS_001.000', // hand-named test cell, no convention
      '/tmp/enc/weird-name.000'
    ]);
    assert.deepStrictEqual(g.bands, [3]);
    assert.deepStrictEqual(g.byBand.get(3), ['/tmp/enc/US3CO100.000']);
    assert.deepStrictEqual(g.unbanded, ['/tmp/enc/IENC_PASS_001.000', '/tmp/enc/weird-name.000']);
  });

  it('routes IENC cells into bands 7..9 (no longer unbanded)', () => {
    // RWS Dutch IENC and German WSV inland follow the IHO Annex E
    // convention with bands 7..9 — they belong in their own per-band
    // buckets, not the legacy unbanded fallback.
    const g = groupCellsByBand([
      '/tmp/enc/1V7VAR01.000',
      '/tmp/enc/1V7WAD05.000',
      '/tmp/enc/DE7AKxxx.000',
      '/tmp/enc/1V8HARB01.000'
    ]);
    assert.deepStrictEqual(g.bands, [7, 8]);
    assert.deepStrictEqual(g.byBand.get(7), [
      '/tmp/enc/1V7VAR01.000',
      '/tmp/enc/1V7WAD05.000',
      '/tmp/enc/DE7AKxxx.000'
    ]);
    assert.deepStrictEqual(g.byBand.get(8), ['/tmp/enc/1V8HARB01.000']);
    assert.deepStrictEqual(g.unbanded, []);
  });

  it('returns empty bands and one unbanded bucket for a fully non-conforming bundle', () => {
    const g = groupCellsByBand(['/tmp/enc/IENC_PASS_001.000', '/tmp/enc/weird.000']);
    assert.deepStrictEqual(g.bands, []);
    assert.strictEqual(g.byBand.size, 0);
    assert.deepStrictEqual(g.unbanded, ['/tmp/enc/IENC_PASS_001.000', '/tmp/enc/weird.000']);
  });

  it('handles an empty input', () => {
    const g = groupCellsByBand([]);
    assert.deepStrictEqual(g.bands, []);
    assert.strictEqual(g.byBand.size, 0);
    assert.deepStrictEqual(g.unbanded, []);
  });

  it('preserves the original cell-path order within each bucket', () => {
    const g = groupCellsByBand([
      '/tmp/enc/US5MA1SK.000',
      '/tmp/enc/US5NY1SK.000',
      '/tmp/enc/US5CA1SK.000'
    ]);
    assert.deepStrictEqual(g.byBand.get(5), [
      '/tmp/enc/US5MA1SK.000',
      '/tmp/enc/US5NY1SK.000',
      '/tmp/enc/US5CA1SK.000'
    ]);
  });
});
