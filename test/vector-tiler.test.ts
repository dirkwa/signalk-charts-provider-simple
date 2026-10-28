import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';

import { buildVectorMbtiles, groupSources, shardBytesForHeap } from '../dist/utils/vector-tiler.js';
import { _testInternals, tileProperties, tileShard } from '../dist/utils/vector-tile-shard.js';
import { withWorkerPool } from '../dist/utils/worker-pool.js';

type Position = [number, number];

function square(west: number, south: number, east: number, north: number): Position[][] {
  return [
    [
      [west, south],
      [east, south],
      [east, north],
      [west, north],
      [west, south]
    ]
  ];
}

function writeFC(file: string, features: unknown[]): void {
  fs.writeFileSync(file, JSON.stringify({ type: 'FeatureCollection', features }));
}

/** XYZ tile of a position. */
function tileOf(lon: number, lat: number, z: number): { x: number; y: number } {
  const n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const rad = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n);
  return { x, y };
}

function readTile(db: DatabaseSync, z: number, x: number, y: number): VectorTile | null {
  const row = db
    .prepare(
      'SELECT tile_data FROM tiles WHERE zoom_level = ? AND tile_column = ? AND tile_row = ?'
    )
    .get(z, x, 2 ** z - 1 - y) as { tile_data: Uint8Array } | undefined;
  return row ? new VectorTile(new PbfReader(zlib.gunzipSync(row.tile_data))) : null;
}

function readTileAt(db: DatabaseSync, lon: number, lat: number, z: number): VectorTile | null {
  const { x, y } = tileOf(lon, lat, z);
  return readTile(db, z, x, y);
}

describe('tileProperties', () => {
  it('joins list attributes, drops nulls, keeps scalars', () => {
    assert.deepStrictEqual(
      tileProperties({ COLOUR: ['1', '3'], DRVAL1: 2.5, OBJNAM: null, LIT: true, NAME: 'x' }),
      { COLOUR: '1,3', DRVAL1: 2.5, LIT: true, NAME: 'x' }
    );
  });
});

