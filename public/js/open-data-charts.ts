// Open Data Charts tab: pick units (z9 map tiles) of the Open Data Charts
// index on a map into a named set; the server downloads them and builds one
// MBTiles chart per set. These charts are made from open data and are not
// for navigation, which the tab says and asks the user to acknowledge once.

const ODC_API = '/plugins/signalk-charts-provider-simple/open-data';
const ODC_UNIT_COUNT = 512;
const ODC_DRAG_THRESHOLD_PX = 6;
const ODC_BOX_CONFIRM_ABOVE = 50;
const ODC_POLL_MS = 1000;
const ODC_QUALITY_COLORS: Record<string, string> = {
  multibeam: '#2166ac',
  'survey-recent': '#67a9cf',
  'survey-old': '#f4a259',
  model: '#d7191c'
};
const ODC_OTHER_COLOR = '#8c8c8c';

interface OdcQuality {
  id: string;
  label: string;
}

interface OdcUnit {
  id: string;
  region: string;
  x: number;
  y: number;
  bbox: [number, number, number, number];
  version: string;
  size: number;
  built: string | null;
  quality: { best: string; share?: Record<string, number> } | null;
  surveys: number | null;
  changes: string | null;
}

interface OdcIndexResponse {
  status: { status: string; message: string | null };
  fetchedAt: string | null;
  acknowledged: boolean;
  index: {
    generated: string | null;
    disclaimer: string | null;
    attribution: string | null;
    qualities: OdcQuality[];
    regions: { id: string; name: string; bbox: [number, number, number, number] }[];
    units: OdcUnit[];
  } | null;
}

interface OdcSetUnit {
  id: string;
  region: string | null;
  version: string | null;
  builtVersion: string | null;
  size: number | null;
  quality: string | null;
  changes: string | null;
  diskBytes: number;
}

interface OdcProgress {
  phase: 'downloading' | 'building' | 'completed' | 'failed' | 'cancelled';
  message: string;
  unitsDone: number;
  unitsTotal: number;
  bytesDone: number;
  bytesTotal: number;
}

interface OdcSet {
  id: string;
  name: string;
  folder: string;
  unitIds: string[];
  built: Record<string, string>;
  chartFile: string | null;
  lastBuiltAt: string | null;
  status: 'empty' | 'not_built' | 'changed' | 'update_available' | 'up_to_date';
  updates: { id: string; from: string; to: string; changes?: string }[];
  missing: string[];
  chartExists: boolean;
  selectedBytes: number;
  downloadBytes: number;
  freeBytes: number | null;
  units: OdcSetUnit[];
  busy: boolean;
  progress: OdcProgress | null;
}

let odcInitialized = false;
let odcMap: L.Map | null = null;
let odcUnitLayer: L.LayerGroup | null = null;
let odcRenderer: L.Renderer | null = null;
const odcUnits = new Map<string, OdcUnit>();
const odcRects = new Map<string, L.Rectangle>();
let odcQualities: OdcQuality[] = [];
let odcSets: OdcSet[] = [];
let odcActiveId: string | null = null;
let odcAcknowledged = false;
let odcPanMode = false;
let odcPoll: ReturnType<typeof setInterval> | null = null;
let odcHoverTip: L.Tooltip | null = null;

window.handleOpenDataTabActive = function (): void {
  if (!odcInitialized) {
    void odcInit();
    return;
  }
  odcMap?.invalidateSize();
  void odcLoadSets();
};

