/**
 * Charts Loader Module
 *
 * Discovers and loads nautical charts from the file system.
 * Supports three chart formats:
 * - MBTiles: SQLite-based map tile database format
 * - TMS: Tile Map Service with tilemapresource.xml
 * - XYZ: Directory-based tiles with metadata.json
 */

const bluebird = require('bluebird');
const path = require('path');
const MBTiles = require('@mapbox/mbtiles');
const xml2js = require('xml2js');
const { promises: fs } = require('fs');
const _ = require('lodash');

/**
 * Main entry point: Find all charts in the specified directory
 *
 * @param {string} chartBaseDir - Base directory to search for charts
 * @returns {Promise<Object>} Object with chart identifiers as keys and chart metadata as values
 */
function findCharts(chartBaseDir) {
  return findChartsRecursive(chartBaseDir)
    .then((result) => _.filter(result, _.identity)) // Remove null entries
    .then((charts) =>
      _.reduce(
        charts,
        (result, chart) => {
          result[chart.identifier] = chart;
          return result;
        },
        {}
      )
    )
    .catch((err) => {
      console.error(
        `Error reading charts directory ${chartBaseDir}:${err.message}`
      );
    });
}

/**
 * Recursively scan directories for chart files
 *
 * Searches for:
 * - .mbtiles files (SQLite databases)
 * - Directories containing tilemapresource.xml (TMS format)
 * - Directories containing metadata.json (XYZ format)
 *
 * @param {string} currentDir - Current directory to scan
 * @returns {Promise<Array>} Array of chart metadata objects
 */
function findChartsRecursive(currentDir) {
  return fs
    .readdir(currentDir, { withFileTypes: true })
    .then((files) => {
      return bluebird.mapSeries(files, (file) => {
        const filePath = path.resolve(currentDir, file.name);
        const isMbtilesFile = file.name.match(/\.mbtiles$/i);
        const isDirectory = file.isDirectory();

        if (isMbtilesFile) {
          return openMbtilesFile(filePath, file.name);
        } else if (isDirectory) {
          // Skip hidden directories and node_modules
          if (file.name.startsWith('.') || file.name === 'node_modules') {
            return Promise.resolve([]);
          }

          // Check if this directory is itself a chart (TMS/XYZ format)
          return directoryToMapInfo(filePath, file.name)
            .then((chartInfo) => {
              if (chartInfo) {
                // This is a chart directory - return it without recursing
                return [chartInfo];
              } else {
                // Not a chart directory - recurse into it to find charts
                return findChartsRecursive(filePath);
              }
            });
        } else {
          // Ignore other file types
          return Promise.resolve([]);
        }
      });
    })
    .then((results) => {
      // Flatten array of arrays into single array of charts
      return _.flatten(results);
    });
}

/**
 * Open and parse an MBTiles file
 *
 * MBTiles is a SQLite database containing map tiles and metadata.
 * This function extracts the metadata and creates a chart object
 * compatible with Signal K v1 and v2 APIs.
 *
 * @param {string} file - Full path to .mbtiles file
 * @param {string} filename - Name of the file (for generating identifier)
 * @returns {Promise<Object|null>} Chart metadata object or null if invalid
 */
function openMbtilesFile(file, filename) {
  return (
    new Promise((resolve, reject) => {
      new MBTiles(file, (err, mbtiles) => {
        if (err) {
          return reject(err);
        }
        mbtiles.getInfo((err, metadata) => {
          if (err) {
            return reject(err);
          }
          return resolve({ mbtiles, metadata });
        });
      });
    })
      .then((res) => {
        // Validate metadata - must have bounds
        if (_.isEmpty(res.metadata) || res.metadata.bounds === undefined) {
          return null;
        }

        const identifier = filename.replace(/\.mbtiles$/i, '');

        // Build chart metadata object
        const data = {
          // Internal properties (prefixed with _)
          _fileFormat: 'mbtiles',
          _filePath: file,
          _mbtilesHandle: res.mbtiles,
          _flipY: false, // MBTiles uses XYZ scheme (no Y-flip needed)

          // Chart metadata
          identifier,
          name: res.metadata.name || res.metadata.id,
          description: res.metadata.description,
          bounds: res.metadata.bounds, // [minLon, minLat, maxLon, maxLat]
          minzoom: res.metadata.minzoom,
          maxzoom: res.metadata.maxzoom,
          format: res.metadata.format, // 'png', 'jpg', 'pbf', etc.
          type: 'tilelayer',
          scale: parseInt(res.metadata.scale) || 250000,

          // Signal K v1 API format
          v1: {
            tilemapUrl: `~tilePath~/${identifier}/{z}/{x}/{y}`,
            chartLayers: res.metadata.vector_layers
              ? parseVectorLayers(res.metadata.vector_layers)
              : []
          },

          // Signal K v2 API format
          v2: {
            url: `~tilePath~/${identifier}/{z}/{x}/{y}`,
            layers: res.metadata.vector_layers
              ? parseVectorLayers(res.metadata.vector_layers)
              : []
          }
        };
        return data;
      })
      .catch((e) => {
        console.error(`Error loading chart ${file}`, e.message);
        return null;
      })
  );
}

/**
 * Parse vector layer metadata from MBTiles
 *
 * @param {Array} layers - Array of layer objects with id property
 * @returns {Array<string>} Array of layer IDs
 */
function parseVectorLayers(layers) {
  return layers.map((l) => l.id);
}