describe('tileShard', () => {
  let dir: string;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tile-shard-'));
  });
  after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function tileAll(file: string): Map<string, Buffer> {
    const tiles = new Map<string, Buffer>();
    tileShard(
      {
        files: [file],
        groups: [
          { layer: 'LNDARE', minzoom: 0, maxzoom: 5 },
          { layer: 'DEPARE', minzoom: 2, maxzoom: 6 }
        ],
        z: 0,
        x: 0,
        y: 0,
        extent: 4096,
        buffer: 64,
        gzip: false
      },
      (batch) => {
        for (const t of batch) {
          tiles.set(`${t.z}/${t.x}/${t.y}`, Buffer.from(t.data));
        }
      }
    );
    return tiles;
  }

  it('writes the same tiles when a shard is indexed in chunks', () => {
    const file = path.join(dir, 'shard.ndjson');
    const lines: string[] = [];
    for (let i = 0; i < 40; i++) {
      const west = -170 + i * 8;
      const feature = {
        type: 'Feature',
        properties: { n: i },
        geometry: { type: 'Polygon', coordinates: square(west, -40 + i, west + 5, -30 + i) }
      };
      lines.push(`${i % 2}\t${JSON.stringify(feature)}`);
    }
    fs.writeFileSync(file, lines.join('\n') + '\n');

    const whole = tileAll(file);
    const saved = _testInternals.limits.pendingChars;
    _testInternals.limits.pendingChars = 1;
    let chunked: Map<string, Buffer>;
    try {
      chunked = tileAll(file);
    } finally {
      _testInternals.limits.pendingChars = saved;
    }

    assert.ok(whole.size > 40);
    assert.deepStrictEqual([...chunked.keys()].sort(), [...whole.keys()].sort());
    for (const [key, data] of whole) {
      assert.ok(chunked.get(key)?.equals(data), `tile ${key} differs`);
    }
  });

  it('writes no vertex twice in a row where many land on one tile pixel', () => {
    // A coastline-like square with 2000 vertices along its south edge, a
    // sliver whose ring rounds to nothing at zoom 0, the south edge as a line,
    // and a line whose two vertices round to one pixel.
    const south: Position[] = [];
    for (let i = 0; i <= 2000; i++) {
      south.push([i * 0.005, 0]);
    }
    const coast = [[...south, [10, 10], [0, 10], [0, 0]]];
    const sliver = square(20, 20, 20.000001, 20.000001);
    const collapsedLine: Position[] = [
      [30, 30],
      [30.001, 30]
    ];
    const features = [
      { type: 'Polygon', coordinates: coast },
      { type: 'Polygon', coordinates: sliver },
      { type: 'LineString', coordinates: south },
      { type: 'LineString', coordinates: collapsedLine }
    ].map((geometry, n) => ({ type: 'Feature', properties: { n }, geometry }));
    const file = path.join(dir, 'shard.ndjson');
    fs.writeFileSync(file, features.map((f) => `0\t${JSON.stringify(f)}`).join('\n') + '\n');

    const tiles = new Map<string, Uint8Array>();
    tileShard(
      {
        files: [file],
        groups: [{ layer: 'LNDARE', minzoom: 0, maxzoom: 0 }],
        z: 0,
        x: 0,
        y: 0,
        extent: 4096,
        buffer: 64,
        gzip: false
      },
      (batch) => {
        for (const t of batch) {
          tiles.set(`${t.z}/${t.x}/${t.y}`, t.data);
        }
      }
    );
    const data = tiles.get('0/0/0');
    assert.ok(data);
    const layer = new VectorTile(new PbfReader(data)).layers.LNDARE;
    const kept = new Map<number, { x: number; y: number }[][]>();
    for (let i = 0; i < layer.length; i++) {
      const f = layer.feature(i);
      kept.set(Number(f.properties.n), f.loadGeometry());
    }

    assert.deepStrictEqual(
      [...kept.keys()].sort(),
      [0, 2],
      'the sliver and the collapsed line draw nothing and go'
    );
    for (const rings of kept.values()) {
      for (const ring of rings) {
        for (let i = 1; i < ring.length; i++) {
          const repeated = ring[i].x === ring[i - 1].x && ring[i].y === ring[i - 1].y;
          assert.ok(!repeated, `vertex ${i} repeats the one before it`);
        }
      }
    }
    // 2000 source vertices over 10 degrees cover about 114 pixels at zoom 0.
    assert.ok((kept.get(0)?.[0].length ?? 0) < 200);
  });

  it('with rootOnly, writes only its own tile and counts what reaches each child', () => {
    const features = [
      square(-100, 40, -90, 50), // north-west
      square(90, -50, 100, -40), // south-east
      square(-170, -60, 170, 60) // all four
    ].map((coordinates, n) => ({
      type: 'Feature',
      properties: { n, OBJNAM: 'Ærøskøbing' },
      geometry: { type: 'Polygon', coordinates }
    }));
    const lines = features.map((f) => `0\t${JSON.stringify(f)}`);
    const file = path.join(dir, 'root-only.ndjson');
    fs.writeFileSync(file, lines.join('\n') + '\n');

    const keys: string[] = [];
    const result = tileShard(
      {
        files: [file],
        groups: [{ layer: 'DEPARE', minzoom: 0, maxzoom: 4 }],
        z: 0,
        x: 0,
        y: 0,
        extent: 4096,
        buffer: 64,
        gzip: false,
        rootOnly: true
      },
      (batch) => {
        keys.push(...batch.map((t) => `${t.z}/${t.x}/${t.y}`));
      }
    );

    assert.deepStrictEqual(keys, ['0/0/0']);
    // In UTF-8 bytes, as the shard file holds them.
    const [nw, se, all] = lines.map((line) => Buffer.byteLength(line));
    assert.deepStrictEqual(result.quarters, [all + nw, all, all, all + se]);
  });

  it('with rootOnly, writes its tile as the full walk does', () => {
    const hole = square(-20, -10, 20, 10)[0].reverse();
    const geometries: unknown[] = [
      { type: 'Polygon', coordinates: [...square(-60, -40, 60, 40), hole] },
      {
        type: 'MultiPolygon',
        coordinates: [square(100, 10, 120, 30), square(-120, -30, -100, -10)]
      },
      {
        type: 'LineString',
        coordinates: [
          [-170, 0],
          [170, 5]
        ]
      },
      {
        type: 'MultiLineString',
        coordinates: [
          [
            [0, 70],
            [10, 75]
          ],
          [
            [-50, -70],
            [-40, -75]
          ]
        ]
      },
      { type: 'Point', coordinates: [5, 5] },
      {
        type: 'MultiPoint',
        coordinates: [
          [1, 1],
          [-1, -1]
        ]
      },
      {
        type: 'GeometryCollection',
        geometries: [
          { type: 'Point', coordinates: [30, 30] },
          {
            type: 'LineString',
            coordinates: [
              [30, 30],
              [40, 35]
            ]
          }
        ]
      },
      // Reaches past the shard's buffer, so only its clipped part is drawn.
      { type: 'Polygon', coordinates: square(150, -50, 200, 50) }
    ];
    const lines = [
      // Not drawn here, yet it ranks its group first, ahead of the others.
      {
        group: 4,
        feature: {
          type: 'Feature',
          properties: { n: 80, '\u0000minzoom': 1 },
          geometry: { type: 'Point', coordinates: [3, 3] }
        }
      },
      ...geometries
        .map((geometry, n) => ({
          group: n % 2,
          properties: { n, NAME: n % 3 === 0 ? 'a' : 'b', DRVAL1: n - 2.5, LIT: n > 3, X: null }
        }))
        .map(({ group, properties }, n) => ({
          group,
          feature: { type: 'Feature', properties, geometry: geometries[n] }
        })),
      // Shown only from zoom 1, by its own minzoom or its group's.
      {
        group: 0,
        feature: {
          type: 'Feature',
          properties: { n: 90, '\u0000minzoom': 1 },
          geometry: { type: 'Point', coordinates: [0, 0] }
        }
      },
      {
        group: 2,
        feature: {
          type: 'Feature',
          properties: { n: 91 },
          geometry: { type: 'Point', coordinates: [0, 0] }
        }
      },
      {
        group: 4,
        feature: {
          type: 'Feature',
          properties: { n: 81 },
          geometry: { type: 'Point', coordinates: [4, 4] }
        }
      },
      {
        group: 3,
        feature: {
          type: 'Feature',
          properties: { n: 92 },
          geometry: { type: 'Point', coordinates: [2, 2] }
        }
      }
    ].map(({ group, feature }) => `${String(group)}\t${JSON.stringify(feature)}`);
    const file = path.join(dir, 'root-equal.ndjson');
    fs.writeFileSync(file, lines.join('\n') + '\n');

    interface Point {
      x: number;
      y: number;
    }
    interface Decoded {
      type: number;
      properties: Record<string, unknown>;
      geometry: Point[][];
    }
    const root = (rootOnly: boolean): Record<string, Decoded[]> => {
      let data: Uint8Array | undefined;
      tileShard(
        {
          files: [file],
          groups: [
            { layer: 'DEPARE', minzoom: 0, maxzoom: 1 },
            { layer: 'DEPARE', minzoom: 0, maxzoom: 0 },
            { layer: 'LIGHTS', minzoom: 1, maxzoom: 1 },
            { layer: 'LIGHTS', minzoom: 0, maxzoom: 1 },
            { layer: 'DEPARE', minzoom: 0, maxzoom: 1 }
          ],
          z: 0,
          x: 0,
          y: 0,
          extent: 4096,
          buffer: 1280,
          gzip: false,
          rootOnly
        },
        (batch) => {
          data ??= batch.find((t) => t.z === 0)?.data;
        }
      );
      assert.ok(data);
      const tile = new VectorTile(new PbfReader(data));
      const out: Record<string, Decoded[]> = {};
      for (const [name, layer] of Object.entries(tile.layers)) {
        out[name] = Array.from({ length: layer.length }, (_, i) => {
          const f = layer.feature(i);
          return { type: f.type, properties: f.properties, geometry: f.loadGeometry() };
        });
      }
      return out;
    };

    const whole = root(false);
    assert.deepStrictEqual(Object.keys(whole), ['DEPARE', 'LIGHTS']);
    assert.ok(!whole.DEPARE.some((f) => f.properties.n === 90));
    assert.strictEqual(whole.DEPARE[0].properties.n, 81);
    // geojson-vt rounds positions to its deepest zoom's grid before this
    // tile's, so they can land a grid step away from a single rounding.
    const nearly = (a: Point, b: Point): boolean =>
      Math.abs(a.x - b.x) <= 1 && Math.abs(a.y - b.y) <= 1;
    const streamed = root(true);
    assert.deepStrictEqual(Object.keys(streamed), Object.keys(whole));
    for (const [name, features] of Object.entries(whole)) {
      const other = streamed[name];
      assert.strictEqual(other.length, features.length, name);
      features.forEach((f, i) => {
        const g = other[i];
        assert.strictEqual(g.type, f.type);
        assert.deepStrictEqual(g.properties, f.properties);
        assert.strictEqual(g.geometry.length, f.geometry.length);
        f.geometry.forEach((ring, r) => {
          assert.strictEqual(g.geometry[r].length, ring.length);
          ring.forEach((p, k) => {
            assert.ok(nearly(p, g.geometry[r][k]), `${name} feature ${String(f.properties.n)}`);
          });
        });
      });
    }
  });
});