async function odcInit(): Promise<void> {
  odcInitialized = true;
  const output = document.getElementById('openDataOutput');
  if (!output) {
    return;
  }
  output.innerHTML = `
    <div class="odc-banner">
      Charts built from open data: Shom surveys, OpenStreetMap and more.
      <strong>Not for navigation.</strong> Depths and dangers may be missing or wrong;
      use official charts to navigate.
    </div>
    <div class="cc-container">
      <div class="cc-left">
        <div class="cc-list-header">Chart sets</div>
        <div id="odcList" class="cc-list"></div>
        <div id="odcNewForm" class="cc-new-form" data-needs="readwrite" style="display:none;">
          <input type="text" id="odcNewName" class="cc-input" placeholder="Chart set name" maxlength="120" />
          <div class="cc-new-form-actions">
            <button class="cc-btn cc-btn-primary" data-odc-action="create">Create</button>
            <button class="cc-btn" data-odc-action="create-cancel">Cancel</button>
          </div>
        </div>
        <div class="cc-actions">
          <button class="cc-btn cc-btn-primary" data-needs="readwrite" data-odc-action="new">New</button>
          <button class="cc-btn cc-btn-primary" data-needs="readwrite" id="odcBuildBtn" data-odc-action="build" disabled>Download</button>
          <button class="cc-btn" data-needs="readwrite" id="odcRenameBtn" data-odc-action="rename" disabled>Rename</button>
          <button class="cc-btn cc-btn-danger" data-needs="admin" id="odcDeleteBtn" data-odc-action="delete" disabled>Delete</button>
        </div>
        <div id="odcDetail" class="cc-detail"></div>
        <div id="odcProgress" class="cc-progress"></div>
      </div>
      <div class="cc-right">
        <div class="cc-map-note">
          <span id="odcMapNote">Loading Open Data Charts areas…</span>
          <button class="cc-link-btn" data-odc-action="refresh-index">Refresh</button>
        </div>
        <div class="cc-map-tools">
          <span class="cc-map-hint" id="odcMapHint"></span>
          <button class="cc-btn" id="odcPanBtn" data-odc-action="pan-mode" aria-pressed="false"
            title="Drag to move the map instead of picking areas">Move map</button>
        </div>
        <div id="odcMap" class="cc-map"></div>
        <div class="cc-legend" id="odcLegend"></div>
        <div class="cc-detail-date" id="odcAttribution"></div>
      </div>
    </div>`;
  odcWireHandlers(output);
  odcInitMap();
  await Promise.all([odcLoadIndex(), odcLoadSets()]);
  window.setTimeout(() => {
    odcMap?.invalidateSize();
    odcFitActive();
  }, 0);
}

function odcInitMap(): void {
  const el = document.getElementById('odcMap');
  if (!el || odcMap || typeof L === 'undefined') {
    return;
  }
  odcMap = L.map(el, { worldCopyJump: true, minZoom: 2, boxZoom: false }).setView([0, 0], 2);
  odcRenderer = L.canvas({ padding: 0.5 });
  // See enc-charts.ts: OSM blocks tile requests without a referrer.
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18,
    referrerPolicy: 'origin',
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(odcMap);
  L.tileLayer('https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png', {
    maxZoom: 18,
    referrerPolicy: 'origin',
    attribution: 'Seamarks &copy; OpenSeaMap'
  }).addTo(odcMap);
  odcUnitLayer = L.layerGroup().addTo(odcMap);
  odcHoverTip = L.tooltip({ direction: 'top', offset: [0, -6] });
  odcWireGestures(el);
}

function odcActive(): OdcSet | null {
  return odcSets.find((s) => s.id === odcActiveId) ?? null;
}

function odcCanSelect(): boolean {
  const set = odcActive();
  return set !== null && !set.busy && window.canChange('readwrite');
}

function odcQualityLabel(id: string | null | undefined): string {
  return odcQualities.find((q) => q.id === id)?.label ?? 'Other';
}

function odcQualityColor(id: string | null | undefined): string {
  return (id ? ODC_QUALITY_COLORS[id] : undefined) ?? ODC_OTHER_COLOR;
}

// ---- Index and map ----

async function odcLoadIndex(refresh = false): Promise<void> {
  const note = document.getElementById('odcMapNote');
  if (note && refresh) {
    note.textContent = 'Refreshing…';
  }
  let data: OdcIndexResponse;
  try {
    const resp = await fetch(`${ODC_API}/index${refresh ? '?refresh=1' : ''}`);
    if (!resp.ok) {
      throw new Error(`HTTP ${String(resp.status)}`);
    }
    data = (await resp.json()) as OdcIndexResponse;
  } catch {
    if (note) {
      note.textContent = 'Could not load the Open Data Charts areas from this server.';
    }
    return;
  }
  odcAcknowledged = data.acknowledged;
  if (data.index) {
    odcQualities = data.index.qualities;
    odcUnits.clear();
    for (const unit of data.index.units) {
      odcUnits.set(unit.id, unit);
    }
    odcDrawIndex(data.index);
    const attribution = document.getElementById('odcAttribution');
    if (attribution) {
      attribution.textContent = data.index.attribution ? `Sources: ${data.index.attribution}` : '';
    }
  }
  if (note) {
    if (!data.index) {
      note.textContent =
        data.status.message ??
        "The Open Data Charts index has not been downloaded yet. Check this device's internet connection, then click Refresh.";
    } else {
      const saved =
        data.status.status === 'error' || data.status.status === 'incompatible'
          ? ` (saved copy; ${data.status.message ?? 'refresh failed'})`
          : '';
      note.textContent = `${String(odcUnits.size)} areas in ${String(data.index.regions.length)} region(s)${saved}.`;
    }
  }
  odcRenderLegend();
  odcRenderDetail();
}

