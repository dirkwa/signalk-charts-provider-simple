// ENC Charts tab — build a named "chart set" by picking ENC units on a map
// of the ENC index: NOAA's band-4 boxes, drawn as rectangles, and every
// other free ENC source's cells, drawn as their coverage outlines. The
// cells the picked units bring in are downloaded and converted server-side
// into one MBTiles per chart set. (The API/server modules keep the generic
// "custom-catalog" names.)

const CC_API_BASE = '/plugins/signalk-charts-provider-simple';

// Selected-area fill colours, by state.
const CC_RED = '#e53935'; // selected, needs download / out of date
const CC_YELLOW = '#f6c000'; // downloaded / in progress, not yet converted
const CC_GREEN = '#2e9e4f'; // downloaded + converted, up to date

const CC_NOAA_SOURCE = 'noaa';
// A click or hover this close to a thin river outline still picks it.
const CC_HIT_TOLERANCE_PX = 6;
// Ask before a dragged box changes more units than this.
const CC_BOX_CONFIRM_ABOVE = 50;
// A press that moves less than this is a click on one area, not a box.
const CC_DRAG_THRESHOLD_PX = 6;
const CC_WORLD_CENTER: L.LatLngExpression = [20, 0];
const CC_WORLD_ZOOM = 2;
// How long the "create a chart set first" hint stays up.
const CC_SET_HINT_MS = 5000;

type CcPosition = [number, number];
type CcOutline =
  | { type: 'Polygon'; coordinates: CcPosition[][] }
  | { type: 'MultiPolygon'; coordinates: CcPosition[][][] };

interface CcUnit {
  source: string;
  id: string;
  title: string;
  scale?: number;
  /** [west, south, east, north]; west > east crosses the antimeridian. */
  bbox: [number, number, number, number];
  outline: CcOutline;
}

interface CcSource {
  id: string;
  label: string;
  units: number;
}

interface CcIndexStatus {
  status: 'ok' | 'error' | 'incompatible' | 'never';
  message: string | null;
}

interface EncIndexResponse {
  status: CcIndexStatus;
  /** When this server last downloaded or revalidated the index. */
  fetchedAt: string | null;
  index: {
    generatedAt: string;
    sources: CcSource[];
    units: CcUnit[];
  } | null;
}

type CustomCatalogStatus = 'empty' | 'out_of_date' | 'downloaded' | 'converted';

interface CustomCatalog {
  id: string;
  name: string;
  selectedBand4ChartIds: string[];
  selectedUnitIds: string[];
  includedChartIds: string[];
  convertedChartPath: string | null;
  status: CustomCatalogStatus;
  lastConvertedAt: string | null;
  // Decorated server-side fields.
  effectiveStatus: string;
  includedCount: number;
  updateReasons: string[];
  // Per-unit freshness by cell version: unit id -> 'up_to_date' | 'needs_refresh'.
  boxStates: Record<string, string>;
  // Selected units the index no longer lists (nothing to click on the map).
  missingUnitIds: string[];
  // Selected units the index lists in a form this version cannot read.
  unreadableUnitIds: string[];
  // Disk the set's kept cells take (raw cells and their GDAL output).
  cacheBytes: number;
}

interface CatalogProgress {
  status: string;
  message: string;
  log: string[];
}

type CatalogPhase =
  | 'preparing'
  | 'downloading'
  | 'converting'
  | 'joining'
  | 'completed'
  | 'cancelling'
  | 'cancelled'
  | 'failed';

interface CatalogProgressDetail {
  phase: CatalogPhase;
  overallPercent: number;
  sectionLabel: string;
  sectionPercent: number;
  downloadedChartIds: string[];
  coverageByBox?: Record<string, string[]>;
}

interface CatalogStatusResponse extends CustomCatalog {
  busy: boolean;
  progress: CatalogProgress | null;
  detail: CatalogProgressDetail | null;
}

/** A unit as drawn: its layer, and its outline in a form cheap to hit-test. */
interface CcDrawnUnit {
  unit: CcUnit;
  layer: L.Path;
  /** West/east with east >= west, unwrapped across the antimeridian. */
  west: number;
  east: number;
  /** Exterior rings as [lon, lat], unwrapped like west/east. */
  rings: CcPosition[][];
  /** Rough size, for picking the smallest of overlapping units. */
  area: number;
  /** Whole turns (degrees) the layer is drawn shifted by; see ccFollowWorld. */
  shift: number;
}

let ccInitialized = false;
let ccMap: L.Map | null = null;
let ccFootprintLayer: L.LayerGroup | null = null;
// Markers for selected units too small to see at the current zoom.
let ccSmallLayer: L.LayerGroup | null = null;
let ccRenderer: L.Renderer | null = null;
const ccDrawnById = new Map<string, CcDrawnUnit>();
// Per-box bottom-to-top "fill" overlays on NOAA rectangles, shown during download.
const ccFillRects = new Map<string, L.Rectangle>();
let ccUnits: CcUnit[] = [];
let ccCatalogs: CustomCatalog[] = [];
let ccActiveId: string | null = null;
let ccBusy = false;
let ccDetail: CatalogProgressDetail | null = null;
let ccStatusPoll: ReturnType<typeof setInterval> | null = null;
let ccHoverId: string | null = null;
let ccHoverTip: L.Tooltip | null = null;
// Dragging picks chart areas while a set is open; this turns it back into panning.
let ccPanMode = false;
let ccSetHintTimer: ReturnType<typeof setTimeout> | null = null;
// A box drag ends with a click the map must not treat as a unit toggle.
let ccSuppressClick = false;
// Source id → display name, from the index.
const ccSources = new Map<string, string>();

window.handleCustomCatalogsTabActive = function (): void {
  if (!ccInitialized) {
    void initCustomCatalogsTab();
    return;
  }
  // Leaflet sizes itself to its container; the map was created while the tab
  // was display:none, so recompute now that it's visible.
  ccMap?.invalidateSize();
  void loadCatalogs();
};

