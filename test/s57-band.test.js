const { describe, it } = require('node:test');
const assert = require('node:assert');

const { detectEncBand, BAND_MAX_ZOOM, bandClampedMaxzoom } = require('../dist/utils/s57-band');

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
    assert.strictEqual(detectEncBand('123ABC.000'), null); // starts with digits
  });

  it('returns null for out-of-range band digits', () => {
    assert.strictEqual(detectEncBand('US0CO100.000'), null);
    assert.strictEqual(detectEncBand('US7CO100.000'), null);
    assert.strictEqual(detectEncBand('US9CO100.000'), null);
  });

  it('requires uppercase country code (S-57 spec)', () => {
    assert.strictEqual(detectEncBand('us3CO100.000'), null);
    assert.strictEqual(detectEncBand('Us3CO100.000'), null);
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
});

describe('bandClampedMaxzoom', () => {
  it('clamps single-band-3 bundles to z12', () => {
    const r = bandClampedMaxzoom(['US3CO100.000', 'US3CO200.000', 'US3CO300.000'], 16);
    assert.strictEqual(r.effective, 12);
    assert.strictEqual(r.highestBand, 3);
    assert.deepStrictEqual(r.bands, [3, 3, 3]);
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
