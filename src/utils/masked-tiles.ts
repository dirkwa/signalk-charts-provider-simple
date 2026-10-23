/**
 * Serves the tiles of masked chart versions: an online chart kept offline,
 * with the land ("Water only") or the water ("Land only") cut away using the
 * land index.
 *
 * The proxy's tile store stays exactly as the provider sent it; a tile is
 * masked the first time it is served and the result is kept in the masked
 * tile cache, keyed by the chart, the mask and the land index version, and
 * stamped with when the source tile was fetched. A refreshed source tile or
 * a rebuilt land index therefore makes it again, while switching a version
 * on or off never touches the kept or downloaded tiles.
 *
 * Failure differs by mask, because the two sit at opposite ends of the stack:
 * - "Water only" fails open: if masking a tile fails, the plain tile is
 *   served, marked so plotters do not keep it, and nothing is cached, since
 *   showing the plain chart is harmless. A tile that cannot be decoded at all
 *   is remembered as such until its source tile changes, and served as sent.
 * - "Land only" fails closed: it lies on top of every other chart, so without
 *   the land index, or when the source tile cannot be had or masked, it serves
 *   a transparent tile, never the raw image, which would hide the charts
 *   underneath.
 */

import { PNG } from 'pngjs';
import type { LandIndex } from './land-index.js';
import { tileBbox3857, type OnlineTileProxy, type OnlineTileSource } from './online-tile-cache.js';
import { SHORE_MARGIN_PX, type MaskMode } from './raster-mask.js';
import type { RasterTileCache } from './raster-tile-cache.js';
import { maskInWorker } from './raster-worker-pool.js';

export type { MaskMode } from './raster-mask.js';

/**
 * A tile to serve, or null for none. `provisional` marks a stand-in served
 * because masking failed (the plain tile, or a transparent one): a plotter
 * must not keep it, or it would show it long after the masked tile can be made.
 */
export type MaskedTile = { data: Buffer; provisional?: true } | null;

const TRANSPARENT_TILE = ((): Buffer => {
  const png = new PNG({ width: 256, height: 256 });
  png.data.fill(0);
  return PNG.sync.write(png);
})();

// What a cached entry holds after its stamp: a kind byte, then for MASKED the PNG.
const EMPTY = 0;
const RAW = 1;
const MASKED = 2;
/** The tile cannot be decoded; trying again would only fail again. */
const UNMASKABLE = 3;

/**
 * Bump when a change to the masking gives different pixels for the same tile
 * and land data, so tiles masked the old way are made again.
 */
const MASK_REVISION = 1;

/** The cache key text for a masked version: the same chart, mask and land data make the same tiles. */
export function maskedCacheText(catalogId: string, mode: MaskMode, landVersion: string): string {
  return `${catalogId}\0${mode}\0${landVersion}\0${String(MASK_REVISION)}`;
}

export class MaskedTiles {
  private readonly inFlight = new Map<string, Promise<MaskedTile>>();

  constructor(
    private readonly proxy: OnlineTileProxy,
    private readonly cache: RasterTileCache,
    private readonly landIndex: () => LandIndex | null
  ) {}

  getTile(
    catalogId: string,
    source: OnlineTileSource,
    mode: MaskMode,
    z: number,
    x: number,
    y: number
  ): Promise<MaskedTile> {
    const flightKey = `${catalogId}/${mode}/${String(z)}/${String(x)}/${String(y)}`;
    let pending = this.inFlight.get(flightKey);
    if (!pending) {
      pending = this.make(catalogId, source, mode, z, x, y).finally(() =>
        this.inFlight.delete(flightKey)
      );
      this.inFlight.set(flightKey, pending);
    }
    return pending;
  }

  private async make(
    catalogId: string,
    source: OnlineTileSource,
    mode: MaskMode,
    z: number,
    x: number,
    y: number
  ): Promise<MaskedTile> {
    const landOnly = mode === 'land-only';
    const transparent = (): MaskedTile => ({ data: TRANSPARENT_TILE, provisional: true });
    const raw = await this.proxy.getKeptTile(catalogId, source, z, x, y);
    // Land only answers a tile it could not get with a transparent stand-in
    // plotters do not keep, rather than a 404 they may, so it fills in once
    // the provider answers; a tile with nothing left to show is a 404.
    if (!raw) {
      return landOnly ? transparent() : null;
    }
    const fallback = (): MaskedTile =>
      landOnly ? transparent() : { data: raw.data, provisional: true };
    const index = this.landIndex();
    if (!index) {
      return fallback();
    }
    const key = this.cache.key(maskedCacheText(catalogId, mode, index.version));
    const stored = key ? this.cache.readStamped(key, z, x, y, raw.fetchedAt) : null;
    if (stored && stored.length > 0) {
      if (stored[0] === EMPTY) {
        return null;
      }
      if (stored[0] === RAW) {
        return { data: raw.data };
      }
      if (stored[0] === UNMASKABLE) {
        return landOnly ? transparent() : { data: raw.data };
      }
      if (stored[0] === MASKED && stored.length > 1) {
        return { data: stored.subarray(1) };
      }
    }
    const keep = (kind: number, data: Uint8Array = new Uint8Array(0)): void => {
      if (key) {
        this.cache.writeStamped(
          key,
          z,
          x,
          y,
          raw.fetchedAt,
          Buffer.concat([Buffer.of(kind), data])
        );
      }
    };
    // "Land only" shrinks the land, so it needs the land just outside the tile
    // too: read as far as the margin reaches on a tile of 128 px or more.
    const margin = landOnly ? SHORE_MARGIN_PX : 0;
    const bbox = tileBbox3857(z, x, y);
    const reach = ((bbox[2] - bbox[0]) / 128) * margin;
    let polygons: Uint8Array[];
    try {
      polygons = index.polygonsIn(
        [bbox[0] - reach, bbox[1] - reach, bbox[2] + reach, bbox[3] + reach],
        z
      );
    } catch (err) {
      console.error(`[charts-provider] Reading the land index failed: ${String(err)}`);
      return fallback();
    }
    if (polygons.length === 0) {
      if (landOnly) {
        keep(EMPTY);
        return null;
      }
      return { data: raw.data };
    }
    const result = await maskInWorker({ raw: raw.data, polygons, bbox, margin, mode }).catch(
      (err: unknown) => {
        // A worker that crashed or could not start: the fallback below.
        console.error(
          `[charts-provider] Masking tile ${String(z)}/${String(x)}/${String(y)} failed:`,
          err
        );
        return { kind: 'failed' } as const;
      }
    );
    switch (result.kind) {
      case 'raw':
        keep(RAW);
        return { data: raw.data };
      case 'empty':
        keep(EMPTY);
        return null;
      case 'masked':
        keep(MASKED, result.data);
        return {
          data: Buffer.from(result.data.buffer, result.data.byteOffset, result.data.byteLength)
        };
      case 'undecodable':
        keep(UNMASKABLE);
        return landOnly ? transparent() : { data: raw.data };
      case 'failed':
        return fallback();
    }
  }
}