describe('groupSources', () => {
  it('merges sources with the same layer and zoom range, drops empty ranges', () => {
    const { groups, files } = groupSources([
      { layer: 'A', minzoom: 9, maxzoom: 12, files: ['a1'] },
      { layer: 'A', minzoom: 9, maxzoom: 12, files: ['a2'] },
      { layer: 'A', minzoom: 12, maxzoom: 16, files: ['a3'] },
      { layer: 'B', minzoom: 14, maxzoom: 12, files: ['b1'] }
    ]);
    assert.deepStrictEqual(groups, [
      { layer: 'A', minzoom: 9, maxzoom: 12 },
      { layer: 'A', minzoom: 12, maxzoom: 16 }
    ]);
    assert.deepStrictEqual(files, [
      { path: 'a1', group: 0 },
      { path: 'a2', group: 0 },
      { path: 'a3', group: 1 }
    ]);
  });

  it('keeps SCAMIN sources apart from plain ones of the same layer and zooms', () => {
    const { groups } = groupSources([
      { layer: 'A', minzoom: 9, maxzoom: 12, files: ['a1'], scamin: true },
      { layer: 'A', minzoom: 9, maxzoom: 12, files: ['a2'] }
    ]);
    assert.deepStrictEqual(groups, [
      { layer: 'A', minzoom: 9, maxzoom: 12, scamin: true },
      { layer: 'A', minzoom: 9, maxzoom: 12 }
    ]);
  });
});

