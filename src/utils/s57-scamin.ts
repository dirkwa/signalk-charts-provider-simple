/**
 * The zoom from which an S-57 feature belongs in vector tiles, from its
 * SCAMIN attribute. Both toolchains use it: the container one stamps it as
 * each feature's `tippecanoe.minzoom` (s57-container.ts), the WebAssembly one
 * carries it through the tiler (vector-tile-shard.ts).
 */

/**
 * Scale denominator of a 256 px web-mercator tile at zoom 0 on the equator,
 * with the OGC standard rendering pixel of 0.28 mm.
 */
const ZOOM0_SCALE_DENOMINATOR = 559082264.0287178;

/**
 * The lowest zoom whose tiles should carry a feature with an S-57 SCAMIN
 * attribute. S-52 hides a feature while the display scale is smaller than
 * 1:SCAMIN, so at zooms below this one no client would draw it, yet every
 * tile would still have to ship and decode it (soundings above all).
 *
 * The web-mercator scale grows towards the poles, and a minzoom applies to
 * the whole feature, so the feature's position farthest from the equator
 * decides: the part of it that qualifies first must not be missing.
 * Rounded up, because OpenLayers draws a fractional zoom from the next
 * higher zoom's tiles by default, so the feature still shows from the
 * integer zoom below. Null when the feature has no usable SCAMIN or position.
 */
export function scaminMinzoom(feature: unknown): number | null {
  if (typeof feature !== 'object' || feature === null) {
    return null;
  }
  const f = feature as { properties?: unknown; geometry?: unknown };
  const props = f.properties as Record<string, unknown> | null | undefined;
  const scamin = Number(props?.SCAMIN);
  if (!Number.isFinite(scamin) || scamin <= 0) {
    return null;
  }
  const geometry = f.geometry as { coordinates?: unknown } | null | undefined;
  const latitude = farthestLatitude(geometry?.coordinates);
  if (latitude === null) {
    return null;
  }
  const denominatorAtZoom0 = ZOOM0_SCALE_DENOMINATOR * Math.cos((latitude * Math.PI) / 180);
  return Math.max(0, Math.ceil(Math.log2(denominatorAtZoom0 / scamin)));
}

/**
 * The largest absolute latitude among a GeoJSON geometry's positions, at any
 * nesting depth (point, line, polygon, multi-geometries). Null when there is
 * no position short of a pole.
 */
function farthestLatitude(coordinates: unknown): number | null {
  if (!Array.isArray(coordinates)) {
    return null;
  }
  const items = coordinates as unknown[];
  if (typeof items[0] === 'number') {
    const latitude = items[1];
    return typeof latitude === 'number' && Math.abs(latitude) < 90 ? Math.abs(latitude) : null;
  }
  let farthest: number | null = null;
  for (const child of items) {
    const latitude = farthestLatitude(child);
    if (latitude !== null && (farthest === null || latitude > farthest)) {
      farthest = latitude;
    }
  }
  return farthest;
}
