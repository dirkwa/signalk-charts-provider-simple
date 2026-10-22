import { describe, it } from 'node:test';
import assert from 'node:assert';
import { Value } from 'typebox/value';

import {
  OUTLINE_TOLERANCE,
  gridOutline,
  outlineFromCoverage,
  reduceRing,
  roundCoord,
  simplifyLine,
  type Position
} from '../dist/catalog/enc-outline.js';
import {
  ARCHIVE_REVISION,
  CELL_MARKER,
  FEATURES_MARKER,
  PREFERRED_SOURCE,
  archiveJobs,
  cellVersion,
  assembleEncIndex,
  decideEncIndexPublish,
  encIndexBlockers,
  encSources,
  jobKey,
  jobsToBuild,
  noaaUnits,
  parseGdalReport,
  readPublishedEncIndex,
  unitsForArchive,
  type ArchiveJob,
  type ArchiveResult,
  type CellReport,
  type EncIndexInputs,
  type NoaaResult
} from '../dist/catalog/build-enc-index.js';
import { EncIndexSchema, type EncIndex } from '../dist/catalog/enc-index-schema.js';
import type { ChartcatalogsIndex } from '../dist/catalog/merged-catalog-schema.js';
import {
  computeInclusion,
  coverageByBox,
  parseFootprints
} from '../dist/utils/noaa-enc-footprints.js';

const NOW = new Date('2026-10-21T00:00:00Z');

function square(west: number, south: number, size: number): Position[] {
  return [
    [west, south],
    [west + size, south],
    [west + size, south + size],
    [west, south + size],
    [west, south]
  ];
}

function cellReport(
  path: string,
  coverage: Position[][][],
  extra: Partial<CellReport> = {}
): CellReport {
  return { path, scale: null, edition: null, update: null, coverage, ...extra };
}

describe('enc outlines', () => {
  it('keeps both ends and drops points within the tolerance', () => {
    const line: Position[] = [
      [0, 0],
      [1, OUTLINE_TOLERANCE / 2],
      [2, 0],
      [3, 1],
      [4, 0]
    ];
    assert.deepStrictEqual(simplifyLine(line, OUTLINE_TOLERANCE), [
      [0, 0],
      [2, 0],
      [3, 1],
      [4, 0]
    ]);
  });

  it('rounds to five decimals without producing -0', () => {
    assert.strictEqual(roundCoord(12.3456789), 12.34568);
    assert.ok(Object.is(roundCoord(-0.000001), 0));
  });

  it('closes an open ring and rounds it', () => {
    const ring = reduceRing([
      [10.000001, 50.000001],
      [10.5, 50],
      [10.5, 50.5],
      [10, 50.5]
    ]);
    assert.deepStrictEqual(ring, [
      [10, 50],
      [10.5, 50],
      [10.5, 50.5],
      [10, 50.5],
      [10, 50]
    ]);
  });

  it('turns a ring smaller than the tolerance into its bounding box', () => {
    const ring = reduceRing([
      [5, 5],
      [5.00004, 5.00001],
      [5.00002, 5.00004],
      [5, 5]
    ]);
    assert.deepStrictEqual(ring, [
      [5, 5],
      [5.00004, 5],
      [5.00004, 5.00004],
      [5, 5.00004],
      [5, 5]
    ]);
  });

  it('drops a ring that is a point', () => {
    assert.strictEqual(
      reduceRing([
        [1, 1],
        [1, 1],
        [1, 1],
        [1, 1]
      ]),
      null
    );
  });

  it('keeps exterior rings only and lists a repeated polygon once', () => {
    const outer = square(0, 0, 1);
    const hole = square(0.25, 0.25, 0.5);
    const result = outlineFromCoverage([[outer, hole], [outer]]);
    assert.deepStrictEqual(result, {
      outline: { type: 'Polygon', coordinates: [outer] },
      bbox: [0, 0, 1, 1]
    });
  });

  it('makes a MultiPolygon from separate coverage areas', () => {
    const result = outlineFromCoverage([[square(0, 0, 1)], [square(2, 2, 1)]]);
    assert.strictEqual(result?.outline.type, 'MultiPolygon');
    assert.deepStrictEqual(result.bbox, [0, 0, 3, 3]);
  });

  it('returns null when there is no coverage', () => {
    assert.strictEqual(outlineFromCoverage([]), null);
  });

  it('outlines scattered features by the grid squares they fall in, merged along rows', () => {
    const result = gridOutline([
      [-90.05, 30.05],
      [-90.15, 30.02],
      [-90.15, 30.08],
      [-87.55, 41.85]
    ]);
    assert.deepStrictEqual(result, {
      outline: {
        type: 'MultiPolygon',
        coordinates: [[bboxRingOf(-90.2, 30, -90, 30.1)], [bboxRingOf(-87.6, 41.8, -87.5, 41.9)]]
      },
      bbox: [-90.2, 30, -87.5, 41.9]
    });
  });

  it('merges a column of grid squares into one rectangle', () => {
    assert.deepStrictEqual(
      gridOutline([
        [-90.05, 30.05],
        [-90.05, 30.15],
        [-90.05, 30.25]
      ])?.outline,
      { type: 'Polygon', coordinates: [bboxRingOf(-90.1, 30, -90, 30.3)] }
    );
  });

  it('returns no grid outline without positions', () => {
    assert.strictEqual(gridOutline([]), null);
  });
});