/**
 * Check if a directory contains a chart and parse its metadata
 *
 * Looks for:
 * 1. tilemapresource.xml (TMS format)
 * 2. metadata.json (XYZ format)
 *
 * @param {string} file - Directory path
 * @param {string} identifier - Directory name (used as chart identifier)
 * @returns {Promise<Object|null>} Chart metadata object or null
 */
function directoryToMapInfo(file, identifier) {
  async function loadInfo() {
    const tilemapResource = path.join(file, 'tilemapresource.xml');
    const metadataJson = path.join(file, 'metadata.json');

    // Try TMS format first
    try {
      await fs.stat(tilemapResource);
      return parseTilemapResource(tilemapResource);
    } catch {
      // TMS not found, try XYZ format
      try {
        await fs.stat(metadataJson);
        return parseMetadataJson(metadataJson);
      } catch {
        // Neither format found - not a chart directory
        return null;
      }
    }
  }

  return loadInfo()
    .then((info) => {
      if (info) {
        // Validate - must have format specified
        if (!info.format) {
          console.error(`Missing format metadata for chart ${identifier}`);
          return null;
        }

        // Add directory-specific properties
        info.identifier = identifier;
        info._fileFormat = 'directory';
        info._filePath = file;

        // Add Signal K v1 API format
        info.v1 = {
          tilemapUrl: `~tilePath~/${identifier}/{z}/{x}/{y}`,
          chartLayers: []
        };

        // Add Signal K v2 API format
        info.v2 = {
          url: `~tilePath~/${identifier}/{z}/{x}/{y}`,
          layers: []
        };

        return info;
      }
      return null;
    })
    .catch((e) => {
      console.error(`Error getting charts from ${file}`, e.message);
      return undefined;
    });
}

/**
 * Parse TMS (Tile Map Service) tilemapresource.xml file
 *
 * TMS is an older standard that uses a Y-flipped coordinate system
 * compared to XYZ (TMS origin is bottom-left, XYZ is top-left).
 *
 * @param {string} tilemapResource - Path to tilemapresource.xml
 * @returns {Promise<Object>} Chart metadata object
 */
function parseTilemapResource(tilemapResource) {
  return (
    fs
      .readFile(tilemapResource)
      .then(bluebird.promisify(xml2js.parseString))
      .then((parsed) => {
        const result = parsed.TileMap;
        const name = _.get(result, 'Title.0');
        const format = _.get(result, 'TileFormat.0.$.extension'); // e.g., 'png'
        const scale = _.get(result, 'Metadata.0.$.scale');
        const bbox = _.get(result, 'BoundingBox.0.$');

        // Extract available zoom levels
        const zoomLevels = _.map(
          _.get(result, 'TileSets.0.TileSet') || [],
          (set) => parseInt(_.get(set, '$.href'))
        );

        const res = {
          _flipY: true, // TMS uses bottom-left origin, need to flip Y coordinate
          name,
          description: name,
          bounds: bbox
            ? [
                parseFloat(bbox.minx),
                parseFloat(bbox.miny),
                parseFloat(bbox.maxx),
                parseFloat(bbox.maxy)
              ]
            : undefined,
          minzoom: !_.isEmpty(zoomLevels) ? _.min(zoomLevels) : undefined,
          maxzoom: !_.isEmpty(zoomLevels) ? _.max(zoomLevels) : undefined,
          format,
          type: 'tilelayer',
          scale: parseInt(scale) || 250000, // Default to 1:250,000 if not specified
          identifier: '', // Will be set by caller
          _filePath: ''   // Will be set by caller
        };
        return res;
      })
  );
}

/**
 * Parse XYZ format metadata.json file
 *
 * XYZ is a simpler format than TMS, using standard top-left origin
 * for Y coordinates (same as web maps like Google Maps, OpenStreetMap).
 *
 * @param {string} metadataJson - Path to metadata.json
 * @returns {Promise<Object>} Chart metadata object
 */
function parseMetadataJson(metadataJson) {
  return fs
    .readFile(metadataJson, { encoding: 'utf8' })
    .then((txt) => {
      return JSON.parse(txt);
    })
    .then((metadata) => {
      /**
       * Parse bounds from various formats
       * Accepts: "minLon,minLat,maxLon,maxLat" or [minLon, minLat, maxLon, maxLat]
       */
      function parseBounds(bounds) {
        if (_.isString(bounds)) {
          return _.map(bounds.split(','), (bound) => parseFloat(_.trim(bound)));
        } else if (_.isArray(bounds) && bounds.length === 4) {
          return bounds;
        } else {
          return undefined;
        }
      }

      const res = {
        _flipY: false, // XYZ uses standard web map Y coordinate (top-left origin)
        name: metadata.name || metadata.id,
        description: metadata.description || '',
        bounds: parseBounds(metadata.bounds),
        minzoom: parseIntIfNotUndefined(metadata.minzoom),
        maxzoom: parseIntIfNotUndefined(metadata.maxzoom),
        format: metadata.format, // e.g., 'png', 'jpg'
        type: metadata.type || 'tilelayer',
        scale: parseInt(metadata.scale) || 250000,
        identifier: '', // Will be set by caller
        _filePath: ''   // Will be set by caller
      };
      return res;
    });
}

/**
 * Safely parse integer values, returning undefined for invalid inputs
 *
 * @param {*} val - Value to parse
 * @returns {number|undefined} Parsed integer or undefined
 */
function parseIntIfNotUndefined(val) {
  const parsed = parseInt(val);
  return _.isFinite(parsed) ? parsed : undefined;
}

module.exports = {
  findCharts
};
