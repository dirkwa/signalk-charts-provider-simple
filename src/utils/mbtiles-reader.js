/**
 * MBTiles Reader Module
 *
 * A lightweight MBTiles reader using better-sqlite3 to replace @mapbox/mbtiles.
 * This avoids native module compatibility issues across Node.js versions.
 *
 * MBTiles is a SQLite database containing:
 * - metadata table: key-value pairs describing the tileset
 * - tiles table: tile data indexed by zoom/column/row (TMS scheme)
 */

const Database = require('better-sqlite3');

/**
 * MBTiles reader class
 * Provides methods to read metadata and tiles from an MBTiles file.
 */
class MBTilesReader {
  /**
   * Create a new MBTiles reader
   * @param {string} filePath - Path to the .mbtiles file
   */
  constructor(filePath) {
    this.filePath = filePath;
    this.db = new Database(filePath, { readonly: true });
    this._metadata = null;
  }

  /**
   * Get metadata from the MBTiles file
   * Reads and parses the metadata table, caching the result.
   *
   * @returns {Object} Metadata object with properties like name, bounds, minzoom, maxzoom, format, etc.
   */
  getInfo() {
    if (this._metadata) {
      return this._metadata;
    }

    const rows = this.db.prepare('SELECT name, value FROM metadata').all();
    const metadata = {};

    for (const row of rows) {
      const { name, value } = row;

      // Parse specific fields
      switch (name) {
        case 'bounds':
          // bounds is stored as "minLon,minLat,maxLon,maxLat"
          metadata.bounds = value.split(',').map(Number);
          break;
        case 'center':
          // center is stored as "lon,lat,zoom"
          metadata.center = value.split(',').map(Number);
          break;
        case 'minzoom':
        case 'maxzoom':
          metadata[name] = parseInt(value, 10);
          break;
        case 'json':
          // Some MBTiles files store additional metadata as JSON
          try {
            const parsed = JSON.parse(value);
            if (parsed.vector_layers) {
              metadata.vector_layers = parsed.vector_layers;
            }
          } catch (e) {
            // Ignore JSON parse errors
          }
          break;
        case 'vector_layers':
          // Vector layers can also be stored directly
          try {
            metadata.vector_layers = JSON.parse(value);
          } catch (e) {
            // Ignore JSON parse errors
          }
          break;
        default:
          metadata[name] = value;
      }
    }

    this._metadata = metadata;
    return metadata;
  }

  /**
   * Get a tile from the MBTiles file
   *
   * MBTiles uses TMS (Tile Map Service) coordinate system where Y is flipped
   * compared to XYZ (web map) coordinates. This method accepts XYZ coordinates
   * and handles the conversion internally.
   *
   * @param {number} z - Zoom level
   * @param {number} x - X coordinate (column)
   * @param {number} y - Y coordinate in XYZ scheme (will be flipped to TMS internally)
   * @returns {Object|null} Object with { data: Buffer, headers: Object } or null if tile doesn't exist
   */
  getTile(z, x, y) {
    // MBTiles uses TMS scheme where Y is flipped
    // Convert from XYZ (web) to TMS: tmsY = (2^z - 1) - xyzY
    const tmsY = (1 << z) - 1 - y;

    const row = this.db.prepare(
      'SELECT tile_data FROM tiles WHERE zoom_level = ? AND tile_column = ? AND tile_row = ?'
    ).get(z, x, tmsY);

    if (!row || !row.tile_data) {
      return null;
    }

    const data = row.tile_data;
    const metadata = this.getInfo();
    const format = metadata.format || 'png';

    // Determine content type and encoding based on format
    const headers = {};

    switch (format) {
      case 'pbf':
        headers['Content-Type'] = 'application/x-protobuf';
        // Check if data is gzipped (common for vector tiles)
        if (data[0] === 0x1f && data[1] === 0x8b) {
          headers['Content-Encoding'] = 'gzip';
        }
        break;
      case 'jpg':
      case 'jpeg':
        headers['Content-Type'] = 'image/jpeg';
        break;
      case 'webp':
        headers['Content-Type'] = 'image/webp';
        break;
      case 'png':
      default:
        headers['Content-Type'] = 'image/png';
        break;
    }

    return { data, headers };
  }

  /**
   * Close the database connection
   * Should be called when the reader is no longer needed.
   */
  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

/**
 * Open an MBTiles file and return a reader instance
 *
 * @param {string} filePath - Path to the .mbtiles file
 * @returns {Promise<MBTilesReader>} Promise resolving to an MBTilesReader instance
 */
function open(filePath) {
  return new Promise((resolve, reject) => {
    try {
      const reader = new MBTilesReader(filePath);
      // Verify the file is valid by reading metadata
      reader.getInfo();
      resolve(reader);
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = {
  MBTilesReader,
  open
};