function bboxRingOf(west: number, south: number, east: number, north: number): Position[] {
  return [
    [west, south],
    [east, south],
    [east, north],
    [west, north],
    [west, south]
  ];
}

describe('parseGdalReport', () => {
  it('counts an M_COVR object without CATCOV as coverage', () => {
    const [report] = parseGdalReport(
      [
        `${CELL_MARKER}2P7D1124.000`,
        JSON.stringify({
          type: 'Feature',
          properties: {},
          geometry: { type: 'Polygon', coordinates: [square(20, 44, 1)] }
        })
      ].join('\n')
    );
    assert.deepStrictEqual(report.coverage, [[square(20, 44, 1)]]);
  });

  it('collects scale and CATCOV=1 coverage per cell, ignoring everything else', () => {
    const report = [
      'Warning 1: No SRS set on layer.',
      `${CELL_MARKER}ENC_ROOT/AA1/AA1.000`,
      JSON.stringify({ type: 'Feature', properties: { DSPM_CSCL: 4000 }, geometry: null }),
      JSON.stringify({
        type: 'Feature',
        properties: { CATCOV: 1 },
        geometry: { type: 'Polygon', coordinates: [square(0, 0, 1)] }
      }),
      JSON.stringify({
        type: 'Feature',
        properties: { CATCOV: 2 },
        geometry: { type: 'Polygon', coordinates: [square(5, 5, 1)] }
      }),
      '{not json',
      `${CELL_MARKER}BB2.000`,
      JSON.stringify({
        type: 'Feature',
        properties: { CATCOV: 1 },
        geometry: { type: 'MultiPolygon', coordinates: [[square(0, 0, 1)], [square(2, 0, 1)]] }
      }),
      ''
    ].join('\n');
    assert.deepStrictEqual(parseGdalReport(report), [
      cellReport('ENC_ROOT/AA1/AA1.000', [[square(0, 0, 1)]], { scale: 4000 }),
      cellReport('BB2.000', [[square(0, 0, 1)], [square(2, 0, 1)]])
    ]);
  });

  it('reads the edition and update GDAL gives as text', () => {
    const [report] = parseGdalReport(
      [
        `${CELL_MARKER}1R7WAD01.000`,
        JSON.stringify({
          type: 'Feature',
          properties: { DSPM_CSCL: 8000, DSID_EDTN: '5', DSID_UPDN: '2' },
          geometry: null
        })
      ].join('\n')
    );
    assert.deepStrictEqual([report.edition, report.update], [5, 2]);
  });

  it('keeps only the distinct positions of a dumped cell, rounded to 0.001 degree', () => {
    const [report] = parseGdalReport(
      [
        `${CELL_MARKER}3UABUOYS.000`,
        FEATURES_MARKER,
        JSON.stringify({
          type: 'Feature',
          properties: { OBJNAM: 'Buoy 1' },
          geometry: { type: 'Point', coordinates: [-90.12341, 30.00049] }
        }),
        JSON.stringify({
          type: 'Feature',
          properties: {},
          geometry: {
            type: 'LineString',
            coordinates: [
              [-90.1234, 30.0001],
              [-90.2, 30.1]
            ]
          }
        }),
        `${CELL_MARKER}NEXT.000`
      ].join('\n')
    );
    assert.deepStrictEqual(report.points, [
      [-90.123, 30],
      [-90.2, 30.1]
    ]);
    assert.deepStrictEqual(report.coverage, []);
  });

  it('reads a covered cell normally after a cell whose features were dumped', () => {
    const reports = parseGdalReport(
      [
        `${CELL_MARKER}A.000`,
        FEATURES_MARKER,
        JSON.stringify({
          type: 'Feature',
          properties: {},
          geometry: { type: 'Point', coordinates: [1, 2] }
        }),
        `${CELL_MARKER}B.000`,
        JSON.stringify({
          type: 'Feature',
          properties: { DSPM_CSCL: 4000, DSID_EDTN: '3', DSID_UPDN: '0' },
          geometry: null
        }),
        JSON.stringify({
          type: 'Feature',
          properties: { CATCOV: 1 },
          geometry: { type: 'Polygon', coordinates: [square(0, 0, 1)] }
        })
      ].join('\n')
    );
    assert.deepStrictEqual(reports[1], {
      path: 'B.000',
      scale: 4000,
      edition: 3,
      update: 0,
      coverage: [[square(0, 0, 1)]]
    });
  });
});