function odcDrawIndex(index: NonNullable<OdcIndexResponse['index']>): void {
  if (!odcUnitLayer) {
    return;
  }
  odcUnitLayer.clearLayers();
  odcRects.clear();
  for (const region of index.regions) {
    const [w, s, e, n] = region.bbox;
    L.rectangle(
      [
        [s, w],
        [n, e]
      ],
      {
        color: '#37474f',
        weight: 1.5,
        dashArray: '6 4',
        fill: false,
        interactive: false,
        renderer: odcRenderer ?? undefined
      }
    )
      .addTo(odcUnitLayer);
    // On the north edge, so the name never hides an area.
    L.tooltip({ permanent: true, direction: 'top', className: 'odc-region-label' })
      .setLatLng([n, (w + e) / 2])
      .setContent(odcEsc(region.name))
      .addTo(odcUnitLayer);
  }
  for (const unit of index.units) {
    const [w, s, e, n] = unit.bbox;
    const rect = L.rectangle(
      [
        [s, w],
        [n, e]
      ],
      { interactive: false, renderer: odcRenderer ?? undefined }
    );
    rect.addTo(odcUnitLayer);
    odcRects.set(unit.id, rect);
  }
  odcRestyle();
}

function odcRestyle(): void {
  const set = odcActive();
  const selected = new Set(set?.unitIds ?? []);
  const updates = new Set(set?.updates.map((u) => u.id) ?? []);
  for (const [id, rect] of odcRects) {
    const color = odcQualityColor(odcUnits.get(id)?.quality?.best);
    if (selected.has(id)) {
      rect.setStyle({
        color: updates.has(id) ? '#e65100' : '#102a43',
        weight: 3,
        dashArray: updates.has(id) ? '5 4' : undefined,
        fillColor: color,
        fillOpacity: 0.6
      });
      rect.bringToFront();
    } else {
      rect.setStyle({ color, weight: 1, dashArray: undefined, fillColor: color, fillOpacity: 0.2 });
    }
  }
}

function odcRenderLegend(): void {
  const legend = document.getElementById('odcLegend');
  if (!legend) {
    return;
  }
  const items = [...odcQualities, { id: 'other', label: 'Other' }].map(
    (q) =>
      `<span class="cc-legend-item"><span class="cc-swatch" style="background:${odcQualityColor(q.id)}"></span>${odcEsc(q.label)}</span>`
  );
  items.push(
    '<span class="cc-legend-item"><span class="cc-swatch odc-swatch-selected"></span>In the set</span>',
    '<span class="cc-legend-item"><span class="cc-swatch odc-swatch-update"></span>Update available</span>'
  );
  legend.innerHTML = items.join('');
}

function odcFitActive(): void {
  if (!odcMap) {
    return;
  }
  const set = odcActive();
  const ids = set && set.unitIds.length > 0 ? set.unitIds : [...odcUnits.keys()];
  const units = ids.map((id) => odcUnits.get(id)).filter((u) => u !== undefined);
  if (units.length === 0) {
    return;
  }
  const bounds = L.latLngBounds(
    units.flatMap((u) => [
      L.latLng(u.bbox[1], u.bbox[0]),
      L.latLng(u.bbox[3], u.bbox[2])
    ])
  );
  odcMap.fitBounds(bounds.pad(0.2), { animate: false, maxZoom: 11 });
}

// ---- Picking units ----

/** The unit (z9 tile) under a point, if the index lists one there. */
function odcUnitAt(latlng: L.LatLng): OdcUnit | null {
  const lng = (((latlng.lng + 180) % 360) + 360) % 360;
  const x = Math.floor((lng / 360) * ODC_UNIT_COUNT);
  const lat = Math.max(-85.05, Math.min(85.05, latlng.lat));
  const rad = (lat * Math.PI) / 180;
  const y = Math.floor(
    ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * ODC_UNIT_COUNT
  );
  return odcUnits.get(`z9-${String(x)}-${String(y)}`) ?? null;
}

