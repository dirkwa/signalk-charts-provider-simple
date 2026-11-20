/**
 * Open Data Charts: unit geometry, reading the index, planning a set's
 * build, assembling units into one MBTiles and updating one unit's rows,
 * the download cache, and a whole build from a local HTTP server.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  parseUnitId,
  unitBounds,
  unitOfTile,
  UNIT_ROWS_SQL
} from '../dist/utils/open-data/tiles.js';
import { interpretOpenDataIndex } from '../dist/utils/open-data/index-schema.js';
import type { OpenDataIndex, OpenDataUnit } from '../dist/utils/open-data/index-schema.js';
import {
  afterPlan,
  afterShading,
  OpenDataSetStore,
  planSet,
  planShading,
  setState,
  type OpenDataSet
} from '../dist/utils/open-data/sets.js';
import {
  assembleChart,
  mergeVectorLayers,
  NotPatchableError
} from '../dist/utils/open-data/assemble.js';
import { UnitCache } from '../dist/utils/open-data/unit-cache.js';
import { OpenDataCharts } from '../dist/utils/open-data/service.js';
import { MBTilesReader } from '../dist/utils/mbtiles-reader.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'open-data-test-'));
after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function tmpDir(name: string): string {
  return fs.mkdtempSync(path.join(tmpRoot, `${name}-`));
}

interface TileRow {
  z: number;
  x: number;
  row: number;
  data: string;
}

/** Every stored tile of unit (x, y) from z9 to `maxzoom`, plus one of a neighbour. */
function unitTiles(x: number, y: number, version: string, maxzoom = 11): TileRow[] {
  const rows: TileRow[] = [];
  for (let z = 9; z <= maxzoom; z++) {
    const scale = 2 ** (z - 9);
    for (let dx = 0; dx < scale; dx++) {
      for (let dy = 0; dy < scale; dy++) {
        const xyzY = y * scale + dy;
        rows.push({
          z,
          x: x * scale + dx,
          row: 2 ** z - 1 - xyzY,
          data: `${String(x)}-${String(y)}@${version}`
        });
      }
    }
  }
  // A tiler's buffer tile of the unit to the east.
  rows.push({ z: 9, x: x + 1, row: 511 - y, data: `buffer@${version}` });
  return rows;
}

/**
 * A unit file as tippecanoe writes it (deduplicated `map`/`images` and a
 * `tiles` view) or as a plain `tiles` table.
 */
function writeMbtiles(
  file: string,
  rows: TileRow[],
  layers: string[],
  style: 'view' | 'table' = 'view'
): void {
  fs.rmSync(file, { force: true });
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE metadata (name TEXT, value TEXT)');
  if (style === 'table') {
    db.exec(
      'CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB)'
    );
    const insert = db.prepare('INSERT INTO tiles VALUES (?, ?, ?, ?)');
    for (const r of rows) {
      insert.run(r.z, r.x, r.row, Buffer.from(r.data));
    }
  } else {
    db.exec(`
      CREATE TABLE map (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_id TEXT);
      CREATE TABLE images (zoom_level INTEGER, tile_data BLOB, tile_id TEXT);
      CREATE VIEW tiles AS SELECT map.zoom_level AS zoom_level, map.tile_column AS tile_column,
        map.tile_row AS tile_row, images.tile_data AS tile_data
        FROM map JOIN images ON images.tile_id = map.tile_id AND images.zoom_level = map.zoom_level;
    `);
    const map = db.prepare('INSERT INTO map VALUES (?, ?, ?, ?)');
    const images = db.prepare('INSERT INTO images VALUES (?, ?, ?)');
    rows.forEach((r, i) => {
      map.run(r.z, r.x, r.row, String(i));
      images.run(r.z, Buffer.from(r.data), String(i));
    });
  }
  const json = JSON.stringify({
    vector_layers: layers.map((id) => ({
      id,
      minzoom: 9,
      maxzoom: 11,
      fields: { [`${id}_F`]: 'String' }
    }))
  });
  db.prepare("INSERT INTO metadata VALUES ('json', ?)").run(json);
  db.prepare("INSERT INTO metadata VALUES ('format', 'pbf')").run();
  db.close();
}

function readTiles(file: string): Map<string, string> {
  const db = new DatabaseSync(file, { readOnly: true });
  const rows = db
    .prepare('SELECT zoom_level AS z, tile_column AS x, tile_row AS r, tile_data AS d FROM tiles')
    .all() as { z: number; x: number; r: number; d: Uint8Array }[];
  db.close();
  return new Map(
    rows.map((r) => [`${String(r.z)}/${String(r.x)}/${String(r.r)}`, Buffer.from(r.d).toString()])
  );
}

function readMetadata(file: string): Record<string, string> {
  const db = new DatabaseSync(file, { readOnly: true });
  const rows = db.prepare('SELECT name, value FROM metadata').all() as {
    name: string;
    value: string;
  }[];
  db.close();
  return Object.fromEntries(rows.map((r) => [r.name, r.value]));
}

function unit(id: string, version: string, extra: Partial<OpenDataUnit> = {}): OpenDataUnit {
  const tile = parseUnitId(id);
  assert.ok(tile);
  const [w, s, e, n] = unitBounds(tile);
  return {
    id,
    region: 'new-caledonia',
    z: 9,
    x: tile.x,
    y: tile.y,
    bbox: [w, s, e, n],
    version,
    url: `https://example.com/${id}.${version}.mbtiles`,
    size: 100,
    sha256: 'a'.repeat(64),
    minzoom: 9,
    maxzoom: 15,
    quality: { best: 'multibeam', share: { multibeam: 1 } },
    ...extra
  };
}