async function initCustomCatalogsTab(): Promise<void> {
  ccInitialized = true;
  const output = document.getElementById('customCatalogsOutput');
  if (!output) {
    return;
  }

  output.innerHTML = `
    <div class="cc-container">
      <div class="cc-left">
        <div class="cc-list-header">Chart sets</div>
        <div id="ccList" class="cc-list"></div>
        <div id="ccNewForm" class="cc-new-form" style="display:none;">
          <input type="text" id="ccNewName" class="cc-input" placeholder="Chart set name" maxlength="120" />
          <div class="cc-new-form-actions">
            <button class="cc-btn cc-btn-primary" data-cc-action="create">Create</button>
            <button class="cc-btn" data-cc-action="create-cancel">Cancel</button>
          </div>
        </div>
        <div class="cc-actions">
          <button class="cc-btn cc-btn-primary" data-cc-action="new">New</button>
          <button class="cc-btn cc-btn-primary" id="ccDownloadBtn" data-cc-action="download" disabled>Download &amp; Convert</button>
          <button class="cc-btn cc-btn-danger" id="ccDeleteBtn" data-cc-action="delete" disabled>Delete</button>
        </div>
        <div id="ccDetail" class="cc-detail"></div>
        <div id="ccProgress" class="cc-progress"></div>
        <pre id="ccLog" class="cc-log" style="display:none;"></pre>
      </div>
      <div class="cc-right">
        <div class="cc-map-note">
          <span id="ccMapNote">Loading ENC chart areas…</span>
          <button class="cc-link-btn" data-cc-action="refresh-index">Refresh</button>
        </div>
        <div class="cc-map-tools">
          <span class="cc-map-hint" id="ccMapHint"></span>
          <button class="cc-btn" id="ccPanBtn" data-cc-action="pan-mode" aria-pressed="false"
            title="Drag to move the map instead of picking chart areas">Move map</button>
        </div>
        <div id="ccMap" class="cc-map"></div>
        <div class="cc-legend">
          <span class="cc-legend-item"><span class="cc-swatch cc-swatch-clear"></span>Available</span>
          <span class="cc-legend-item"><span class="cc-swatch cc-swatch-red"></span>Needs download</span>
          <span class="cc-legend-item"><span class="cc-swatch cc-swatch-yellow"></span>Downloaded</span>
          <span class="cc-legend-item"><span class="cc-swatch cc-swatch-green"></span>Up to date</span>
        </div>
      </div>
    </div>
  `;

  wireCustomCatalogHandlers();
  initCustomCatalogMap();
  updateMapMode();
  await Promise.all([loadCatalogs(), loadEncIndex()]);
  // Both the chart-set list (auto-selects the first) and the units are now
  // loaded. The map was created the instant this tab became visible, so Leaflet
  // may have cached a stale (zero) container size; recompute it, then frame the
  // active set (or every unit if none). Deferred a tick so layout has settled,
  // and non-animated since it's the only fit now.
  window.setTimeout(() => {
    ccMap?.invalidateSize();
    const cat = ccActiveCatalog();
    if (cat && ccSelectedIds(cat).size > 0) {
      fitMapToActiveCatalog({ animate: false });
    } else {
      showWholeWorld({ animate: false });
    }
  }, 0);
}

function initCustomCatalogMap(): void {
  if (ccMap || typeof L === 'undefined') {
    return;
  }
  const el = document.getElementById('ccMap');
  if (!el) {
    return;
  }
  // A drag picks units by box here, so Leaflet's own Shift+drag zoom is
  // turned off. A canvas renderer keeps thousands of outlines responsive.
  ccMap = L.map(el, { worldCopyJump: true, minZoom: CC_WORLD_ZOOM, boxZoom: false }).setView(
    CC_WORLD_CENTER,
    CC_WORLD_ZOOM
  );
  ccRenderer = L.canvas({ padding: 0.5 });
  // OpenSeaMap = OSM base + a seamark overlay. Tiles need internet; if they
  // fail the units stay fully usable, so selection still works offline.
  // The Signal K server sends Referrer-Policy: no-referrer, which strips the
  // Referer from tile requests; OSM's usage policy then answers with an "Access
  // blocked" placeholder tile. A per-image policy overrides the document one and
  // sends the bare origin only, never the page path or query.
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18,
    referrerPolicy: 'origin',
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(ccMap);
  L.tileLayer('https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png', {
    maxZoom: 18,
    referrerPolicy: 'origin',
    attribution: 'Seamarks &copy; OpenSeaMap'
  }).addTo(ccMap);
  ccFootprintLayer = L.layerGroup().addTo(ccMap);
  ccSmallLayer = L.layerGroup().addTo(ccMap);
  ccMap.on('moveend', () => {
    ccFollowWorld();
    updateSmallMarkers();
  });
  ccHoverTip = L.tooltip({ direction: 'top', offset: [0, -6] });

  // Units are not interactive themselves: overlapping outlines are resolved
  // here, so a click picks the unit the user means (see ccUnitAt).
  ccMap.on('click', (ev: L.LeafletMouseEvent) => {
    if (ccSuppressClick) {
      ccSuppressClick = false;
      return;
    }
    const hit = ccUnitAt(ev.latlng);
    if (hit) {
      void onAreaClick(hit.unit);
    }
  });
  ccMap.on('mousemove', (ev: L.LeafletMouseEvent) => {
    onHover(ccUnitAt(ev.latlng), ev.latlng);
  });
  ccMap.on('mouseout', () => {
    onHover(null, null);
  });
  wireDragSelect(el);
}

function ccClearStyle(): L.PathOptions {
  return { color: '#5b6b7a', weight: 1, fillColor: '#8aa0b4', fillOpacity: 0.05 };
}

function ccSelectedStyle(color: string): L.PathOptions {
  return { color, weight: 2, fillColor: color, fillOpacity: 0.35 };
}

function ccActiveCatalog(): CustomCatalog | null {
  return ccCatalogs.find((c) => c.id === ccActiveId) ?? null;
}

/** Every unit a set has selected; NOAA and other ids share one namespace. */
function ccSelectedIds(cat: CustomCatalog | null): Set<string> {
  return new Set(cat ? [...cat.selectedBand4ChartIds, ...cat.selectedUnitIds] : []);
}

function ccStatusColor(cat: CustomCatalog): string {
  if (ccBusy && cat.id === ccActiveId) {
    return CC_YELLOW;
  }
  switch (cat.effectiveStatus) {
    case 'converted':
      return CC_GREEN;
    case 'downloaded':
      return CC_YELLOW;
    default:
      return CC_RED;
  }
}

function ccStatusClass(cat: CustomCatalog): string {
  if (ccBusy && cat.id === ccActiveId) {
    return 'yellow';
  }
  switch (cat.effectiveStatus) {
    case 'converted':
      return 'green';
    case 'downloaded':
      return 'yellow';
    case 'empty':
      return 'clear';
    default:
      return 'red';
  }
}

function ccStatusLabel(cat: CustomCatalog): string {
  if (ccBusy && cat.id === ccActiveId) {
    return 'Working…';
  }
  switch (cat.effectiveStatus) {
    case 'converted':
      return 'Up to date';
    case 'downloaded':
      return 'Downloaded, not converted';
    case 'empty':
      return 'No chart areas selected';
    default:
      return 'Needs download & convert';
  }
}

function ccSourceLabel(sourceId: string): string {
  return ccSources.get(sourceId) ?? sourceId;
}

