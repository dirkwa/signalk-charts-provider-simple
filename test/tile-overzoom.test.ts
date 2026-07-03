/**
 * Tests for serve-time overzoom synthesis from vector MBTiles.
 *
 * The fixture (create-test-vector-mbtiles.mjs) advertises minzoom=2,
 * maxzoom=16 but contains only six tiles — see the generator's header for
 * the authoritative inventory: z2 (0,1) 'test-buoy' (id 42) + `areas`
 * polygon, z3 (0,3) 'z3-buoy' (id 43) at the same lon/lat, z8 (56,86)
 * 'z8-buoy' (id 88) far away, corrupt-gzip z2 (1,1), buffer-only z4 (0,7)
 * and z4 (3,5). That reproduces the pyramid
 * holes and cell-edge artifacts of a combined NOAA chart set: deep requests
 * inside coverage must synthesize from the NEAREST content-bearing ancestor,
 * requests outside coverage must keep returning null (→ 404).
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';

import { PbfReader } from 'pbf';
import { VectorTile } from '@mapbox/vector-tile';
import { fromGeojsonVt } from 'vt-pbf';
import type { Feature, Point } from 'geojson';

import { MBTilesReader } from '../dist/utils/mbtiles-reader.js';
import {
  getBlankTileReplacement,
  getOverzoomedTile,
  MAX_OVERZOOM_DELTA,
  _overzoomCacheStats
} from '../dist/utils/tile-overzoom.js';
import { serveTileFromMbtiles } from '../dist/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const VECTOR_MBTILES = path.join(__dirname, '..', 'test', 'fixtures', 'test-vector-chart.mbtiles');
const RASTER_MBTILES = path.join(__dirname, '..', 'test', 'fixtures', 'test-chart.mbtiles');

const POINT_LON = -157.9;
const POINT_LAT = 21.4;
const DEEP_LON = -100;
const DEEP_LAT = 50;
// One MVT extent unit at z3 ≈ 0.011°; allow generous slack for geojson-vt
// rounding on top of quantization.
const TOLERANCE_DEG = 0.05;

function decode(tile: Buffer): VectorTile {
  assert.strictEqual(tile[0], 0x1f, 'synthesized tile must be gzipped');
  assert.strictEqual(tile[1], 0x8b, 'synthesized tile must be gzipped');
  return new VectorTile(new PbfReader(gunzipSync(tile)));
}

function pointCoords(vt: VectorTile, x: number, y: number, z: number): [number, number] {
  const geo = vt.layers.points.feature(0).toGeoJSON(x, y, z) as Feature<Point>;
  return [geo.geometry.coordinates[0], geo.geometry.coordinates[1]];
}

describe('getOverzoomedTile()', () => {
  let reader!: MBTilesReader;

  before(() => {
    reader = new MBTilesReader(VECTOR_MBTILES);
  });

  after(() => {
    reader?.close();
  });

  it('synthesizes a child tile one level below the ancestor', () => {
    const tile = getOverzoomedTile(reader, 3, 0, 3);
    assert.ok(tile, 'child quadrant containing the point should synthesize');

    const vt = decode(tile);
    assert.ok(vt.layers.points, 'points layer should survive re-slicing');
    assert.ok(vt.layers.areas, 'areas layer should survive re-slicing');
    assert.strictEqual(vt.layers.points.version, 2, 'must emit MVT v2 like tippecanoe');

    const feature = vt.layers.points.feature(0);
    assert.strictEqual(feature.id, 42, 'feature id should survive');
    assert.strictEqual(feature.properties.name, 'test-buoy');
    assert.strictEqual(feature.properties.kind, 'buoy');

    const [lon, lat] = pointCoords(vt, 0, 3, 3);
    assert.ok(
      Math.abs(lon - POINT_LON) < TOLERANCE_DEG,
      `lon should round-trip (got ${lon}, want ~${POINT_LON})`
    );
    assert.ok(
      Math.abs(lat - POINT_LAT) < TOLERANCE_DEG,
      `lat should round-trip (got ${lat}, want ~${POINT_LAT})`
    );
  });

  it('slices from the NEAREST ancestor, not just any', () => {
    // z4 (0,7) has two candidate ancestors: z3 (0,3) and z2 (0,1). The z3
    // tile must win — it carries 'z3-buoy' and has no `areas` layer.
    const tile = getOverzoomedTile(reader, 4, 0, 7);
    assert.ok(tile, 'z4 child should synthesize');

    const vt = decode(tile);
    const feature = vt.layers.points.feature(0);
    assert.strictEqual(feature.properties.name, 'z3-buoy', 'must slice from z3, not z2');
    assert.strictEqual(feature.id, 43);
    assert.strictEqual(vt.layers.areas, undefined, 'z2 content must not leak in');

    const [lon, lat] = pointCoords(vt, 0, 7, 4);
    assert.ok(Math.abs(lon - POINT_LON) < TOLERANCE_DEG);
    assert.ok(Math.abs(lat - POINT_LAT) < TOLERANCE_DEG);
  });

  it('synthesizes deep targets (z15) — pins the geojson-vt maxZoom option', () => {
    // geojson-vt's DEFAULT maxZoom is 14: without the explicit maxZoom: 24 in
    // buildAncestorEntry, any synthesis target deeper than z14 silently
    // returns null. Real combined sets advertise maxzoom 16+, so this is the
    // production shape: z15 request, nearest ancestor at z8 (delta 7).
    const tile = getOverzoomedTile(reader, 15, 7281, 11113);
    assert.ok(tile, 'z15 child of the z8 ancestor should synthesize');

    const vt = decode(tile);
    const feature = vt.layers.points.feature(0);
    assert.strictEqual(feature.properties.name, 'z8-buoy');
    assert.strictEqual(feature.id, 88);

    const [lon, lat] = pointCoords(vt, 7281, 11113, 15);
    assert.ok(Math.abs(lon - DEEP_LON) < TOLERANCE_DEG);
    assert.ok(Math.abs(lat - DEEP_LAT) < TOLERANCE_DEG);
  });

  it('returns null for empty sibling quadrants of an existing ancestor', () => {
    assert.strictEqual(getOverzoomedTile(reader, 3, 1, 3), null);
    assert.strictEqual(getOverzoomedTile(reader, 3, 0, 2), null);
    assert.strictEqual(getOverzoomedTile(reader, 3, 1, 2), null);
  });

  it('returns null outside ancestor coverage', () => {
    assert.strictEqual(getOverzoomedTile(reader, 3, 7, 7), null);
  });

  it('returns null at or below minzoom', () => {
    assert.strictEqual(getOverzoomedTile(reader, 2, 0, 1), null);
    assert.strictEqual(getOverzoomedTile(reader, 1, 0, 0), null);
  });

  it('synthesizes up to MAX_OVERZOOM_DELTA levels and no further', () => {
    // The S-57 pipeline can combine band 1 (ceiling z8) with band 6 (z18),
    // so the cap must span at least 10 levels.
    assert.strictEqual(MAX_OVERZOOM_DELTA, 10);
    // z13 (502,3597) → nearest ancestor z3 (0,3), delta exactly 10.
    const within = getOverzoomedTile(reader, 13, 502, 3597);
    assert.ok(within, 'delta 10 should synthesize');
    const vt = decode(within);
    assert.strictEqual(vt.layers.points.feature(0).properties.name, 'z3-buoy');
    // z14 (1005,7194) would need delta 11 to reach z3.
    assert.strictEqual(getOverzoomedTile(reader, 14, 1005, 7194), null);
  });

  it('degrades to null (not a throw) on a corrupt ancestor', () => {
    // z2 (1,1) holds gzip magic followed by garbage.
    let result: Buffer | null = null;
    assert.doesNotThrow(() => {
      result = getOverzoomedTile(reader, 3, 2, 2);
    });
    assert.strictEqual(result, null);
  });

  it('caches synthesized tiles, nulls, and ancestor indexes per reader', () => {
    const fresh = new MBTilesReader(VECTOR_MBTILES);
    try {
      const rawCalls: Array<[number, number, number]> = [];
      const realGetRawTile = fresh.getRawTile.bind(fresh);
      fresh.getRawTile = (z: number, x: number, y: number) => {
        rawCalls.push([z, x, y]);
        return realGetRawTile(z, x, y);
      };

      const first = getOverzoomedTile(fresh, 3, 0, 3);
      assert.ok(first);
      assert.deepStrictEqual(rawCalls, [[2, 0, 1]], 'first synthesis reads the ancestor once');

      const repeat = getOverzoomedTile(fresh, 3, 0, 3);
      assert.strictEqual(repeat, first, 'repeat request returns the cached Buffer instance');
      assert.strictEqual(rawCalls.length, 1, 'repeat request does no raw reads');

      assert.ok(getOverzoomedTile(fresh, 4, 0, 7));
      assert.deepStrictEqual(
        rawCalls,
        [
          [2, 0, 1],
          [3, 0, 3]
        ],
        'a different ancestor is read once, the z2 index is not re-read'
      );

      // (4,2,6) is empty at every ancestor; the walk probes the missing z3
      // (1,3) once, then slices the already-cached z2 index without reading.
      assert.strictEqual(getOverzoomedTile(fresh, 4, 2, 6), null, 'empty quadrant');
      assert.deepStrictEqual(
        rawCalls,
        [
          [2, 0, 1],
          [3, 0, 3],
          [3, 1, 3]
        ],
        'cached ancestor indexes are sliced without raw re-reads'
      );

      const stats = _overzoomCacheStats(fresh);
      assert.strictEqual(stats.indexes, 2, 'both ancestor indexes cached');
      assert.strictEqual(stats.tiles, 3, 'two tiles plus one null cached');

      assert.strictEqual(getOverzoomedTile(fresh, 4, 2, 6), null);
      assert.strictEqual(rawCalls.length, 3, 'null results are cached too');
      assert.deepStrictEqual(_overzoomCacheStats(fresh), stats);
    } finally {
      fresh.close();
    }
  });

  it('walks past buffer-only ancestors to deeper coverage', () => {
    // z5 (1,14) is missing; its nearest ancestor z4 (0,7) is the stored
    // buffer-only tile (nothing visible). The walk must continue to z3.
    const tile = getOverzoomedTile(reader, 5, 1, 14);
    assert.ok(tile, 'must synthesize from z3 despite the blank z4 ancestor');
    const vt = decode(tile);
    assert.strictEqual(vt.layers.points.feature(0).properties.name, 'z3-buoy');
    assert.strictEqual(vt.layers.ghost, undefined);
  });

  describe('getBlankTileReplacement()', () => {
    it('replaces a stored buffer-only tile with synthesized content', () => {
      const raw = reader.getRawTile(4, 0, 7);
      assert.ok(raw, 'fixture must store the buffer-only tile');
      assert.ok(decode(raw).layers.ghost, 'stored tile holds only the ghost layer');

      const replacement = getBlankTileReplacement(reader, 4, 0, 7, raw);
      assert.ok(replacement, 'blank stored tile must be replaced');
      const vt = decode(replacement);
      assert.strictEqual(vt.layers.points.feature(0).properties.name, 'z3-buoy');
      assert.strictEqual(vt.layers.ghost, undefined, 'invisible buffer content is not merged');
    });

    it('keeps the stored tile when the blank quadrant has nothing to synthesize', () => {
      const raw = reader.getRawTile(4, 3, 5);
      assert.ok(raw);
      assert.strictEqual(getBlankTileReplacement(reader, 4, 3, 5, raw), null);
    });

    it('leaves stored tiles with visible features untouched', () => {
      const raw = reader.getRawTile(2, 0, 1);
      assert.ok(raw);
      assert.strictEqual(getBlankTileReplacement(reader, 2, 0, 1, raw), null);
    });

    it('never replaces a stored tile whose feature straddles the tile edge', () => {
      // Simulate the stored (4,0,7) tile holding a feature whose bbox is
      // x1 < 0 < x2 — partially visible. That quadrant WOULD synthesize
      // ('z3-buoy'), so misclassifying straddlers as blank fails loudly.
      const straddleRaw = gzipSync(
        Buffer.from(
          fromGeojsonVt(
            {
              ghost: {
                features: [
                  {
                    id: 1,
                    type: 3,
                    geometry: [
                      [
                        [-100, 200],
                        [500, 200],
                        [500, 800],
                        [-100, 800],
                        [-100, 200]
                      ]
                    ],
                    tags: { kind: 'straddle' }
                  }
                ]
              }
            },
            { version: 2 }
          )
        )
      );
      const fresh = new MBTilesReader(VECTOR_MBTILES);
      try {
        assert.strictEqual(getBlankTileReplacement(fresh, 4, 0, 7, straddleRaw), null);
      } finally {
        fresh.close();
      }
    });

    it('skips the blank check entirely for oversized stored tiles', () => {
      // (4,0,7) WOULD synthesize if the check ran (an all-zero buffer parses
      // as zero layers = blank), so the size cap is pinned by asserting no
      // synthesis happens.
      const fresh = new MBTilesReader(VECTOR_MBTILES);
      try {
        const rawCalls: Array<[number, number, number]> = [];
        const realGetRawTile = fresh.getRawTile.bind(fresh);
        fresh.getRawTile = (z: number, x: number, y: number) => {
          rawCalls.push([z, x, y]);
          return realGetRawTile(z, x, y);
        };
        assert.strictEqual(getBlankTileReplacement(fresh, 4, 0, 7, Buffer.alloc(40000)), null);
        assert.strictEqual(rawCalls.length, 0, 'no synthesis attempted beyond the size cap');
      } finally {
        fresh.close();
      }
    });

    it('degrades to the stored tile on corrupt data and caches that verdict', () => {
      const fresh = new MBTilesReader(VECTOR_MBTILES);
      try {
        const corrupt = fresh.getRawTile(2, 1, 1);
        assert.ok(corrupt);
        let result: Buffer | null = null;
        assert.doesNotThrow(() => {
          result = getBlankTileReplacement(fresh, 2, 1, 1, corrupt);
        });
        assert.strictEqual(result, null);
        assert.strictEqual(
          _overzoomCacheStats(fresh).replacements,
          1,
          'stored bytes are immutable per reader — the error verdict must be cached'
        );
      } finally {
        fresh.close();
      }
    });

    it('caches "serve stored" verdicts for visible tiles', () => {
      const fresh = new MBTilesReader(VECTOR_MBTILES);
      try {
        const raw = fresh.getRawTile(2, 0, 1);
        assert.ok(raw);
        assert.strictEqual(getBlankTileReplacement(fresh, 2, 0, 1, raw), null);
        assert.strictEqual(_overzoomCacheStats(fresh).replacements, 1);
      } finally {
        fresh.close();
      }
    });

    it('caches replacement verdicts per tile', () => {
      const fresh = new MBTilesReader(VECTOR_MBTILES);
      try {
        const raw = fresh.getRawTile(4, 0, 7);
        assert.ok(raw);
        const rawCalls: Array<[number, number, number]> = [];
        const realGetRawTile = fresh.getRawTile.bind(fresh);
        fresh.getRawTile = (z: number, x: number, y: number) => {
          rawCalls.push([z, x, y]);
          return realGetRawTile(z, x, y);
        };

        const first = getBlankTileReplacement(fresh, 4, 0, 7, raw);
        assert.ok(first);
        assert.deepStrictEqual(rawCalls, [[3, 0, 3]], 'synthesis reads the ancestor once');

        const second = getBlankTileReplacement(fresh, 4, 0, 7, raw);
        assert.strictEqual(second, first, 'repeat returns the cached Buffer instance');
        assert.strictEqual(rawCalls.length, 1, 'verdict cache avoids re-checking');
        assert.ok(_overzoomCacheStats(fresh).replacements >= 1);

        // The verdict is keyed by coordinates, not content: a cached hit
        // must return without decoding (garbage would throw → null if the
        // cache lookup were broken).
        const garbage = Buffer.from([0x1f, 0x8b, 0x00, 0x01, 0x02]);
        assert.strictEqual(
          getBlankTileReplacement(fresh, 4, 0, 7, garbage),
          first,
          'cache hit must short-circuit before any decode'
        );
      } finally {
        fresh.close();
      }
    });
  });

  it('returns null for raster charts (overzoom is pbf-only)', () => {
    const raster = new MBTilesReader(RASTER_MBTILES);
    try {
      assert.strictEqual(raster.getInfo().format, 'png');
      assert.strictEqual(getOverzoomedTile(raster, 3, 0, 0), null);
    } finally {
      raster.close();
    }
  });

  describe('serveTileFromMbtiles() route handler', () => {
    type ServeArgs = Parameters<typeof serveTileFromMbtiles>;

    function fakeRes() {
      const res = {
        statusCode: 0,
        headers: {} as Record<string, string>,
        body: undefined as unknown,
        writeHead(code: number, headers: Record<string, string>) {
          res.statusCode = code;
          res.headers = headers;
          return res;
        },
        end(data?: unknown) {
          res.body = data;
        },
        sendStatus(code: number) {
          res.statusCode = code;
        }
      };
      return res;
    }

    const asProvider = (r: MBTilesReader): ServeArgs[1] =>
      ({ identifier: 'test', format: 'pbf', _mbtilesHandle: r }) as unknown as ServeArgs[1];

    it('serves synthesized tiles for coverage holes with pbf+gzip headers', () => {
      // z5 (1,14) is missing; synthesis walks past the blank z4 ghost to z3.
      const res = fakeRes();
      serveTileFromMbtiles(res as unknown as ServeArgs[0], asProvider(reader), 5, 1, 14);
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.headers['Content-Type'], 'application/x-protobuf');
      assert.strictEqual(res.headers['Content-Encoding'], 'gzip');
      assert.ok(res.headers['Cache-Control'], 'cache header must be present');
      const vt = decode(res.body as Buffer);
      assert.strictEqual(vt.layers.points.feature(0).properties.name, 'z3-buoy');
    });

    it('serves the replacement for stored blank tiles', () => {
      const res = fakeRes();
      serveTileFromMbtiles(res as unknown as ServeArgs[0], asProvider(reader), 4, 0, 7);
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.headers['Content-Type'], 'application/x-protobuf');
      assert.strictEqual(res.headers['Content-Encoding'], 'gzip');
      const vt = decode(res.body as Buffer);
      assert.strictEqual(vt.layers.points.feature(0).properties.name, 'z3-buoy');
      assert.strictEqual(vt.layers.ghost, undefined, 'must not serve the stored ghost bytes');
    });

    it('serves stored tiles with visible content unchanged', () => {
      const res = fakeRes();
      serveTileFromMbtiles(res as unknown as ServeArgs[0], asProvider(reader), 2, 0, 1);
      assert.strictEqual(res.statusCode, 200);
      const stored = reader.getTile(2, 0, 1);
      assert.ok(stored);
      assert.deepStrictEqual(res.body, stored.data, 'stored bytes must pass through untouched');
      assert.strictEqual(res.headers['Content-Type'], 'application/x-protobuf');
    });

    it('keeps 404 outside coverage', () => {
      const res = fakeRes();
      serveTileFromMbtiles(res as unknown as ServeArgs[0], asProvider(reader), 3, 7, 7);
      assert.strictEqual(res.statusCode, 404);
    });
  });
});
