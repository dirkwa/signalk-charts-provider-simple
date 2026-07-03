/**
 * Script to create a minimal vector (pbf) test MBTiles file for the
 * tile-overzoom tests. The pyramid intentionally has holes: metadata
 * advertises minzoom=2..maxzoom=16 but only six tiles exist — the same
 * shape as a combined NOAA chart set where deep zooms are missing in areas
 * covered only by a low band.
 *
 *   z2 XYZ (0,1)   point 'test-buoy' (id 42) + polygon (layer `areas`)
 *   z3 XYZ (0,3)   point 'z3-buoy'   (id 43), same lon/lat — lets tests pin
 *                  that synthesis picks the NEAREST ancestor, not just any
 *   z8 XYZ (56,86) point 'z8-buoy'   (id 88) far from the others — lets tests
 *                  synthesize a z15 child (deep targets pin geojson-vt's
 *                  maxZoom option, whose default 14 would return null)
 *   z2 XYZ (1,1)   corrupt gzip bytes — synthesis from it must degrade to
 *                  null, never throw
 *   z4 XYZ (0,7)   STORED "buffer-only" tile: four features, each outside
 *                  the visible extent past a different edge (x > extent,
 *                  y > extent, x < 0, y < 0), like tippecanoe cell-edge
 *                  tiles carrying just the neighbor's buffer spill — must be
 *                  REPLACED by synthesis from z3, which pins every arm of
 *                  the visibility predicate
 *   z4 XYZ (3,5)   buffer-only, and its quadrant is empty in every
 *                  ancestor — stored tile must be served as-is
 *
 * Tile contents are independent per tile (no real pyramid consistency); the
 * overzoom module only ever reads one ancestor at a time, so that's fine.
 * Run with: node test/fixtures/create-test-vector-mbtiles.mjs
 */

// ESM because geojson-vt 4 is ESM-only (no CJS entry to require()).
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';
import { gzipSync } from 'node:zlib';
import geojsonvt from 'geojson-vt';
import vtpbf from 'vt-pbf';

const outputPath = path.join(import.meta.dirname, 'test-vector-chart.mbtiles');

if (fs.existsSync(outputPath)) {
  fs.unlinkSync(outputPath);
}

const db = new DatabaseSync(outputPath);

db.exec(`
  CREATE TABLE metadata (name TEXT, value TEXT);
  CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB);
  CREATE UNIQUE INDEX tile_index ON tiles (zoom_level, tile_column, tile_row);
`);

const insertMetadata = db.prepare('INSERT INTO metadata (name, value) VALUES (?, ?)');
insertMetadata.run('name', 'Test Vector Chart');
insertMetadata.run('description', 'A vector test chart with pyramid holes');
insertMetadata.run('format', 'pbf');
// z2 tile (0,1) footprint; bounds are required or charts-loader rejects the file
insertMetadata.run('bounds', '-180,0,-90,66.51');
insertMetadata.run('minzoom', '2');
// Advertised far deeper than any stored tile, like a real combined set.
insertMetadata.run('maxzoom', '16');
insertMetadata.run('type', 'overlay');
insertMetadata.run('json', JSON.stringify({ vector_layers: [{ id: 'points' }, { id: 'areas' }] }));

// The point sits at ~25% of the z2 tile's width (~49% of its z3 child's), so
// child-quadrant assertions at z3 are unambiguous (well clear of the 64/4096
// buffer spill into sibling tiles). The polygon must be ±0.5° — anything much
// smaller collapses to nothing at z2, where one extent unit is ~0.022° and
// geojson-vt simplifies below its 3-unit tolerance.
const POINT_LON = -157.9;
const POINT_LAT = 21.4;
const AREA_HALF_WIDTH = 0.5;
// In z8 tile XYZ (56,86); its z15 descendant containing the point is (7281,11113).
const DEEP_LON = -100;
const DEEP_LAT = 50;