const JOB: ArchiveJob = {
  source: 'XX_IENC_Catalog',
  url: 'https://example.com/river.zip',
  version: '2026-01-01T00:00:00Z',
  title: 'River (Base1)'
};

describe('unitsForArchive', () => {
  it('makes one unit per cell, naming cells of a shared archive', () => {
    const result = unitsForArchive(JOB, 'zip', [
      cellReport('R/1X7RIV02.000', [[square(1, 0, 1)]], { scale: 5000 }),
      cellReport('R/1X7RIV01.000', [[square(0, 0, 1)]]),
      cellReport('R/1X7RIV03.000', [], { scale: 5000 })
    ]);
    assert.deepStrictEqual(result.archive, {
      url: JOB.url,
      source: JOB.source,
      version: JOB.version,
      kind: 'zip',
      revision: ARCHIVE_REVISION
    });
    assert.deepStrictEqual(
      result.units.map((u) => [u.id, u.title, u.scale, u.cells, u.statusCells]),
      [
        [
          '1X7RIV01',
          '1X7RIV01 - River (Base1)',
          undefined,
          [{ name: '1X7RIV01', archive: JOB.url, path: 'R/1X7RIV01.000' }],
          ['1X7RIV01']
        ],
        [
          '1X7RIV02',
          '1X7RIV02 - River (Base1)',
          5000,
          [{ name: '1X7RIV02', archive: JOB.url, path: 'R/1X7RIV02.000' }],
          ['1X7RIV02']
        ]
      ]
    );
    assert.deepStrictEqual(result.problems, ['R/1X7RIV03.000: no usable M_COVR coverage']);
  });

  it('outlines a cell without M_COVR from where its features are', () => {
    const result = unitsForArchive(JOB, 'zip', [
      cellReport('3UABUOYS.000', [], {
        points: [
          [-90.05, 30.05],
          [-87.55, 41.85]
        ]
      })
    ]);
    assert.strictEqual(result.units[0].outline.type, 'MultiPolygon');
    assert.deepStrictEqual(result.units[0].bbox, [-90.1, 30, -87.5, 41.9]);
    assert.deepStrictEqual(result.problems, [
      '3UABUOYS.000: no M_COVR coverage; outlined from where its features are'
    ]);
  });

  it('versions each cell from its edition, its update and the update files beside it', () => {
    const report = cellReport('ENC_ROOT/1R7WAD01/1R7WAD01.000', [], { edition: 5, update: 0 });
    const files = [
      'ENC_ROOT/1R7WAD01/1R7WAD01.001',
      'ENC_ROOT/1R7WAD01/1R7WAD01.002',
      'ENC_ROOT/1R7WAD01/1R7WAD01.004',
      'OTHER/1R7WAD01.003',
      'ENC_ROOT/1R7WAD01/1R7WAD02.003'
    ];
    assert.strictEqual(cellVersion(report, '1R7WAD01', files), '1R7WAD01_ED005_UP002');
    assert.strictEqual(
      cellVersion({ ...report, update: 11 }, '1R7WAD01', []),
      '1R7WAD01_ED005_UP011'
    );
    assert.strictEqual(cellVersion({ ...report, edition: null }, '1R7WAD01', files), undefined);
  });

  it('keeps a cell whose coverage strays past the antimeridian, and drops a zero scale', () => {
    const result = unitsForArchive(JOB, 'zip', [
      cellReport(
        'X.000',
        [
          [
            [
              [179.5, 50],
              [180.2, 50],
              [180.2, 51],
              [179.5, 51],
              [179.5, 50]
            ]
          ]
        ],
        { scale: 0 }
      )
    ]);
    assert.deepStrictEqual(result.problems, []);
    assert.deepStrictEqual(result.units[0].bbox, [179.5, 50, 180, 51]);
    assert.strictEqual(result.units[0].scale, undefined);
  });

  it('records only the update files whose base cell is in another archive', () => {
    const result = unitsForArchive(
      JOB,
      'zip',
      [cellReport('ENC_ROOT/EA200004.000', [[square(0, 0, 1)]])],
      [
        'ENC_ROOT/CATALOG.031',
        'ENC_ROOT/EA200004.001',
        'ENC_ROOT/EA200003.036',
        'ENC_ROOT/EA200001.041'
      ]
    );
    assert.deepStrictEqual(result.archive.updates, [
      'ENC_ROOT/EA200001.041',
      'ENC_ROOT/EA200003.036'
    ]);
    assert.strictEqual(result.updatesOnly, false);
  });

  it('uses the entry title as-is for a single cell, and keeps the first of a repeated cell', () => {
    const result = unitsForArchive({ ...JOB, title: '1X7RIV01 - River' }, 'zip', [
      cellReport('a/1X7RIV01.000', [[square(0, 0, 1)]]),
      cellReport('b/1X7RIV01.000', [[square(0, 0, 1)]])
    ]);
    assert.deepStrictEqual(
      result.units.map((u) => [u.title, u.cells[0].path]),
      [['1X7RIV01 - River', 'a/1X7RIV01.000']]
    );
    assert.strictEqual(result.problems.length, 1);
  });
});