function emptySet(unitIds: string[], built: Record<string, string> = {}): OpenDataSet {
  return {
    schemaVersion: 1,
    id: 'noumea',
    name: 'Nouméa',
    folder: 'Open Data Charts',
    unitIds,
    built,
    overviews: {},
    chartFile: null,
    terrain: true,
    shaded: {},
    shadingFile: null,
    createdAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-01T00:00:00Z',
    lastBuiltAt: null
  };
}

function indexOf(units: OpenDataUnit[]): OpenDataIndex {
  return {
    generated: null,
    disclaimer: 'Not for navigation.',
    attribution: 'Shom; (c) OpenStreetMap contributors',
    regions: [{ id: 'new-caledonia', name: 'New Caledonia', bbox: [158, -26, 172, -17] }],
    units
  };
}

describe('unit geometry', () => {
  it('finds the z9 ancestor of a TMS row', () => {
    // Unit z9-492-288 (Nouméa) is TMS row 511 - 288 = 223 at z9.
    assert.deepStrictEqual(unitOfTile(9, 492, 223), { x: 492, y: 288 });
    // Its z15 tiles: XYZ rows 288*64 .. 288*64+63.
    const z = 15;
    const topXyz = 288 * 64;
    assert.deepStrictEqual(unitOfTile(z, 492 * 64, 2 ** z - 1 - topXyz), { x: 492, y: 288 });
    assert.deepStrictEqual(unitOfTile(z, 492 * 64 + 63, 2 ** z - 1 - (topXyz + 63)), {
      x: 492,
      y: 288
    });
    assert.deepStrictEqual(unitOfTile(z, 492 * 64, 2 ** z - 1 - (topXyz + 64)), {
      x: 492,
      y: 289
    });
    assert.strictEqual(unitOfTile(8, 246, 111), null);
  });

  it('selects the same rows in SQL', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER)');
    const insert = db.prepare('INSERT INTO tiles VALUES (?, ?, ?)');
    const rows = [...unitTiles(492, 288, 'a', 12), ...unitTiles(493, 288, 'a', 12)];
    for (const r of rows) {
      insert.run(r.z, r.x, r.row);
    }
    insert.run(8, 246, 111);
    const picked = db
      .prepare(
        `SELECT zoom_level AS z, tile_column AS x, tile_row AS row FROM tiles WHERE ${UNIT_ROWS_SQL}`
      )
      .all({ ux: 492, uy: 288 }) as { z: number; x: number; row: number }[];
    const expected = rows.filter((r) => {
      const u = unitOfTile(r.z, r.x, r.row);
      return u?.x === 492 && u.y === 288;
    });
    assert.strictEqual(picked.length, expected.length);
    assert.ok(picked.every((r) => unitOfTile(r.z, r.x, r.row)?.x === 492));
    db.close();
  });

  it('parses unit ids and computes the Nouméa unit bounds', () => {
    assert.deepStrictEqual(parseUnitId('z9-492-288'), { x: 492, y: 288 });
    assert.strictEqual(parseUnitId('z9-512-0'), null);
    assert.strictEqual(parseUnitId('z9-../-1'), null);
    const [w, s, e, n] = unitBounds({ x: 492, y: 288 });
    assert.strictEqual(w, 165.9375);
    assert.strictEqual(e, 166.640625);
    assert.ok(Math.abs(s - -22.593726) < 1e-5);
    assert.ok(Math.abs(n - -21.943046) < 1e-5);
  });
});

describe('interpretOpenDataIndex', () => {
  const good = {
    schemaVersion: 1,
    generated: '2026-12-01T03:00:00Z',
    disclaimer: 'Not for navigation.',
    attribution: 'Shom',
    aFieldFromTheFuture: { x: 1 },
    regions: [
      { id: 'new-caledonia', name: 'New Caledonia', bbox: [158, -26, 172, -17], overview: null },
      { id: 'bad region', name: 'x', bbox: [0, 0, 1, 1] }
    ],
    units: [
      { ...unit('z9-492-288', 'v1'), somethingNew: true },
      { ...unit('z9-493-288', 'v1'), quality: { best: 'satellite-derived' } },
      { ...unit('z9-494-288', 'v1'), x: 1 },
      { ...unit('z9-495-288', 'v1'), sha256: 'nope' },
      { ...unit('z9-496-288', 'v1'), z: 10 },
      { ...unit('z9-497-288', '../evil') },
      unit('z9-492-288', 'v2'),
      'garbage'
    ]
  };

  it('keeps readable entries, ignores unknown fields and skips the rest', () => {
    const result = interpretOpenDataIndex(good);
    assert.ok(result.ok);
    assert.deepStrictEqual(
      result.index.units.map((u) => `${u.id}@${u.version}`),
      ['z9-492-288@v1', 'z9-493-288@v1']
    );
    assert.strictEqual(result.index.units[1].quality?.best, 'satellite-derived');
    assert.deepStrictEqual(
      result.index.regions.map((r) => r.id),
      ['new-caledonia']
    );
    assert.strictEqual(result.skipped, 7);
    assert.strictEqual(result.index.attribution, 'Shom');
  });

  it('drops a terrain shading it cannot read and keeps the unit', () => {
    const hillshade = {
      url: 'https://example.com/s.mbtiles',
      sha256: 'c'.repeat(64),
      size: 10,
      minzoom: 9,
      maxzoom: 12
    };
    const result = interpretOpenDataIndex({
      ...good,
      units: [
        { ...unit('z9-492-288', 'v1'), hillshade },
        { ...unit('z9-493-288', 'v1'), hillshade: { ...hillshade, sha256: 'nope' } },
        { ...unit('z9-494-288', 'v1'), hillshade: { ...hillshade, minzoom: 8 } }
      ]
    });
    assert.ok(result.ok);
    assert.deepStrictEqual(
      result.index.units.map((u) => [u.id, u.hillshade?.size ?? null]),
      [
        ['z9-492-288', 10],
        ['z9-493-288', null],
        ['z9-494-288', null]
      ]
    );
    assert.strictEqual(result.skipped, 1, 'only the bad region');
  });

  it('reports a newer schemaVersion as incompatible', () => {
    const result = interpretOpenDataIndex({ ...good, schemaVersion: 2 });
    assert.ok(!result.ok);
    assert.strictEqual(result.reason, 'incompatible');
  });

  it('rejects a file that is not an index', () => {
    for (const raw of [null, [], {}, { schemaVersion: 1 }, { schemaVersion: '1' }]) {
      const result = interpretOpenDataIndex(raw);
      assert.ok(!result.ok);
      assert.strictEqual(result.reason, 'invalid');
    }
  });
});

