/** The boat's position, as the Chart Catalog's "Near me" filter uses it. */
export interface VesselPosition {
  latitude: number;
  longitude: number;
}

/**
 * Read `navigation.position` from what `app.getSelfPath` returns: the
 * path's node (`{ value: { latitude, longitude }, … }`) on current servers,
 * or the bare value. Null for anything that isn't a finite, in-range
 * position.
 */
export function readVesselPosition(node: unknown): VesselPosition | null {
  const value: unknown =
    node !== null && typeof node === 'object' && 'value' in node ? node.value : node;
  if (value === null || typeof value !== 'object') {
    return null;
  }
  const { latitude, longitude } = value as { latitude?: unknown; longitude?: unknown };
  return typeof latitude === 'number' &&
    typeof longitude === 'number' &&
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    Math.abs(latitude) <= 90 &&
    Math.abs(longitude) <= 180
    ? { latitude, longitude }
    : null;
}
