/**
 * Tests for turning a chart set's selection into the cells to download
 * (`enc-chart-set.ts`): mixing sources, shared cells, units the index no
 * longer lists, and separately published updates.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  buildEncIndexLookup,
  formatCellVersion,
  parseCellVersion,
  resolveChartSet,
  separateUpdatesFor
} from '../dist/utils/enc-chart-set.js';
import type {
  EncIndexArchive,
  EncIndexCell,
  EncIndexUnit
} from '../dist/catalog/enc-index-schema.js';

function unit(
  source: string,
  id: string,
  cells: EncIndexCell[],
  statusCells?: string[]
): EncIndexUnit {
  return {
    source,
    id,
    title: id,
    bbox: [0, 0, 1, 1],
    outline: {
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 0]
        ]
      ]
    },
    cells,
    statusCells: statusCells ?? [cells[0].name]
  };
}

function cell(
  name: string,
  archive: string,
  version?: string,
  extra: Partial<EncIndexCell> = {}
): EncIndexCell {
  return { name, archive, path: `${name}.000`, ...(version ? { version } : {}), ...extra };
}

function archive(
  url: string,
  source: string,
  version: string,
  extra: Partial<EncIndexArchive> = {}
): EncIndexArchive {
  return { url, source, version, kind: 'zip', ...extra };
}

const NOAA_A = 'https://charts.noaa.gov/ENCs/US4AAAAA.zip';
const NOAA_B = 'https://charts.noaa.gov/ENCs/US4BBBBB.zip';
const NOAA_3 = 'https://charts.noaa.gov/ENCs/US3CCCCC.zip';
const EURIS = 'https://www.eurisportal.eu/AWFIENC/api/IENC/DownloadIENCMap?mapID=1';
const RHONE = 'https://inforhone.cnr.tm.fr/Content/CarteECDIS/3T5RHO01.000';
const ODRA = 'https://www.szczecin.uzs.gov.pl/IENC_OD.zip';

function lookup() {
  const units = [
    unit(
      'noaa',
      'US4AAAAA',
      [
        cell('US3CCCCC', NOAA_3, 'US3CCCCC_ED001_UP000'),
        cell('US4AAAAA', NOAA_A, 'US4AAAAA_ED002_UP003')
      ],
      ['US4AAAAA']
    ),
    unit(
      'noaa',
      'US4BBBBB',
      [
        cell('US3CCCCC', NOAA_3, 'US3CCCCC_ED001_UP000'),
        cell('US4BBBBB', NOAA_B, 'US4BBBBB_ED001_UP000')
      ],
      ['US4BBBBB']
    ),
    unit('EURIS_IENC_Catalog', '1H7D1430', [cell('1H7D1430', EURIS, '1H7D1430_ED011_UP000')]),
    unit('FR_IENC_RHONE_Catalog', '3T5RHO01', [cell('3T5RHO01', RHONE, '3T5RHO01_ED001_UP000')]),
    unit('PL_IENC_Catalog', 'PL1OD001', [cell('PL1OD001', ODRA, 'PL1OD001_ED001_UP000')]),
    unit('PL_IENC_Catalog', 'PL1OD002', [cell('PL1OD002', ODRA, 'PL1OD002_ED001_UP000')])
  ];
  const archives = [
    archive(NOAA_A, 'noaa', 'US4AAAAA_ED002_UP003'),
    archive(NOAA_B, 'noaa', 'US4BBBBB_ED001_UP000'),
    archive(NOAA_3, 'noaa', 'US3CCCCC_ED001_UP000'),
    archive(EURIS, 'EURIS_IENC_Catalog', '2026-07-17T06:35:31Z'),
    archive(RHONE, 'FR_IENC_RHONE_Catalog', '2025-01-01T00:00:00Z', { kind: 'cell' }),
    archive(ODRA, 'PL_IENC_Catalog', '2024-05-20T00:00:00Z')
  ];
  return buildEncIndexLookup(units, archives);
}

describe('resolveChartSet', () => {
  it('mixes NOAA boxes with other sources’ cells in one set', () => {
    const r = resolveChartSet(lookup(), {
      selectedBand4ChartIds: ['US4AAAAA'],
      selectedUnitIds: ['1H7D1430', '3T5RHO01']
    });
    assert.deepStrictEqual(r.includedChartIds, ['1H7D1430', '3T5RHO01', 'US3CCCCC', 'US4AAAAA']);
    const rhone = r.cells.find((c) => c.name === '3T5RHO01');
    assert.strictEqual(rhone?.archiveKind, 'cell');
    assert.strictEqual(rhone.archive, RHONE);
    assert.deepStrictEqual(r.missingSelected, []);
  });

  it('brings in a cell shared by two boxes once', () => {
    const r = resolveChartSet(lookup(), {
      selectedBand4ChartIds: ['US4AAAAA', 'US4BBBBB'],
      selectedUnitIds: []
    });
    assert.deepStrictEqual(r.includedChartIds, ['US3CCCCC', 'US4AAAAA', 'US4BBBBB']);
    assert.deepStrictEqual(r.coverageByUnit, { US4AAAAA: ['US4AAAAA'], US4BBBBB: ['US4BBBBB'] });
  });

  it('records each cell’s version from the index', () => {
    const r = resolveChartSet(lookup(), {
      selectedBand4ChartIds: ['US4AAAAA'],
      selectedUnitIds: []
    });
    assert.deepStrictEqual(r.chartVersions, {
      US3CCCCC: 'US3CCCCC_ED001_UP000',
      US4AAAAA: 'US4AAAAA_ED002_UP003'
    });
  });

  it('reports selected units the index no longer lists', () => {
    const r = resolveChartSet(lookup(), {
      selectedBand4ChartIds: ['US4GONE00'],
      selectedUnitIds: ['1H7D1430', 'XX7GONE0']
    });
    assert.deepStrictEqual(r.missingSelected, ['US4GONE00', 'XX7GONE0']);
    assert.deepStrictEqual(r.includedChartIds, ['1H7D1430']);
  });

  it('does not take a NOAA id from the other units, or the reverse', () => {
    const r = resolveChartSet(lookup(), {
      selectedBand4ChartIds: ['1H7D1430'],
      selectedUnitIds: ['US4AAAAA']
    });
    assert.deepStrictEqual(r.missingSelected, ['1H7D1430', 'US4AAAAA']);
  });
});

describe('cell versions', () => {
  it('parses and formats the index’s token form', () => {
    assert.deepStrictEqual(parseCellVersion('1R7WAD01_ED005_UP002'), {
      name: '1R7WAD01',
      edition: 5,
      update: 2
    });
    assert.strictEqual(parseCellVersion('US4FL1EP'), null);
    assert.strictEqual(formatCellVersion('EA200001', 2, 41), 'EA200001_ED002_UP041');
  });
});

describe('separately published updates', () => {
  const SCS = 'SCS_ENC_Catalog';
  const BASE = 'http://member.eahc.asia/userfiles/file/SCSENC_ed3.zip';
  const upd = (n: string) => `http://member.eahc.asia/updating/file/scsenc_eNTM_${n}.zip`;

  function scs(
    cellExtra: Partial<EncIndexCell>,
    updates: { url: string; date: string; paths: string[] }[]
  ) {
    const c = cell('EA200004', BASE, 'EA200004_ED003_UP000', cellExtra);
    return buildEncIndexLookup(
      [unit(SCS, 'EA200004', [c])],
      [
        archive(BASE, SCS, '2019-01-01T00:00:00Z'),
        ...updates.map((u) => archive(u.url, SCS, u.date, { updates: u.paths }))
      ]
    );
  }

  it('applies updates numbered after the cell’s own, in order', () => {
    const l = scs({ updatesPublishedSeparately: true }, [
      { url: upd('3_004'), date: '2019-04-15T00:00:00Z', paths: ['ENC_ROOT/EA200004.002'] },
      { url: upd('3_003'), date: '2019-03-15T00:00:00Z', paths: ['ENC_ROOT/EA200004.001'] }
    ]);
    const r = resolveChartSet(l, { selectedBand4ChartIds: [], selectedUnitIds: ['EA200004'] });
    assert.deepStrictEqual(
      r.cells[0].updates.map((u) => [u.number, u.archive]),
      [
        [1, upd('3_003')],
        [2, upd('3_004')]
      ]
    );
    assert.strictEqual(r.chartVersions.EA200004, 'EA200004_ED003_UP002');
  });

  it('ignores updates from archives older than the cell’s (an earlier edition)', () => {
    const l = scs({ updatesPublishedSeparately: true }, [
      { url: upd('2_054'), date: '2013-03-15T00:00:00Z', paths: ['ENC_ROOT/EA200004.011'] },
      { url: upd('3_003'), date: '2019-03-15T00:00:00Z', paths: ['ENC_ROOT/EA200004.001'] }
    ]);
    const c = l.otherUnits.get('EA200004')?.cells[0];
    assert.ok(c);
    assert.deepStrictEqual(
      separateUpdatesFor(l, SCS, c).map((u) => u.number),
      [1]
    );
  });

  it('stops at the first missing update', () => {
    const l = scs({ updatesPublishedSeparately: true }, [
      { url: upd('3_003'), date: '2019-03-15T00:00:00Z', paths: ['ENC_ROOT/EA200004.001'] },
      { url: upd('3_005'), date: '2019-05-15T00:00:00Z', paths: ['ENC_ROOT/EA200004.003'] }
    ]);
    const c = l.otherUnits.get('EA200004')?.cells[0];
    assert.ok(c);
    assert.deepStrictEqual(
      separateUpdatesFor(l, SCS, c).map((u) => u.number),
      [1]
    );
  });

  it('applies nothing to a cell the index does not flag', () => {
    const l = scs({}, [
      { url: upd('3_003'), date: '2019-03-15T00:00:00Z', paths: ['ENC_ROOT/EA200004.001'] }
    ]);
    const r = resolveChartSet(l, { selectedBand4ChartIds: [], selectedUnitIds: ['EA200004'] });
    assert.deepStrictEqual(r.cells[0].updates, []);
    assert.strictEqual(r.chartVersions.EA200004, 'EA200004_ED003_UP000');
  });

  it('only takes updates from the cell’s own source', () => {
    const c = cell('EA200004', BASE, 'EA200004_ED003_UP000', { updatesPublishedSeparately: true });
    const l = buildEncIndexLookup(
      [unit(SCS, 'EA200004', [c])],
      [
        archive(BASE, SCS, '2019-01-01T00:00:00Z'),
        archive(upd('x'), 'OTHER', '2020-01-01T00:00:00Z', { updates: ['EA200004.001'] })
      ]
    );
    assert.deepStrictEqual(separateUpdatesFor(l, SCS, c), []);
  });
});