describe('planning a set', () => {
  const a1 = unit('z9-492-288', 'v1');
  const b1 = unit('z9-493-288', 'v1');
  const b2 = unit('z9-493-288', 'v2', { changes: 'Seamarks updated' });

  it('builds every selected unit when there is no chart', () => {
    const plan = planSet(emptySet([a1.id, b1.id, 'z9-1-1']), indexOf([a1, b1]), false);
    assert.strictEqual(plan.fresh, true);
    assert.deepStrictEqual(
      plan.add.map((u) => u.id),
      [a1.id, b1.id]
    );
    assert.deepStrictEqual(plan.missing, ['z9-1-1']);
  });

  it('updates only the unit whose version changed', () => {
    const set = emptySet([a1.id, b1.id], { [a1.id]: 'v1', [b1.id]: 'v1' });
    const index = indexOf([a1, b2]);
    const state = setState(set, index, true);
    assert.strictEqual(state.status, 'update_available');
    assert.deepStrictEqual(state.updates, [
      { id: b1.id, from: 'v1', to: 'v2', changes: 'Seamarks updated' }
    ]);
    const plan = planSet(set, index, true);
    assert.strictEqual(plan.fresh, false);
    assert.deepStrictEqual(
      plan.add.map((u) => `${u.id}@${u.version}`),
      [`${b1.id}@v2`]
    );
    assert.deepStrictEqual(plan.remove, [b1.id]);
    assert.strictEqual(plan.overviews, null);
    assert.deepStrictEqual(afterPlan(set, plan).built, { [a1.id]: 'v1', [b1.id]: 'v2' });
  });

  it('removes a unit taken out of the set and keeps one the index dropped', () => {
    const set = emptySet([a1.id, 'z9-1-1'], { [a1.id]: 'v1', [b1.id]: 'v1', 'z9-1-1': 'v0' });
    const index = indexOf([a1, b1]);
    assert.strictEqual(setState(set, index, true).status, 'changed');
    const plan = planSet(set, index, true);
    assert.deepStrictEqual(plan.add, []);
    assert.deepStrictEqual(plan.remove, [b1.id]);
    assert.deepStrictEqual(afterPlan(set, plan).built, { [a1.id]: 'v1', 'z9-1-1': 'v0' });
  });

  it('is up to date when every version matches, and plans the region overview', () => {
    const set = emptySet([a1.id], { [a1.id]: 'v1' });
    assert.strictEqual(setState(set, indexOf([a1]), true).status, 'up_to_date');
    assert.strictEqual(setState(set, indexOf([a1]), false).status, 'not_built');
    const withOverview = indexOf([a1]);
    withOverview.regions[0].overview = {
      url: 'https://example.com/o.mbtiles',
      sha256: 'b'.repeat(64),
      size: 10,
      version: 'o1',
      minzoom: 0,
      maxzoom: 8
    };
    const plan = planSet(set, withOverview, true);
    assert.deepStrictEqual(
      plan.overviews?.map((o) => `${o.region}@${o.version}`),
      ['new-caledonia@o1']
    );
    assert.deepStrictEqual(afterPlan(set, plan).overviews, { 'new-caledonia': 'o1' });
  });

  it('reports a new overview version as an update', () => {
    const set = { ...emptySet([a1.id], { [a1.id]: 'v1' }), overviews: { 'new-caledonia': 'o1' } };
    const index = indexOf([a1]);
    const overview = {
      url: 'https://example.com/o.mbtiles',
      sha256: 'b'.repeat(64),
      size: 10,
      version: 'o1',
      minzoom: 0,
      maxzoom: 8
    };
    index.regions[0].overview = overview;
    assert.strictEqual(setState(set, index, true).status, 'up_to_date');
    index.regions[0].overview = { ...overview, version: 'o2' };
    assert.strictEqual(setState(set, index, true).status, 'update_available');
  });

  it('counts a unit the index dropped as missing once the chart is gone', () => {
    const set = emptySet([a1.id, 'z9-1-1'], { [a1.id]: 'v1', 'z9-1-1': 'v0' });
    const index = indexOf([a1]);
    assert.deepStrictEqual(setState(set, index, true).missing, []);
    assert.deepStrictEqual(setState(set, index, false).missing, ['z9-1-1']);
    assert.deepStrictEqual(planSet(set, index, false).missing, ['z9-1-1']);
  });
});

