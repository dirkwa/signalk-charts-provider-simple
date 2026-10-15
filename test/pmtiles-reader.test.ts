/**
 * PMTiles charts: the reader, the loader and the tile route.
 *
 * Archives are written here by a small writer that follows the PMTiles v3
 * spec, so each test controls the layout it needs: gzip or uncompressed
 * directories, a leaf directory, the tile type and compression.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { zxyToTileId } from 'pmtiles';

import { findCharts } from '../dist/charts-loader.js';
import { PMTilesReader, pmtilesBounds } from '../dist/utils/pmtiles-reader.js';
import { chartIdFromFilename, collectChartIds } from '../dist/utils/online-charts.js';
import { scanChartsRecursively } from '../dist/utils/file-scanner.js';
import { pmtilesMetadataView, serveTileFromPmtiles } from '../dist/index.js';

const COMPRESSION_NONE = 1;
const COMPRESSION_GZIP = 2;
const COMPRESSION_ZSTD = 4;
const TILE_MVT = 1;
const TILE_PNG = 2;

interface FixtureTile {
  z: number;
  x: number;
  y: number;
  data: Buffer;
}

interface FixtureOptions {
  tiles: FixtureTile[];
  metadata?: Record<string, unknown>;
  tileType?: number;
  tileCompression?: number;
  internalCompression?: number;
  /** Put every entry in one leaf directory behind a single root entry. */
  leaf?: boolean;
  bounds?: [number, number, number, number];
}

function varint(n: number): number[] {
  const out: number[] = [];
  let v = n;
  while (v >= 0x80) {
    out.push((v % 0x80) | 0x80);
    v = Math.floor(v / 0x80);
  }
  out.push(v);
  return out;
}

interface Entry {
  tileId: number;
  offset: number;
  length: number;
  runLength: number;
}

function serializeDirectory(entries: Entry[]): Buffer {
  const bytes: number[] = [...varint(entries.length)];
  let lastId = 0;
  for (const e of entries) {
    bytes.push(...varint(e.tileId - lastId));
    lastId = e.tileId;
  }
  for (const e of entries) {
    bytes.push(...varint(e.runLength));
  }
  for (const e of entries) {
    bytes.push(...varint(e.length));
  }
  entries.forEach((e, i) => {
    const prev = entries[i - 1];
    const contiguous = prev !== undefined && e.offset === prev.offset + prev.length;
    bytes.push(...varint(contiguous ? 0 : e.offset + 1));
  });
  return Buffer.from(bytes);
}

function writePmtiles(file: string, opts: FixtureOptions): void {
  const internal = opts.internalCompression ?? COMPRESSION_NONE;
  const compress = (b: Buffer): Buffer => (internal === COMPRESSION_GZIP ? gzipSync(b) : b);

  const sorted = opts.tiles
    .map((t) => ({ ...t, tileId: zxyToTileId(t.z, t.x, t.y) }))
    .sort((a, b) => a.tileId - b.tileId);
  const entries: Entry[] = [];
  let tileOffset = 0;
  for (const t of sorted) {
    entries.push({ tileId: t.tileId, offset: tileOffset, length: t.data.length, runLength: 1 });
    tileOffset += t.data.length;
  }
  const tileData = Buffer.concat(sorted.map((t) => t.data));

  let root: Buffer;
  let leaves: Buffer = Buffer.alloc(0);
  if (opts.leaf) {
    leaves = compress(serializeDirectory(entries));
    root = compress(
      serializeDirectory([
        { tileId: entries[0]?.tileId ?? 0, offset: 0, length: leaves.length, runLength: 0 }
      ])
    );
  } else {
    root = compress(serializeDirectory(entries));
  }
  const metadata = compress(Buffer.from(JSON.stringify(opts.metadata ?? {})));

  const rootOffset = 127;
  const metadataOffset = rootOffset + root.length;
  const leafOffset = metadataOffset + metadata.length;
  const dataOffset = leafOffset + leaves.length;
  const zooms = opts.tiles.map((t) => t.z);
  const [west, south, east, north] = opts.bounds ?? [-10, 40, 10, 60];

  const header = Buffer.alloc(127);
  header.write('PMTiles', 0, 'ascii');
  header.writeUInt8(3, 7);
  const u64 = (pos: number, v: number) => header.writeBigUInt64LE(BigInt(v), pos);
  u64(8, rootOffset);
  u64(16, root.length);
  u64(24, metadataOffset);
  u64(32, metadata.length);
  u64(40, leafOffset);
  u64(48, leaves.length);
  u64(56, dataOffset);
  u64(64, tileData.length);
  u64(72, entries.length);
  u64(80, entries.length);
  u64(88, entries.length);
  header.writeUInt8(1, 96);
  header.writeUInt8(internal, 97);
  header.writeUInt8(opts.tileCompression ?? COMPRESSION_GZIP, 98);
  header.writeUInt8(opts.tileType ?? TILE_MVT, 99);
  header.writeUInt8(Math.min(...zooms), 100);
  header.writeUInt8(Math.max(...zooms), 101);
  header.writeInt32LE(Math.round(west * 1e7), 102);
  header.writeInt32LE(Math.round(south * 1e7), 106);
  header.writeInt32LE(Math.round(east * 1e7), 110);
  header.writeInt32LE(Math.round(north * 1e7), 114);
  header.writeUInt8(Math.min(...zooms), 118);

  fs.writeFileSync(file, Buffer.concat([header, root, metadata, leaves, tileData]));
}