async function loadEncIndex(forceRefresh = false): Promise<void> {
  const note = document.getElementById('ccMapNote');
  if (note && forceRefresh) {
    note.textContent = 'Refreshing ENC chart areas…';
  }
  try {
    const resp = await fetch(
      `${CC_API_BASE}/custom-catalogs/enc-index${forceRefresh ? '?refresh=1' : ''}`
    );
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`);
    }
    const data = (await resp.json()) as EncIndexResponse;
    if (data.index) {
      ccUnits = data.index.units;
      ccSources.clear();
      for (const s of data.index.sources) {
        ccSources.set(s.id, s.label);
      }
      drawUnits();
      // The list's status colours depend on the index the server now holds.
      void loadCatalogs();
    }
    renderMapNote(data);
  } catch {
    if (note) {
      note.textContent = 'Could not load the ENC chart areas from this server.';
    }
  }
}

function renderMapNote(data: EncIndexResponse): void {
  const note = document.getElementById('ccMapNote');
  if (!note) {
    return;
  }
  if (!data.index) {
    note.textContent =
      data.status.message ??
      "The ENC index has not been downloaded yet. It lists the chart areas to pick from; check this device's internet connection, then click Refresh.";
    return;
  }
  const sourceCount = data.index.sources.filter((s) => s.units > 0).length;
  const stale =
    data.status.status === 'error' || data.status.status === 'incompatible'
      ? ` (saved copy from ${data.fetchedAt ? new Date(data.fetchedAt).toLocaleDateString() : 'an earlier start'}; ${data.status.message ?? 'refresh failed'})`
      : '';
  note.textContent = `${ccUnits.length} chart areas from ${sourceCount} sources${stale}.`;
  note.title = data.index.sources
    .filter((s) => s.units > 0)
    .map((s) => `${s.label}: ${s.units}`)
    .join('\n');
}

/** Exterior rings of an outline as [lon, lat] lists. */
function ccOutlineRings(outline: CcOutline): CcPosition[][] {
  return outline.type === 'Polygon'
    ? [outline.coordinates[0]]
    : outline.coordinates.map((polygon) => polygon[0]);
}

function drawUnits(): void {
  if (!ccMap || !ccFootprintLayer) {
    return;
  }
  ccFootprintLayer.clearLayers();
  ccDrawnById.clear();
  ccFillRects.clear();
  for (const unit of ccUnits) {
    const [w, s, e, n] = unit.bbox;
    const west = w;
    const east = e < w ? e + 360 : e;
    const unwrap = (p: CcPosition): CcPosition => [e < w && p[0] < w ? p[0] + 360 : p[0], p[1]];
    const rings = ccOutlineRings(unit.outline).map((ring) => ring.map(unwrap));
    let layer: L.Path;
    if (unit.source === CC_NOAA_SOURCE) {
      layer = L.rectangle(
        [
          [s, west],
          [n, east]
        ],
        { ...ccClearStyle(), interactive: false, renderer: ccRenderer ?? undefined }
      );
    } else {
      layer = L.polygon(
        rings.map((ring) => ring.map(([lon, lat]) => L.latLng(lat, lon))),
        { ...ccClearStyle(), interactive: false, renderer: ccRenderer ?? undefined }
      );
    }
    layer.addTo(ccFootprintLayer);
    const area = (east - west) * (n - s) * Math.cos((((n + s) / 2) * Math.PI) / 180);
    ccDrawnById.set(unit.id, { unit, layer, west, east, rings, area, shift: 0 });
  }
  // Note: the map view is framed by init / selectCatalog (fitMapToActiveCatalog
  // or showWholeWorld), not here — a fit during draw competed with the
  // initial set fit and won the race, leaving the wide view.
  refreshAreaColors();
}

// ---- Hit testing ----

function ccInRing(lon: number, lat: number, ring: CcPosition[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** Distance in screen pixels from a point to a ring's edges. */
function ccRingDistancePx(map: L.Map, point: L.Point, ring: CcPosition[]): number {
  let best = Infinity;
  let prev: L.Point | null = null;
  for (const [lon, lat] of ring) {
    const cur = map.latLngToContainerPoint([lat, lon]);
    if (prev) {
      best = Math.min(best, L.LineUtil.pointToSegmentDistance(point, prev, cur));
    }
    prev = cur;
  }
  return best;
}

/** The point's longitude shifted by whole turns into the unit's unwrapped range. */
function ccLonFor(drawn: CcDrawnUnit, lon: number): number {
  let x = lon;
  while (x < drawn.west - 180) {
    x += 360;
  }
  while (x > drawn.west + 180) {
    x -= 360;
  }
  return x;
}

/**
 * The unit under a point. Where outlines overlap (a NOAA box and the river
 * overlay, adjacent river cells, a harbour cell inside an approach cell) the
 * smallest wins, as the most specific choice; the larger one is still
 * clickable where it is alone. A point just outside a thin outline, within a
 * few pixels, still counts, so narrow river cells can be clicked.
 */
function ccUnitAt(latlng: L.LatLng): CcDrawnUnit | null {
  if (!ccMap) {
    return null;
  }
  const map = ccMap;
  const point = map.latLngToContainerPoint(latlng);
  const tolDeg = Math.abs(
    map.containerPointToLatLng([point.x + CC_HIT_TOLERANCE_PX, point.y]).lng - latlng.lng
  );
  let inside: CcDrawnUnit | null = null;
  let near: CcDrawnUnit | null = null;
  let nearDist = Infinity;
  for (const drawn of ccDrawnById.values()) {
    const lon = ccLonFor(drawn, latlng.lng);
    const [, s, , n] = drawn.unit.bbox;
    if (
      lon < drawn.west - tolDeg ||
      lon > drawn.east + tolDeg ||
      latlng.lat < s - tolDeg ||
      latlng.lat > n + tolDeg
    ) {
      continue;
    }
    if (drawn.rings.some((ring) => ccInRing(lon, latlng.lat, ring))) {
      if (!inside || drawn.area < inside.area) {
        inside = drawn;
      }
      continue;
    }
    if (inside) {
      continue;
    }
    const shifted = L.latLng(latlng.lat, lon);
    const p = map.latLngToContainerPoint(shifted);
    const d = Math.min(...drawn.rings.map((ring) => ccRingDistancePx(map, p, ring)));
    if (d <= CC_HIT_TOLERANCE_PX && (d < nearDist || (d === nearDist && near && drawn.area < near.area))) {
      near = drawn;
      nearDist = d;
    }
  }
  return inside ?? near;
}

function ccSegmentsCross(a: CcPosition, b: CcPosition, c: CcPosition, d: CcPosition): boolean {
  const cross = (p: CcPosition, q: CcPosition, r: CcPosition): number =>
    (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  return d1 * d2 <= 0 && d3 * d4 <= 0;
}

/** Whether a unit's outline touches a lon/lat box (west <= east, unwrapped). */
function ccTouchesBox(
  drawn: CcDrawnUnit,
  west: number,
  south: number,
  east: number,
  north: number
): boolean {
  const shift = ccLonFor(drawn, (west + east) / 2) - (west + east) / 2;
  const w = west + shift;
  const e = east + shift;
  const [, s, , n] = drawn.unit.bbox;
  if (drawn.east < w || drawn.west > e || n < south || s > north) {
    return false;
  }
  const corners: CcPosition[] = [
    [w, south],
    [e, south],
    [e, north],
    [w, north]
  ];
  for (const ring of drawn.rings) {
    if (ring.some(([x, y]) => x >= w && x <= e && y >= south && y <= north)) {
      return true;
    }
    if (corners.some(([x, y]) => ccInRing(x, y, ring))) {
      return true;
    }
    for (let i = 1; i < ring.length; i++) {
      for (let k = 0; k < 4; k++) {
        if (ccSegmentsCross(ring[i - 1], ring[i], corners[k], corners[(k + 1) % 4])) {
          return true;
        }
      }
    }
  }
  return false;
}

// ---- Hover ----

function onHover(drawn: CcDrawnUnit | null, latlng: L.LatLng | null): void {
  const id = drawn?.unit.id ?? null;
  if (ccMap && ccHoverTip) {
    if (drawn && latlng) {
      const u = drawn.unit;
      const title = u.title && u.title !== u.id ? u.title : '';
      ccHoverTip
        .setLatLng(latlng)
        .setContent(
          `<strong>${ccEscHtml(u.id)}</strong>${title ? ` — ${ccEscHtml(title)}` : ''}<br>${ccEscHtml(ccSourceLabel(u.source))}${
            u.scale ? ` · 1:${u.scale.toLocaleString()}` : ''
          }`
        );
      if (!ccMap.hasLayer(ccHoverTip)) {
        ccHoverTip.addTo(ccMap);
      }
    } else if (ccMap.hasLayer(ccHoverTip)) {
      ccMap.removeLayer(ccHoverTip);
    }
    ccMap.getContainer().style.cursor = drawn ? 'pointer' : ccDragSelects() ? 'crosshair' : '';
  }
  if (id === ccHoverId) {
    return;
  }
  const previous = ccHoverId;
  ccHoverId = id;
  if (previous) {
    styleUnit(previous);
  }
  if (id) {
    styleUnit(id);
  }
}

// ---- Box selection ----

/** Whether the open set takes changes now; a set being built does not. */
function ccCanSelect(): boolean {
  return ccActiveCatalog() !== null && !ccBusy;
}

function ccDragSelects(): boolean {
  return ccCanSelect() && !ccPanMode;
}

function setPanMode(on: boolean): void {
  ccPanMode = on;
  updateMapMode();
}

/** Brings the Move map button, cursor and instructions in line with the state. */
function updateMapMode(): void {
  const canSelect = ccCanSelect();
  const selecting = ccDragSelects();
  const btn = document.getElementById('ccPanBtn') as HTMLButtonElement | null;
  if (btn) {
    btn.style.display = canSelect ? '' : 'none';
    btn.classList.toggle('cc-btn-active', canSelect && ccPanMode);
    btn.setAttribute('aria-pressed', canSelect && ccPanMode ? 'true' : 'false');
  }
  const el = ccMap?.getContainer();
  if (el) {
    el.classList.toggle('cc-selecting', selecting);
    el.style.cursor = selecting ? 'crosshair' : '';
  }
  const hint = document.getElementById('ccMapHint');
  if (!hint || ccSetHintTimer !== null) {
    return;
  }
  if (!ccActiveCatalog()) {
    hint.textContent = 'Click New to start a chart set, then pick its chart areas on the map.';
  } else if (ccBusy) {
    hint.textContent = 'Chart areas can be changed again once this chart set is done.';
  } else if (ccPanMode) {
    hint.textContent = 'Drag to move the map. Turn off Move map to pick chart areas again.';
  } else {
    hint.textContent =
      'Drag across chart areas to add them, or tap one to add or remove it. To pan, use two fingers or';
  }
}

/** Points at New when areas are picked before any chart set is open. */
function showSetHint(): void {
  const hint = document.getElementById('ccMapHint');
  const newBtn = document.querySelector<HTMLElement>('[data-cc-action="new"]');
  if (ccSetHintTimer !== null) {
    clearTimeout(ccSetHintTimer);
  }
  if (hint) {
    hint.textContent =
      'Create a chart set first: click New and give it a name. Then click or drag over chart areas to add them.';
    hint.classList.add('cc-map-hint-warn');
  }
  newBtn?.classList.add('cc-btn-pulse');
  ccSetHintTimer = setTimeout(() => {
    ccSetHintTimer = null;
    hint?.classList.remove('cc-map-hint-warn');
    newBtn?.classList.remove('cc-btn-pulse');
    updateMapMode();
  }, CC_SET_HINT_MS);
}

// While a set is open, a drag draws a box and adds every unit it touches;
// a click still toggles one unit. Leaflet's own one-finger panning is turned
// off for the gesture only, so a two-finger pinch keeps moving and zooming
// the map. With Move map on, a drag pans and Shift+drag draws the box.
function wireDragSelect(el: HTMLElement): void {
  const touches = new Set<number>();
  let pointerId: number | null = null;
  let startPoint: L.Point | null = null;
  let start: L.LatLng | null = null;
  let box: L.Rectangle | null = null;

  const reset = (): void => {
    if (box && ccMap) {
      ccMap.removeLayer(box);
    }
    box = null;
    start = null;
    startPoint = null;
    pointerId = null;
  };

  el.addEventListener(
    'pointerdown',
    (ev: PointerEvent) => {
      if (!ccMap) {
        return;
      }
      if (ev.pointerType === 'touch') {
        touches.add(ev.pointerId);
        if (touches.size > 1) {
          // A second finger: Leaflet pinches, and no box is drawn.
          reset();
          return;
        }
      }
      if (ev.button !== 0 || !ccCanSelect() || (ccPanMode && !ev.shiftKey)) {
        return;
      }
      if ((ev.target as HTMLElement | null)?.closest('.leaflet-control')) {
        return;
      }
      if (ev.pointerType === 'mouse') {
        // No text selection while the box is drawn.
        ev.preventDefault();
      }
      ccMap.dragging.disable();
      pointerId = ev.pointerId;
      startPoint = ccMap.mouseEventToContainerPoint(ev);
      start = ccMap.containerPointToLatLng(startPoint);
    },
    true
  );
  el.addEventListener('pointermove', (ev: PointerEvent) => {
    if (!ccMap || !start || !startPoint || ev.pointerId !== pointerId) {
      return;
    }
    const point = ccMap.mouseEventToContainerPoint(ev);
    if (!box && point.distanceTo(startPoint) < CC_DRAG_THRESHOLD_PX) {
      return;
    }
    const bounds = L.latLngBounds(start, ccMap.containerPointToLatLng(point));
    if (box) {
      box.setBounds(bounds);
    } else {
      onHover(null, null);
      box = L.rectangle(bounds, {
        color: '#1565c0',
        weight: 1,
        dashArray: '4 4',
        fillOpacity: 0.08,
        interactive: false
      }).addTo(ccMap);
    }
  });
  const finish = (ev: PointerEvent): void => {
    touches.delete(ev.pointerId);
    if (!ccMap) {
      return;
    }
    if (ev.pointerId === pointerId) {
      const bounds = box?.getBounds() ?? null;
      reset();
      if (bounds) {
        ccSuppressClick = true;
        window.setTimeout(() => {
          ccSuppressClick = false;
        }, 0);
        if (ev.type === 'pointerup') {
          void addUnitsInBox(bounds);
        }
      }
    }
    if (touches.size === 0) {
      ccMap.dragging.enable();
    }
  };
  // On the window: a drag can end outside the map.
  window.addEventListener('pointerup', finish, true);
  window.addEventListener('pointercancel', finish, true);
}

// Adds every unit the box touches. A box over units that are all in the set
// already takes them out again, so a mistaken box can be undone the same way.
async function addUnitsInBox(bounds: L.LatLngBounds): Promise<void> {
  const cat = ccActiveCatalog();
  if (!cat) {
    showSetHint();
    return;
  }
  if (ccBusy) {
    return;
  }
  const west = bounds.getWest();
  const east = bounds.getEast();
  const south = bounds.getSouth();
  const north = bounds.getNorth();
  const selected = ccSelectedIds(cat);
  const touched: CcUnit[] = [];
  for (const drawn of ccDrawnById.values()) {
    if (ccTouchesBox(drawn, west, south, east, north)) {
      touched.push(drawn.unit);
    }
  }
  if (touched.length === 0) {
    return;
  }
  const unselected = touched.filter((u) => !selected.has(u.id));
  const removing = unselected.length === 0;
  const changing = removing ? touched : unselected;
  if (
    changing.length > CC_BOX_CONFIRM_ABOVE &&
    !confirm(
      removing
        ? `Remove ${changing.length} chart areas from “${cat.name}”?`
        : `Add ${changing.length} chart areas to “${cat.name}”?`
    )
  ) {
    return;
  }
  const changingIds = new Set(changing.map((u) => u.id));
  for (const key of ['selectedBand4ChartIds', 'selectedUnitIds'] as const) {
    const ids = changing
      .filter((u) => (u.source === CC_NOAA_SOURCE) === (key === 'selectedBand4ChartIds'))
      .map((u) => u.id);
    cat[key] = removing ? cat[key].filter((id) => !changingIds.has(id)) : [...cat[key], ...ids];
  }
  refreshAreaColors();
  await putSelection(cat);
}

// ---- Colours ----

function unitColor(id: string, cat: CustomCatalog): string {
  const downloading = ccBusy && ccDetail?.phase === 'downloading';
  if (downloading) {
    // NOAA boxes show progress as a rising fill overlay; other units turn
    // yellow once their cell has landed.
    const drawn = ccDrawnById.get(id);
    if (drawn && drawn.unit.source !== CC_NOAA_SOURCE && boxFillFraction(id) >= 1) {
      return CC_YELLOW;
    }
    return CC_RED;
  }
  if (ccBusy) {
    return CC_YELLOW; // converting / combining
  }
  // Idle colour is per-unit, driven by cell-version freshness (green = baked
  // versions still current, red = a newer version / never built). Falls back
  // to the set-level colour if the server had no index to compare against.
  const boxStates = cat.boxStates;
  if (Object.keys(boxStates).length > 0) {
    return boxStates[id] === 'up_to_date' ? CC_GREEN : CC_RED;
  }
  return ccStatusColor(cat);
}

function styleUnit(id: string): void {
  const drawn = ccDrawnById.get(id);
  if (!drawn) {
    return;
  }
  const active = ccActiveCatalog();
  const selected = active ? ccSelectedIds(active).has(id) : false;
  const style = active && selected ? ccSelectedStyle(unitColor(id, active)) : ccClearStyle();
  if (id === ccHoverId) {
    style.weight = (style.weight ?? 1) + 2;
  }
  drawn.layer.setStyle(style);
}

function refreshAreaColors(): void {
  const active = ccActiveCatalog();
  const selected = ccSelectedIds(active);
  for (const id of ccDrawnById.keys()) {
    styleUnit(id);
  }
  // Selected units draw over the rest, so their outline is never hidden.
  for (const id of selected) {
    const layer = ccDrawnById.get(id)?.layer;
    if (layer && 'bringToFront' in layer) {
      (layer).bringToFront();
    }
  }
  const downloading = ccBusy && ccDetail?.phase === 'downloading';
  updateFillOverlays(downloading, selected);
  updateSmallMarkers();
}

/** The whole-turn shift that puts a unit nearest the map's center. */
function ccShiftToView(drawn: CcDrawnUnit): number {
  const centerLon = ccMap ? ccMap.getCenter().lng : 0;
  return Math.round((centerLon - (drawn.west + drawn.east) / 2) / 360) * 360;
}

/**
 * Leaflet draws a vector layer in one copy of the world only, so a selection
 * framed across the antimeridian (Guam and American Samoa, or the Keys and
 * Micronesia) would be partly drawn out of view. Selected units are moved to
 * the copy being looked at; the rest stay where they are.
 */
function ccFollowWorld(): void {
  for (const id of ccSelectedIds(ccActiveCatalog())) {
    const drawn = ccDrawnById.get(id);
    if (!drawn) {
      continue;
    }
    const shift = ccShiftToView(drawn);
    if (shift === drawn.shift) {
      continue;
    }
    drawn.shift = shift;
    const [, s, , n] = drawn.unit.bbox;
    if (drawn.layer instanceof L.Rectangle) {
      drawn.layer.setBounds([
        [s, drawn.west + shift],
        [n, drawn.east + shift]
      ]);
    } else if (drawn.layer instanceof L.Polygon) {
      drawn.layer.setLatLngs(
        drawn.rings.map((ring) => ring.map(([lon, lat]) => L.latLng(lat, lon + shift)))
      );
    }
  }
}

// Below this size on screen a selected unit gets a marker, or it could not
// be seen, found or removed (an atoll box at world zoom is a speck).
const CC_SMALL_UNIT_PX = 10;

function updateSmallMarkers(): void {
  if (!ccMap || !ccSmallLayer) {
    return;
  }
  const map = ccMap;
  ccSmallLayer.clearLayers();
  const active = ccActiveCatalog();
  if (!active) {
    return;
  }
  for (const id of ccSelectedIds(active)) {
    const drawn = ccDrawnById.get(id);
    if (!drawn) {
      continue;
    }
    const [, s, , n] = drawn.unit.bbox;
    const sw = map.latLngToContainerPoint([s, drawn.west]);
    const ne = map.latLngToContainerPoint([n, drawn.east]);
    if (Math.max(Math.abs(ne.x - sw.x), Math.abs(ne.y - sw.y)) >= CC_SMALL_UNIT_PX) {
      continue;
    }
    const center = L.latLng((s + n) / 2, (drawn.west + drawn.east) / 2 + drawn.shift);
    const color = unitColor(id, active);
    const marker = L.circleMarker(center, {
      radius: 7,
      color,
      weight: 2,
      fillColor: color,
      fillOpacity: 0.5,
      renderer: ccRenderer ?? undefined
    });
    // The marker sits where the unit is too small to click, so it toggles
    // the unit itself; the map must not see the same click.
    marker.on('click', (ev: L.LeafletMouseEvent) => {
      L.DomEvent.stopPropagation(ev);
      void onAreaClick(drawn.unit);
    });
    marker.on('mouseover', (ev: L.LeafletMouseEvent) => {
      onHover(drawn, ev.latlng);
    });
    marker.addTo(ccSmallLayer);
  }
}

// Fill fraction = (status cells downloaded) / (that unit's status cells), 0..1.
function boxFillFraction(unitId: string): number {
  const cov = ccDetail?.coverageByBox?.[unitId];
  if (!cov || cov.length === 0) {
    return 0;
  }
  const staged = new Set(ccDetail?.downloadedChartIds ?? []);
  let done = 0;
  for (const id of cov) {
    if (staged.has(id)) {
      done += 1;
    }
  }
  return Math.max(0, Math.min(1, done / cov.length));
}

function updateFillOverlays(downloading: boolean, selected: Set<string>): void {
  if (!ccMap || !ccFootprintLayer || !downloading) {
    clearFillOverlays();
    return;
  }
  for (const id of selected) {
    const drawn = ccDrawnById.get(id);
    const frac = boxFillFraction(id);
    if (!drawn || drawn.unit.source !== CC_NOAA_SOURCE || frac <= 0) {
      removeFillOverlay(id);
      continue;
    }
    const [, minLat, , maxLat] = drawn.unit.bbox;
    const topLat = minLat + frac * (maxLat - minLat);
    const bounds = L.latLngBounds([
      [minLat, drawn.west + drawn.shift],
      [topLat, drawn.east + drawn.shift]
    ]);
    const existing = ccFillRects.get(id);
    if (existing) {
      existing.setBounds(bounds);
    } else {
      const overlay = L.rectangle(bounds, {
        stroke: false,
        fill: true,
        fillColor: CC_YELLOW,
        fillOpacity: 0.55,
        interactive: false,
        renderer: ccRenderer ?? undefined
      });
      overlay.addTo(ccFootprintLayer);
      ccFillRects.set(id, overlay);
    }
  }
  // Drop overlays for units no longer selected.
  for (const id of [...ccFillRects.keys()]) {
    if (!selected.has(id)) {
      removeFillOverlay(id);
    }
  }
}

function removeFillOverlay(id: string): void {
  const overlay = ccFillRects.get(id);
  if (overlay) {
    ccFootprintLayer?.removeLayer(overlay);
    ccFillRects.delete(id);
  }
}

function clearFillOverlays(): void {
  for (const id of [...ccFillRects.keys()]) {
    removeFillOverlay(id);
  }
}

async function loadCatalogs(): Promise<void> {
  try {
    const resp = await fetch(`${CC_API_BASE}/custom-catalogs`);
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`);
    }
    ccCatalogs = (await resp.json()) as CustomCatalog[];
  } catch {
    ccCatalogs = [];
  }
  if (ccActiveId && !ccCatalogs.some((c) => c.id === ccActiveId)) {
    ccActiveId = null;
  }
  if (!ccActiveId && ccCatalogs.length > 0) {
    ccActiveId = ccCatalogs[0].id;
  }
  renderCustomCatalogList();
  renderDetail();
  refreshAreaColors();
  await maybeStartStatusPoll();
}

