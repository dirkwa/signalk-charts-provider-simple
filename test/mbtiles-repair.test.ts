/**
 * Tests for the "repair broken MBTiles metadata" feature: deriving
 * bounds/zoom/format/tileSize from the tiles table, surfacing dropped
 * charts as repairable, and persisting the derived metadata back into the
 * file so the chart loads. Also covers tile-derived bounds for charts that
 * straddle the antimeridian.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';

import { antimeridianSpan, open, tileRangeToBounds } from '../dist/utils/mbtiles-reader.js';
import { repairMbtilesMetadata } from '../dist/utils/mbtiles-metadata.js';
import { findCharts, findRepairableCharts } from '../dist/charts-loader.js';

// A minimal valid 1x1 PNG (same bytes the fixture builder uses). IHDR width
// at offset 16 is 0x00000001 → readUInt32BE(16) === 1.
const PNG_1x1 = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82
]);

/** A PNG header whose IHDR encodes the given square width (no valid body). */
function pngHeaderWithWidth(width: number): Buffer {
  const b = Buffer.from(PNG_1x1);
  b.writeUInt32BE(width, 16); // width
  b.writeUInt32BE(width, 20); // height
  return b;
}

interface TileSpec {
  z: number;
  col: number;
  row: number;
  data?: Buffer;
}

interface BuildOpts {
  metadata?: Record<string, string>;
  /** Raw metadata rows, allowing duplicate names (the table has no UNIQUE constraint). */
  metadataRows?: { name: string; value: string }[];
  tiles?: TileSpec[];
  /** When true, omit the tiles table entirely. */
  noTilesTable?: boolean;
}

/** Build a throwaway .mbtiles in a temp dir and return its path. */
function buildMbtiles(dir: string, filename: string, opts: BuildOpts): string {
  const filePath = path.join(dir, filename);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
  const db = new DatabaseSync(filePath);
  db.exec('CREATE TABLE metadata (name TEXT, value TEXT);');
  if (!opts.noTilesTable) {
    db.exec(
      'CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB);'
    );
  }
  const insMeta = db.prepare('INSERT INTO metadata (name, value) VALUES (?, ?)');
  for (const [name, value] of Object.entries(opts.metadata ?? {})) {
    insMeta.run(name, value);
  }
  for (const row of opts.metadataRows ?? []) {
    insMeta.run(row.name, row.value);
  }
  if (!opts.noTilesTable) {
    const insTile = db.prepare(
      'INSERT INTO tiles (zoom_level, tile_column, tile_row, tile_data) VALUES (?, ?, ?, ?)'
    );
    for (const t of opts.tiles ?? []) {
      insTile.run(t.z, t.col, t.row, t.data ?? PNG_1x1);
    }
  }
  db.close();
  return filePath;
}

describe('tileRangeToBounds (pure)', () => {
  it('derives full-world bounds at z0 from a single tile', () => {
    const b = tileRangeToBounds(0, 0, 0, 0, 0);
    assert.ok(Math.abs(b[0] - -180) < 1e-3, `west ${b[0]}`);
    assert.ok(Math.abs(b[1] - -85.0511) < 1e-3, `south ${b[1]}`);
    assert.ok(Math.abs(b[2] - 180) < 1e-3, `east ${b[2]}`);
    assert.ok(Math.abs(b[3] - 85.0511) < 1e-3, `north ${b[3]}`);
  });

  it('derives full-world bounds at z9 from the complete grid', () => {
    const b = tileRangeToBounds(9, 0, 511, 0, 511);
    assert.ok(Math.abs(b[0] - -180) < 1e-3);
    assert.ok(Math.abs(b[1] - -85.0511) < 1e-3);
    assert.ok(Math.abs(b[2] - 180) < 1e-3);
    assert.ok(Math.abs(b[3] - 85.0511) < 1e-3);
  });

  it('flips TMS→XYZ: high TMS row is the northern hemisphere', () => {
    // z1, the single NW tile in TMS is col 0, row 1.
    const b = tileRangeToBounds(1, 0, 0, 1, 1);
    // west -180, east 0 (meridian), and a positive (northern) latitude band.
    assert.ok(Math.abs(b[0] - -180) < 1e-3, `west ${b[0]}`);
    assert.ok(Math.abs(b[2] - 0) < 1e-3, `east ${b[2]}`);
    assert.ok(b[1] >= -1e-6, `south should be >= 0 (equator), got ${b[1]}`);
    assert.ok(b[3] > 80, `north should be ~85, got ${b[3]}`);
  });

  it('handles a non-square regional range', () => {
    // z9, cols 100..103 (4 wide), TMS rows 200..205 (6 tall).
    const b = tileRangeToBounds(9, 100, 103, 200, 205);
    const lon = (col: number): number => (col / 512) * 360 - 180;
    const lat = (xyz: number): number =>
      (Math.atan(Math.sinh(Math.PI * (1 - (2 * xyz) / 512))) * 180) / Math.PI;
    assert.ok(Math.abs(b[0] - lon(100)) < 1e-6, 'west');
    assert.ok(Math.abs(b[2] - lon(104)) < 1e-6, 'east edge = col+1');
    // northern edge = highest TMS row → xyzTop = 511-205 = 306
    assert.ok(Math.abs(b[3] - lat(306)) < 1e-6, 'north');
    // southern edge = lowest TMS row → xyzBottom = 511-200 = 311, +1 = 312
    assert.ok(Math.abs(b[1] - lat(312)) < 1e-6, 'south');
    assert.ok(b[2] > b[0] && b[3] > b[1], 'box is well-ordered');
  });
});

