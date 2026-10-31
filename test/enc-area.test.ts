/**
 * Tests for the cells reaching an area (`enc-area.ts`) and the downloads
 * other plugins ask for around the vessel (`enc-area-request.ts`).
 */

import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { EncIndexUnitRead } from '../dist/catalog/enc-index-schema.js';
import { bboxesMeet, cellBboxes, cellsIn, unitsIn } from '../dist/utils/enc-area.js';
import {
  AREA_RETRY_MS,
  AREA_SET_NAME,
  createAreaRequester,
  MAX_AREA_UNITS,
  SLOT_RETRY_MS,
  type AreaChartSet,
  type AreaRequestDeps
} from '../dist/utils/enc-area-request.js';
import type { EncCollection } from '../dist/utils/enc-store.js';

type Bbox = [number, number, number, number];

function unit(source: string, id: string, bbox: Bbox, cells: string[]): EncIndexUnitRead {
  return {
    source,
    id,
    title: id,
    bbox,
    outline: {
      type: 'Polygon',
      coordinates: [
        [
          [bbox[0], bbox[1]],
          [bbox[2], bbox[1]],
          [bbox[2], bbox[3]],
          [bbox[0], bbox[1]]
        ]
      ]
    },
    cells: cells.map((name) => ({
      name,
      archive: 'https://example.com/a.zip',
      path: `${name}.000`
    })),
    statusCells: cells
  };
}

function lookup(units: EncIndexUnitRead[]) {
  const noaaUnits = new Map(units.filter((u) => u.source === 'noaa').map((u) => [u.id, u]));
  const otherUnits = new Map(units.filter((u) => u.source !== 'noaa').map((u) => [u.id, u]));
  return { noaaUnits, otherUnits };
}

function collection(id: string, cells: { name: string; version?: string }[]): EncCollection {
  return {
    id,
    name: id,
    kind: 'chart-set',
    source: 'chart-set',
    cellCount: cells.length,
    bytes: 0,
    updatedAt: '2026-10-30T00:00:00.000Z',
    dir: `/store/${id}`,
    cells: cells.map((c) => ({
      name: c.name,
      ...(c.version === undefined ? {} : { version: c.version }),
      dir: path.join('/store', id, c.name),
      files: [{ name: `${c.name}.000`, bytes: 1, modified: '2026-10-30T00:00:00.000Z' }]
    }))
  };
}

describe('enc-area', () => {
  it('meets boxes, across the antimeridian too', () => {
    assert.strictEqual(bboxesMeet([20, 59, 21, 60], [20.5, 59.5, 22, 61]), true);
    assert.strictEqual(bboxesMeet([20, 59, 21, 60], [21.5, 59, 22, 60]), false);
    assert.strictEqual(bboxesMeet([20, 59, 21, 60], [20, 61, 21, 62]), false);
    assert.strictEqual(bboxesMeet([179, -18, -179, -16], [-179.5, -17, -179.2, -16.5]), true);
    assert.strictEqual(bboxesMeet([179, -18, -179, -16], [0, -17, 1, -16.5]), false);
  });

  it('gives a NOAA cell listed by several boxes their union, and finds the units of an area', () => {
    const index = lookup([
      unit('noaa', 'US4FL1EP', [-81, 25, -80, 26], ['US4FL1EP', 'US3EAST1']),
      unit('noaa', 'US4FL2EP', [-80, 25, -79, 26], ['US4FL2EP', 'US3EAST1']),
      unit('fi', 'FI5AAAAA', [20, 59, 21, 60], ['FI5AAAAA'])
    ]);
    const extents = cellBboxes(index);
    assert.deepStrictEqual(extents.get('US3EAST1'), [-81, 25, -79, 26]);
    assert.deepStrictEqual(extents.get('FI5AAAAA'), [20, 59, 21, 60]);
    // A cell listed by a box across the antimeridian keeps every longitude.
    const across = cellBboxes(
      lookup([
        unit('noaa', 'US4AK1', [178, 51, 179, 52], ['US4AK1', 'US3ALEUT']),
        unit('noaa', 'US4AK2', [179.5, 51, -179.5, 52], ['US4AK2', 'US3ALEUT'])
      ])
    );
    assert.deepStrictEqual(across.get('US3ALEUT'), [-180, 51, 180, 52]);
    assert.deepStrictEqual(unitsIn(index, [-79.5, 25.5, -79.4, 25.6]), {
      noaa: ['US4FL2EP'],
      other: []
    });
    assert.deepStrictEqual(unitsIn(index, [20.5, 59.5, 20.6, 59.6]), {
      noaa: [],
      other: ['FI5AAAAA']
    });
  });

  it('finds the stored cells reaching an area, one of each, the newest first', () => {
    const extents = new Map<string, readonly [number, number, number, number]>([
      ['FI5AAAAA', [20, 59, 21, 60]],
      ['FI5BBBBB', [24, 59, 25, 60]]
    ]);
    const found = cellsIn(
      [
        collection('B_set', [{ name: 'FI5AAAAA', version: 'FI5AAAAA_ED002_UP001' }]),
        collection('A_set', [
          { name: 'FI5AAAAA', version: 'FI5AAAAA_ED001_UP009' },
          { name: 'FI5BBBBB' },
          { name: 'XX5UNKWN' }
        ])
      ],
      [20.5, 59.5, 20.6, 59.6],
      extents
    );
    assert.deepStrictEqual(
      found.map((c) => [c.cell, c.collection, c.version, c.base]),
      [
        [
          'FI5AAAAA',
          'B_set',
          'FI5AAAAA_ED002_UP001',
          path.join('/store', 'B_set', 'FI5AAAAA', 'FI5AAAAA.000')
        ],
        // Its extent is not known: it may reach the area.
        ['XX5UNKWN', 'A_set', undefined, path.join('/store', 'A_set', 'XX5UNKWN', 'XX5UNKWN.000')]
      ]
    );
  });
});