describe('planning a set’s terrain shading', () => {
  const shade = (version: string) => ({
    url: `https://example.com/s.${version}.mbtiles`,
    sha256: 'c'.repeat(64),
    size: 7,
    minzoom: 9,
    maxzoom: 12
  });
  const a1 = unit('z9-492-288', 'v1', { hillshade: shade('v1') });
  const b1 = unit('z9-493-288', 'v1', { hillshade: shade('v1') });
  const b2 = unit('z9-493-288', 'v2', { hillshade: shade('v2') });
  const sea = unit('z9-494-288', 'v1');

  it('shades every selected unit that has a shading when there is none yet', () => {
    const set = emptySet([a1.id, b1.id, sea.id]);
    const plan = planShading(set, indexOf([a1, b1, sea]), false);
    assert.strictEqual(plan.fresh, true);
    assert.deepStrictEqual(
      plan.add.map((s) => `${s.id}@${s.version}`),
      [`${a1.id}@v1`, `${b1.id}@v1`]
    );
    assert.deepStrictEqual(afterShading(set, plan), { [a1.id]: 'v1', [b1.id]: 'v1' });
  });

  it('replaces only a changed unit’s shading and reports it as an update', () => {
    const built = { [a1.id]: 'v1', [b1.id]: 'v1' };
    const set = { ...emptySet([a1.id, b1.id], built), shaded: built };
    assert.strictEqual(setState(set, indexOf([a1, b1]), true, true).status, 'up_to_date');
    const plan = planShading(set, indexOf([a1, b2]), true);
    assert.deepStrictEqual(
      plan.add.map((s) => `${s.id}@${s.version}`),
      [`${b1.id}@v2`]
    );
    assert.deepStrictEqual(plan.remove, [b1.id]);
  });

  it('takes the shading out when terrain is switched off, and keeps a dropped unit’s', () => {
    const shaded = { [a1.id]: 'v1', 'z9-1-1': 'v0' };
    const set = { ...emptySet([a1.id, 'z9-1-1'], shaded), shaded };
    const index = indexOf([a1]);
    assert.deepStrictEqual(planShading(set, index, true), { fresh: false, add: [], remove: [] });
    const off = { ...set, terrain: false };
    assert.strictEqual(setState(off, index, true, true).status, 'changed');
    const plan = planShading(off, index, true);
    assert.deepStrictEqual(plan.remove.sort(), ['z9-1-1', a1.id]);
    assert.deepStrictEqual(afterShading(off, plan), {});
  });

  it('wants nothing from an index without shading', () => {
    const set = emptySet([sea.id], { [sea.id]: 'v1' });
    assert.strictEqual(setState(set, indexOf([sea]), true, false).status, 'up_to_date');
  });
});

