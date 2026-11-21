import fs from 'fs';
import path from 'path';
import { gunzipSync } from 'zlib';
import { cellZoomRange, exportFileParts } from './s57-band.js';
import { polygonTiles, type ChartCoverage, type CoveragePolygon } from './chart-coverage.js';

const COVERAGE_LAYER = 'M_COVR';
// S-57 CATCOV: 1 coverage available, 2 no coverage available.
const CATCOV_NO_COVERAGE = 2;
// A ring wider than this crosses the antimeridian, which S-57 cells must not.
const MAX_RING_SPAN_DEG = 180;
/**
 * The deepest zoom whose tiles are listed; a deeper tile is covered when
 * its ancestor there is. Within a range, at most this many zooms below its
 * first: finer tiles of an overview band would only grow the list.
 */
const MAX_TILE_ZOOM = 14;
const MAX_TILE_ZOOMS_BELOW_MINZOOM = 6;
/** Keeps the chart resource small: every client reads it with the chart list. */
const MAX_TILES_PER_RANGE = 2000;

interface CoverageFeature {
  properties?: Record<string, unknown> | null;
  geometry?: { type?: string; coordinates?: unknown } | null;
}

function exportFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    // `.merged` holds copies of the exports, merged by layer.
    if (entry.name.startsWith('.')) {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...exportFiles(full));
    } else if (/\.geojson(\.gz)?$/.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

function readFeatures(file: string): CoverageFeature[] {
  const bytes = fs.readFileSync(file);
  const text = (file.endsWith('.gz') ? gunzipSync(bytes) : bytes).toString('utf8');
  const parsed = JSON.parse(text) as { features?: unknown };
  return Array.isArray(parsed.features) ? (parsed.features as CoverageFeature[]) : [];
}

function onOneSide(polygon: CoveragePolygon): boolean {
  const lons = polygon.flat().map(([lon]) => lon);
  return Math.max(...lons) - Math.min(...lons) <= MAX_RING_SPAN_DEG;
}

function coveragePolygons(feature: CoverageFeature): CoveragePolygon[] {
  // Some producers leave CATCOV out altogether, which can only mean coverage.
  const catcov = Number(feature.properties?.CATCOV);
  const geometry = feature.geometry;
  if (catcov === CATCOV_NO_COVERAGE || !geometry) {
    return [];
  }
  const polygons =
    geometry.type === 'Polygon'
      ? [geometry.coordinates as CoveragePolygon]
      : geometry.type === 'MultiPolygon'
        ? (geometry.coordinates as CoveragePolygon[])
        : [];
  return polygons.filter(onOneSide);
}

/**
 * The chart's coverage from the `M_COVR` exports of its cells anywhere under
 * `exportRoot`: per zoom range the cells are tiled at (cellZoomRange), the
 * tiles their coverage areas fill together. Inside its `M_COVR`, an S-57
 * cell's skin of earth (depth areas, land, …) leaves no gap, so the chart is
 * opaque there at those zooms. Above a range's maxzoom the server overzooms
 * only tiles a larger scale left empty, so the range keeps its maxzoom
 * unless it reaches the chart's own top zoom.
 */
export function encCoverage(
  exportRoot: string,
  userMinzoom: number,
  userMaxzoom: number,
  chartMaxzoom: number
): ChartCoverage | null {
  const byRange = new Map<
    string,
    { minzoom: number; maxzoom: number; polygons: CoveragePolygon[] }
  >();
  for (const file of exportFiles(exportRoot)) {
    const { layer, cell } = exportFileParts(file);
    if (layer !== COVERAGE_LAYER) {
      continue;
    }
    const polygons = readFeatures(file).flatMap(coveragePolygons);
    if (polygons.length === 0) {
      continue;
    }
    const range = cellZoomRange(cell, userMinzoom, userMaxzoom);
    const key = `${String(range.minzoom)}/${String(range.maxzoom)}`;
    const group = byRange.get(key) ?? { ...range, polygons: [] };
    group.polygons.push(...polygons);
    byRange.set(key, group);
  }
  const coverage: ChartCoverage = [];
  for (const { minzoom, maxzoom, polygons } of byRange.values()) {
    const tileZoom = Math.min(MAX_TILE_ZOOM, maxzoom, minzoom + MAX_TILE_ZOOMS_BELOW_MINZOOM);
    const tiles = polygonTiles(polygons, tileZoom, MAX_TILES_PER_RANGE);
    if (tiles.length > 0) {
      coverage.push({ minzoom, ...(maxzoom < chartMaxzoom ? { maxzoom } : {}), tiles });
    }
  }
  coverage.sort((a, b) => a.minzoom - b.minzoom);
  return coverage.length > 0 ? coverage : null;
}