describe('MBTilesReader repair helpers', () => {
  let dir: string;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mbtiles-repair-'));
  });
  after(() => {
    // On Windows the node:sqlite file handle can linger briefly after
    // close(), so an immediate recursive rm hits EPERM. Retry, and never
    // let a teardown failure fail the suite — a leaked temp dir is harmless.
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    } catch {
      /* best-effort temp cleanup */
    }
  });

  it('hasTiles / getZoomRangeFromTiles / deriveBoundsFromTiles', async () => {
    const file = buildMbtiles(dir, 'helpers.mbtiles', {
      metadata: { name: 'Helpers' },
      tiles: [
        { z: 0, col: 0, row: 0 },
        { z: 1, col: 0, row: 1 },
        { z: 1, col: 1, row: 1 }
      ]
    });
    const reader = await open(file);
    try {
      assert.strictEqual(reader.hasTiles(), true);
      assert.deepStrictEqual(reader.getZoomRangeFromTiles(), { minzoom: 0, maxzoom: 1 });
      const bounds = reader.deriveBoundsFromTiles();
      assert.ok(Array.isArray(bounds) && bounds.length === 4);
    } finally {
      reader.close();
    }
  });

  it('hasTiles is false when there is no tiles table', async () => {
    const file = buildMbtiles(dir, 'no-tiles.mbtiles', {
      metadata: { name: 'Empty' },
      noTilesTable: true
    });
    const reader = await open(file);
    try {
      assert.strictEqual(reader.hasTiles(), false);
      assert.strictEqual(reader.getZoomRangeFromTiles(), null);
      assert.strictEqual(reader.deriveBoundsFromTiles(), null);
    } finally {
      reader.close();
    }
  });

  it('sniffFormatFromTiles detects png, jpg, pbf(gzip), webp', async () => {
    const cases: { name: string; magic: Buffer; expect: string }[] = [
      { name: 'png', magic: PNG_1x1, expect: 'png' },
      { name: 'jpg', magic: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]), expect: 'jpg' },
      { name: 'pbf', magic: Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0, 0, 0, 0]), expect: 'pbf' },
      {
        name: 'webp',
        magic: Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]),
        expect: 'webp'
      }
    ];
    for (const c of cases) {
      const file = buildMbtiles(dir, `sniff-${c.name}.mbtiles`, {
        metadata: { name: c.name },
        tiles: [{ z: 0, col: 0, row: 0, data: c.magic }]
      });
      const reader = await open(file);
      try {
        assert.strictEqual(reader.sniffFormatFromTiles(), c.expect, c.name);
      } finally {
        reader.close();
      }
    }
  });

  it('getTilePixelSize reads PNG IHDR (256 and 512), undefined for non-PNG', async () => {
    const f256 = buildMbtiles(dir, 'px256.mbtiles', {
      tiles: [{ z: 0, col: 0, row: 0, data: pngHeaderWithWidth(256) }]
    });
    const f512 = buildMbtiles(dir, 'px512.mbtiles', {
      tiles: [{ z: 0, col: 0, row: 0, data: pngHeaderWithWidth(512) }]
    });
    const fjpg = buildMbtiles(dir, 'pxjpg.mbtiles', {
      tiles: [
        {
          z: 0,
          col: 0,
          row: 0,
          data: Buffer.from([
            0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0
          ])
        }
      ]
    });
    let r = await open(f256);
    try {
      assert.strictEqual(r.getTilePixelSize(), 256);
    } finally {
      r.close();
    }
    r = await open(f512);
    try {
      assert.strictEqual(r.getTilePixelSize(), 512);
    } finally {
      r.close();
    }
    r = await open(fjpg);
    try {
      assert.strictEqual(r.getTilePixelSize(), undefined);
    } finally {
      r.close();
    }
  });
});

