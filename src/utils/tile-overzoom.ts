/**
 * Serve-time overzoom fallback for vector (pbf) MBTiles.
 *
 * Chart sets combined from multiple ENC bands (tippecanoe + tile-join) have
 * spatially varying max zoom: in areas covered only by a low band, tiles for
 * the advertised deeper zooms don't exist, so clients render black instead of
 * overzooming (OpenLayers/MapLibre only overzoom past the advertised maxzoom,
 * never for mid-pyramid holes). When a pbf tile is missing, this module walks
 * up the ancestor pyramid and re-slices the nearest existing ancestor MVT into
 * the requested child tile — lossless for vector data, so clients render it
 * exactly like native overzoom.
 *
 * A second band-edge artifact gets the same treatment: tippecanoe emits
 * STORED tiles at chart-cell edges whose features all lie in the buffer zone
 * outside the tile's own extent (the neighbor cell's content). Renderers clip
 * to the extent, so such a tile draws nothing — and because it exists, it
 * would block the fallback and leave a blank stripe over content a lower band
 * provides. getBlankTileReplacement() detects those and synthesizes instead.
 *
 * Nothing is written back to the MBTiles; synthesis is on demand with
 * in-memory LRUs per reader. The first miss touching an ancestor pays one
 * decode+index (~30–300 ms); further children of the same ancestor are served
 * from cache in ~1 ms.
 */

import { gunzipSync, gzipSync } from 'node:zlib';
import { PbfReader } from 'pbf';
import { VectorTile } from '@mapbox/vector-tile';
import geojsonvt from 'geojson-vt';
import { fromGeojsonVt } from 'vt-pbf';
import type { Feature } from 'geojson';
import type { MBTilesReader } from './mbtiles-reader.js';

// Must span the band ceilings the S-57 pipeline can combine: BAND_MAX_ZOOM
// runs z8 (band 1) to z18 (band 6), so a band-1-only area of a full-district
// set needs delta 10 at the deepest advertised zoom. Walk cost doesn't scale
// with delta (one indexed SELECT per probe).
export const MAX_OVERZOOM_DELTA = 10;

// geojson-vt indexes keep growing after construction: every getTile() caches
// the intermediate tiles it materializes and never evicts. Measured on the
// largest hole-adjacent ancestor in a real combined set (157 KB gzipped MVT):
// ~7 MB at build, ~15 MB after a 60-tile pan. Typical band-edge ancestors are
// ≤70 KB (~2 MB indexes). The caps below bound the worst case to tens of MB:
// 4 index slots, and each entry is dropped (rebuilt on next miss) after
// INDEX_SLICE_BUDGET slices so a long pan can't grow one entry unboundedly.
const INDEX_CACHE_SIZE = 4;
const INDEX_SLICE_BUDGET = 64;

// Stored (gzipped) ancestors beyond this size would index into hundreds of MB
// (tippecanoe runs with --no-tile-size-limit). Real hole-adjacent ancestors
// measure ≤160 KB; anything bigger is never indexed — the walk passes it like
// a blank tile, so a coarser ancestor may still cover its descendants —
// rather than risking an OOM on small-RAM hosts.
const MAX_ANCESTOR_BYTES = 256 * 1024;

const TILE_CACHE_SIZE = 256;

// Buffer-only edge tiles observed in real combined sets are 0.6–1.2 KB;
// 32 KB leaves generous headroom while keeping the worst-case blank check
// (one decode + bbox scan, ~1–2 ms, cached per tile) off large stored tiles.
const BLANK_CHECK_MAX_BYTES = 32 * 1024;

class LruMap<K, V> {
  private readonly map = new Map<K, V>();

  constructor(private readonly capacity: number) {}

  get(key: K): V | undefined {
    if (!this.map.has(key)) {
      return undefined;
    }
    const value = this.map.get(key) as V;
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.capacity) {
      const oldest = this.map.keys().next();
      if (!oldest.done) {
        this.map.delete(oldest.value);
      }
    }
  }

  delete(key: K): void {
    this.map.delete(key);
  }

  get size(): number {
    return this.map.size;
  }
}

interface AncestorEntry {
  // One geojson-vt index per source layer.
  indexes: Map<string, ReturnType<typeof geojsonvt>>;
  slices: number;
}

interface OverzoomState {
  indexes: LruMap<string, AncestorEntry>;
  // Ancestors that contribute nothing to any descendant — buffer-only
  // cell-edge tiles (all features outside their own extent) and oversized
  // tiles. Tracked separately from `indexes` so walking past them never
  // evicts a real index, and their (cheap) decode isn't repaid per walk.
  blankAncestors: LruMap<string, true>;
  // Cached nulls matter: empty ocean quadrants inside ancestor coverage get
  // hammered while panning and must not re-slice on every request.
  tiles: LruMap<string, Buffer | null>;
  // Blank-check verdicts for STORED tiles: the synthesized replacement, or
  // null for "serve the stored tile as-is" (not blank, nothing to
  // synthesize, or undecodable). Caching nulls keeps the decode+bbox scan
  // off repeats.
  replacements: LruMap<string, Buffer | null>;
}