describe('buildVectorMbtiles', () => {
  let tmp: string;
  let db: DatabaseSync;

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-charts-tiler-'));
    // A coastal (band 4) and a harbour (band 5) depth area over the same
    // water, so their zoom ranges overlap at z12-z14, plus a light.
    writeFC(path.join(tmp, 'coastal.geojson'), [
      {
        type: 'Feature',
        properties: { DRVAL1: 0, BAND: 4, COLOUR: ['1', '3'], OBJNAM: null },
        geometry: { type: 'Polygon', coordinates: square(10.0, 54.0, 10.2, 54.1) }
      }
    ]);
    writeFC(path.join(tmp, 'harbour.geojson'), [
      {
        type: 'Feature',
        properties: { DRVAL1: 5, BAND: 5 },
        geometry: { type: 'Polygon', coordinates: square(10.05, 54.02, 10.1, 54.05) }
      }
    ]);
    writeFC(path.join(tmp, 'lights.geojson'), [
      {
        type: 'Feature',
        properties: { CATLIT: ['4'] },
        geometry: { type: 'Point', coordinates: [10.07, 54.03] }
      }
    ]);
    // A polygon far larger than its shards (z6 shards are ~5.6° wide), to
    // check that features reaching past a shard are cut cleanly.
    writeFC(path.join(tmp, 'overview.geojson'), [
      {
        type: 'Feature',
        properties: { BAND: 1 },
        geometry: { type: 'Polygon', coordinates: square(-10, -10, 10, 10) }
      }
    ]);

    const output = path.join(tmp, 'out.mbtiles');
    const result = await withWorkerPool(2, undefined, (pool) =>
      buildVectorMbtiles({
        sources: [
          { layer: 'DEPARE', minzoom: 10, maxzoom: 14, files: [path.join(tmp, 'coastal.geojson')] },
          { layer: 'DEPARE', minzoom: 12, maxzoom: 16, files: [path.join(tmp, 'harbour.geojson')] },
          { layer: 'LIGHTS', minzoom: 12, maxzoom: 16, files: [path.join(tmp, 'lights.geojson')] },
          { layer: 'M_COVR', minzoom: 6, maxzoom: 8, files: [path.join(tmp, 'overview.geojson')] }
        ],
        output,
        scratchDir: path.join(tmp, 'scratch'),
        pool,
        name: 'Test chart'
      })
    );
    assert.strictEqual(result.minzoom, 6);
    assert.strictEqual(result.maxzoom, 16);
    assert.strictEqual(result.features, 4);
    db = new DatabaseSync(output);
  });

  after(() => {
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('removes its scratch directory', () => {
    assert.strictEqual(fs.existsSync(path.join(tmp, 'scratch')), false);
  });

  it('writes MBTiles metadata with the layers and their fields', () => {
    const meta = Object.fromEntries(
      (
        db.prepare('SELECT name, value FROM metadata').all() as { name: string; value: string }[]
      ).map((r) => [r.name, r.value])
    );
    assert.strictEqual(meta.name, 'Test chart');
    assert.strictEqual(meta.format, 'pbf');
    assert.strictEqual(meta.minzoom, '6');
    assert.strictEqual(meta.maxzoom, '16');
    const json = JSON.parse(meta.json) as {
      vector_layers: {
        id: string;
        minzoom: number;
        maxzoom: number;
        fields: Record<string, string>;
      }[];
    };
    const depare = json.vector_layers.find((l) => l.id === 'DEPARE');
    assert.deepStrictEqual(
      { minzoom: depare?.minzoom, maxzoom: depare?.maxzoom },
      { minzoom: 10, maxzoom: 16 }
    );
    assert.deepStrictEqual(depare?.fields, { DRVAL1: 'Number', BAND: 'Number', COLOUR: 'String' });
    const [west, south, east, north] = meta.bounds.split(',').map(Number);
    assert.deepStrictEqual([west, south, east, north], [-10, -10, 10.2, 54.1]);
  });

  it('shows each source only within its zoom range', () => {
    const z10 = readTileAt(db, 10.07, 54.03, 10);
    assert.deepStrictEqual(Object.keys(z10?.layers ?? {}), ['DEPARE']);
    assert.strictEqual(z10?.layers.DEPARE.length, 1);
    assert.strictEqual(z10?.layers.DEPARE.feature(0).properties.BAND, 4);

    const z16 = readTileAt(db, 10.07, 54.03, 16);
    const bands = Array.from(
      { length: z16?.layers.DEPARE.length ?? 0 },
      (_, i) => z16?.layers.DEPARE.feature(i).properties.BAND
    );
    assert.deepStrictEqual(bands, [5]);
    assert.strictEqual(readTileAt(db, 10.07, 54.03, 9), null);
  });

  it('merges same-named layers where zoom ranges of sources overlap', () => {
    const z13 = readTileAt(db, 10.07, 54.03, 13);
    assert.ok(z13);
    assert.deepStrictEqual(Object.keys(z13.layers).sort(), ['DEPARE', 'LIGHTS']);
    const bands = Array.from({ length: z13.layers.DEPARE.length }, (_, i) =>
      Number(z13.layers.DEPARE.feature(i).properties.BAND)
    ).sort();
    assert.deepStrictEqual(bands, [4, 5]);
    assert.strictEqual(z13.layers.LIGHTS.feature(0).properties.CATLIT, '4');
    assert.strictEqual(z13.layers.DEPARE.feature(0).properties.OBJNAM, undefined);
  });

  it('cuts features larger than a shard exactly, with no copies across the antimeridian', () => {
    // Inside the big polygon: the tile is covered.
    const inside = readTileAt(db, 0, 0, 8);
    assert.ok(inside, 'a tile inside the polygon');
    const ring = inside.layers.M_COVR.feature(0).loadGeometry()[0];
    const xs = ring.map((p) => p.x);
    assert.ok(Math.min(...xs) <= 0 && Math.max(...xs) >= 4096, 'covers the whole tile');
    // Well outside it, on every side, nothing.
    for (const [lon, lat] of [
      [15, 0],
      [-15, 0],
      [0, 15],
      [0, -15],
      [170, 0]
    ] as const) {
      assert.strictEqual(
        readTileAt(db, lon, lat, 8),
        null,
        `no tile at ${String(lon)},${String(lat)}`
      );
    }
  });

  it('writes the tile rows south-up (TMS)', () => {
    const { x, y } = tileOf(5, 5, 6);
    const row = db
      .prepare('SELECT 1 FROM tiles WHERE zoom_level = 6 AND tile_column = ? AND tile_row = ?')
      .get(x, 2 ** 6 - 1 - y);
    assert.ok(row);
  });
});