describe('findRepairableCharts + repair round-trip', () => {
  let dir: string;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mbtiles-repair-loader-'));
  });
  after(() => {
    // On Windows the node:sqlite file handle can linger briefly after
    // close(), so an immediate recursive rm hits EPERM. Retry, and never
    // let a teardown failure fail the suite — a leaked temp dir is harmless.
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    } catch {
      /* best-effort temp cleanup */
    }
  });

  const BROKEN_TILES: TileSpec[] = [
    { z: 0, col: 0, row: 0 },
    { z: 1, col: 0, row: 0 },
    { z: 1, col: 0, row: 1 },
    { z: 1, col: 1, row: 0 },
    { z: 1, col: 1, row: 1 }
  ];

  it('drops a no-bounds chart but surfaces it as repairable', async () => {
    const sub = fs.mkdtempSync(path.join(dir, 'scan-'));
    buildMbtiles(sub, 'broken.mbtiles', {
      metadata: { name: 'Broken World', version: '1' }, // no bounds
      tiles: BROKEN_TILES
    });

    const loaded = await findCharts(sub);
    assert.strictEqual(Object.keys(loaded).length, 0, 'loader drops the no-bounds chart');

    const repairable = await findRepairableCharts(sub);
    assert.strictEqual(repairable.length, 1);
    const rc = repairable[0];
    assert.strictEqual(rc.reason, 'missing_bounds');
    assert.strictEqual(rc.hasTiles, true);
    assert.strictEqual(rc.relativePath, 'broken.mbtiles');
    assert.ok(rc.derived, 'derived metadata present');
    assert.deepStrictEqual([rc.derived.minzoom, rc.derived.maxzoom], [0, 1], 'derived zoom range');
    assert.strictEqual(rc.derived.format, 'png');
  });

  it('a chart with no tiles is NOT repairable', async () => {
    const sub = fs.mkdtempSync(path.join(dir, 'notiles-'));
    buildMbtiles(sub, 'empty.mbtiles', {
      metadata: { name: 'Empty' }, // no bounds, no tiles
      tiles: []
    });
    assert.strictEqual((await findRepairableCharts(sub)).length, 0);
  });

  it('repairs the file: derived metadata written, then loads and is no longer repairable', async () => {
    const sub = fs.mkdtempSync(path.join(dir, 'roundtrip-'));
    const file = buildMbtiles(sub, 'fixme.mbtiles', {
      metadata: { name: 'Fix Me' },
      tiles: BROKEN_TILES
    });

    const before = await findRepairableCharts(sub);
    assert.strictEqual(before.length, 1);
    const derived = before[0].derived;
    assert.ok(derived);

    const result = await repairMbtilesMetadata(file, derived);
    assert.strictEqual(result.ok, true);
    assert.ok(result.written.includes('bounds'), 'bounds written');

    // Re-read: bounds now present and equal to the derived value.
    const reader = await open(file);
    try {
      const info = reader.getInfo();
      assert.ok(Array.isArray(info.bounds) && info.bounds.length === 4, 'bounds persisted');
      assert.deepStrictEqual(info.bounds, derived.bounds);
      assert.strictEqual(info.minzoom, 0);
      assert.strictEqual(info.maxzoom, 1);
    } finally {
      reader.close();
    }

    // Now it loads, and is no longer listed as repairable.
    const loaded = await findCharts(sub);
    assert.strictEqual(Object.keys(loaded).length, 1, 'repaired chart loads');
    assert.strictEqual((await findRepairableCharts(sub)).length, 0);

    // Idempotent: a second repair writes nothing.
    const again = await repairMbtilesMetadata(file, derived);
    assert.strictEqual(again.ok, true);
    assert.strictEqual(again.written.length, 0, 'nothing left to write');
    assert.ok(again.skipped.includes('bounds'));
  });

  it('only fills absent fields — never clobbers a present value', async () => {
    const sub = fs.mkdtempSync(path.join(dir, 'absent-'));
    // bounds missing, but a deliberately wrong-but-present minzoom.
    const file = buildMbtiles(sub, 'partial.mbtiles', {
      metadata: { name: 'Partial', minzoom: '99' },
      tiles: BROKEN_TILES
    });

    const repairable = await findRepairableCharts(sub);
    const derived = repairable[0]?.derived;
    assert.ok(derived);

    const result = await repairMbtilesMetadata(file, derived);
    assert.strictEqual(result.ok, true);
    assert.ok(result.written.includes('bounds'), 'bounds written');
    assert.ok(result.skipped.includes('minzoom'), 'minzoom kept');

    const reader = await open(file);
    try {
      // The pre-existing (wrong) minzoom is preserved, not overwritten.
      assert.strictEqual(reader.getInfo().minzoom, 99);
    } finally {
      reader.close();
    }
  });

  // The table has no UNIQUE constraint, so a key can have both an empty and
  // a non-empty row. "Any non-empty = present" must skip the key regardless
  // of row order — the inverse (non-empty→empty) order is the one a naive
  // last-row-wins read would get wrong, so both orders are exercised.
  for (const order of ['empty-first', 'non-empty-first'] as const) {
    it(`is deterministic when metadata has duplicate name rows (${order})`, async () => {
      const sub = fs.mkdtempSync(path.join(dir, `dupes-${order}-`));
      const rows =
        order === 'empty-first'
          ? [
              { name: 'format', value: '' },
              { name: 'format', value: 'jpg' }
            ]
          : [
              { name: 'format', value: 'jpg' },
              { name: 'format', value: '' }
            ];
      const file = buildMbtiles(sub, 'dupes.mbtiles', {
        metadata: { name: 'Dupes' },
        metadataRows: rows,
        tiles: BROKEN_TILES
      });

      const repairable = await findRepairableCharts(sub);
      const derived = repairable[0]?.derived;
      assert.ok(derived);

      const result = await repairMbtilesMetadata(file, derived);
      assert.strictEqual(result.ok, true);
      assert.ok(result.written.includes('bounds'), 'bounds written');
      assert.ok(
        result.skipped.includes('format'),
        'present (non-empty) format kept, not duplicated'
      );

      // No third format row was inserted — the two seeded rows are unchanged.
      const db = new DatabaseSync(file, { readOnly: true });
      try {
        const countRow = db
          .prepare("SELECT COUNT(*) AS n FROM metadata WHERE name = 'format'")
          .get() as { n: number };
        assert.strictEqual(countRow.n, 2, 'no duplicate format row inserted');
      } finally {
        db.close();
      }
    });
  }

  it('surfaces and repairs an uppercase .MBTILES file', async () => {
    const sub = fs.mkdtempSync(path.join(dir, 'upper-'));
    const file = buildMbtiles(sub, 'WORLD.MBTILES', {
      metadata: { name: 'Upper' },
      tiles: BROKEN_TILES
    });

    const repairable = await findRepairableCharts(sub);
    assert.strictEqual(repairable.length, 1, 'uppercase ext is discovered');
    assert.strictEqual(repairable[0].relativePath, 'WORLD.MBTILES');

    const result = await repairMbtilesMetadata(file, repairable[0].derived!);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(Object.keys(await findCharts(sub)).length, 1, 'repaired uppercase loads');
  });
});

