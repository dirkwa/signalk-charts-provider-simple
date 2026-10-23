/**
 * Serve-time fill for missing tiles in raster (jpg/png) MBTiles.
 *
 * Raster chart exports are often missing tiles inside their advertised zoom
 * range: a whole level skipped (an export holding z15 and z17 but no z16) or
 * a ragged coverage edge that differs per level. Clients request every level
 * between minzoom and maxzoom, so each hole renders as a blank patch, and a
 * skipped level blanks the whole chart at that zoom. OpenLayers only falls
 * back to tiles it already holds in memory, which a pan into a new area never
 * does.
 *
 * A missing tile is built from what the file does hold around it: the nearest
 * stored ancestor, upscaled, as the background, overlaid with any stored
 * children one level down, downsampled. Decoding and encoding take tens of
 * milliseconds per tile, so they run in the raster worker pool; only the
 * SQLite reads happen here. Nothing is written back to the chart; results are kept in a
 * small LRU per reader and, when the plugin has set it up, in the on-disk
 * cache of raster-tile-cache.ts, so each tile is synthesized once across
 * restarts.
 */

import type { MBTilesReader } from './mbtiles-reader.js';
import type { RasterJob, RasterTile } from './raster-compose.js';
import { overzoomTileCache } from './raster-tile-cache.js';
import { composeInWorker } from './raster-worker-pool.js';
import { LruMap } from './tile-overzoom.js';

export type { RasterTile } from './raster-compose.js';

// Each ancestor level doubles the magnification; past 2^5 the stretched
// pixels carry no more useful detail than the client's own overzoom.
export const MAX_RASTER_OVERZOOM_DELTA = 5;

// A synthesized 256 px tile is 10–150 KB, so this bounds the cache to a few
// MB per chart while covering a screenful of tiles at two zoom levels. Tiles
// that fall out of it come back from the disk cache at stored-tile speed, so
// it is not raised: the target boxes are short of memory, not of disk.
const TILE_CACHE_SIZE = 128;

const RASTER_FORMATS = new Set(['png', 'jpg', 'jpeg']);

// Keyed by reader instance: chart reload/rename/delete builds fresh readers,
// so stale entries are unreachable and collected without explicit eviction.
// Promises are cached so concurrent requests for one tile share one job.
const caches = new WeakMap<MBTilesReader, LruMap<string, Promise<RasterTile | null>>>();

// The disk cache key of each reader's chart file, computed once per reader:
// a reload builds a fresh reader and so re-reads the file's size and mtime.
const diskKeys = new WeakMap<MBTilesReader, string | null>();

function getDiskKey(reader: MBTilesReader): string | null {
  let key = diskKeys.get(reader);
  if (key === undefined) {
    key = overzoomTileCache.fileKey(reader.getFilePath());
    diskKeys.set(reader, key);
  }
  return key;
}

function getCache(reader: MBTilesReader): LruMap<string, Promise<RasterTile | null>> {
  let cache = caches.get(reader);
  if (!cache) {
    cache = new LruMap(TILE_CACHE_SIZE);
    caches.set(reader, cache);
  }
  return cache;
}

/** The stored tiles a missing tile can be built from, or null if none is within reach. */
function collectJob(reader: MBTilesReader, z: number, x: number, y: number): RasterJob | null {
  const info = reader.getInfo();
  const format = info.format ?? 'png';
  if (!RASTER_FORMATS.has(format)) {
    return null;
  }

  const children: RasterJob['children'] = [];
  if (info.maxzoom === undefined || z < info.maxzoom) {
    for (let dy = 0; dy < 2; dy++) {
      for (let dx = 0; dx < 2; dx++) {
        const raw = reader.getRawTile(z + 1, 2 * x + dx, 2 * y + dy);
        if (raw) {
          children.push({ raw, dx, dy });
        }
      }
    }
  }

  let ancestor: RasterJob['ancestor'] = null;
  if (children.length < 4) {
    const minzoom = info.minzoom ?? 0;
    for (let d = 1; d <= MAX_RASTER_OVERZOOM_DELTA && z - d >= minzoom; d++) {
      const raw = reader.getRawTile(z - d, x >> d, y >> d);
      if (raw) {
        const mask = (1 << d) - 1;
        ancestor = { raw, d, qx: x & mask, qy: y & mask };
        break;
      }
    }
  }

  return ancestor || children.length > 0 ? { format, ancestor, children } : null;
}

/**
 * Build a missing raster tile from its stored neighbours in the pyramid.
 * Resolves to null when the chart is not jpg/png, or nothing within reach
 * (an ancestor up to MAX_RASTER_OVERZOOM_DELTA levels up, or a child one
 * level down) is stored: the area is outside the chart and should stay a
 * 404. Never rejects.
 */
export function getRasterOverzoomedTile(
  reader: MBTilesReader,
  z: number,
  x: number,
  y: number
): Promise<RasterTile | null> {
  const cache = getCache(reader);
  const tileKey = `${z}/${x}/${y}`;
  const cached = cache.get(tileKey);
  if (cached) {
    return cached;
  }

  let result: Promise<RasterTile | null>;
  try {
    const diskKey = getDiskKey(reader);
    const stored = diskKey ? overzoomTileCache.read(diskKey, z, x, y) : null;
    if (stored) {
      result = Promise.resolve(stored);
    } else {
      const job = collectJob(reader, z, x, y);
      result = job
        ? composeInWorker(job).then((tile) => {
            if (tile && diskKey) {
              overzoomTileCache.write(diskKey, z, x, y, tile);
            }
            return tile;
          })
        : Promise.resolve(null);
    }
  } catch (err) {
    result = Promise.reject(err instanceof Error ? err : new Error(String(err)));
  }
  const settled = result.catch((err: unknown) => {
    // A crashed worker or failed read must degrade to 404, never a 500.
    // Not cached so a transient failure can recover.
    console.error(`Error synthesizing raster tile ${tileKey}:`, err);
    cache.delete(tileKey);
    return null;
  });
  cache.set(tileKey, settled);
  return settled;
}