describe('buildVectorMbtiles with a shard size limit', () => {
  let tmp: string;
  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-charts-split-'));
    const features = [];
    for (let i = 0; i < 30; i++) {
      const west = 10 + (i % 6) * 0.3;
      const south = 54 + Math.floor(i / 6) * 0.2;
      features.push({
        type: 'Feature',
        properties: { n: i },
        geometry: { type: 'Polygon', coordinates: square(west, south, west + 0.25, south + 0.15) }
      });
    }
    features.push({
      type: 'Feature',
      properties: { n: 30 },
      geometry: { type: 'Point', coordinates: [10.6, 54.5] }
    });
    // Alone in its quarter, and too small for the grid of the tiles above it.
    features.push({
      type: 'Feature',
      properties: { n: 31 },
      geometry: { type: 'Polygon', coordinates: square(14.5, 57, 14.5004, 57.0003) }
    });
    writeFC(path.join(tmp, 'depare.geojson'), features);
  });
  after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  async function build(name: string, shardBytesLimit?: number): Promise<DatabaseSync> {
    const output = path.join(tmp, `${name}.mbtiles`);
    await withWorkerPool(2, undefined, (pool) =>
      buildVectorMbtiles({
        sources: [
          { layer: 'DEPARE', minzoom: 6, maxzoom: 10, files: [path.join(tmp, 'depare.geojson')] }
        ],
        output,
        scratchDir: path.join(tmp, `scratch-${name}`),
        pool,
        name,
        ...(shardBytesLimit === undefined ? {} : { shardBytesLimit })
      })
    );
    return new DatabaseSync(output);
  }

  /** Each tile's features, as their `n` values. */
  function contents(db: DatabaseSync): Map<string, number[]> {
    const rows = db
      .prepare('SELECT zoom_level z, tile_column x, tile_row y, tile_data d FROM tiles')
      .all() as { z: number; x: number; y: number; d: Uint8Array }[];
    const out = new Map<string, number[]>();
    for (const row of rows) {
      const layer = new VectorTile(new PbfReader(zlib.gunzipSync(row.d))).layers.DEPARE;
      const ns = Array.from({ length: layer.length }, (_, i) =>
        Number(layer.feature(i).properties.n)
      );
      out.set(
        `${row.z}/${row.x}/${row.y}`,
        ns.sort((a, b) => a - b)
      );
    }
    return out;
  }

  it('writes the same tiles when every shard is tiled in parts', async () => {
    const whole = await build('whole');
    const parts = await build('parts', 1);
    try {
      const a = contents(whole);
      assert.ok(a.size > 10);
      assert.ok([...a.values()].some((ns) => ns.includes(31)));
      assert.deepStrictEqual(contents(parts), a);
    } finally {
      whole.close();
      parts.close();
    }
  });

  it('sizes the largest shard a worker tiles in one piece from its heap', () => {
    assert.strictEqual(shardBytesForHeap(512), Math.floor((512 * 1024 * 1024) / 4));
  });
});