describe('antimeridianSpan (pure)', () => {
  const lon = (z: number, col: number): number => (col / 2 ** z) * 360 - 180;

  it('spans a tile set on both sides of the antimeridian with west > east', () => {
    // The Fiji packs at z17: columns 0..662 and 129110..131071.
    const span = antimeridianSpan(17, 662, 129110);
    assert.ok(span);
    assert.deepStrictEqual(span, [lon(17, 129110), lon(17, 663)]);
    assert.ok(span[0] > span[1], 'west > east');
  });

  it('is null when a hemisphere has no tiles', () => {
    assert.strictEqual(antimeridianSpan(5, null, 20), null);
    assert.strictEqual(antimeridianSpan(5, 3, null), null);
    // z0 has a single column, which lies west of 0°.
    assert.strictEqual(antimeridianSpan(0, 0, null), null);
  });

  it('is null when the tiles run continuously across 0°', () => {
    assert.strictEqual(antimeridianSpan(5, 15, 16), null);
  });

  it('is null when the empty run across 0° is under half the world', () => {
    // 14 empty columns of 32: the crossing box would be wider than 180°.
    assert.strictEqual(antimeridianSpan(5, 5, 20), null);
  });

  it('spans the tiles when the empty run across 0° is exactly half the world', () => {
    assert.deepStrictEqual(antimeridianSpan(5, 7, 24), [lon(5, 24), lon(5, 8)]);
  });
});