function renderCustomCatalogList(): void {
  const list = document.getElementById('ccList');
  if (!list) {
    return;
  }
  if (ccCatalogs.length === 0) {
    list.innerHTML = `<div class="cc-empty">No chart sets yet. Click “New” to create one.</div>`;
    return;
  }
  list.innerHTML = ccCatalogs
    .map(
      (cat) => `
      <div class="cc-list-row${cat.id === ccActiveId ? ' active' : ''}" data-cc-select="${ccEscAttr(
        cat.id
      )}">
        <span class="cc-status-dot cc-dot-${ccStatusClass(cat)}"></span>
        <span class="cc-list-name">${ccEscHtml(cat.name)}</span>
        <span class="cc-list-meta">${ccSelectedIds(cat).size}</span>
      </div>`
    )
    .join('');
}

function renderDetail(): void {
  const detail = document.getElementById('ccDetail');
  const dlBtn = document.getElementById('ccDownloadBtn') as HTMLButtonElement | null;
  const delBtn = document.getElementById('ccDeleteBtn') as HTMLButtonElement | null;
  const cat = ccActiveCatalog();
  const count = ccSelectedIds(cat).size;

  if (dlBtn) {
    dlBtn.disabled = !cat || count === 0 || ccBusy;
  }
  if (delBtn) {
    delBtn.disabled = !cat || ccBusy;
  }

  updateMapMode();
  if (!detail) {
    return;
  }
  if (!cat) {
    detail.innerHTML = `<div class="cc-detail-empty">Select or create a chart set, then click chart areas on the map.</div>`;
    return;
  }
  // The banners below say these already.
  const shownReasons = cat.updateReasons.filter(
    (r) => !r.startsWith('No longer published:') && !r.startsWith('Needs a newer plugin version:')
  );
  detail.innerHTML = `
    <div class="cc-detail-name">${ccEscHtml(cat.name)}</div>
    <div class="cc-detail-status cc-status-${ccStatusClass(cat)}">${ccEscHtml(ccStatusLabel(cat))}</div>
    <div class="cc-detail-meta">${count} selected area(s) &rarr; ${cat.includedCount} ENC cell(s)</div>
    ${
      cat.missingUnitIds.length > 0
        ? `<div class="cc-missing">${cat.missingUnitIds.length} selected area(s) no longer published.
            <button class="cc-link-btn" data-cc-action="drop-missing" ${ccBusy ? 'disabled' : ''}>Remove from set</button></div>`
        : ''
    }
    ${
      cat.unreadableUnitIds.length > 0
        ? `<div class="cc-missing">${cat.unreadableUnitIds.length} selected area(s) need a newer version of this plugin. Update it from the App Store.</div>`
        : ''
    }
    ${
      shownReasons.length > 0
        ? `<ul class="cc-reasons">${shownReasons.map((r) => `<li>${ccEscHtml(r)}</li>`).join('')}</ul>`
        : ''
    }
    ${
      cat.lastConvertedAt
        ? `<div class="cc-detail-date">Last built ${ccEscHtml(
            new Date(cat.lastConvertedAt).toLocaleString()
          )}</div>`
        : ''
    }
    ${
      cat.cacheBytes > 0
        ? `<div class="cc-detail-date" title="Kept so an update downloads and reads only the charts that changed">Kept cells: ${ccFormatSize(cat.cacheBytes)}</div>`
        : ''
    }
  `;
}