function odcUnitsInBox(bounds: L.LatLngBounds): OdcUnit[] {
  const west = bounds.getWest();
  const east = bounds.getEast();
  const south = bounds.getSouth();
  const north = bounds.getNorth();
  return [...odcUnits.values()].filter((u) => {
    const [w, s, e, n] = u.bbox;
    // Leaflet keeps a box's longitudes in the world copy it was drawn in.
    const shift = Math.round(((west + east) / 2 - (w + e) / 2) / 360) * 360;
    return w + shift < east && e + shift > west && s < north && n > south;
  });
}

async function odcToggle(units: OdcUnit[], box: boolean): Promise<void> {
  const set = odcActive();
  if (!set || units.length === 0) {
    if (!set) {
      odcHint('Create a chart set first: click New and give it a name.');
    }
    return;
  }
  const selected = new Set(set.unitIds);
  const removing = box ? units.every((u) => selected.has(u.id)) : selected.has(units[0].id);
  const changing = removing ? units : units.filter((u) => !selected.has(u.id));
  if (
    box &&
    changing.length > ODC_BOX_CONFIRM_ABOVE &&
    !confirm(`${removing ? 'Remove' : 'Add'} ${String(changing.length)} areas?`)
  ) {
    return;
  }
  for (const unit of changing) {
    if (removing) {
      selected.delete(unit.id);
    } else {
      selected.add(unit.id);
    }
  }
  set.unitIds = [...selected];
  odcRestyle();
  odcRenderDetail();
  await odcPut(set.id, { unitIds: set.unitIds });
}

function odcHint(text: string | null): void {
  const hint = document.getElementById('odcMapHint');
  if (!hint) {
    return;
  }
  if (text) {
    hint.textContent = text;
    hint.classList.add('cc-map-hint-warn');
    return;
  }
  hint.classList.remove('cc-map-hint-warn');
  if (!window.canChange('readwrite')) {
    hint.textContent = 'Picking areas needs read/write access.';
  } else if (!odcActive()) {
    hint.textContent = 'Click New to start a chart set, then pick its areas on the map.';
  } else if (odcActive()?.busy) {
    hint.textContent = 'Areas can be changed again once this set is done.';
  } else if (odcPanMode) {
    hint.textContent = 'Drag to move the map. Turn off Move map to pick areas again.';
  } else {
    hint.textContent =
      'Tap an area to add or remove it, or drag across areas to add them all (drag again to remove). To pan, use two fingers or the Move map button.';
  }
}

function odcUpdateMapMode(): void {
  const canSelect = odcCanSelect();
  const btn = document.getElementById('odcPanBtn');
  if (btn) {
    btn.style.display = canSelect ? '' : 'none';
    btn.classList.toggle('cc-btn-active', canSelect && odcPanMode);
    btn.setAttribute('aria-pressed', canSelect && odcPanMode ? 'true' : 'false');
  }
  const el = odcMap?.getContainer();
  if (el) {
    el.style.cursor = canSelect && !odcPanMode ? 'crosshair' : '';
  }
  odcHint(null);
}