describe('sources and jobs', () => {
  const index: ChartcatalogsIndex = {
    'XX_IENC_Catalog.xml': {
      label: 'XX Inland ENC',
      category: 'navigation',
      format: 'enc',
      regions: ['europe'],
      bbox: [0, 40, 10, 50]
    },
    'XX_RNC_Catalog.xml': {
      label: 'XX Raster',
      category: 'navigation',
      format: 'rnc',
      regions: ['europe'],
      bbox: [0, 40, 10, 50]
    }
  };

  it('covers NOAA and every chartcatalogs file whose format is enc', () => {
    assert.deepStrictEqual(encSources(index), [
      {
        id: 'XX_IENC_Catalog',
        label: 'XX Inland ENC',
        kind: 'chartcatalogs',
        file: 'XX_IENC_Catalog.xml'
      },
      { id: 'noaa', label: 'NOAA ENC (United States)', kind: 'noaa' }
    ]);
  });

  it('lists each archive once, at its newest version, skipping non-http locations', () => {
    const chart = (url: string, date: string) => ({
      number: '1',
      title: 'T',
      format: '',
      zipfile_location: url,
      zipfile_datetime_iso8601: date
    });
    const jobs = archiveJobs(encSources(index), [
      {
        file: 'XX_IENC_Catalog.xml',
        parsed: {
          header: { title: '', dateCreated: '', dateValid: '' },
          charts: [
            chart('https://e.com/b.zip', '2026-01-01'),
            chart('https://e.com/a.zip', '2026-01-01'),
            chart('https://e.com/a.zip', '2026-02-01'),
            chart('ftp://e.com/c.zip', '2026-01-01')
          ]
        }
      }
    ]);
    assert.deepStrictEqual(
      jobs.map((j) => [j.url, j.version]),
      [
        ['https://e.com/a.zip', '2026-02-01'],
        ['https://e.com/b.zip', '2026-01-01']
      ]
    );
  });
});

/**
 * A small NOAA footprint file. Coordinates are already lon/lat, which
 * `projectCoord` passes through, so the boxes are easy to read:
 * two band-4 boxes side by side under one band-3 cell, band-5 harbours
 * inside each, a band-5 cell straddling both, and cells far away.
 */
function feature(encEdUp: string, band: number, west: number, south: number, size: number) {
  return {
    type: 'Feature',
    properties: { enc_ed_up: encEdUp, scale_band: band, scale: 10 ** band, title: encEdUp },
    geometry: { type: 'Polygon', coordinates: [square(west, south, size)] }
  };
}

const NOAA_GEOJSON = {
  type: 'FeatureCollection',
  features: [
    feature('US3AA1AA_ED004_UP002', 3, -82, 24, 2),
    feature('US4AA1AA_ED003_UP012', 4, -81.9, 24.1, 0.5),
    feature('US4AA1AB_ED001_UP000', 4, -81.3, 24.1, 0.5),
    feature('US5AA1AA_ED002_UP001', 5, -81.8, 24.2, 0.1),
    feature('US5AA1AB_ED001_UP003', 5, -81.2, 24.2, 0.1),
    feature('US5AA1AC_ED001_UP000', 5, -81.42, 24.3, 0.15),
    feature('US4ZZ1ZZ_ED001_UP000', 4, -70, 40, 0.5),
    feature('US5ZZ1ZZ_ED001_UP000', 5, -69.9, 40.1, 0.1),
    feature('US2AA1AA_ED001_UP000', 2, -85, 20, 10),
    feature('US6AA1AA_ED001_UP000', 6, -81.8, 24.2, 0.01)
  ]
};