const VECTOR_TILES: FixtureTile[] = [
  { z: 2, x: 1, y: 1, data: gzipSync(Buffer.from('tile 2/1/1')) },
  { z: 3, x: 2, y: 3, data: gzipSync(Buffer.from('tile 3/2/3')) },
  { z: 3, x: 3, y: 3, data: gzipSync(Buffer.from('tile 3/3/3')) }
];

const S57_METADATA = {
  name: 'Fiji crowdsourced depth',
  description: 'Not for navigation.',
  type: 'S-57',
  vector_layers: [{ id: 'SOUNDG' }, { id: 'DEPARE' }, { id: 'DEPCNT' }]
};

function fakeResponse() {
  return new Promise<{ statusCode: number; headers: Record<string, string>; body: unknown }>(
    (resolve) => {
      const res = {
        statusCode: 0,
        headersSent: false,
        headers: {} as Record<string, string>,
        body: undefined as unknown,
        writeHead(code: number, headers: Record<string, string>) {
          res.statusCode = code;
          res.headers = headers;
          res.headersSent = true;
          return res;
        },
        end(data?: unknown) {
          res.body = data;
          resolve(res);
        },
        sendStatus(code: number) {
          res.statusCode = code;
          resolve(res);
        }
      };
      fakeResponse.current = res;
    }
  );
}
fakeResponse.current = undefined as unknown;

async function serve(provider: unknown, z: number, x: number, y: number) {
  const done = fakeResponse();
  type Args = Parameters<typeof serveTileFromPmtiles>;
  await serveTileFromPmtiles(fakeResponse.current as Args[0], provider as Args[1], z, x, y);
  return done;
}