describe('buildVectorMbtiles and SCAMIN', () => {
  let tmp: string;
  let db: DatabaseSync;
  // At 54° a tile shows 1:SCAMIN 90000 from z12 on (s57-scamin.ts).
  const at = (lon: number): Position => [lon, 54.03];

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-charts-scamin-'));
    const soundings = [
      { c: 'always' },
      { c: 'coastal', SCAMIN: 90000 },
      { c: 'berth', SCAMIN: 1000 },
      { c: 'overview', SCAMIN: 1e9 }
    ].map((properties, i) => ({
      type: 'Feature',
      properties,
      geometry: { type: 'Point', coordinates: at(10.07 + i * 0.0001) }
    }));
    writeFC(path.join(tmp, 'soundg.geojson'), soundings);
    writeFC(path.join(tmp, 'plain.geojson'), soundings);
    const output = path.join(tmp, 'out.mbtiles');
    await withWorkerPool(2, undefined, (pool) =>
      buildVectorMbtiles({
        sources: [
          {
            layer: 'SOUNDG',
            minzoom: 9,
            maxzoom: 14,
            files: [path.join(tmp, 'soundg.geojson')],
            scamin: true
          },
          { layer: 'PLAIN', minzoom: 9, maxzoom: 14, files: [path.join(tmp, 'plain.geojson')] }
        ],
        output,
        scratchDir: path.join(tmp, 'scratch'),
        pool,
        name: 'SCAMIN chart'
      })
    );
    db = new DatabaseSync(output);
  });

  after(() => {
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const featuresAt = (layer: string, z: number): string[] => {
    const tile = readTileAt(db, 10.07, 54.03, z);
    const l = tile?.layers[layer];
    return Array.from({ length: l?.length ?? 0 }, (_, i) =>
      String(l?.feature(i).properties.c)
    ).sort();
  };

  it('leaves a feature out of tiles below the zoom its SCAMIN is reached at', () => {
    assert.deepStrictEqual(featuresAt('SOUNDG', 9), ['always', 'overview']);
    assert.deepStrictEqual(featuresAt('SOUNDG', 11), ['always', 'overview']);
    assert.deepStrictEqual(featuresAt('SOUNDG', 12), ['always', 'coastal', 'overview']);
    // Capped at the source's maxzoom, so clients overzooming still show it.
    assert.deepStrictEqual(featuresAt('SOUNDG', 14), ['always', 'berth', 'coastal', 'overview']);
  });

  it('ignores SCAMIN for sources that do not ask for it', () => {
    assert.deepStrictEqual(featuresAt('PLAIN', 9), ['always', 'berth', 'coastal', 'overview']);
  });

  it('never writes the carried zoom into a tile or the metadata', () => {
    const tile = readTileAt(db, 10.07, 54.03, 14);
    const l = tile?.layers.SOUNDG;
    assert.ok(l);
    for (let i = 0; i < l.length; i++) {
      assert.deepStrictEqual(
        Object.keys(l.feature(i).properties).filter((k) => k !== 'c' && k !== 'SCAMIN'),
        []
      );
    }
    const json = JSON.parse(
      (db.prepare("SELECT value FROM metadata WHERE name = 'json'").get() as { value: string })
        .value
    ) as { vector_layers: { id: string; fields: Record<string, string> }[] };
    const soundg = json.vector_layers.find((v) => v.id === 'SOUNDG');
    assert.deepStrictEqual(soundg?.fields, { c: 'String', SCAMIN: 'Number' });
  });
});