describe('noaaUnits', () => {
  const all = parseFootprints(NOAA_GEOJSON);
  const { units, archives } = noaaUnits(all);
  const byId = new Map(units.map((u) => [u.id, u]));
  const version = new Map(archives.map((a) => [a.url, a.version]));

  it('has one unit per band-4 box, with the bare chart id as its id', () => {
    assert.deepStrictEqual(
      units.map((u) => u.id),
      ['US4AA1AA', 'US4AA1AB', 'US4ZZ1ZZ']
    );
  });

  it('lists per unit exactly what computeInclusion and coverageByBox give for its box', () => {
    for (const unit of units) {
      assert.deepStrictEqual(
        unit.cells.map((c) => c.name),
        computeInclusion(all, [unit.id]).includedChartIds,
        unit.id
      );
      assert.deepStrictEqual(unit.statusCells, coverageByBox(all, [unit.id])[unit.id], unit.id);
    }
    assert.deepStrictEqual(byId.get('US4AA1AA')?.statusCells, ['US4AA1AA', 'US5AA1AA', 'US5AA1AC']);
  });

  it('gives the same cells and versions as computeInclusion for a multi-box selection', () => {
    for (const selection of [
      ['US4AA1AA', 'US4AA1AB'],
      ['US4AA1AB', 'US4ZZ1ZZ'],
      ['US4AA1AA', 'US4AA1AB', 'US4ZZ1ZZ']
    ]) {
      const expected = computeInclusion(all, selection);
      const cells = new Map(
        selection.flatMap((id) => byId.get(id)?.cells ?? []).map((c) => [c.name, c])
      );
      const names = [...cells.keys()].sort((a, b) => a.localeCompare(b));
      assert.deepStrictEqual(names, expected.includedChartIds, selection.join());
      const versions = Object.fromEntries(
        [...cells.values()].map((c) => [c.name, version.get(c.archive)])
      );
      assert.deepStrictEqual(versions, expected.chartVersions, selection.join());
    }
  });

  it('records each cell at its enc_ed_up token verbatim, with NOAA download paths', () => {
    assert.strictEqual(
      version.get('https://charts.noaa.gov/ENCs/US4AA1AA.zip'),
      'US4AA1AA_ED003_UP012'
    );
    assert.deepStrictEqual(byId.get('US4ZZ1ZZ')?.cells, [
      {
        name: 'US4ZZ1ZZ',
        archive: 'https://charts.noaa.gov/ENCs/US4ZZ1ZZ.zip',
        path: 'ENC_ROOT/US4ZZ1ZZ/US4ZZ1ZZ.000',
        version: 'US4ZZ1ZZ_ED001_UP000'
      },
      {
        name: 'US5ZZ1ZZ',
        archive: 'https://charts.noaa.gov/ENCs/US5ZZ1ZZ.zip',
        path: 'ENC_ROOT/US5ZZ1ZZ/US5ZZ1ZZ.000',
        version: 'US5ZZ1ZZ_ED001_UP000'
      }
    ]);
  });

  it('outlines each unit with its band-4 box', () => {
    const unit = byId.get('US4ZZ1ZZ');
    assert.deepStrictEqual(unit?.bbox, [-70, 40, -69.5, 40.5]);
    assert.deepStrictEqual(unit.outline, {
      type: 'Polygon',
      coordinates: [square(-70, 40, 0.5)]
    });
  });
});

// ---- Assembly ----

const SOURCES = encSources({
  'XX_IENC_Catalog.xml': {
    label: 'XX Inland ENC',
    category: 'navigation',
    format: 'enc',
    regions: ['europe'],
    bbox: [0, 40, 10, 50]
  }
});

function job(name: string, version = 'v1', source = 'XX_IENC_Catalog'): ArchiveJob {
  return {
    source,
    url: `https://example.com/${name}.zip`,
    version,
    title: name
  };
}

function built(j: ArchiveJob, cells: string[], west = 0): ArchiveResult {
  return unitsForArchive(
    j,
    'zip',
    cells.map((name, i) => cellReport(`${name}.000`, [[square(west + i, 45, 0.5)]]))
  );
}

const NOAA: NoaaResult = noaaUnits(parseFootprints(NOAA_GEOJSON));

function inputs(overrides: Partial<EncIndexInputs> = {}): EncIndexInputs {
  return {
    sources: SOURCES,
    jobs: [],
    built: new Map(),
    failed: new Map(),
    noaa: NOAA,
    previous: null,
    now: NOW,
    ...overrides
  };
}

function published(index: EncIndex, schemaText: string | null = null) {
  return readPublishedEncIndex(JSON.parse(JSON.stringify(index)), schemaText);
}