describe('assembling a chart', () => {
  it('copies only each unit’s own rows and unions the metadata', () => {
    const dir = tmpDir('assemble');
    const a = path.join(dir, 'a.mbtiles');
    const b = path.join(dir, 'b.mbtiles');
    writeMbtiles(a, unitTiles(492, 288, 'v1'), ['DEPARE', 'LNDARE']);
    writeMbtiles(b, unitTiles(493, 288, 'v1'), ['DEPARE', 'SOUNDG'], 'table');
    const overview = path.join(dir, 'o.mbtiles');
    writeMbtiles(
      overview,
      [
        { z: 8, x: 246, row: 111, data: 'overview' },
        { z: 9, x: 492, row: 223, data: 'not an overview row' }
      ],
      ['COALNE']
    );
    const target = path.join(dir, 'charts', 'Open Data Charts', 'Noumea.mbtiles');
    assembleChart({
      kind: 'chart',
      target,
      base: null,
      remove: [],
      add: [
        { tile: { x: 492, y: 288 }, file: a },
        { tile: { x: 493, y: 288 }, file: b }
      ],
      overviews: [overview],
      units: [
        { x: 492, y: 288 },
        { x: 493, y: 288 }
      ],
      name: 'Nouméa (not for navigation)',
      description: 'NOT FOR NAVIGATION.',
      attribution: 'Shom',
      setId: 'noumea'
    });
    const tiles = readTiles(target);
    // 1 + 4 + 16 own tiles per unit, plus the overview tile.
    assert.strictEqual(tiles.size, 21 * 2 + 1);
    assert.strictEqual(tiles.get('9/492/223'), '492-288@v1');
    assert.strictEqual(tiles.get('9/493/223'), '493-288@v1');
    assert.strictEqual(tiles.get('8/246/111'), 'overview');
    assert.ok(![...tiles.values()].some((d) => d.startsWith('buffer')));
    assert.deepStrictEqual(
      fs.readdirSync(path.dirname(target)),
      ['Noumea.mbtiles'],
      'no temporary file is left'
    );

    const meta = readMetadata(target);
    assert.strictEqual(meta.name, 'Nouméa (not for navigation)');
    assert.strictEqual(meta.type, 'S-57');
    assert.strictEqual(meta.format, 'pbf');
    assert.strictEqual(meta.minzoom, '8');
    assert.strictEqual(meta.maxzoom, '11');
    assert.strictEqual(meta.attribution, 'Shom');
    assert.strictEqual(meta.bounds, '165.937500,-22.593726,167.343750,-21.943046');
    const layers = (JSON.parse(meta.json) as { vector_layers: { id: string }[] }).vector_layers;
    assert.deepStrictEqual(
      layers.map((l) => l.id),
      ['COALNE', 'DEPARE', 'LNDARE', 'SOUNDG']
    );

    // The loader reads it like any other chart.
    const reader = new MBTilesReader(target);
    assert.strictEqual(reader.getRawTile(9, 492, 288)?.toString(), '492-288@v1');
    reader.close();
  });

  it('replaces only the changed unit’s rows on an update, and removes a unit', () => {
    const dir = tmpDir('update');
    const a1 = path.join(dir, 'a1.mbtiles');
    const b1 = path.join(dir, 'b1.mbtiles');
    const b2 = path.join(dir, 'b2.mbtiles');
    writeMbtiles(a1, unitTiles(492, 288, 'v1'), ['DEPARE']);
    writeMbtiles(b1, unitTiles(493, 288, 'v1'), ['DEPARE']);
    // Version 2 lost its z11 tiles: they must not survive the update.
    writeMbtiles(
      b2,
      unitTiles(493, 288, 'v2', 10).filter((t) => t.z <= 10),
      ['DEPARE', 'BOYLAT']
    );
    const target = path.join(dir, 'Set.mbtiles');
    const labels = { name: 'Set', description: 'd', attribution: null, setId: 'set' };
    const both = [
      { x: 492, y: 288 },
      { x: 493, y: 288 }
    ];
    assembleChart({
      kind: 'chart',
      target,
      base: null,
      remove: [],
      add: [
        { tile: both[0], file: a1 },
        { tile: both[1], file: b1 }
      ],
      overviews: null,
      units: both,
      ...labels
    });
    const before = readTiles(target);

    assembleChart({
      kind: 'chart',
      target,
      base: target,
      remove: [both[1]],
      add: [{ tile: both[1], file: b2 }],
      overviews: null,
      units: both,
      ...labels
    });
    const updated = readTiles(target);
    for (const [key, data] of before) {
      if (data.startsWith('492-288')) {
        assert.strictEqual(updated.get(key), data, `unit a keeps ${key}`);
      }
    }
    const bRows = [...updated.values()].filter((d) => d.startsWith('493-288'));
    assert.strictEqual(bRows.length, 1 + 4);
    assert.ok(bRows.every((d) => d === '493-288@v2'));
    const layers = (
      JSON.parse(readMetadata(target).json) as { vector_layers: { id: string }[] }
    ).vector_layers.map((l) => l.id);
    assert.deepStrictEqual(layers, ['BOYLAT', 'DEPARE']);

    assembleChart({
      kind: 'chart',
      target,
      base: target,
      remove: [both[1]],
      add: [],
      overviews: null,
      units: [both[0]],
      ...labels
    });
    const removed = readTiles(target);
    assert.strictEqual(removed.size, 21);
    assert.ok([...removed.values()].every((d) => d === '492-288@v1'));
    assert.strictEqual(readMetadata(target).bounds?.split(',')[2], '166.640625');
  });

  it('refuses to patch a chart it did not write', () => {
    const dir = tmpDir('foreign');
    const foreign = path.join(dir, 'Foreign.mbtiles');
    writeMbtiles(foreign, unitTiles(1, 1, 'x'), ['A']);
    assert.throws(
      () =>
        assembleChart({
          kind: 'chart',
          target: foreign,
          base: foreign,
          remove: [],
          add: [],
          overviews: null,
          units: [],
          name: 'x',
          description: 'x',
          attribution: null,
          setId: 'x'
        }),
      NotPatchableError
    );
    assert.deepStrictEqual(fs.readdirSync(dir), ['Foreign.mbtiles']);
  });

  it('merges vector layer fields and zoom ranges', () => {
    assert.deepStrictEqual(
      mergeVectorLayers([
        [{ id: 'A', minzoom: 10, maxzoom: 12, fields: { x: 'String' } }],
        [{ id: 'A', minzoom: 9, maxzoom: 15, fields: { y: 'Number' } }]
      ]),
      [{ id: 'A', minzoom: 9, maxzoom: 15, fields: { x: 'String', y: 'Number' } }]
    );
  });
});

describe('set store', () => {
  it('keeps ids safe and fields a newer version wrote', () => {
    const dataDir = tmpDir('store');
    const store = new OpenDataSetStore(dataDir);
    const set = store.create('../../Nouméa lagoon');
    assert.match(set.id, /^[A-Za-z0-9_-]+$/);
    assert.strictEqual(store.create('../../Nouméa lagoon').id, `${set.id}_2`);
    assert.strictEqual(store.get('../etc/passwd'), null);
    const file = path.join(dataDir, 'open-data-sets', `${set.id}.json`);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    fs.writeFileSync(file, JSON.stringify({ ...raw, futureField: 42, folder: '../../etc' }));
    const read = store.get(set.id);
    assert.ok(read);
    assert.strictEqual(read.folder, 'Open Data Charts');
    store.save({ ...read, unitIds: ['z9-492-288'] });
    const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    assert.strictEqual(saved.futureField, 42);
    assert.deepStrictEqual(saved.unitIds, ['z9-492-288']);
    assert.strictEqual(store.acknowledged(), false);
    store.acknowledge();
    assert.strictEqual(store.acknowledged(), true);
  });
});

// ---- Against a local HTTP server ----

interface Served {
  url: string;
  requests: string[];
  files: Map<string, Buffer>;
  /** Paths that fail once mid-body, to test resume. */
  breakOnce: Set<string>;
  close: () => Promise<void>;
}