// A drag draws a box and a tap toggles one area, as in the ENC Charts tab;
// a second finger pinches, and with Move map on a drag pans the map.
function odcWireGestures(el: HTMLElement): void {
  const touches = new Set<number>();
  let pointerId: number | null = null;
  let startPoint: L.Point | null = null;
  let start: L.LatLng | null = null;
  let box: L.Rectangle | null = null;

  const reset = (): void => {
    if (box && odcMap) {
      odcMap.removeLayer(box);
    }
    box = null;
    start = null;
    startPoint = null;
    pointerId = null;
  };

  el.addEventListener(
    'pointerdown',
    (ev: PointerEvent) => {
      if (!odcMap) {
        return;
      }
      if (ev.pointerType === 'touch') {
        touches.add(ev.pointerId);
        if (touches.size > 1) {
          reset();
          return;
        }
      }
      if (ev.button !== 0 || (ev.target as HTMLElement | null)?.closest('.leaflet-control')) {
        return;
      }
      pointerId = ev.pointerId;
      startPoint = odcMap.mouseEventToContainerPoint(ev);
      start = odcMap.containerPointToLatLng(startPoint);
      if (odcCanSelect() && (!odcPanMode || ev.shiftKey)) {
        if (ev.pointerType === 'mouse') {
          ev.preventDefault();
        }
        odcMap.dragging.disable();
      }
    },
    true
  );
  el.addEventListener('pointermove', (ev: PointerEvent) => {
    if (!odcMap) {
      return;
    }
    const point = odcMap.mouseEventToContainerPoint(ev);
    if (ev.pointerId !== pointerId || !start || !startPoint) {
      if (ev.pointerType === 'mouse') {
        odcHover(odcMap.containerPointToLatLng(point));
      }
      return;
    }
    if (odcMap.dragging.enabled() || (!box && point.distanceTo(startPoint) < ODC_DRAG_THRESHOLD_PX)) {
      return;
    }
    const bounds = L.latLngBounds(start, odcMap.containerPointToLatLng(point));
    if (box) {
      box.setBounds(bounds);
    } else {
      odcHover(null);
      box = L.rectangle(bounds, {
        color: '#1565c0',
        weight: 1,
        dashArray: '4 4',
        fillOpacity: 0.08,
        interactive: false
      }).addTo(odcMap);
    }
  });
  el.addEventListener('pointerleave', () => {
    odcHover(null);
  });
  el.addEventListener(
    'touchmove',
    (ev: TouchEvent) => {
      if (box && ev.touches.length === 1) {
        ev.preventDefault();
      }
    },
    { passive: false }
  );
  const finish = (ev: PointerEvent): void => {
    touches.delete(ev.pointerId);
    if (!odcMap || ev.pointerId !== pointerId || !startPoint) {
      if (touches.size === 0) {
        odcMap?.dragging.enable();
      }
      return;
    }
    const release = odcMap.mouseEventToContainerPoint(ev);
    const bounds = box?.getBounds() ?? null;
    const tapped =
      ev.type === 'pointerup' &&
      !bounds &&
      release.distanceTo(startPoint) < ODC_DRAG_THRESHOLD_PX &&
      (ev.target as HTMLElement | null)?.closest('.leaflet-control') === null;
    reset();
    if (touches.size === 0) {
      odcMap.dragging.enable();
    }
    if (bounds && ev.type === 'pointerup') {
      void odcToggle(odcUnitsInBox(bounds), true);
    } else if (tapped && window.canChange('readwrite')) {
      const unit = odcUnitAt(odcMap.containerPointToLatLng(release));
      if (unit && !odcActive()?.busy) {
        void odcToggle([unit], false);
      }
    }
  };
  window.addEventListener('pointerup', finish, true);
  window.addEventListener('pointercancel', finish, true);
}

function odcHover(latlng: L.LatLng | null): void {
  if (!odcMap || !odcHoverTip) {
    return;
  }
  const unit = latlng ? odcUnitAt(latlng) : null;
  if (!unit || !latlng) {
    if (odcMap.hasLayer(odcHoverTip)) {
      odcMap.removeLayer(odcHoverTip);
    }
    return;
  }
  const share = unit.quality?.share ?? {};
  const shares = Object.entries(share)
    .filter(([, v]) => v > 0)
    .map(([k, v]) => `${odcEsc(odcQualityLabel(k))} ${String(Math.round(v * 100))}%`)
    .join(', ');
  odcHoverTip
    .setLatLng(latlng)
    .setContent(
      `<strong>${odcEsc(unit.id)}</strong> · ${odcFormatSize(unit.size)}<br>` +
        `Best: ${odcEsc(odcQualityLabel(unit.quality?.best))}${shares ? `<br>${shares}` : ''}` +
        (unit.surveys !== null ? `<br>${String(unit.surveys)} survey(s)` : '') +
        (unit.built ? `<br>Built ${odcEsc(unit.built)}` : '')
    );
  if (!odcMap.hasLayer(odcHoverTip)) {
    odcHoverTip.addTo(odcMap);
  }
}

// ---- Sets ----

async function odcLoadSets(): Promise<void> {
  try {
    const resp = await fetch(`${ODC_API}/sets`);
    if (!resp.ok) {
      throw new Error(`HTTP ${String(resp.status)}`);
    }
    odcSets = (await resp.json()) as OdcSet[];
  } catch {
    odcSets = [];
  }
  if (odcActiveId === null || !odcSets.some((s) => s.id === odcActiveId)) {
    odcActiveId = odcSets[0]?.id ?? null;
  }
  odcRenderAll();
}