describe('enc-area-request', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'enc-area-request-'));
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const index = lookup([
    unit('noaa', 'US4FL1EP', [-81, 25, -80, 26], ['US4FL1EP']),
    unit('fi', 'FI5AAAAA', [20, 59, 21, 60], ['FI5AAAAA']),
    unit('fi', 'FI5BBBBB', [21, 59, 22, 60], ['FI5BBBBB'])
  ]);
  let sets: Map<string, AreaChartSet>;
  let started: string[];
  let held: (() => void)[];
  let timers: { task: () => void; ms: number }[];
  let allowed: true | string;
  let clock: number;
  let run = 0;

  function deps(overrides: Partial<AreaRequestDeps> = {}): AreaRequestDeps {
    run += 1;
    return {
      enabled: () => true,
      index: () => index,
      refreshIndex: () => {},
      mayDownload: () => allowed,
      whenAllowed: (task) => held.push(task),
      later: (task, ms) => {
        timers.push({ task, ms });
        return () => {
          timers = timers.filter((t) => t.task !== task);
        };
      },
      getSet: (id) => sets.get(id) ?? null,
      createSet: (name) => {
        const set = {
          id: name.replace(/ /g, '_'),
          selectedBand4ChartIds: [],
          selectedUnitIds: [],
          status: 'empty'
        };
        sets.set(set.id, set);
        return set;
      },
      saveSet: (set) => sets.set(set.id, { ...set }),
      busy: () => false,
      slotFree: () => true,
      start: (set) => started.push(set.id),
      stateFile: path.join(tmp, `area-${String(run)}.json`),
      now: () => clock,
      log: () => {},
      ...overrides
    };
  }

  beforeEach(() => {
    sets = new Map();
    started = [];
    held = [];
    timers = [];
    allowed = true;
    clock = 1_000_000;
  });

  it('downloads nothing unless the user turned it on, and only for an area', () => {
    const off = createAreaRequester(deps({ enabled: () => false })).request;
    const r = off([20, 59, 21, 60], 'underkeel');
    assert.strictEqual(r.accepted, false);
    assert.match(r.reason, /turn on/);
    const request = createAreaRequester(deps()).request;
    assert.strictEqual(request([20, 61, 21, 60], 'underkeel').accepted, false);
    assert.strictEqual(request('somewhere', 'underkeel').accepted, false);
    assert.deepStrictEqual(started, []);
  });

  it('loads the ENC index first, and says when no free ENC covers the area', () => {
    let refreshed = 0;
    const noIndex = createAreaRequester(
      deps({ index: () => null, refreshIndex: () => (refreshed += 1) })
    ).request;
    assert.match(noIndex([20, 59, 21, 60], 'u').reason, /not loaded/);
    assert.strictEqual(refreshed, 1);
    const request = createAreaRequester(deps()).request;
    assert.match(request([0, 0, 1, 1], 'u').reason, /no free ENC/);
    assert.deepStrictEqual(started, []);
  });

  it('adds the units reaching the area to one set, which grows along the voyage', () => {
    const d = deps();
    const request = createAreaRequester(d).request;
    const first = request([20.5, 59.5, 20.6, 59.6], 'underkeel');
    assert.deepStrictEqual(first, {
      accepted: true,
      started: true,
      reason: 'downloading the area',
      setId: 'Around_the_vessel'
    });
    assert.strictEqual(sets.get('Around_the_vessel')?.selectedUnitIds.join(), 'FI5AAAAA');
    assert.strictEqual(JSON.parse(fs.readFileSync(d.stateFile, 'utf8')).setId, 'Around_the_vessel');
    sets.get('Around_the_vessel')!.status = 'converted';
    // The same area again: nothing to do.
    assert.match(request([20.5, 59.5, 20.6, 59.6], 'underkeel').reason, /is downloaded/);
    // Further along, a unit is added and the set downloaded again.
    request([20.9, 59.5, 21.5, 59.6], 'underkeel');
    assert.deepStrictEqual(sets.get('Around_the_vessel')?.selectedUnitIds, [
      'FI5AAAAA',
      'FI5BBBBB'
    ]);
    assert.deepStrictEqual(started, ['Around_the_vessel', 'Around_the_vessel']);
    // A NOAA unit goes where the set keeps NOAA's.
    request([-80.5, 25.5, -80.4, 25.6], 'underkeel');
    assert.deepStrictEqual(sets.get('Around_the_vessel')?.selectedBand4ChartIds, ['US4FL1EP']);
    assert.strictEqual(AREA_SET_NAME, 'Around the vessel');
  });

  it('makes a new set when the user deleted it', () => {
    const d = deps();
    const request = createAreaRequester(d).request;
    request([20.5, 59.5, 20.6, 59.6], 'u');
    sets.clear();
    request([20.5, 59.5, 20.6, 59.6], 'u');
    assert.deepStrictEqual([...sets.keys()], ['Around_the_vessel']);
  });

  it('waits for the internet connection, and starts once when it allows', () => {
    allowed = 'it is metered';
    const request = createAreaRequester(deps()).request;
    const r = request([20.5, 59.5, 20.6, 59.6], 'u');
    assert.strictEqual(r.started, false);
    assert.match(r.reason, /internet connection allows: it is metered/);
    request([20.9, 59.5, 21.5, 59.6], 'u');
    assert.strictEqual(held.length, 1, 'one download waits, however often it is asked');
    allowed = true;
    held[0]();
    assert.deepStrictEqual(started, ['Around_the_vessel']);
  });

  it('keeps a waiting download until a conversion slot is free', () => {
    allowed = 'it is metered';
    let free = false;
    const requester = createAreaRequester(deps({ slotFree: () => free }));
    requester.request([20.5, 59.5, 20.6, 59.6], 'u');
    allowed = true;
    held[0]();
    assert.deepStrictEqual(started, []);
    assert.deepStrictEqual(
      timers.map((t) => t.ms),
      [SLOT_RETRY_MS]
    );
    timers[0].task();
    assert.strictEqual(timers.length, 2, 'still no slot: it looks again');
    free = true;
    timers[1].task();
    assert.deepStrictEqual(started, ['Around_the_vessel']);
    // Stopping cancels a retry still pending.
    allowed = 'it is metered';
    free = false;
    requester.request([20.9, 59.5, 21.5, 59.6], 'u');
    allowed = true;
    held[1]();
    assert.strictEqual(timers.length, 3);
    requester.reset();
    assert.strictEqual(timers.length, 2);
  });

  it('queues a waiting download again after a restart dropped the one held', () => {
    allowed = 'it is offline';
    const requester = createAreaRequester(deps());
    requester.request([20.5, 59.5, 20.6, 59.6], 'u');
    assert.strictEqual(held.length, 1);
    // The plugin stops: the gate drops what it held.
    held = [];
    requester.request([20.5, 59.5, 20.6, 59.6], 'u');
    assert.strictEqual(held.length, 0, 'still marked as waiting without a reset');
    requester.reset();
    requester.request([20.5, 59.5, 20.6, 59.6], 'u');
    assert.strictEqual(held.length, 1);
  });

  it('refuses a huge area, and waits while the set is busy or slots are taken', () => {
    const many = lookup(
      Array.from({ length: MAX_AREA_UNITS + 1 }, (_, i) =>
        unit('fi', `FI5U${String(i).padStart(4, '0')}`, [20, 59, 21, 60], [`FI5U${String(i)}`])
      )
    );
    assert.match(
      createAreaRequester(deps({ index: () => many })).request([20, 59, 21, 60], 'u').reason,
      /more than/
    );
    const busy = createAreaRequester(deps({ busy: () => true })).request;
    assert.match(busy([20.5, 59.5, 20.6, 59.6], 'u').reason, /being downloaded/);
    const full = createAreaRequester(deps({ slotFree: () => false })).request;
    assert.match(full([20.5, 59.5, 20.6, 59.6], 'u').reason, /other conversions/);
    assert.deepStrictEqual(started, []);
  });

  it('does not start a set left out of date again before the retry time', () => {
    const request = createAreaRequester(deps()).request;
    request([20.5, 59.5, 20.6, 59.6], 'u');
    // The run failed: the set stays out of date.
    assert.match(request([20.5, 59.5, 20.6, 59.6], 'u').reason, /a moment ago/);
    clock += AREA_RETRY_MS;
    assert.strictEqual(request([20.5, 59.5, 20.6, 59.6], 'u').started, true);
    assert.deepStrictEqual(started, ['Around_the_vessel', 'Around_the_vessel']);
  });
});
