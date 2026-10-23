/**
 * Serves the tiles of masked chart versions: an online chart kept offline,
 * with the land ("Water only") cut away using the land index.
 *
 * The proxy's tile store stays exactly as the provider sent it; a tile is
 * masked the first time it is served and the result is kept in the masked
 * tile cache, keyed by the chart, the mask and the land index version, and
 * stamped with when the source tile was fetched. A refreshed source tile or
 * a rebuilt land index therefore makes it again, while switching a version
 * on or off never touches the kept or downloaded tiles.
 *
 * "Water only" fails open: if masking a tile fails, the plain tile is served,
 * marked so plotters do not keep it, and nothing is cached, since showing the
 * plain chart is harmless. A tile that cannot be decoded at all is remembered
 * as such until its source tile changes, and served as sent.
 */

import type { LandIndex } from './land-index.js';
import { tileBbox3857, type OnlineTileProxy, type OnlineTileSource } from './online-tile-cache.js';
import type { MaskMode } from './raster-mask.js';
import type { RasterTileCache } from './raster-tile-cache.js';
import { maskInWorker } from './raster-worker-pool.js';

export type { MaskMode } from './raster-mask.js';

/**
 * A tile to serve, or null for none. `provisional` marks a plain tile served
 * because masking failed: a plotter must not keep it, or it would show the
 * plain chart long after the masked tile can be made.
 */
export type MaskedTile = { data: Buffer; provisional?: true } | null;

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
    const raw = await this.proxy.getKeptTile(catalogId, source, z, x, y);
    if (!raw) {
      return null;
    }
    const index = this.landIndex();
    if (!index) {
      return { data: raw.data, provisional: true };
    }
    const key = this.cache.key(maskedCacheText(catalogId, mode, index.version));
    const stored = key ? this.cache.readStamped(key, z, x, y, raw.fetchedAt) : null;
    if (stored && stored.length > 0) {
      if (stored[0] === EMPTY) {
        return null;
      }
      if (stored[0] === RAW || stored[0] === UNMASKABLE) {
        return { data: raw.data };
      }
      if (stored[0] === MASKED && stored.length > 1) {
        return { data: stored.subarray(1) };
      }
    }
    let polygons: Uint8Array[];
    try {
      polygons = index.polygonsIn(tileBbox3857(z, x, y), z);
    } catch (err) {
      console.error(`[charts-provider] Reading the land index failed: ${String(err)}`);
      return { data: raw.data, provisional: true };
    }
    if (polygons.length === 0) {
      return { data: raw.data };
    }
    const result = await maskInWorker({
      raw: raw.data,
      polygons,
      bbox: tileBbox3857(z, x, y),
      mode
    }).catch((err: unknown) => {
      // A worker that crashed or could not start; the tile is served unmasked.
      console.error(
        `[charts-provider] Masking tile ${String(z)}/${String(x)}/${String(y)} failed:`,
        err
      );
      return { kind: 'failed' } as const;
    });
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
        return { data: raw.data };
      case 'failed':
        return { data: raw.data, provisional: true };
    }
  }
}