describe('assembleEncIndex', () => {
  const a = job('a');
  const b = job('b');
  const first = assembleEncIndex(
    inputs({
      jobs: [a, b],
      built: new Map([
        [jobKey(a), built(a, ['1X7AAA01', '1X7AAA02'])],
        [jobKey(b), built(b, ['1X7BBB01'], 5)]
      ])
    })
  ).index;

  it('builds a valid, sorted index from NOAA and the archives read', () => {
    assert.ok(Value.Check(EncIndexSchema, first));
    assert.deepStrictEqual(
      first.sources.map((s) => s.id),
      ['XX_IENC_Catalog', 'noaa']
    );
    assert.deepStrictEqual(
      first.units.filter((u) => u.source !== 'noaa').map((u) => u.id),
      ['1X7AAA01', '1X7AAA02', '1X7BBB01']
    );
    assert.strictEqual(first.archives.filter((x) => x.source === 'noaa').length, 8);
  });

  it('gives the same file whatever order its inputs come in', () => {
    const again = assembleEncIndex(
      inputs({
        jobs: [b, a],
        built: new Map([
          [jobKey(b), built(b, ['1X7BBB01'], 5)],
          [jobKey(a), built(a, ['1X7AAA01', '1X7AAA02'])]
        ]),
        now: new Date('2027-01-01T00:00:00Z')
      })
    ).index;
    assert.strictEqual(again.contentHash, first.contentHash);
  });

  it('reuses archives whose version is unchanged and reads only the rest', () => {
    const previous = published(first);
    const b2 = job('b', 'v2');
    assert.deepStrictEqual(jobsToBuild([a, b2], previous), [b2]);
    const result = assembleEncIndex(
      inputs({
        jobs: [a, b2],
        built: new Map([[jobKey(b2), built(b2, ['1X7BBB01', '1X7BBB02'], 5)]]),
        previous
      })
    );
    assert.strictEqual(result.reused, 1);
    assert.deepStrictEqual(
      result.index.units.filter((u) => u.source !== 'noaa').map((u) => u.id),
      ['1X7AAA01', '1X7AAA02', '1X7BBB01', '1X7BBB02']
    );
    assert.strictEqual(result.index.archives.find((x) => x.url === b2.url)?.version, 'v2');
  });

  it('reads an archive again when it was built by older rules', () => {
    const raw = JSON.parse(JSON.stringify(first)) as EncIndex;
    for (const archive of raw.archives) {
      delete archive.revision;
    }
    assert.deepStrictEqual(jobsToBuild([a, b], readPublishedEncIndex(raw, null)), [a, b]);
  });

  it('keeps the published units of an archive that fails, at their old version', () => {
    const b2 = job('b', 'v2');
    const result = assembleEncIndex(
      inputs({
        jobs: [a, b2],
        failed: new Map([[jobKey(b2), 'HTTP 503']]),
        previous: published(first)
      })
    );
    assert.deepStrictEqual(result.carriedForward, [`${jobKey(b2)}: HTTP 503`]);
    assert.strictEqual(result.index.archives.find((x) => x.url === b2.url)?.version, 'v1');
    assert.ok(result.index.units.some((u) => u.id === '1X7BBB01'));
  });

  it('treats an archive with no usable cells as a failure', () => {
    const b2 = job('b', 'v2');
    const result = assembleEncIndex(
      inputs({
        jobs: [a, b2],
        built: new Map([[jobKey(b2), built(b2, [])]]),
        previous: published(first)
      })
    );
    assert.deepStrictEqual(result.carriedForward, [
      `${jobKey(b2)}: no S-57 cell with usable coverage`
    ]);
  });

  it('records an archive of update files only, and reuses it like any other', () => {
    const u = job('updates');
    const updates = unitsForArchive(u, 'zip', [], ['ENC_ROOT/EA200001.041']);
    assert.strictEqual(updates.updatesOnly, true);
    const index = assembleEncIndex(
      inputs({ jobs: [a, u], built: new Map([[jobKey(u), updates]]), previous: published(first) })
    ).index;
    assert.ok(index.archives.some((x) => x.url === u.url));
    const previous = published(index);
    assert.deepStrictEqual(jobsToBuild([a, u], previous), []);
    const again = assembleEncIndex(inputs({ jobs: [a, u], previous }));
    assert.strictEqual(again.reused, 2);
    assert.ok(again.index.archives.some((x) => x.url === u.url));
  });

  it('records update files for cells published in another archive, and flags those cells', () => {
    const base = job('base', '2019-01-01');
    const fresh = job('entm-003', '2019-03-15');
    const stale = job('entm-046', '2012-07-15');
    const archives = new Map([
      [jobKey(base), built(base, ['EA200001', 'EA200002'])],
      [jobKey(fresh), unitsForArchive(fresh, 'zip', [], ['ENC_ROOT/EA200001.003'])],
      [jobKey(stale), unitsForArchive(stale, 'zip', [], ['ENC_ROOT/EA200002.046'])]
    ]);
    const result = assembleEncIndex(inputs({ jobs: [base, fresh, stale], built: archives }));
    const cell = (name: string) =>
      result.index.units.find((u) => u.id === name)?.cells[0].updatesPublishedSeparately;
    assert.strictEqual(cell('EA200001'), true);
    assert.strictEqual(cell('EA200002'), undefined);
    assert.deepStrictEqual(result.separateUpdates, ['XX_IENC_Catalog EA200001']);
    assert.deepStrictEqual(result.index.archives.find((x) => x.url === fresh.url)?.updates, [
      'ENC_ROOT/EA200001.003'
    ]);

    // The flag is worked out on each build, so it clears when the update
    // archive is no longer listed, even though the base is reused as-is.
    const later = assembleEncIndex(
      inputs({ jobs: [base, stale], previous: published(result.index) })
    );
    assert.strictEqual(later.reused, 2);
    assert.strictEqual(
      later.index.units.find((u) => u.id === 'EA200001')?.cells[0].updatesPublishedSeparately,
      undefined
    );
  });

  it('leaves out a failed archive that was never published', () => {
    const c = job('c');
    const result = assembleEncIndex(
      inputs({ jobs: [c], failed: new Map([[jobKey(c), 'HTTP 404']]) })
    );
    assert.deepStrictEqual(result.skipped, [`${jobKey(c)}: HTTP 404`]);
    assert.ok(!result.index.archives.some((x) => x.url === c.url));
  });

  it('keeps the published units of an archive not read this run', () => {
    const b2 = job('b', 'v2');
    const result = assembleEncIndex(inputs({ jobs: [a, b2], previous: published(first) }));
    assert.deepStrictEqual(result.deferred, [jobKey(b2)]);
    assert.ok(result.index.units.some((u) => u.id === '1X7BBB01'));
  });

  it('keeps the published units of a source whose catalog could not be read', () => {
    const result = assembleEncIndex(
      inputs({
        jobs: [],
        unreadSources: new Set(['XX_IENC_Catalog']),
        previous: published(first)
      })
    );
    assert.deepStrictEqual(result.carriedForward, [
      'XX_IENC_Catalog: its catalog could not be read'
    ]);
    assert.deepStrictEqual(result.removedUpstream, []);
    assert.strictEqual(result.index.units.filter((u) => u.source === 'XX_IENC_Catalog').length, 3);
  });

  it('removes archives their source no longer lists', () => {
    const result = assembleEncIndex(inputs({ jobs: [a], previous: published(first) }));
    assert.deepStrictEqual(result.removedUpstream, [jobKey(b)]);
    assert.ok(!result.index.units.some((u) => u.id === '1X7BBB01'));
  });

  it('keeps the published NOAA units when NOAA cannot be read', () => {
    const result = assembleEncIndex(
      inputs({ jobs: [a, b], previous: published(first), noaa: { error: 'timeout' } })
    );
    assert.deepStrictEqual(result.carriedForward, ['noaa: timeout']);
    assert.strictEqual(result.index.units.filter((u) => u.source === 'noaa').length, 3);
  });

  it('keeps one unit per cell across sources, taking EuRIS first', () => {
    const euris = job('euris-a', '2026-01-01', PREFERRED_SOURCE);
    const national = job('national', '2026-09-01');
    const result = assembleEncIndex(
      inputs({
        sources: [
          ...SOURCES,
          { id: PREFERRED_SOURCE, label: 'EuRIS', kind: 'chartcatalogs', file: 'EURIS.xml' }
        ],
        jobs: [euris, national],
        built: new Map([
          [jobKey(euris), built(euris, ['1X7SHR01'])],
          [jobKey(national), built(national, ['1X7SHR01', '1X7NAT01'])]
        ])
      })
    );
    const cells = result.index.units
      .filter((u) => u.source !== 'noaa')
      .map((u) => [u.id, u.source]);
    assert.deepStrictEqual(cells, [
      ['1X7SHR01', PREFERRED_SOURCE],
      ['1X7NAT01', 'XX_IENC_Catalog']
    ]);
    assert.deepStrictEqual(result.duplicateCells, [
      { cell: '1X7SHR01', kept: PREFERRED_SOURCE, dropped: 'XX_IENC_Catalog' }
    ]);
  });

  describe('as EuRIS takes over cells from a national source', () => {
    const eurisSources = [
      ...SOURCES,
      { id: PREFERRED_SOURCE, label: 'EuRIS', kind: 'chartcatalogs' as const, file: 'EURIS.xml' }
    ];
    const national = job('national', '2026-09-01');
    const nationalCells = Array.from(
      { length: 20 },
      (_, i) => `1X7NAT${String(i).padStart(2, '0')}`
    );
    const euris = nationalCells
      .slice(0, 15)
      .map((cell) => job(cell, '2026-10-01', PREFERRED_SOURCE));
    const before = assembleEncIndex(
      inputs({
        sources: eurisSources,
        jobs: [national],
        built: new Map([[jobKey(national), built(national, nationalCells)]])
      })
    ).index;
    const after = assembleEncIndex(
      inputs({
        sources: eurisSources,
        jobs: [national, ...euris],
        built: new Map(euris.map((j, i) => [jobKey(j), built(j, [nationalCells[i]], i)])),
        previous: published(before)
      })
    );

    it('records the cells the national archive leaves to EuRIS', () => {
      assert.strictEqual(after.reused, 1);
      assert.deepStrictEqual(
        after.index.archives.find((x) => x.url === national.url)?.shadowed,
        nationalCells.slice(0, 15)
      );
      assert.strictEqual(after.index.units.filter((u) => u.source === 'XX_IENC_Catalog').length, 5);
    });

    it('does not trip the drop guard', () => {
      assert.deepStrictEqual(encIndexBlockers(after.index, published(before)), []);
    });

    it('reads the national archive again when EuRIS stops listing a cell it took', () => {
      const state = published(after.index);
      const remaining = euris.slice(1);
      assert.deepStrictEqual(jobsToBuild([national, ...remaining], state), [national]);
      const result = assembleEncIndex(
        inputs({
          sources: eurisSources,
          jobs: [national, ...remaining],
          built: new Map([[jobKey(national), built(national, nationalCells)]]),
          previous: state
        })
      );
      assert.strictEqual(
        result.index.units.find((u) => u.id === nationalCells[0])?.source,
        'XX_IENC_Catalog'
      );
    });

    it('reads it again on the next run when EuRIS still lists the archive but lost the cell', () => {
      const lost = euris[0];
      const gap = assembleEncIndex(
        inputs({
          sources: eurisSources,
          jobs: [national, ...euris],
          built: new Map([[jobKey(lost), built(lost, ['1X7OTHER'])]]),
          previous: published(after.index)
        })
      ).index;
      assert.strictEqual(
        gap.units.find((u) => u.id === nationalCells[0]),
        undefined
      );
      assert.deepStrictEqual(jobsToBuild([national, ...euris], published(gap)), [national]);
    });

    it('drops a national update flag when EuRIS supplies the cell', () => {
      const updates = job('national-updates', '2026-10-15');
      const result = assembleEncIndex(
        inputs({
          sources: eurisSources,
          jobs: [national, updates, ...euris],
          built: new Map([
            [
              jobKey(updates),
              unitsForArchive(
                updates,
                'zip',
                [],
                [`${nationalCells[0]}.001`, `${nationalCells[19]}.001`]
              )
            ]
          ]),
          previous: published(after.index)
        })
      );
      const flag = (id: string) =>
        result.index.units.find((u) => u.id === id)?.cells[0].updatesPublishedSeparately;
      assert.strictEqual(flag(nationalCells[0]), undefined);
      assert.strictEqual(flag(nationalCells[19]), true);
    });
  });

  it('keeps the cell from the newer archive when two archives of a source have it', () => {
    const old = job('old', '2025-01-01');
    const fresh = job('new', '2026-01-01');
    const result = assembleEncIndex(
      inputs({
        jobs: [fresh, old],
        built: new Map([
          [jobKey(old), built(old, ['1X7DUP01'])],
          [jobKey(fresh), built(fresh, ['1X7DUP01'])]
        ])
      })
    );
    const unit = result.index.units.find((u) => u.id === '1X7DUP01');
    assert.strictEqual(unit?.cells[0].archive, fresh.url);
    assert.strictEqual(result.duplicateCells.length, 1);
  });
});

