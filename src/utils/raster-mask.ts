/**
 * Pixel work for masked chart versions: fill the land polygons under a tile
 * into a coverage mask and make the masked part of the tile transparent.
 * Runs in the raster workers, like raster-compose.ts.
 *
 * "Water only" (mask `water-only`) keeps what the chart draws on water and
 * cuts the land away, so imagery underneath shows on land.
 */

import { PNG } from 'pngjs';
import { decodeRings, landCoverage, type Bbox } from './land-geometry.js';
import { decodeRaster } from './raster-compose.js';

export type MaskMode = 'water-only';

export interface MaskJob {
  /** The tile as the provider sent it. */
  raw: Uint8Array;
  /** The encoded land polygons that may reach into the tile. */
  polygons: Uint8Array[];
  /** The tile's extent in Web Mercator metres. */
  bbox: Bbox;
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

export function maskRasterTile(job: MaskJob): MaskResult {
  if (job.polygons.length === 0) {
    return { kind: 'raw' };
  }
  const img = decodeRaster(job.raw);
  if (!img || img.width !== img.height) {
    return { kind: 'undecodable' };
  }
  const coverage = landCoverage(job.polygons.map(decodeRings), job.bbox, img.width);
  let anyLand = false;
  let allLand = true;
  for (const c of coverage) {
    anyLand ||= c > 0;
    allLand &&= c === 255;
  }
  if (!anyLand) {
    return { kind: 'raw' };
  }
  if (allLand) {
    return { kind: 'empty' };
  }
  const { data } = img;
  let visible = false;
  for (let i = 0; i < coverage.length; i++) {
    const alpha = Math.round((data[4 * i + 3] * (255 - coverage[i])) / 255);
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