describe('buildVectorMbtiles failures', () => {
  it('rejects when no source has features and leaves no output behind', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-charts-tiler-empty-'));
    try {
      writeFC(path.join(tmp, 'empty.geojson'), []);
      const output = path.join(tmp, 'out.mbtiles');
      await assert.rejects(
        withWorkerPool(1, undefined, (pool) =>
          buildVectorMbtiles({
            sources: [
              { layer: 'X', minzoom: 9, maxzoom: 10, files: [path.join(tmp, 'empty.geojson')] }
            ],
            output,
            scratchDir: path.join(tmp, 'scratch'),
            pool,
            name: 'x'
          })
        ),
        /No valid GeoJSON layers/
      );
      assert.strictEqual(fs.existsSync(output), false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('stops with a cancellation when the pool is aborted', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-charts-tiler-abort-'));
    try {
      writeFC(path.join(tmp, 'a.geojson'), [
        {
          type: 'Feature',
          properties: {},
          geometry: { type: 'Polygon', coordinates: square(0, 0, 1, 1) }
        }
      ]);
      const controller = new AbortController();
      controller.abort();
      await assert.rejects(
        withWorkerPool(1, controller.signal, (pool) =>
          buildVectorMbtiles({
            sources: [
              { layer: 'X', minzoom: 9, maxzoom: 10, files: [path.join(tmp, 'a.geojson')] }
            ],
            output: path.join(tmp, 'out.mbtiles'),
            scratchDir: path.join(tmp, 'scratch'),
            pool,
            name: 'x',
            signal: controller.signal
          })
        ),
        /cancelled/
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