describe('readPublishedEncIndex', () => {
  it('rebuilds an archive with a unit that no longer validates, and counts units from the raw array', () => {
    const a = job('a');
    const b = job('b');
    const index = assembleEncIndex(
      inputs({
        jobs: [a, b],
        built: new Map([
          [jobKey(a), built(a, ['1X7AAA01', '1X7AAA02'])],
          [jobKey(b), built(b, ['1X7BBB01'], 5)]
        ])
      })
    ).index;
    const raw = JSON.parse(JSON.stringify(index)) as { units: unknown[] };
    (raw.units[0] as { outline: unknown }).outline = 'broken';
    const state = readPublishedEncIndex(raw, null);
    assert.strictEqual(
      [...state.cellsBySource.values()].reduce((sum, n) => sum + n, 0),
      index.units.length
    );
    assert.strictEqual(state.archives.get(jobKey(a)), undefined);
    assert.strictEqual(state.archives.get(jobKey(b))?.units.length, 1);
    assert.deepStrictEqual(jobsToBuild([a, b], state), [a]);
    assert.strictEqual(state.noaa?.units.length, 3);
  });

  it('reads anything that is not an index as empty', () => {
    const state = readPublishedEncIndex('nope', null);
    assert.strictEqual(state.cellsBySource.size, 0);
    assert.strictEqual(state.noaa, null);
  });
});