const BLANK_ANCESTOR_CACHE_SIZE = 64;

// Keyed by reader instance: chart reload/rename/delete builds fresh readers,
// so stale entries are unreachable and collected without explicit eviction.
const states = new WeakMap<MBTilesReader, OverzoomState>();

function getState(reader: MBTilesReader): OverzoomState {
  let state = states.get(reader);
  if (!state) {
    state = {
      indexes: new LruMap(INDEX_CACHE_SIZE),
      blankAncestors: new LruMap(BLANK_ANCESTOR_CACHE_SIZE),
      tiles: new LruMap(TILE_CACHE_SIZE),
      replacements: new LruMap(TILE_CACHE_SIZE)
    };
    states.set(reader, state);
  }
  return state;
}

/** Test hook: cache occupancy for a reader (entries, not bytes). */
export function _overzoomCacheStats(reader: MBTilesReader): {
  indexes: number;
  tiles: number;
  replacements: number;
} {
  const state = states.get(reader);
  return {
    indexes: state?.indexes.size ?? 0,
    tiles: state?.tiles.size ?? 0,
    replacements: state?.replacements.size ?? 0
  };
}

function decodeTile(raw: Buffer): VectorTile {
  const bytes = raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw) : raw;
  return new VectorTile(new PbfReader(bytes));
}