function phaseText(phase: CatalogPhase | undefined): string {
  switch (phase) {
    case 'preparing':
      return 'Preparing';
    case 'downloading':
      return 'Downloading charts';
    case 'converting':
      return 'Converting';
    case 'joining':
      return 'Joining tiles';
    case 'completed':
      return 'Completed';
    case 'cancelling':
      return 'Cancelling…';
    case 'cancelled':
      return 'Cancelled';
    case 'failed':
      return 'Failed';
    default:
      return 'Working…';
  }
}

// Two progress bars (current step + overall conversion) plus a Cancel button,
// driven by the structured `detail`. The log <pre> below stays as-is.
function renderProgress(): void {
  const el = document.getElementById('ccProgress');
  const log = document.getElementById('ccLog');
  if (!el) {
    return;
  }
  const d = ccDetail;
  const terminal = d?.phase === 'completed' || d?.phase === 'cancelled' || d?.phase === 'failed';
  if (!ccBusy && !terminal) {
    el.innerHTML = '';
    if (log) {
      log.style.display = 'none';
    }
    return;
  }

  const overall = d ? Math.max(0, Math.min(100, Math.round(d.overallPercent))) : 0;
  const sectionPct = d ? d.sectionPercent : -1;
  const sectionIndeterminate = sectionPct < 0;
  const sectionLabel = d?.sectionLabel ?? 'Working…';
  const sectionPctText = sectionIndeterminate ? '' : ` ${Math.round(sectionPct)}%`;

  let cancelHtml = '';
  if (ccBusy && d?.phase === 'cancelling') {
    cancelHtml = `<span class="cc-cancel-pending">Cancelling…</span>`;
  } else if (ccBusy) {
    // Every phase — including the combine — is cancellable: the cancel
    // route aborts the in-flight download or container job.
    cancelHtml = `<button class="cc-btn cc-btn-danger cc-cancel-btn" data-cc-action="cancel">Cancel</button>`;
  }

  el.innerHTML = `
    <div class="cc-prog">
      <div class="cc-prog-head">
        <span class="cc-prog-phase">${ccEscHtml(phaseText(d?.phase))}</span>
        ${cancelHtml}
      </div>
      <div class="cc-prog-line">
        <div class="cc-prog-caption">${ccEscHtml(sectionLabel)}${ccEscHtml(sectionPctText)}</div>
        <div class="cc-bar"><div class="cc-bar-fill${
          sectionIndeterminate ? ' cc-bar-indeterminate' : ''
        }" style="${sectionIndeterminate ? '' : `width:${Math.round(sectionPct)}%`}"></div></div>
      </div>
      <div class="cc-prog-line">
        <div class="cc-prog-caption">Overall conversion ${overall}%</div>
        <div class="cc-bar"><div class="cc-bar-fill cc-bar-overall" style="width:${overall}%"></div></div>
      </div>
    </div>`;
  if (log) {
    log.style.display = 'block';
  }
}