describe('PMTiles charts', () => {
  let root: string;
  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cps-pmtiles-'));
  });
  after(() => {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  function fixture(name: string, opts: FixtureOptions): string {
    const dir = fs.mkdtempSync(path.join(root, `${name}-`));
    writePmtiles(path.join(dir, `${name}.pmtiles`), opts);
    return dir;
  }

  async function withReader<T>(file: string, fn: (r: PMTilesReader) => T | Promise<T>): Promise<T> {
    const reader = await PMTilesReader.open(file);
    try {
      return await fn(reader);
    } finally {
      await reader.close();
    }
  }

  it('serves a vector archive as an S-57 chart with its metadata', async () => {
    const dir = fixture('fiji', { tiles: VECTOR_TILES, metadata: S57_METADATA });
    const charts = await findCharts(dir);
    const chart = charts.fiji;
    assert.ok(chart, 'the archive should load as a chart');
    try {
      assert.strictEqual(chart._fileFormat, 'pmtiles');
      assert.strictEqual(chart.name, 'Fiji crowdsourced depth');
      assert.strictEqual(chart.type, 'S-57');
      assert.strictEqual(chart.format, 'pbf');
      assert.strictEqual(chart.minzoom, 2);
      assert.strictEqual(chart.maxzoom, 3);
      assert.deepStrictEqual(chart.bounds, [-10, 40, 10, 60]);
      assert.deepStrictEqual(chart.v2.layers, ['SOUNDG', 'DEPARE', 'DEPCNT']);
      assert.strictEqual(chart.v2.url, '~tilePath~/fiji/{z}/{x}/{y}');
    } finally {
      await chart._pmtilesHandle?.close();
    }
  });

  it('recognizes S-57 layers when the metadata has no chart type', async () => {
    const dir = fixture('untyped', {
      tiles: VECTOR_TILES,
      metadata: { vector_layers: [{ id: 'DEPARE' }] }
    });
    const chart = (await findCharts(dir)).untyped;
    assert.ok(chart);
    try {
      assert.strictEqual(chart.type, 'S-57');
      assert.strictEqual(chart.name, 'untyped');
    } finally {
      await chart._pmtilesHandle?.close();
    }
  });

  it('returns a gzip vector tile as stored, with its encoding', async () => {
    const dir = fixture('stored', { tiles: VECTOR_TILES });
    await withReader(path.join(dir, 'stored.pmtiles'), async (reader) => {
      const tile = await reader.getTile(3, 2, 3);
      assert.ok(tile);
      assert.deepStrictEqual(tile.data, VECTOR_TILES[1]?.data);
      assert.strictEqual(tile.headers['Content-Type'], 'application/x-protobuf');
      assert.strictEqual(tile.headers['Content-Encoding'], 'gzip');
    });
  });

  it('returns null for a missing tile and for zooms outside the archive', async () => {
    const dir = fixture('missing', { tiles: VECTOR_TILES });
    await withReader(path.join(dir, 'missing.pmtiles'), async (reader) => {
      assert.strictEqual(await reader.getTile(3, 0, 0), null);
      assert.strictEqual(await reader.getTile(1, 0, 0), null);
      assert.strictEqual(await reader.getTile(9, 0, 0), null);
      assert.strictEqual(await reader.getTile(3, 8, 0), null);
    });
  });

  it('treats an empty stored tile as missing rather than sending an empty gzip body', async () => {
    const dir = fixture('empty', {
      tiles: [...VECTOR_TILES, { z: 3, x: 0, y: 0, data: Buffer.alloc(0) }]
    });
    await withReader(path.join(dir, 'empty.pmtiles'), async (reader) => {
      assert.strictEqual(await reader.getTile(3, 0, 0), null);
      assert.ok(await reader.getTile(3, 2, 3));
    });
  });

  it('follows a leaf directory and reads gzip-compressed directories', async () => {
    const dir = fixture('leaf', {
      tiles: VECTOR_TILES,
      metadata: S57_METADATA,
      leaf: true,
      internalCompression: COMPRESSION_GZIP
    });
    await withReader(path.join(dir, 'leaf.pmtiles'), async (reader) => {
      assert.strictEqual(reader.metadata.name, 'Fiji crowdsourced depth');
      for (const t of VECTOR_TILES) {
        const raw = await reader.getRawTile(t.z, t.x, t.y);
        assert.deepStrictEqual(raw, t.data, `tile ${t.z}/${t.x}/${t.y}`);
      }
    });
  });

  it('serves an uncompressed raster tile without a content encoding', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const dir = fixture('raster', {
      tiles: [{ z: 4, x: 3, y: 5, data: png }],
      tileType: TILE_PNG,
      tileCompression: COMPRESSION_NONE
    });
    const chart = (await findCharts(dir)).raster;
    assert.ok(chart);
    try {
      assert.strictEqual(chart.format, 'png');
      assert.strictEqual(chart.type, 'tilelayer');
      const res = await serve(chart, 4, 3, 5);
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.headers['Content-Type'], 'image/png');
      assert.strictEqual(res.headers['Content-Encoding'], undefined);
      assert.deepStrictEqual(res.body, png);
      assert.strictEqual((await serve(chart, 4, 0, 0)).statusCode, 404);
    } finally {
      await chart._pmtilesHandle?.close();
    }
  });

  it('answers 500 rather than throwing when the archive was closed', async () => {
    const dir = fixture('closed', { tiles: VECTOR_TILES });
    const chart = (await findCharts(dir)).closed;
    assert.ok(chart);
    await chart._pmtilesHandle?.close();
    assert.strictEqual((await serve(chart, 3, 2, 3)).statusCode, 500);
  });

  it('skips an archive it cannot serve without failing the scan', async () => {
    const dir = fixture('zstd', { tiles: VECTOR_TILES, tileCompression: COMPRESSION_ZSTD });
    fs.writeFileSync(path.join(dir, 'garbage.pmtiles'), 'not an archive');
    const charts = await findCharts(dir);
    assert.deepStrictEqual(Object.keys(charts), []);
  });

  it('skips an archive whose directories use an unsupported compression', async () => {
    const dir = fixture('zstd-dirs', {
      tiles: VECTOR_TILES,
      internalCompression: COMPRESSION_ZSTD
    });
    assert.deepStrictEqual(Object.keys(await findCharts(dir)), []);
  });

  it('refuses a tile the archive claims but does not hold', async () => {
    const dir = fixture('truncated', { tiles: VECTOR_TILES });
    const file = path.join(dir, 'truncated.pmtiles');
    fs.truncateSync(file, fs.statSync(file).size - 4);
    // Tile data is laid out in tile-id order, so the cut lands in the last one.
    const byId = [...VECTOR_TILES].sort(
      (a, b) => zxyToTileId(a.z, a.x, a.y) - zxyToTileId(b.z, b.x, b.y)
    );
    const last = byId[byId.length - 1];
    const first = byId[0];
    assert.ok(last && first);
    await withReader(file, async (reader) => {
      await assert.rejects(reader.getRawTile(last.z, last.x, last.y), /past the end/);
      assert.deepStrictEqual(await reader.getRawTile(first.z, first.x, first.y), first.data);
    });
  });

  it('publishes a crossing box for an archive that straddles the antimeridian', () => {
    const header = { minLon: -180, minLat: -20, maxLon: 180, maxLat: -16 };
    const adjusted = pmtilesBounds(header as never, {
      antimeridian_adjusted_bounds: '176,-20,182,-16'
    });
    assert.deepStrictEqual(adjusted, [176, -20, -178, -16]);
    assert.deepStrictEqual(pmtilesBounds(header as never, {}), [-180, -20, 180, -16]);
    const narrow = { minLon: 176, minLat: -20, maxLon: 179, maxLat: -16 };
    assert.deepStrictEqual(
      pmtilesBounds(narrow as never, { antimeridian_adjusted_bounds: '176,-20,182,-16' }),
      [176, -20, 179, -16]
    );
  });

  it('shows read-only metadata without the bulky tippecanoe fields', async () => {
    const dir = fixture('meta', {
      tiles: VECTOR_TILES,
      metadata: { ...S57_METADATA, tilestats: { layers: [] }, generator_options: 'tippecanoe' }
    });
    await withReader(path.join(dir, 'meta.pmtiles'), (reader) => {
      const view = pmtilesMetadataView(reader);
      assert.strictEqual(view.name, 'Fiji crowdsourced depth');
      assert.strictEqual(view.type, 'S-57');
      assert.strictEqual(view.format, 'pbf');
      assert.strictEqual(view.tileCount, 3);
      assert.strictEqual(view.readOnly, true);
      assert.strictEqual(view.tilestats, undefined);
      assert.strictEqual(view.generator_options, undefined);
      assert.strictEqual(view.vector_layers, undefined);
    });
  });

  it('lists an archive for management under the name its metadata gives', async () => {
    const dir = fixture('listed', { tiles: VECTOR_TILES, metadata: S57_METADATA });
    const scanned = await scanChartsRecursively(dir);
    assert.deepStrictEqual(
      scanned.map((c) => [c.name, c.chartName]),
      [['listed.pmtiles', 'Fiji crowdsourced depth']]
    );
  });

  it('gives .pmtiles files a chart id like any other chart file', async () => {
    assert.strictEqual(chartIdFromFilename('csb-fiji.pmtiles'), 'csb-fiji');
    assert.strictEqual(chartIdFromFilename('CSB-FIJI.PMTILES'), 'CSB-FIJI');
    const dir = fixture('ids', { tiles: VECTOR_TILES });
    const ids = await collectChartIds(dir);
    assert.ok(ids.has('ids'));
  });
});
