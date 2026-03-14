/**
 * Script to create a minimal test MBTiles file for testing purposes.
 * Run with: node test/fixtures/create-test-mbtiles.js
 */

const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const outputPath = path.join(__dirname, 'test-chart.mbtiles');

// Remove existing file if it exists
if (fs.existsSync(outputPath)) {
  fs.unlinkSync(outputPath);
}

const db = new DatabaseSync(outputPath);

// Create MBTiles schema
db.exec(`
  CREATE TABLE metadata (name TEXT, value TEXT);
  CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB);
  CREATE UNIQUE INDEX tile_index ON tiles (zoom_level, tile_column, tile_row);
`);

// Insert metadata
const insertMetadata = db.prepare('INSERT INTO metadata (name, value) VALUES (?, ?)');
insertMetadata.run('name', 'Test Chart');
insertMetadata.run('description', 'A test chart for unit testing');
insertMetadata.run('format', 'png');
insertMetadata.run('bounds', '-180,-85,180,85');
insertMetadata.run('center', '0,0,2');
insertMetadata.run('minzoom', '0');
insertMetadata.run('maxzoom', '4');
insertMetadata.run('type', 'baselayer');

// Create a minimal 1x1 transparent PNG (67 bytes)
const transparentPng = Buffer.from([
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a, // PNG signature
  0x00,
  0x00,
  0x00,
  0x0d,
  0x49,
  0x48,
  0x44,
  0x52, // IHDR chunk
  0x00,
  0x00,
  0x00,
  0x01,
  0x00,
  0x00,
  0x00,
  0x01, // 1x1 dimensions
  0x08,
  0x06,
  0x00,
  0x00,
  0x00,
  0x1f,
  0x15,
  0xc4, // RGBA, etc
  0x89,
  0x00,
  0x00,
  0x00,
  0x0a,
  0x49,
  0x44,
  0x41, // IDAT chunk
  0x54,
  0x78,
  0x9c,
  0x63,
  0x00,
  0x01,
  0x00,
  0x00, // compressed data
  0x05,
  0x00,
  0x01,
  0x0d,
  0x0a,
  0x2d,
  0xb4,
  0x00, //
  0x00,
  0x00,
  0x00,
  0x49,
  0x45,
  0x4e,
  0x44,
  0xae, // IEND chunk
  0x42,
  0x60,
  0x82
]);

// Insert some test tiles at different zoom levels
// MBTiles uses TMS scheme (Y is flipped)
const insertTile = db.prepare(
  'INSERT INTO tiles (zoom_level, tile_column, tile_row, tile_data) VALUES (?, ?, ?, ?)'
);

// Zoom 0: single tile (0,0,0) - TMS row 0 = XYZ y 0
insertTile.run(0, 0, 0, transparentPng);

// Zoom 1: 4 tiles
insertTile.run(1, 0, 0, transparentPng);
insertTile.run(1, 0, 1, transparentPng);
insertTile.run(1, 1, 0, transparentPng);
insertTile.run(1, 1, 1, transparentPng);

// Zoom 2: just a couple tiles for testing
insertTile.run(2, 1, 1, transparentPng);
insertTile.run(2, 2, 2, transparentPng);

db.close();

console.log(`Created test MBTiles file: ${outputPath}`);