describe('publishing the ENC index', () => {
  const a = job('a');
  const cells = Array.from({ length: 20 }, (_, i) => `1X7AAA${String(i).padStart(2, '0')}`);
  const full = assembleEncIndex(
    inputs({ jobs: [a], built: new Map([[jobKey(a), built(a, cells)]]) })
  ).index;

  it('blocks a sharp fall in units, overall or in one source', () => {
    const fewer = assembleEncIndex(
      inputs({ jobs: [a], built: new Map([[jobKey(a), built(a, cells.slice(0, 5))]]) })
    ).index;
    assert.deepStrictEqual(encIndexBlockers(fewer, published(full)), [
      'cells dropped from 23 to 8',
      'XX_IENC_Catalog cells dropped from 20 to 5'
    ]);
  });

  it('blocks an empty index', () => {
    const empty = assembleEncIndex(inputs({ noaa: null })).index;
    assert.deepStrictEqual(encIndexBlockers(empty, null), ['the index has no units']);
  });

  it('publishes on a content or schema change only', () => {
    assert.strictEqual(decideEncIndexPublish(full, null, 's', false).publish, true);
    assert.strictEqual(
      decideEncIndexPublish(full, published(full, 's'), 's', false).publish,
      false
    );
    assert.strictEqual(decideEncIndexPublish(full, published(full, 's'), 't', false).publish, true);
    assert.strictEqual(decideEncIndexPublish(full, published(full, 's'), 's', true).publish, true);
  });
});
