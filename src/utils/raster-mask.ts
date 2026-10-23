/**
 * Pixel work for masked chart versions: fill the land polygons under a tile
 * into a coverage mask and make the masked part of the tile transparent.
 * Runs in the raster workers, like raster-compose.ts.
 *
 * - "Water only" (mask `water-only`) keeps what the chart draws on water and
 *   cuts the land away, so imagery underneath shows on land.
 * - "Land only" (mask `land-only`) keeps the land and cuts the water away, so
 *   imagery can lie on top of every other chart. Its land is shrunk by
 *   SHORE_MARGIN_PX first, so where the OSM coastline and a chart's disagree,
 *   the chart's shoreline (rocks, buoys, piers) shows rather than imagery.
 */

import { PNG } from 'pngjs';
import { decodeRings, landCoverage, type Bbox } from './land-geometry.js';
import { decodeRaster } from './raster-compose.js';

export type MaskMode = 'water-only' | 'land-only';

/**
 * How far "Land only" pulls the land back from the coastline, in tile pixels.
 * Masked tiles are cached, so a change needs a MASK_REVISION bump.
 */
export const SHORE_MARGIN_PX = 2;

export interface MaskJob {
  /** The tile as the provider sent it. */
  raw: Uint8Array;
  /** The encoded land polygons that may reach into `bbox`, or within `margin` pixels of it. */
  polygons: Uint8Array[];
  /** The tile's extent in Web Mercator metres. */
  bbox: Bbox;
  /** Pixels around the tile to fill too, so land just outside it shrinks correctly. */
  margin: number;
  mode: MaskMode;
}

/**
 * - `raw`: nothing to cut away; serve the tile as the provider sent it.
 * - `empty`: everything was cut away; serve no tile.
 * - `masked`: the masked tile, always PNG since JPEG has no alpha.
 * - `undecodable`: the tile is not an image the plugin can decode (WebP).
 * - `failed`: masking went wrong.
 */
export type MaskResult =
  | { kind: 'raw' }
  | { kind: 'empty' }
  | { kind: 'masked'; data: Uint8Array }
  | { kind: 'undecodable' }
  | { kind: 'failed' };

/** Grey-scale erosion by a (2r+1)² square, done as two passes of a running minimum. */
function erode(coverage: Uint8Array, size: number, r: number): Uint8Array {
  const pass = (src: Uint8Array, horizontal: boolean): Uint8Array => {
    const out = new Uint8Array(src.length);
    for (let a = 0; a < size; a++) {
      for (let b = 0; b < size; b++) {
        let min = 255;
        for (let k = Math.max(0, b - r); k <= Math.min(size - 1, b + r) && min > 0; k++) {
          const v = horizontal ? src[a * size + k] : src[k * size + a];
          min = v < min ? v : min;
        }
        out[horizontal ? a * size + b : b * size + a] = min;
      }
    }
    return out;
  };
  return pass(pass(coverage, true), false);
}

/** How much of each pixel of the tile is kept: 0 cut away, 255 kept. */
function keptCoverage(job: MaskJob, size: number): Uint8Array {
  const grown = size + 2 * job.margin;
  const pad = ((job.bbox[2] - job.bbox[0]) / size) * job.margin;
  const [minX, minY, maxX, maxY] = job.bbox;
  let land = landCoverage(
    job.polygons.map(decodeRings),
    [minX - pad, minY - pad, maxX + pad, maxY + pad],
    grown
  );
  if (job.mode === 'land-only') {
    // By the margin filled, so every tile pixel's window lies within the grid.
    land = erode(land, grown, job.margin);
  }
  const kept = new Uint8Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const c = land[(y + job.margin) * grown + x + job.margin];
      kept[y * size + x] = job.mode === 'land-only' ? c : 255 - c;
    }
  }
  return kept;
}

export function maskRasterTile(job: MaskJob): MaskResult {
  if (job.polygons.length === 0) {
    return { kind: job.mode === 'land-only' ? 'empty' : 'raw' };
  }
  const img = decodeRaster(job.raw);
  if (!img || img.width !== img.height) {
    return { kind: 'undecodable' };
  }
  const kept = keptCoverage(job, img.width);
  let anyKept = false;
  let allKept = true;
  for (const k of kept) {
    anyKept ||= k > 0;
    allKept &&= k === 255;
  }
  if (allKept) {
    return { kind: 'raw' };
  }
  if (!anyKept) {
    return { kind: 'empty' };
  }
  const { data } = img;
  let visible = false;
  for (let i = 0; i < kept.length; i++) {
    const alpha = Math.round((data[4 * i + 3] * kept[i]) / 255);
    data[4 * i + 3] = alpha;
    visible ||= alpha > 0;
  }
  if (!visible) {
    return { kind: 'empty' };
  }
  const png = new PNG({ width: img.width, height: img.height });
  png.data = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return { kind: 'masked', data: PNG.sync.write(png) };
}