/** True when at least one feature touches the tile's visible extent. */
function hasVisibleFeature(tile: VectorTile): boolean {
  for (const layer of Object.values(tile.layers)) {
    const extent = layer.extent;
    for (let i = 0; i < layer.length; i++) {
      const [x1, y1, x2, y2] = layer.feature(i).bbox();
      if (!(x2 < 0 || x1 > extent || y2 < 0 || y1 > extent)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Build geojson-vt indexes for an ancestor, or return null for ancestors
 * that can't contribute visible content to any descendant: buffer-only
 * cell-edge tiles (their features belong to the neighbor cell and land at
 * most in descendants' invisible buffer margins) and oversized tiles
 * (indexing them would cost hundreds of MB; the walk passes them so a
 * coarser ancestor can still cover their descendants).
 */
function buildAncestorEntry(raw: Buffer, az: number, ax: number, ay: number): AncestorEntry | null {
  if (raw.byteLength > MAX_ANCESTOR_BYTES) {
    console.warn(
      `Overzoom: ancestor tile ${az}/${ax}/${ay} is ${raw.byteLength} bytes ` +
        `(> ${MAX_ANCESTOR_BYTES}); skipping it — coarser ancestors may cover its descendants`
    );
    return null;
  }

  const tile = decodeTile(raw);
  if (!hasVisibleFeature(tile)) {
    return null;
  }

  const indexes: AncestorEntry['indexes'] = new Map();
  for (const [name, layer] of Object.entries(tile.layers)) {
    if (layer.length === 0) {
      continue;
    }
    const features: Feature[] = [];
    for (let i = 0; i < layer.length; i++) {
      features.push(layer.feature(i).toGeoJSON(ax, ay, az));
    }
    indexes.set(
      name,
      // maxZoom: 24 is required — geojson-vt's default of 14 makes getTile()
      // silently return null for deeper children. tolerance 3 (the default)
      // simplifies the intermediate drill-down tiles; at the requested zoom
      // it is ~3/4096 of a tile, below what the ancestor's own quantization
      // already lost, and it nearly halves index memory vs tolerance 0.
      geojsonvt(
        { type: 'FeatureCollection', features },
        { maxZoom: 24, indexMaxZoom: 0, tolerance: 3, buffer: 64, extent: 4096 }
      )
    );
  }

  return { indexes, slices: 0 };
}

/**
 * Synthesize a missing pbf tile from the nearest content-bearing ancestor.
 * Blank ancestors (buffer-only cell-edge tiles, oversized tiles) are walked
 * past; the first ancestor with visible content is authoritative — if its
 * slice of the requested quadrant is empty, the area is genuinely empty.
 * Returns a gzipped MVT buffer, or null when the chart is not pbf, no
 * ancestor within MAX_OVERZOOM_DELTA covers the quadrant (genuinely outside
 * coverage), or the quadrant is empty — all of which should keep today's
 * 404.
 */
export function getOverzoomedTile(
  reader: MBTilesReader,
  z: number,
  x: number,
  y: number
): Buffer | null {
  try {
    const info = reader.getInfo();
    if (info.format !== 'pbf') {
      return null;
    }
    const minzoom = info.minzoom ?? 0;
    if (z <= minzoom) {
      return null;
    }

    const state = getState(reader);
    const tileKey = `${z}/${x}/${y}`;
    const cached = state.tiles.get(tileKey);
    if (cached !== undefined) {
      return cached;
    }

    // Levels above the advertised maxzoom hold no tiles; start probing below.
    const maxzoom = info.maxzoom ?? z - 1;
    const dStart = Math.max(1, z - maxzoom);

    for (let d = dStart; d <= MAX_OVERZOOM_DELTA; d++) {
      const az = z - d;
      if (az < minzoom) {
        break;
      }
      const ax = x >> d;
      const ay = y >> d;
      const entryKey = `${az}/${ax}/${ay}`;

      // Walk past known-blank ancestors (buffer-only cell-edge or oversized
      // tiles): a deeper band may cover the area, and stopping at them would
      // re-blank every zoom above. Content-bearing ancestors are
      // authoritative below — never walked past — so a request builds at
      // most ONE index; anything else would thrash the index LRU on every
      // empty-quadrant miss while panning.
      if (state.blankAncestors.get(entryKey)) {
        continue;
      }
      let entry = state.indexes.get(entryKey);
      if (!entry) {
        const raw = reader.getRawTile(az, ax, ay);
        if (!raw) {
          continue;
        }
        const built = buildAncestorEntry(raw, az, ax, ay);
        if (!built) {
          state.blankAncestors.set(entryKey, true);
          continue;
        }
        entry = built;
        state.indexes.set(entryKey, entry);
      }

      const layers: Record<string, { features: unknown[] }> = {};
      let hasFeatures = false;
      for (const [name, index] of entry.indexes) {
        const sliced = index.getTile(z, x, y);
        if (sliced && sliced.features.length > 0) {
          layers[name] = sliced;
          hasFeatures = true;
        }
      }

      // geojson-vt retains every intermediate tile a slice materializes, so
      // an entry grows with use; retire it after a budget of slices and let
      // the next miss rebuild it fresh (synthesized children stay cached).
      entry.slices++;
      if (entry.slices >= INDEX_SLICE_BUDGET) {
        state.indexes.delete(entryKey);
      }

      if (!hasFeatures) {
        // The nearest content-bearing ancestor has nothing in this quadrant:
        // the area is genuinely empty (ocean outside any feature). Cache the
        // null — deeper ancestors cover the same geography and would only
        // repeat the answer at lower detail.
        break;
      }

      // version: 2 is required — vt-pbf defaults to MVT v1, tippecanoe
      // emits v2.
      const encoded = fromGeojsonVt(layers, { version: 2, extent: 4096 });
      const result = gzipSync(encoded);
      state.tiles.set(tileKey, result);
      return result;
    }

    state.tiles.set(tileKey, null);
    return null;
  } catch (err) {
    // A corrupt ancestor must degrade to 404, never bubble into the route's
    // 500 path. Not cached so a transient failure can recover.
    console.error(`Error synthesizing overzoom tile ${z}/${x}/${y}:`, err);
    return null;
  }
}

/**
 * Replacement for a STORED pbf tile that would render blank: tippecanoe
 * writes chart-cell edge tiles whose features all sit in the buffer zone
 * outside the visible extent (the neighbor cell's content, clipped in).
 * Returns a synthesized tile from the nearest ancestor — the invisible
 * buffer features aren't merged in; neighbors carry their own copies — or
 * null when the stored tile should be served as-is (has visible features,
 * is too large to cheaply check, undecodable, or there is nothing to
 * synthesize from).
 */
export function getBlankTileReplacement(
  reader: MBTilesReader,
  z: number,
  x: number,
  y: number,
  raw: Buffer
): Buffer | null {
  let state: OverzoomState | undefined;
  const tileKey = `${z}/${x}/${y}`;
  try {
    if (raw.byteLength > BLANK_CHECK_MAX_BYTES) {
      return null;
    }
    const info = reader.getInfo();
    if (info.format !== 'pbf') {
      return null;
    }

    state = getState(reader);
    const cached = state.replacements.get(tileKey);
    if (cached !== undefined) {
      return cached;
    }

    let replacement: Buffer | null = null;
    if (!hasVisibleFeature(decodeTile(raw))) {
      replacement = getOverzoomedTile(reader, z, x, y);
      if (replacement === null && state.tiles.get(tileKey) === undefined) {
        // getOverzoomedTile errored (its legit nulls are recorded in the
        // tiles cache). Don't pin the verdict — a transient failure should
        // be able to recover on a later request.
        return null;
      }
    }
    state.replacements.set(tileKey, replacement);
    return replacement;
  } catch (err) {
    // A corrupt stored tile must fall back to serving its original bytes,
    // never bubble into the route's 500 path. The stored bytes can't change
    // within this reader's lifetime, so cache the verdict — otherwise every
    // serve of that tile would re-decode and re-log.
    console.error(`Error checking blank tile ${tileKey}:`, err);
    state?.replacements.set(tileKey, null);
    return null;
  }
}
