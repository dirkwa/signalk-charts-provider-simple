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

// ---- The boat on the ENC Charts and Open Data Charts maps ----

/** The boat's last position from Signal K, or null without a fix or read access. */
async function fetchVesselPosition(): Promise<{ latitude: number; longitude: number } | null> {
  try {
    const response = await fetch('/plugins/signalk-charts-provider-simple/vessel-position');
    if (!response.ok) {
      return null;
    }
    const { position } = (await response.json()) as {
      position: { latitude: number; longitude: number } | null;
    };
    return position ?? null;
  } catch {
    return null;
  }
}

/** Marks the boat on a map and adds a button that brings it back into view. */
function showVesselOnMap(
  map: L.Map,
  position: { latitude: number; longitude: number },
  goToVessel: () => void
): void {
  L.circleMarker([position.latitude, position.longitude], {
    radius: 7,
    color: '#ffffff',
    weight: 2,
    fillColor: '#d81b60',
    fillOpacity: 1,
    interactive: false
  }).addTo(map);
  const VesselControl = L.Control.extend({
    onAdd(): HTMLElement {
      const bar = L.DomUtil.create('div', 'leaflet-bar');
      const button = L.DomUtil.create('button', 'vessel-button', bar);
      button.type = 'button';
      button.title = 'Go to vessel';
      button.setAttribute('aria-label', 'Go to vessel');
      button.innerHTML =
        '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="12" cy="12" r="5" fill="#d81b60" stroke="#fff" stroke-width="2"/><path d="M12 1v4M12 19v4M1 12h4M19 12h4" stroke="currentColor" stroke-width="2"/></svg>';
      L.DomEvent.disableClickPropagation(bar);
      L.DomEvent.on(button, 'click', () => {
        goToVessel();
      });
      return bar;
    }
  });
  new VesselControl({ position: 'topleft' }).addTo(map);
}

window.fetchVesselPosition = fetchVesselPosition;
window.showVesselOnMap = showVesselOnMap;