describe('antimeridian bounds from tiles', () => {
  let dir: string;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mbtiles-antimeridian-'));
  });
  after(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    } catch {
      /* best-effort temp cleanup */
    }
  });

  const row = (z: number, cols: number[], tmsRow: number): TileSpec[] =>
    cols.map((col) => ({ z, col, row: tmsRow }));

  // z5 columns are 11.25° wide: 30..31 are 157.5°E..180°, 0..1 are 180°..157.5°W.
  // The z3 tiles check that the extent comes from maxzoom.
  const CROSSING_TILES = [...row(3, [0, 7], 3), ...row(5, [0, 1, 30, 31], 12)];
  const WORLD_TILES = row(2, [0, 1, 2, 3], 1);
  const ORDINARY_TILES = row(5, [20, 21, 22], 12);
  // Both hemispheres, but only 14 of 32 columns empty across 0°.
  const WIDE_TILES = row(5, [0, 1, 2, 3, 4, 5, 20, 25, 31], 12);

  async function derived(name: string, tiles: TileSpec[]): Promise<number[] | null> {
    const file = buildMbtiles(dir, `${name}.mbtiles`, { metadata: { name }, tiles });
    const reader = await open(file);
    try {
      return reader.deriveBoundsFromTiles();
    } finally {
      reader.close();
    }
  }

  async function publishedBounds(
    name: string,
    bounds: string,
    tiles: TileSpec[]
  ): Promise<number[] | undefined> {
    const sub = fs.mkdtempSync(path.join(dir, `${name}-`));
    buildMbtiles(sub, `${name}.mbtiles`, { metadata: { name, bounds, format: 'png' }, tiles });
    const charts = await findCharts(sub);
    try {
      return charts[name]?.bounds;
    } finally {
      for (const chart of Object.values(charts)) {
        chart._mbtilesHandle?.close();
      }
    }
  }

  describe('deriveBoundsFromTiles', () => {
    it('gives west > east for a tile set on both sides of the antimeridian', async () => {
      const b = await derived('crossing', CROSSING_TILES);
      assert.ok(b);
      assert.deepStrictEqual([b[0], b[2]], [157.5, -157.5]);
      assert.ok(b[1] < b[3], 'south < north');
    });

    it('keeps the full width for a genuinely world-wide tile set', async () => {
      const b = await derived('world', WORLD_TILES);
      assert.ok(b);
      assert.deepStrictEqual([b[0], b[2]], [-180, 180]);
    });

    it('keeps the full width when the crossing box would exceed 180°', async () => {
      const b = await derived('wide', WIDE_TILES);
      assert.ok(b);
      assert.deepStrictEqual([b[0], b[2]], [-180, 180]);
    });

    it('is unchanged for an ordinary tile set', async () => {
      const b = await derived('ordinary', ORDINARY_TILES);
      assert.ok(b);
      assert.deepStrictEqual([b[0], b[2]], [45, 78.75]);
    });
  });

  describe('published MBTiles bounds', () => {
    it('replaces full-width metadata bounds with the crossing extent of the tiles', async () => {
      const b = await publishedBounds('fiji', '-180,-21.94,180,-11.18', CROSSING_TILES);
      assert.deepStrictEqual(b, [157.5, -21.94, -157.5, -11.18]);
    });

    it('keeps full-width metadata bounds when the tiles fill the width', async () => {
      const b = await publishedBounds('globe', '-180,-85,180,85', WORLD_TILES);
      assert.deepStrictEqual(b, [-180, -85, 180, 85]);
    });

    it('keeps metadata bounds that already cross the antimeridian', async () => {
      const b = await publishedBounds('crossed', '160,-21.94,-160,-11.18', CROSSING_TILES);
      assert.deepStrictEqual(b, [160, -21.94, -160, -11.18]);
    });

    it('keeps ordinary metadata bounds', async () => {
      const b = await publishedBounds('plain', '45.1,-30,78.7,-20', ORDINARY_TILES);
      assert.deepStrictEqual(b, [45.1, -30, 78.7, -20]);
    });

    it('repairs a crossing chart with west > east bounds that load unchanged', async () => {
      const sub = fs.mkdtempSync(path.join(dir, 'repair-'));
      const file = buildMbtiles(sub, 'lau.mbtiles', {
        metadata: { name: 'Lau' },
        tiles: CROSSING_TILES
      });
      const repairable = await findRepairableCharts(sub);
      const fix = repairable[0]?.derived;
      assert.ok(fix);
      assert.deepStrictEqual([fix.bounds[0], fix.bounds[2]], [157.5, -157.5]);
      assert.strictEqual((await repairMbtilesMetadata(file, fix)).ok, true);

      const charts = await findCharts(sub);
      try {
        assert.deepStrictEqual(charts.lau?.bounds, fix.bounds);
      } finally {
        for (const chart of Object.values(charts)) {
          chart._mbtilesHandle?.close();
        }
      }
    });
  });
});