async function loadLog(id: string): Promise<void> {
  const log = document.getElementById('ccLog');
  if (!log) {
    return;
  }
  try {
    const resp = await fetch(`${CC_API_BASE}/custom-catalogs/${encodeURIComponent(id)}/log?tail=200`);
    if (!resp.ok) {
      return;
    }
    const data = (await resp.json()) as { log?: string[] };
    log.textContent = (data.log ?? []).join('\n');
    log.scrollTop = log.scrollHeight;
  } catch {
    // ignore log blips
  }
}

function replaceCatalog(updated: CustomCatalog): void {
  const idx = ccCatalogs.findIndex((c) => c.id === updated.id);
  if (idx >= 0) {
    ccCatalogs[idx] = updated;
  } else {
    ccCatalogs.push(updated);
  }
  renderCustomCatalogList();
  renderDetail();
  refreshAreaColors();
}

async function onAreaClick(unit: CcUnit): Promise<void> {
  const cat = ccActiveCatalog();
  if (!cat) {
    showSetHint();
    return;
  }
  if (ccBusy) {
    return;
  }
  const key = unit.source === CC_NOAA_SOURCE ? 'selectedBand4ChartIds' : 'selectedUnitIds';
  const selected = new Set(cat[key]);
  if (selected.has(unit.id)) {
    selected.delete(unit.id);
  } else {
    selected.add(unit.id);
  }
  cat[key] = Array.from(selected);
  // Optimistic recolour; the PUT response refreshes counts/status.
  refreshAreaColors();
  await putSelection(cat);
}

