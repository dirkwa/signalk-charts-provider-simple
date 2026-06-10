/**
 * Pure-function tests for the NOAA ENC footprint parsing / geometry /
 * inclusion logic. No network — every input is a hand-built GeoJSON-ish
 * object, satisfying the boat-dev "no network during development" rule.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  band4MapEntries,
  bboxFromCoordinates,
  bboxesOverlap,
  computeInclusion,
  coverageByBox,
  parseFootprints,
  projectCoord,
  type EncFootprint
} from '../dist/utils/noaa-enc-footprints.js';

const WEBMERC_R = 6378137;
function forward3857(lon: number, lat: number): [number, number] {
  const x = ((lon * Math.PI) / 180) * WEBMERC_R;
  const y = Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 180 / 2)) * WEBMERC_R;
  return [x, y];
}

describe('projectCoord (EPSG:3857 → 4326)', () => {
  it('round-trips Web Mercator metres back to lon/lat', () => {
    for (const [lon, lat] of [
      [0, 0],
      [-80.2, 25.8],
      [45, 45],
      [-122.4, 37.8]
    ]) {
      const [x, y] = forward3857(lon, lat);
      const [rlon, rlat] = projectCoord(x, y);
      assert.ok(Math.abs(rlon - lon) < 1e-6, `lon ${rlon} ≈ ${lon}`);
      assert.ok(Math.abs(rlat - lat) < 1e-6, `lat ${rlat} ≈ ${lat}`);
    }
  });

  it('passes through values already in lon/lat range', () => {
    assert.deepStrictEqual(projectCoord(-80.2, 25.8), [-80.2, 25.8]);
  });
});

describe('bboxFromCoordinates', () => {
  it('computes a bbox from a Polygon ring (lon/lat passthrough)', () => {
    const poly = [
      [
        [-80, 25],
        [-79, 25],
        [-79, 26],
        [-80, 26],
        [-80, 25]
      ]
    ];
    assert.deepStrictEqual(bboxFromCoordinates(poly), {
      minLon: -80,
      minLat: 25,
      maxLon: -79,
      maxLat: 26
    });
  });

  it('descends into MultiPolygon nesting', () => {
    const multi = [
      [
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 0]
        ]
      ],
      [
        [
          [5, 5],
          [6, 5],
          [6, 6],
          [5, 5]
        ]
      ]
    ];
    assert.deepStrictEqual(bboxFromCoordinates(multi), {
      minLon: 0,
      minLat: 0,
      maxLon: 6,
      maxLat: 6
    });
  });

  it('returns null when there are no coordinates', () => {
    assert.strictEqual(bboxFromCoordinates([]), null);
  });
});

describe('bboxesOverlap', () => {
  const a = { minLon: 0, minLat: 0, maxLon: 10, maxLat: 10 };
  it('detects overlap', () => {
    assert.strictEqual(bboxesOverlap(a, { minLon: 5, minLat: 5, maxLon: 15, maxLat: 15 }), true);
  });
  it('detects containment', () => {
    assert.strictEqual(bboxesOverlap(a, { minLon: 2, minLat: 2, maxLon: 3, maxLat: 3 }), true);
  });
  it('counts edge-touching as overlap', () => {
    assert.strictEqual(bboxesOverlap(a, { minLon: 10, minLat: 0, maxLon: 20, maxLat: 10 }), true);
  });
  it('returns false for disjoint boxes', () => {
    assert.strictEqual(bboxesOverlap(a, { minLon: 11, minLat: 11, maxLon: 20, maxLat: 20 }), false);
  });
});

function feature(
  encEdUp: string,
  scaleBand: number,
  ring: number[][],
  extra: Record<string, unknown> = {}
): unknown {
  return {
    type: 'Feature',
    properties: { enc_ed_up: encEdUp, scale_band: scaleBand, title: `${encEdUp} title`, ...extra },
    geometry: { type: 'Polygon', coordinates: [ring] }
  };
}

const SQUARE = (x: number, y: number, s = 1): number[][] => [
  [x, y],
  [x + s, y],
  [x + s, y + s],
  [x, y + s],
  [x, y]
];

describe('parseFootprints', () => {
  const geojson = {
    type: 'FeatureCollection',
    features: [
      feature('US4FL1EP_ED003_UP012', 4, SQUARE(-80, 25), { scale: 80000 }),
      feature('US3FL01M_ED005_UP001', 3, SQUARE(-81, 24, 4)),
      feature('US5FL2AB_ED001_UP000', 5, SQUARE(-79.5, 25.5, 0.2)),
      feature('US6XXXXX_ED001_UP000', 6, SQUARE(-79.5, 25.5)), // band 6 dropped
      feature('US2YYYYY_ED001_UP000', 2, SQUARE(0, 0)), // band 2 dropped
      { type: 'Feature', properties: { scale_band: 4 }, geometry: null }, // no enc_ed_up
      feature('SHORT', 4, SQUARE(0, 0)) // enc_ed_up too short
    ]
  };

  it('keeps only band 3/4/5 features with usable geometry + id', () => {
    const fps = parseFootprints(geojson);
    assert.strictEqual(fps.length, 3);
    const ids = fps.map((f) => f.chartId).sort();
    assert.deepStrictEqual(ids, ['US3FL01M', 'US4FL1EP', 'US5FL2AB']);
  });

  it('extracts chartId as the first 8 chars and keeps the full encEdUp', () => {
    const fp = parseFootprints(geojson).find((f) => f.chartId === 'US4FL1EP') as EncFootprint;
    assert.strictEqual(fp.encEdUp, 'US4FL1EP_ED003_UP012');
    assert.strictEqual(fp.scaleBand, 4);
    assert.strictEqual(fp.scale, 80000);
  });
});

describe('band4MapEntries', () => {
  it('returns only band-4 entries, sorted by chart id', () => {
    const fps = parseFootprints({
      type: 'FeatureCollection',
      features: [
        feature('US4ZZ0000_ED1_UP0', 4, SQUARE(0, 0)),
        feature('US4AA0000_ED1_UP0', 4, SQUARE(1, 1)),
        feature('US3BB0000_ED1_UP0', 3, SQUARE(2, 2))
      ]
    });
    const entries = band4MapEntries(fps);
    assert.deepStrictEqual(
      entries.map((e) => e.chartId),
      ['US4AA000', 'US4ZZ000']
    );
  });
});

describe('computeInclusion', () => {
  // Two band-4 areas. b3-near overlaps area A; b5-in sits inside area A; b3-far
  // and b5-far are disjoint from both selected areas.
  const all = parseFootprints({
    type: 'FeatureCollection',
    features: [
      feature('US4AREAA_ED1_UP1', 4, SQUARE(0, 0, 2)), // selected A
      feature('US4AREAB_ED1_UP1', 4, SQUARE(50, 50, 2)), // unselected B
      feature('US3NEAR0_ED1_UP1', 3, SQUARE(1, 1, 5)), // overlaps A
      feature('US5INSI0_ED1_UP1', 5, SQUARE(0.5, 0.5, 0.2)), // inside A
      feature('US3FAR00_ED1_UP1', 3, SQUARE(70, 70, 2)), // disjoint
      feature('US5FAR00_ED1_UP1', 5, SQUARE(75, 75, 1)) // disjoint
    ]
  });

  it('includes overlapping band 3/4/5 cells and dedupes', () => {
    const result = computeInclusion(all, ['US4AREAA']);
    assert.deepStrictEqual(result.includedChartIds, ['US3NEAR0', 'US4AREAA', 'US5INSI0']);
    assert.strictEqual(result.missingSelected.length, 0);
  });

  it('snapshots the current edition for every included chart', () => {
    const result = computeInclusion(all, ['US4AREAA']);
    assert.strictEqual(result.chartVersions['US4AREAA'], 'US4AREAA_ED1_UP1');
    assert.strictEqual(result.chartVersions['US3NEAR0'], 'US3NEAR0_ED1_UP1');
  });

  it('reports selected ids that no longer exist', () => {
    const result = computeInclusion(all, ['US4AREAA', 'US4GONE0']);
    assert.deepStrictEqual(result.missingSelected, ['US4GONE0']);
  });

  it('excludes disjoint cells', () => {
    const result = computeInclusion(all, ['US4AREAA']);
    assert.ok(!result.includedChartIds.includes('US3FAR00'));
    assert.ok(!result.includedChartIds.includes('US5FAR00'));
  });
});

describe('coverageByBox', () => {
  // A big band-4 box with two band-5 cells nested inside it, a band-5 cell
  // far away, and a band-3 cell overlapping the box.
  const all = parseFootprints({
    type: 'FeatureCollection',
    features: [
      feature('US4AREAA_ED1_UP1', 4, SQUARE(0, 0, 10)),
      feature('US5INA00_ED1_UP1', 5, SQUARE(1, 1, 1)), // inside box
      feature('US5INB00_ED1_UP1', 5, SQUARE(8, 8, 1)), // inside box
      feature('US5OUT00_ED1_UP1', 5, SQUARE(50, 50, 1)), // far away
      feature('US3BIG00_ED1_UP1', 3, SQUARE(-5, -5, 30)) // overlaps box, band 3
    ]
  });

  it('counts the band-4 chart plus nested band-5 cells, excluding band 3', () => {
    const cov = coverageByBox(all, ['US4AREAA']);
    assert.deepStrictEqual(cov['US4AREAA'], ['US4AREAA', 'US5INA00', 'US5INB00']);
  });

  it('excludes band-5 cells outside the box', () => {
    const cov = coverageByBox(all, ['US4AREAA']);
    assert.ok(!cov['US4AREAA'].includes('US5OUT00'));
  });

  it('maps an unknown selected id to an empty list', () => {
    const cov = coverageByBox(all, ['US4GONE0']);
    assert.deepStrictEqual(cov['US4GONE0'], []);
  });
});