function serve(): Promise<Served> {
  const files = new Map<string, Buffer>();
  const requests: string[] = [];
  const breakOnce = new Set<string>();
  const server = http.createServer((req, res) => {
    const url = req.url ?? '';
    requests.push(`${url} ${req.headers.range ?? ''}`);
    const body = files.get(url);
    if (!body) {
      res.writeHead(404).end();
      return;
    }
    const range = /^bytes=(\d+)-$/.exec(req.headers.range ?? '');
    const start = range ? Number(range[1]) : 0;
    const slice = body.subarray(start);
    res.writeHead(range ? 206 : 200, {
      'Content-Length': String(slice.length),
      ...(range
        ? {
            'Content-Range': `bytes ${String(start)}-${String(body.length - 1)}/${String(body.length)}`
          }
        : {})
    });
    if (breakOnce.delete(url)) {
      res.write(slice.subarray(0, Math.floor(slice.length / 2)));
      setTimeout(() => res.destroy(), 20);
      return;
    }
    res.end(slice);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${String(port)}`,
        requests,
        files,
        breakOnce,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections();
            server.close(() => {
              done();
            });
          })
      });
    });
  });
}

function sha256(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

describe('unit cache', () => {
  let server: Served;
  before(async () => {
    server = await serve();
  });
  after(async () => {
    await server.close();
  });

  it('resumes a broken download and checks its SHA-256', async () => {
    const body = crypto.randomBytes(256 * 1024);
    server.files.set('/u.mbtiles', body);
    server.breakOnce.add('/u.mbtiles');
    const cache = new UnitCache(tmpDir('cache'));
    const target = { url: `${server.url}/u.mbtiles`, size: body.length, sha256: sha256(body) };
    const file = await cache.ensure('units', 'z9-1-1', 'v1', target);
    assert.deepStrictEqual(fs.readFileSync(file), body);
    assert.ok(
      server.requests.some((r) => r.includes('bytes=')),
      'the retry resumed by Range'
    );
    assert.ok(fs.existsSync(path.join(cache.root, 'CACHEDIR.TAG')));

    await assert.rejects(
      cache.ensure('units', 'z9-1-2', 'v1', { ...target, sha256: 'c'.repeat(64) }),
      /checksum/
    );
    assert.strictEqual(cache.has('units', 'z9-1-2', 'v1'), false);
    assert.deepStrictEqual(fs.readdirSync(path.join(cache.root, 'units')), ['z9-1-1.v1.mbtiles']);

    assert.deepStrictEqual(cache.prune(new Set()), ['z9-1-1.v1.mbtiles']);
  });

  it('shares one download between callers, and keeps a partial download prune is told to', async () => {
    const body = crypto.randomBytes(64 * 1024);
    server.files.set('/shared.mbtiles', body);
    const before = server.requests.filter((r) => r.startsWith('/shared.mbtiles')).length;
    const dataDir = tmpDir('cache-shared');
    const target = { url: `${server.url}/shared.mbtiles`, size: body.length, sha256: sha256(body) };
    const files = await Promise.all([
      new UnitCache(dataDir).ensure('units', 'z9-2-2', 'v1', target),
      new UnitCache(dataDir).ensure('units', 'z9-2-2', 'v1', target)
    ]);
    assert.strictEqual(files[0], files[1]);
    assert.deepStrictEqual(fs.readFileSync(files[0]), body);
    assert.strictEqual(
      server.requests.filter((r) => r.startsWith('/shared.mbtiles')).length - before,
      1
    );

    const cache = new UnitCache(dataDir);
    fs.writeFileSync(`${cache.file('units', 'z9-2-3', 'v1')}.part`, 'partial');
    const removed = cache.prune(new Set([UnitCache.partKey('units', 'z9-2-3', 'v1')]));
    assert.deepStrictEqual(removed, ['z9-2-2.v1.mbtiles']);
    assert.ok(fs.existsSync(`${cache.file('units', 'z9-2-3', 'v1')}.part`));
  });
});

describe('building a set from a local index', () => {
  let server: Served;
  before(async () => {
    server = await serve();
  });
  after(async () => {
    await server.close();
  });

  it('downloads, builds, updates one unit and removes one', async () => {
    const dir = tmpDir('service');
    const dataDir = path.join(dir, 'data');
    const chartPath = path.join(dir, 'charts');
    fs.mkdirSync(chartPath, { recursive: true });
    const publish = (id: string, version: string, rows: TileRow[]): OpenDataUnit => {
      const file = path.join(dir, `${id}.${version}.mbtiles`);
      writeMbtiles(file, rows, ['DEPARE']);
      const body = fs.readFileSync(file);
      const urlPath = `/units/${id}.${version}.mbtiles`;
      server.files.set(urlPath, body);
      return unit(id, version, {
        url: `${server.url}${urlPath}`,
        size: body.length,
        sha256: sha256(body)
      });
    };
    const a1 = publish('z9-492-288', 'v1', unitTiles(492, 288, 'v1'));
    const b1 = publish('z9-493-288', 'v1', unitTiles(493, 288, 'v1'));
    let units = [a1, b1];
    server.files.set('/index.json', Buffer.from('{}'));
    const publishIndex = (): void => {
      server.files.set(
        '/index.json',
        Buffer.from(JSON.stringify({ schemaVersion: 1, ...indexOf(units) }))
      );
    };
    publishIndex();

    const changes: { written?: string; removed?: string }[] = [];
    const odc = new OpenDataCharts({
      dataDir,
      indexUrl: `${server.url}/index.json`,
      chartPath: () => chartPath,
      debug: () => {},
      error: () => {},
      mayRunBackground: () => true,
      chartsChanged: (change) => {
        changes.push(change);
        return Promise.resolve();
      }
    });
    const waitForRun = async (id: string): Promise<string> => {
      for (;;) {
        const progress = odc.decorate(odc.sets.get(id) as OpenDataSet).progress;
        if (progress && ['completed', 'failed', 'cancelled'].includes(progress.phase)) {
          assert.strictEqual(progress.phase, 'completed', progress.message);
          return progress.message;
        }
        await new Promise((r) => setTimeout(r, 20));
      }
    };

    const created = odc.sets.create('Nouméa');
    const set = { ...created, unitIds: [a1.id, b1.id] };
    odc.sets.save(set);
    assert.throws(() => {
      odc.startBuild(set);
    }, /not for navigation/);
    odc.sets.acknowledge();
    odc.startBuild(set);
    await waitForRun(set.id);
    const chart = path.join(chartPath, 'Open Data Charts', 'Nouméa.mbtiles');
    assert.ok(fs.existsSync(chart));
    assert.deepStrictEqual(changes.pop(), {
      written: path.join('Open Data Charts', 'Nouméa.mbtiles')
    });
    let decorated = odc.decorate(odc.sets.get(set.id) as OpenDataSet);
    assert.strictEqual(decorated.status, 'up_to_date');
    assert.ok(decorated.units.every((u) => u.diskBytes > 0));
    assert.strictEqual(readMetadata(chart).name, 'Nouméa (not for navigation)');

    // A new version of one unit.
    const b2 = publish('z9-493-288', 'v2', unitTiles(493, 288, 'v2'));
    units = [a1, { ...b2, changes: 'Seamarks updated' }];
    publishIndex();
    await odc.index.refresh();
    decorated = odc.decorate(odc.sets.get(set.id) as OpenDataSet);
    assert.strictEqual(decorated.status, 'update_available');
    assert.deepStrictEqual(
      decorated.updates.map((u) => u.changes),
      ['Seamarks updated']
    );
    server.requests.length = 0;
    odc.startBuild(odc.sets.get(set.id) as OpenDataSet);
    await waitForRun(set.id);
    assert.deepStrictEqual(
      server.requests.filter((r) => r.startsWith('/units/')).map((r) => r.trim()),
      ['/units/z9-493-288.v2.mbtiles'],
      'only the changed unit is downloaded'
    );
    const tiles = readTiles(chart);
    assert.strictEqual(tiles.get('9/493/223'), '493-288@v2');
    assert.strictEqual(tiles.get('9/492/223'), '492-288@v1');
    // The old version of the changed unit is no longer used by any set.
    assert.strictEqual(odc.cache.has('units', b1.id, 'v1'), false);

    // Taking a unit out and applying removes its rows.
    odc.sets.save({ ...(odc.sets.get(set.id) as OpenDataSet), unitIds: [a1.id] });
    odc.startBuild(odc.sets.get(set.id) as OpenDataSet);
    await waitForRun(set.id);
    assert.ok([...readTiles(chart).values()].every((d) => d === '492-288@v1'));
    assert.strictEqual(odc.cache.has('units', b2.id, 'v2'), false);

    // Renaming the set renames its chart.
    const renamed = await odc.rename(odc.sets.get(set.id) as OpenDataSet, 'Lagoon');
    assert.strictEqual(renamed.chartFile, path.join('Open Data Charts', 'Lagoon.mbtiles'));
    assert.ok(!fs.existsSync(chart));
    assert.strictEqual(
      readMetadata(path.join(chartPath, renamed.chartFile)).name,
      'Lagoon (not for navigation)'
    );
  });

  const shadingFixture = async (prefix: string) => {
    const dir = tmpDir(prefix);
    const dataDir = path.join(dir, 'data');
    const chartPath = path.join(dir, 'charts');
    fs.mkdirSync(chartPath, { recursive: true });
    const serveFile = (name: string, rows: TileRow[]) => {
      const file = path.join(dir, name);
      writeMbtiles(file, rows, ['DEPARE'], 'table');
      const body = fs.readFileSync(file);
      server.files.set(`/${prefix}/${name}`, body);
      return { url: `${server.url}/${prefix}/${name}`, size: body.length, sha256: sha256(body) };
    };
    const land = serveFile('z9-492-288.v1.mbtiles', unitTiles(492, 288, 'v1'));
    const shade = serveFile('z9-492-288.v1.hillshade.mbtiles', unitTiles(492, 288, 'shade', 12));
    const sea = serveFile('z9-493-288.v1.mbtiles', unitTiles(493, 288, 'v1'));
    const units = [
      unit('z9-492-288', 'v1', { ...land, hillshade: { ...shade, minzoom: 9, maxzoom: 12 } }),
      unit('z9-493-288', 'v1', sea)
    ];
    server.files.set(
      `/${prefix}/index.json`,
      Buffer.from(JSON.stringify({ schemaVersion: 1, ...indexOf(units) }))
    );
    const changes: { written?: string; removed?: string }[] = [];
    const odc = new OpenDataCharts({
      dataDir,
      indexUrl: `${server.url}/${prefix}/index.json`,
      chartPath: () => chartPath,
      debug: () => {},
      error: () => {},
      mayRunBackground: () => true,
      chartsChanged: (change) => {
        changes.push(change);
        return Promise.resolve();
      }
    });
    const finish = async (id: string): Promise<{ phase: string; message: string }> => {
      odc.startBuild(odc.sets.get(id) as OpenDataSet);
      for (;;) {
        const progress = odc.decorate(odc.sets.get(id) as OpenDataSet).progress;
        if (progress && ['completed', 'failed', 'cancelled'].includes(progress.phase)) {
          return progress;
        }
        await new Promise((r) => setTimeout(r, 20));
      }
    };

    const build = async (id: string): Promise<void> => {
      const progress = await finish(id);
      assert.strictEqual(progress.phase, 'completed', progress.message);
    };
    await odc.index.refresh();
    fs.mkdirSync(dataDir, { recursive: true });
    odc.sets.acknowledge();
    return { odc, chartPath, changes, units, shade, build, finish };
  };

  it('builds the terrain shading beside the chart, renames it and takes it out', async () => {
    const { odc, chartPath, changes, units, shade, build } = await shadingFixture('shading');
    const set = { ...odc.sets.create('Nouméa'), unitIds: units.map((u) => u.id) };
    odc.sets.save(set);
    assert.strictEqual(odc.decorate(set).shadingBytes, shade.size);
    await build(set.id);

    const shadingFile = path.join('Open Data Charts', 'Nouméa_terrain_shading.mbtiles');
    const shading = path.join(chartPath, shadingFile);
    assert.deepStrictEqual(
      changes.map((c) => c.written),
      [path.join('Open Data Charts', 'Nouméa.mbtiles'), shadingFile]
    );
    const tiles = readTiles(shading);
    assert.strictEqual(tiles.get('12/3936/1791'), '492-288@shade');
    assert.ok([...tiles.values()].every((d) => d === '492-288@shade'));
    const meta = readMetadata(shading);
    assert.strictEqual(meta.format, 'webp');
    assert.strictEqual(meta.type, 'overlay');
    assert.strictEqual(meta.maxzoom, '12');
    assert.strictEqual(meta.name, 'Nouméa terrain shading (not for navigation)');
    assert.ok(Number(meta.scale) < 250000, 'drawn over the vector chart');
    let decorated = odc.decorate(odc.sets.get(set.id) as OpenDataSet);
    assert.strictEqual(decorated.status, 'up_to_date');
    assert.strictEqual(decorated.shadingFile, shadingFile);

    const renamed = await odc.rename(odc.sets.get(set.id) as OpenDataSet, 'Lagoon');
    assert.strictEqual(
      renamed.shadingFile,
      path.join('Open Data Charts', 'Lagoon_terrain_shading.mbtiles')
    );
    assert.ok(!fs.existsSync(shading));
    assert.strictEqual(odc.cache.has('hillshade', 'z9-492-288', 'v1'), true);

    changes.length = 0;
    odc.sets.save({ ...renamed, terrain: false });
    decorated = odc.decorate(odc.sets.get(set.id) as OpenDataSet);
    assert.strictEqual(decorated.status, 'changed');
    await build(set.id);
    assert.deepStrictEqual(changes, [{ removed: renamed.shadingFile }]);
    assert.ok(!fs.existsSync(path.join(chartPath, renamed.shadingFile ?? '')));
    const after = odc.sets.get(set.id) as OpenDataSet;
    assert.strictEqual(after.shadingFile, null);
    assert.deepStrictEqual(after.shaded, {});
    assert.strictEqual(odc.cache.has('hillshade', 'z9-492-288', 'v1'), false);
  });
  it('names the shading apart from a long-named chart', async () => {
    const { odc, chartPath, units, build } = await shadingFixture('long-name');
    const name = `${'a'.repeat(84)} terrain shading`;
    const set = { ...odc.sets.create(name), unitIds: units.map((u) => u.id) };
    odc.sets.save(set);
    await build(set.id);
    const built = odc.sets.get(set.id) as OpenDataSet;
    assert.notStrictEqual(built.shadingFile, built.chartFile);
    assert.strictEqual(readMetadata(path.join(chartPath, built.chartFile ?? '')).format, 'pbf');
    assert.strictEqual(readMetadata(path.join(chartPath, built.shadingFile ?? '')).format, 'webp');
  });

  it("leaves another chart in the shading's place alone", async () => {
    const { odc, chartPath, units, finish } = await shadingFixture('foreign');
    const folder = path.join(chartPath, 'Open Data Charts');
    fs.mkdirSync(folder, { recursive: true });
    const other = path.join(folder, 'Lagoon_terrain_shading.mbtiles');
    fs.writeFileSync(other, 'another set');
    const set = { ...odc.sets.create('Lagoon'), unitIds: units.map((u) => u.id) };
    odc.sets.save(set);
    const progress = await finish(set.id);
    assert.strictEqual(progress.phase, 'failed');
    assert.match(progress.message, /Lagoon_terrain_shading\.mbtiles already exists/);
    assert.strictEqual(fs.readFileSync(other, 'utf8'), 'another set');
    assert.ok(!fs.existsSync(path.join(folder, 'Lagoon.mbtiles')));
  });

  it('keeps both charts when the shading cannot take the new name', async () => {
    const { odc, chartPath, units, build } = await shadingFixture('rename-clash');
    const set = { ...odc.sets.create('Lagoon'), unitIds: units.map((u) => u.id) };
    odc.sets.save(set);
    await build(set.id);
    const built = odc.sets.get(set.id) as OpenDataSet;
    const folder = path.join(chartPath, 'Open Data Charts');
    fs.writeFileSync(path.join(folder, 'Reef_terrain_shading.mbtiles'), 'another set');
    await assert.rejects(odc.rename(built, 'Reef'), /Reef_terrain_shading\.mbtiles already exists/);
    assert.deepStrictEqual(odc.sets.get(set.id), built);
    assert.ok(fs.existsSync(path.join(chartPath, built.chartFile ?? '')));
    assert.ok(fs.existsSync(path.join(chartPath, built.shadingFile ?? '')));
    assert.ok(!fs.existsSync(path.join(folder, 'Reef.mbtiles')));
  });
  it('never lets the shading take the place of the set’s own chart', async () => {
    const { odc, chartPath, units, build, finish } = await shadingFixture('own-place');
    const set = {
      ...odc.sets.create('Lagoon terrain shading'),
      unitIds: units.map((u) => u.id),
      terrain: false
    };
    odc.sets.save(set);
    await build(set.id);
    const built = odc.sets.get(set.id) as OpenDataSet;
    fs.rmSync(path.join(chartPath, built.chartFile ?? ''));
    const renamed = await odc.rename(built, 'Lagoon');
    assert.strictEqual(renamed.chartFile, built.chartFile);
    odc.sets.save({ ...renamed, terrain: true });
    const progress = await finish(set.id);
    assert.strictEqual(progress.phase, 'failed');
    assert.match(progress.message, /would replace its chart Lagoon_terrain_shading\.mbtiles/);
  });
});