async function putSelection(cat: CustomCatalog): Promise<void> {
  try {
    const resp = await fetch(`${CC_API_BASE}/custom-catalogs/${encodeURIComponent(cat.id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        selectedBand4ChartIds: cat.selectedBand4ChartIds,
        selectedUnitIds: cat.selectedUnitIds
      })
    });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`);
    }
    replaceCatalog((await resp.json()) as CustomCatalog);
  } catch {
    // Resync from the server on failure.
    await loadCatalogs();
  }
}

async function dropMissingUnits(): Promise<void> {
  const cat = ccActiveCatalog();
  if (!cat || ccBusy || cat.missingUnitIds.length === 0) {
    return;
  }
  const missing = new Set(cat.missingUnitIds);
  cat.selectedBand4ChartIds = cat.selectedBand4ChartIds.filter((id) => !missing.has(id));
  cat.selectedUnitIds = cat.selectedUnitIds.filter((id) => !missing.has(id));
  await putSelection(cat);
}

function selectCatalog(id: string): void {
  if (ccActiveId === id) {
    return;
  }
  stopStatusPoll();
  ccActiveId = id;
  ccBusy = false;
  ccDetail = null;
  renderProgress();
  renderCustomCatalogList();
  renderDetail();
  refreshAreaColors();
  fitMapToActiveCatalog();
  void maybeStartStatusPoll();
}

/**
 * Bounds that frame the units the short way round: the view starts after
 * the widest stretch of longitude no unit covers, so a set in the Keys and
 * Micronesia is framed across the Pacific, not across Europe and Africa.
 */
function ccFrameBounds(units: Iterable<CcDrawnUnit>): L.LatLngBounds | null {
  const spans: { west: number; east: number; south: number; north: number }[] = [];
  for (const drawn of units) {
    const shift = Math.floor((drawn.west + 180) / 360) * 360;
    spans.push({
      west: drawn.west - shift,
      east: drawn.east - shift,
      south: drawn.unit.bbox[1],
      north: drawn.unit.bbox[3]
    });
  }
  if (spans.length === 0) {
    return null;
  }
  spans.sort((x, y) => x.west - y.west);
  // Walk the covered stretches in order; the gap after the last one wraps
  // round to the first.
  let start = spans[0].west;
  let reach = spans[0].east;
  let widestGap = -1;
  for (const span of spans.slice(1)) {
    if (span.west > reach && span.west - reach > widestGap) {
      widestGap = span.west - reach;
      start = span.west;
    }
    reach = Math.max(reach, span.east);
  }
  if (spans[0].west + 360 - reach > widestGap) {
    start = spans[0].west;
  }
  let west = Infinity;
  let east = -Infinity;
  let south = Infinity;
  let north = -Infinity;
  for (const span of spans) {
    const k = span.west < start ? 360 : 0;
    west = Math.min(west, span.west + k);
    east = Math.max(east, span.east + k);
    south = Math.min(south, span.south);
    north = Math.max(north, span.north);
  }
  return L.latLngBounds([south, west], [north, east]);
}

// Center + zoom the map to the active set's selected units. No-op if the
// map/units aren't ready or the set has no selection (we leave the current
// view rather than jumping to the world).
function fitMapToActiveCatalog(opts: { animate?: boolean } = {}): void {
  if (!ccMap) {
    return;
  }
  const selected: CcDrawnUnit[] = [];
  for (const id of ccSelectedIds(ccActiveCatalog())) {
    const drawn = ccDrawnById.get(id);
    if (drawn) {
      selected.push(drawn);
    }
  }
  const bounds = ccFrameBounds(selected);
  if (!bounds) {
    return;
  }
  // maxZoom keeps a single small unit from zooming in uncomfortably far.
  const zoom = Math.min(ccMap.getBoundsZoom(bounds, false, L.point(60, 60)), 11);
  // Frame the same view from the main copy of the world, where Leaflet draws
  // the unselected units; the selected ones follow (ccFollowWorld).
  const center = bounds.getCenter();
  const lng = ((((center.lng + 180) % 360) + 360) % 360) - 180;
  ccMap.setView([center.lat, lng], zoom, { animate: opts.animate ?? true });
}

// The whole world: the fallback view when no set is selected (e.g. a fresh
// install with no chart sets yet). The units span every continent, so a fit
// to their bounds would only crop some of them off.
function showWholeWorld(opts: { animate?: boolean } = {}): void {
  ccMap?.setView(CC_WORLD_CENTER, CC_WORLD_ZOOM, { animate: opts.animate ?? true });
}