function odcRenderAll(): void {
  odcRenderList();
  odcRenderDetail();
  odcRestyle();
  odcUpdateMapMode();
  const busy = odcSets.some((s) => s.busy);
  if (busy && odcPoll === null) {
    odcPoll = setInterval(() => void odcLoadSets(), ODC_POLL_MS);
  } else if (!busy && odcPoll !== null) {
    clearInterval(odcPoll);
    odcPoll = null;
  }
}

function odcStatusText(set: OdcSet): { text: string; dot: string } {
  if (set.busy) {
    return { text: 'Working…', dot: 'yellow' };
  }
  switch (set.status) {
    case 'up_to_date':
      return { text: 'Up to date', dot: 'green' };
    case 'update_available':
      return { text: 'Update available', dot: 'yellow' };
    case 'changed':
      return { text: 'Areas changed; apply to update the chart', dot: 'yellow' };
    case 'not_built':
      return { text: 'Not downloaded yet', dot: 'red' };
    default:
      return { text: 'No areas selected', dot: 'clear' };
  }
}

function odcRenderList(): void {
  const list = document.getElementById('odcList');
  if (!list) {
    return;
  }
  list.innerHTML =
    odcSets.length === 0
      ? '<div class="cc-empty">No chart sets yet. Click “New” to create one.</div>'
      : odcSets
          .map(
            (set) => `
      <div class="cc-list-row${set.id === odcActiveId ? ' active' : ''}" data-odc-select="${odcEsc(set.id)}">
        <span class="cc-status-dot cc-dot-${odcStatusText(set).dot}"></span>
        <span class="cc-list-name">${odcEsc(set.name)}</span>
        <span class="cc-list-meta">${String(set.unitIds.length)}</span>
      </div>`
          )
          .join('');
}

function odcSelectedBytes(set: OdcSet): number {
  return set.unitIds.reduce((sum, id) => sum + (odcUnits.get(id)?.size ?? 0), 0);
}

function odcRenderDetail(): void {
  const set = odcActive();
  const detail = document.getElementById('odcDetail');
  const build = document.getElementById('odcBuildBtn') as HTMLButtonElement | null;
  const rename = document.getElementById('odcRenameBtn') as HTMLButtonElement | null;
  const del = document.getElementById('odcDeleteBtn') as HTMLButtonElement | null;
  if (build) {
    build.disabled =
      !set || set.busy || (set.unitIds.length === 0 && !set.chartExists) || set.status === 'up_to_date';
    build.textContent = !set?.chartExists ? 'Download' : set.status === 'update_available' ? 'Update' : 'Apply';
  }
  if (rename) {
    rename.disabled = !set || set.busy;
  }
  if (del) {
    del.disabled = !set || set.busy;
  }
  odcRenderProgress(set);
  if (!detail) {
    return;
  }
  if (!set) {
    detail.innerHTML =
      '<div class="cc-detail-empty">Select or create a chart set, then pick areas on the map.</div>';
    return;
  }
  const status = odcStatusText(set);
  const updates =
    set.updates.length > 0
      ? `<ul class="cc-reasons">${set.updates
          .map(
            (u) =>
              `<li>${odcEsc(u.id)}: new version${u.changes ? ` — ${odcEsc(u.changes)}` : ''}</li>`
          )
          .join('')}</ul>`
      : '';
  const missing =
    set.missing.length > 0
      ? `<div class="cc-missing">${String(set.missing.length)} area(s) are no longer published: ${odcEsc(set.missing.join(', '))}</div>`
      : '';
  const rows = set.units
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((u) => {
      const inSet = set.unitIds.includes(u.id);
      const version = u.builtVersion ?? u.version ?? '';
      const note = !inSet
        ? 'removed on apply'
        : u.builtVersion === null
          ? 'new'
          : u.version !== null && u.version !== u.builtVersion
            ? 'update'
            : '';
      return `<tr>
        <td title="Best data: ${odcEsc(odcQualityLabel(u.quality))}"><span class="odc-dot" style="background:${odcQualityColor(u.quality)}"></span>${odcEsc(u.id)}</td>
        <td title="${odcEsc(version)}">${odcEsc(version.slice(0, 8))}${note ? ` <em>${note}</em>` : ''}</td>
        <td>${u.size !== null ? odcFormatSize(u.size) : '–'}</td>
        <td>${u.diskBytes > 0 ? odcFormatSize(u.diskBytes) : '–'}</td>
      </tr>`;
    })
    .join('');
  detail.innerHTML = `
    <div class="cc-detail-name">${odcEsc(set.name)}</div>
    <div class="cc-detail-status cc-status-${status.dot}">${odcEsc(status.text)}</div>
    ${updates}${missing}
    <div class="cc-detail-meta">${String(set.unitIds.length)} area(s) · ${odcFormatSize(odcSelectedBytes(set))}</div>
    <div class="cc-detail-date">To download: ${odcFormatSize(set.downloadBytes)} · Free in the chart folder: ${
      set.freeBytes !== null ? odcFormatSize(set.freeBytes) : 'unknown'
    }</div>
    ${
      set.chartFile && set.chartExists
        ? `<div class="cc-detail-date">Chart: ${odcEsc(set.chartFile)}${
            set.lastBuiltAt ? `, built ${odcEsc(new Date(set.lastBuiltAt).toLocaleString())}` : ''
          }</div>`
        : ''
    }
    ${
      rows
        ? `<div class="odc-units-wrap"><table class="odc-units"><thead><tr><th>Area</th><th>Version</th><th>Size</th><th>On disk</th></tr></thead><tbody>${rows}</tbody></table></div>`
        : ''
    }`;
}

