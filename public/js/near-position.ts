// "Near me" for the Chart Catalog and Online Charts tabs: whether a chart's
// box covers the boat.

// How far outside a chart's box still counts as "near": about 60 nm, so a
// boat just off a coverage edge (or at anchor outside a harbor chart's box)
// still sees it.
const NEAR_ME_MARGIN_DEG = 1;

function isBoundingBox(v: unknown): v is number[] {
  return Array.isArray(v) && v.length === 4 && v.every((n) => Number.isFinite(n));
}

/** Whether `bbox` ([w, s, e, n], west > east crossing the antimeridian) is near `position`. */
function isNearPosition(
  bbox: number[] | undefined,
  position: { latitude: number; longitude: number } | null
): boolean {
  if (!position || !isBoundingBox(bbox)) {
    return false;
  }
  const [west = 0, south = 0, east = 0, north = 0] = bbox;
  const { latitude, longitude } = position;
  const m = NEAR_ME_MARGIN_DEG;
  if (latitude < south - m || latitude > north + m) {
    return false;
  }
  // A degree of longitude shrinks toward the poles; widen the margin so it
  // stays about the same distance.
  const mLon = m / Math.max(Math.cos((latitude * Math.PI) / 180), 0.05);
  const span = west <= east ? east - west : east + 360 - west;
  if (span + 2 * mLon >= 360) {
    return true;
  }
  // Measure eastward from the widened west edge, modulo 360, so boxes and
  // margins that cross the antimeridian need no special case.
  const offset = (((longitude - (west - mLon)) % 360) + 360) % 360;
  return offset <= span + 2 * mLon;
}

window.isBoundingBox = isBoundingBox;
window.isNearPosition = isNearPosition;