function pointFc(id, name, lon, lat) {
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        id,
        properties: { name, kind: 'buoy' },
        geometry: { type: 'Point', coordinates: [lon, lat] }
      }
    ]
  };
}

const areaFc = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      id: 7,
      properties: { kind: 'anchorage' },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [POINT_LON - AREA_HALF_WIDTH, POINT_LAT - AREA_HALF_WIDTH],
            [POINT_LON + AREA_HALF_WIDTH, POINT_LAT - AREA_HALF_WIDTH],
            [POINT_LON + AREA_HALF_WIDTH, POINT_LAT + AREA_HALF_WIDTH],
            [POINT_LON - AREA_HALF_WIDTH, POINT_LAT + AREA_HALF_WIDTH],
            [POINT_LON - AREA_HALF_WIDTH, POINT_LAT - AREA_HALF_WIDTH]
          ]
        ]
      }
    }
  ]
};

const vtOptions = { maxZoom: 10, indexMaxZoom: 0, buffer: 64, extent: 4096 };

function makeTile(layersSpec, z, x, y) {
  const layers = {};
  for (const [layerName, fc] of Object.entries(layersSpec)) {
    const tile = geojsonvt(fc, vtOptions).getTile(z, x, y);
    if (!tile) {
      throw new Error(`Fixture generation failed: no features in ${layerName} at ${z}/${x}/${y}`);
    }
    layers[layerName] = tile;
  }
  return gzipSync(Buffer.from(vtpbf.fromGeojsonVt(layers, { version: 2 })));
}

const insertTile = db.prepare(
  'INSERT INTO tiles (zoom_level, tile_column, tile_row, tile_data) VALUES (?, ?, ?, ?)'
);
const insertXyz = (z, x, y, data) => insertTile.run(z, x, (1 << z) - 1 - y, data);

insertXyz(
  2,
  0,
  1,
  makeTile({ points: pointFc(42, 'test-buoy', POINT_LON, POINT_LAT), areas: areaFc }, 2, 0, 1)
);
insertXyz(3, 0, 3, makeTile({ points: pointFc(43, 'z3-buoy', POINT_LON, POINT_LAT) }, 3, 0, 3));
insertXyz(8, 56, 86, makeTile({ points: pointFc(88, 'z8-buoy', DEEP_LON, DEEP_LAT) }, 8, 56, 86));
// Corrupt tile: valid gzip magic, garbage body.
insertXyz(2, 1, 1, Buffer.from([0x1f, 0x8b, 0xde, 0xad, 0xbe, 0xef, 0x00, 0x01, 0x02, 0x03]));

// Hand-built MVTs in raw extent units (no geojson-vt involved).
function ghostTile(rings) {
  const mvt = vtpbf.fromGeojsonVt(
    {
      ghost: {
        features: rings.map((ring, i) => ({
          id: 99 + i,
          type: 3,
          geometry: [ring],
          tags: { kind: 'neighbor-spill' }
        }))
      }
    },
    { version: 2 }
  );
  return gzipSync(Buffer.from(mvt));
}

const square = (x1, y1, x2, y2) => [
  [x1, y1],
  [x2, y1],
  [x2, y2],
  [x1, y2],
  [x1, y1]
];

// Buffer-only: every feature entirely outside the 0..4096 extent, so the
// tile renders nothing. (0,7) carries one feature per visibility-predicate
// arm: right (x1 > extent), bottom (y1 > extent), left (x2 < 0), top
// (y2 < 0) — losing any arm makes that feature "visible" and the tile
// non-blank.
insertXyz(
  4,
  0,
  7,
  ghostTile([
    square(4500, 100, 5000, 600),
    square(100, 4500, 600, 5000),
    square(-500, 100, -100, 600),
    square(100, -500, 600, -100)
  ])
);
insertXyz(4, 3, 5, ghostTile([square(-500, 100, -100, 600)]));

db.close();

console.log(`Created test vector MBTiles file: ${outputPath}`);