function odcRenderProgress(set: OdcSet | null): void {
  const el = document.getElementById('odcProgress');
  if (!el) {
    return;
  }
  const p = set?.progress;
  if (!set || !p) {
    el.innerHTML = '';
    return;
  }
  const pct = p.bytesTotal > 0 ? Math.round((p.bytesDone / p.bytesTotal) * 100) : -1;
  const indeterminate = p.phase === 'building' || pct < 0;
  const done = p.phase === 'completed' || p.phase === 'failed' || p.phase === 'cancelled';
  el.innerHTML = `
    <div class="cc-prog">
      <div class="cc-prog-head">
        <span class="cc-prog-phase">${odcEsc(p.message)}</span>
        ${set.busy ? '<button class="cc-btn cc-btn-danger cc-cancel-btn" data-needs="readwrite" data-odc-action="cancel">Cancel</button>' : ''}
      </div>
      ${
        done
          ? ''
          : `<div class="cc-prog-line">
        <div class="cc-prog-caption">${
          p.phase === 'downloading'
            ? `${String(p.unitsDone)} of ${String(p.unitsTotal)} · ${odcFormatSize(p.bytesDone)} of ${odcFormatSize(p.bytesTotal)}`
            : 'Building the chart'
        }</div>
        <div class="cc-bar"><div class="cc-bar-fill${indeterminate ? ' cc-bar-indeterminate' : ''}" style="${
          indeterminate ? '' : `width:${String(pct)}%`
        }"></div></div>
      </div>`
      }
    </div>`;
}

async function odcRequest(
  url: string,
  init: RequestInit & { json?: unknown } = {}
): Promise<unknown> {
  const { json, ...rest } = init;
  const resp = await fetch(url, {
    ...rest,
    ...(json !== undefined
      ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(json) }
      : {})
  });
  const body = (await resp.json().catch(() => ({}))) as { error?: string };
  if (!resp.ok) {
    throw new Error(body.error ?? `HTTP ${String(resp.status)}`);
  }
  return body;
}

async function odcPut(id: string, change: { unitIds?: string[]; name?: string }): Promise<void> {
  try {
    await odcRequest(`${ODC_API}/sets/${encodeURIComponent(id)}`, { method: 'PUT', json: change });
  } catch (error) {
    alert(`Could not save the set: ${error instanceof Error ? error.message : String(error)}`);
  }
  await odcLoadSets();
}

/** The one-time statement that these charts are not for navigation. */
function odcAcknowledge(): Promise<boolean> {
  return new Promise((resolve) => {
    document.body.insertAdjacentHTML(
      'beforeend',
      `<div class="delete-modal-overlay" id="odcAckModal">
        <div class="delete-modal">
          <div class="delete-modal-header">
            <div class="delete-modal-icon">${window.getIcon('warning')}</div>
            <h3>Not for navigation</h3>
          </div>
          <div class="delete-modal-body">
            <p>Open Data Charts are built automatically from open data: Shom surveys and models,
            OpenStreetMap and other sources. They are not official charts. Depths, dangers and
            aids to navigation may be missing, outdated or wrong.</p>
            <label class="mask-option"><input type="checkbox" id="odcAckCheck" />
            I understand that these charts are not for navigation.</label>
          </div>
          <div class="delete-modal-actions">
            <button class="btn btn-secondary" id="odcAckCancel">Cancel</button>
            <button class="btn btn-primary" id="odcAckOk" disabled>Continue</button>
          </div>
        </div>
      </div>`
    );
    const modal = document.getElementById('odcAckModal');
    const ok = document.getElementById('odcAckOk') as HTMLButtonElement | null;
    const close = (answer: boolean): void => {
      modal?.remove();
      resolve(answer);
    };
    document.getElementById('odcAckCheck')?.addEventListener('change', (ev) => {
      if (ok) {
        ok.disabled = !(ev.target as HTMLInputElement).checked;
      }
    });
    document.getElementById('odcAckCancel')?.addEventListener('click', () => {
      close(false);
    });
    ok?.addEventListener('click', () => {
      close(true);
    });
  });
}