function showNewForm(show: boolean): void {
  const form = document.getElementById('ccNewForm');
  const input = document.getElementById('ccNewName') as HTMLInputElement | null;
  if (form) {
    form.style.display = show ? 'block' : 'none';
  }
  if (show && input) {
    input.value = '';
    input.focus();
  }
}

async function createCatalog(): Promise<void> {
  const input = document.getElementById('ccNewName') as HTMLInputElement | null;
  const name = input?.value.trim() ?? '';
  if (name === '') {
    input?.focus();
    return;
  }
  try {
    const resp = await fetch(`${CC_API_BASE}/custom-catalogs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    });
    if (!resp.ok) {
      const body = (await resp.json().catch(() => ({}))) as { error?: string };
      alert(`Could not create chart set: ${body.error ?? `HTTP ${resp.status}`}`);
      return;
    }
    const cat = (await resp.json()) as CustomCatalog;
    showNewForm(false);
    ccActiveId = cat.id;
    replaceCatalog(cat);
    // A new set starts empty: show every area there is to pick from.
    showWholeWorld();
  } catch {
    alert('Could not create chart set. Check your connection.');
  }
}

async function deleteActiveCatalog(): Promise<void> {
  const cat = ccActiveCatalog();
  if (!cat || ccBusy) {
    return;
  }
  if (!confirm(`Delete chart set “${cat.name}”? The built chart (if any) is kept.`)) {
    return;
  }
  try {
    const resp = await fetch(`${CC_API_BASE}/custom-catalogs/${encodeURIComponent(cat.id)}`, {
      method: 'DELETE'
    });
    if (!resp.ok) {
      const body = (await resp.json().catch(() => ({}))) as { error?: string };
      alert(`Could not delete: ${body.error ?? `HTTP ${resp.status}`}`);
      return;
    }
    ccActiveId = null;
    await loadCatalogs();
  } catch {
    alert('Could not delete chart set. Check your connection.');
  }
}

async function downloadConvertActive(): Promise<void> {
  const cat = ccActiveCatalog();
  if (!cat || ccBusy || ccSelectedIds(cat).size === 0) {
    return;
  }
  try {
    const resp = await fetch(
      `${CC_API_BASE}/custom-catalogs/${encodeURIComponent(cat.id)}/download-convert`,
      { method: 'POST' }
    );
    if (!resp.ok) {
      const body = (await resp.json().catch(() => ({}))) as { error?: string };
      alert(`Could not start: ${body.error ?? `HTTP ${resp.status}`}`);
      return;
    }
    ccBusy = true;
    ccDetail = {
      phase: 'preparing',
      overallPercent: 0,
      sectionLabel: 'Starting…',
      sectionPercent: -1,
      downloadedChartIds: []
    };
    const log = document.getElementById('ccLog');
    if (log) {
      log.textContent = '';
    }
    renderProgress();
    renderDetail();
    refreshAreaColors();
    startStatusPoll();
  } catch {
    alert('Could not start download. Check your connection.');
  }
}

async function cancelActiveCatalog(): Promise<void> {
  const id = ccActiveId;
  if (!id || !ccBusy) {
    return;
  }
  // Optimistic: show "Cancelling…" immediately; the poll confirms.
  if (ccDetail) {
    ccDetail = { ...ccDetail, phase: 'cancelling' };
    renderProgress();
  }
  try {
    await fetch(`${CC_API_BASE}/custom-catalogs/${encodeURIComponent(id)}/cancel`, {
      method: 'POST'
    });
  } catch {
    // ignore — the next poll reflects real state
  }
}

async function maybeStartStatusPoll(): Promise<void> {
  if (!ccActiveId) {
    ccBusy = false;
    return;
  }
  try {
    const resp = await fetch(`${CC_API_BASE}/custom-catalogs/${encodeURIComponent(ccActiveId)}/status`);
    if (!resp.ok) {
      return;
    }
    const data = (await resp.json()) as CatalogStatusResponse;
    ccBusy = data.busy;
    ccDetail = data.detail;
    replaceCatalog(data);
    renderProgress();
    if (data.busy) {
      startStatusPoll();
    }
  } catch {
    // ignore
  }
}

function startStatusPoll(): void {
  stopStatusPoll();
  ccStatusPoll = setInterval(() => {
    void pollStatus();
  }, 2000);
  void pollStatus();
}

function stopStatusPoll(): void {
  if (ccStatusPoll !== null) {
    clearInterval(ccStatusPoll);
    ccStatusPoll = null;
  }
}

async function pollStatus(): Promise<void> {
  const id = ccActiveId;
  if (!id) {
    stopStatusPoll();
    return;
  }
  try {
    const resp = await fetch(`${CC_API_BASE}/custom-catalogs/${encodeURIComponent(id)}/status`);
    if (!resp.ok) {
      return;
    }
    const data = (await resp.json()) as CatalogStatusResponse;
    ccBusy = data.busy;
    ccDetail = data.detail;
    replaceCatalog(data);
    renderProgress();
    if (data.busy) {
      await loadLog(id);
    } else {
      stopStatusPoll();
      await loadLog(id);
      // Settle onto the persisted status and refresh the whole list.
      await loadCatalogs();
      // Let the terminal (completed/cancelled/failed) bars linger, then clear.
      window.setTimeout(() => {
        ccDetail = null;
        renderProgress();
      }, 6000);
    }
  } catch {
    // ignore poll blips
  }
}

function wireCustomCatalogHandlers(): void {
  const output = document.getElementById('customCatalogsOutput');
  if (!output || output.dataset['ccWired']) {
    return;
  }

  output.addEventListener('click', (ev) => {
    const target = ev.target as HTMLElement | null;
    if (!target) {
      return;
    }

    const selectRow = target.closest<HTMLElement>('[data-cc-select]');
    if (selectRow) {
      const id = selectRow.dataset['ccSelect'];
      if (id) {
        selectCatalog(id);
      }
      return;
    }

    const actionEl = target.closest<HTMLElement>('[data-cc-action]');
    if (!actionEl) {
      return;
    }
    switch (actionEl.dataset['ccAction']) {
      case 'new':
        showNewForm(true);
        break;
      case 'create':
        void createCatalog();
        break;
      case 'create-cancel':
        showNewForm(false);
        break;
      case 'download':
        void downloadConvertActive();
        break;
      case 'cancel':
        void cancelActiveCatalog();
        break;
      case 'delete':
        void deleteActiveCatalog();
        break;
      case 'pan-mode':
        setPanMode(!ccPanMode);
        break;
      case 'drop-missing':
        void dropMissingUnits();
        break;
      case 'refresh-index':
        void loadEncIndex(true);
        break;
      default:
        break;
    }
  });

  output.addEventListener('keydown', (ev) => {
    const target = ev.target as HTMLElement | null;
    if (target?.id === 'ccNewName' && ev.key === 'Enter') {
      ev.preventDefault();
      void createCatalog();
    }
  });

  output.dataset['ccWired'] = '1';
}

function ccFormatSize(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
}

function ccEscHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function ccEscAttr(s: string): string {
  return ccEscHtml(s).replace(/'/g, '&#39;');
}