async function odcBuild(): Promise<void> {
  const set = odcActive();
  if (!set) {
    return;
  }
  if (!odcAcknowledged) {
    if (!(await odcAcknowledge())) {
      return;
    }
    try {
      await odcRequest(`${ODC_API}/acknowledge`, { method: 'POST' });
      odcAcknowledged = true;
    } catch (error) {
      alert(error instanceof Error ? error.message : String(error));
      return;
    }
  }
  try {
    await odcRequest(`${ODC_API}/sets/${encodeURIComponent(set.id)}/build`, { method: 'POST' });
  } catch (error) {
    alert(`Could not start: ${error instanceof Error ? error.message : String(error)}`);
  }
  await odcLoadSets();
}

function odcWireHandlers(output: HTMLElement): void {
  output.addEventListener('click', (ev) => {
    const target = ev.target as HTMLElement;
    const row = target.closest<HTMLElement>('[data-odc-select]');
    if (row?.dataset['odcSelect']) {
      odcActiveId = row.dataset['odcSelect'];
      odcRenderAll();
      odcFitActive();
      return;
    }
    const action = target.closest<HTMLElement>('[data-odc-action]')?.dataset['odcAction'];
    const set = odcActive();
    switch (action) {
      case 'new': {
        const form = document.getElementById('odcNewForm');
        if (form) {
          form.style.display = '';
        }
        document.getElementById('odcNewName')?.focus();
        break;
      }
      case 'create-cancel': {
        const form = document.getElementById('odcNewForm');
        if (form) {
          form.style.display = 'none';
        }
        break;
      }
      case 'create':
        void odcCreate();
        break;
      case 'build':
        void odcBuild();
        break;
      case 'rename':
        if (set) {
          const name = prompt('New name for the chart set', set.name)?.trim();
          if (name && name !== set.name) {
            void odcPut(set.id, { name });
          }
        }
        break;
      case 'delete':
        if (set && confirm(`Delete the chart set “${set.name}”? Its chart stays in Manage Charts.`)) {
          void odcRequest(`${ODC_API}/sets/${encodeURIComponent(set.id)}`, { method: 'DELETE' })
            .catch((error: unknown) => {
              alert(error instanceof Error ? error.message : String(error));
            })
            .then(() => odcLoadSets());
        }
        break;
      case 'cancel':
        if (set) {
          void odcRequest(`${ODC_API}/sets/${encodeURIComponent(set.id)}/cancel`, {
            method: 'POST'
          }).then(() => odcLoadSets());
        }
        break;
      case 'refresh-index':
        void odcLoadIndex(true).then(() => odcLoadSets());
        break;
      case 'pan-mode':
        odcPanMode = !odcPanMode;
        odcUpdateMapMode();
        break;
      default:
        break;
    }
  });
  output.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && (ev.target as HTMLElement).id === 'odcNewName') {
      void odcCreate();
    }
  });
}

async function odcCreate(): Promise<void> {
  const input = document.getElementById('odcNewName') as HTMLInputElement | null;
  const name = input?.value.trim() ?? '';
  if (!name) {
    return;
  }
  try {
    const set = (await odcRequest(`${ODC_API}/sets`, { method: 'POST', json: { name } })) as OdcSet;
    odcActiveId = set.id;
    if (input) {
      input.value = '';
    }
    const form = document.getElementById('odcNewForm');
    if (form) {
      form.style.display = 'none';
    }
  } catch (error) {
    alert(`Could not create the set: ${error instanceof Error ? error.message : String(error)}`);
  }
  await odcLoadSets();
}

function odcFormatSize(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
}

function odcEsc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
