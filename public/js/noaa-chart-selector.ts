// NOAA Charts tab — build a named "chart set" by selecting NOAA band-4
// coverage areas on a map. Selected areas plus the overlapping band-3/5 ENCs
// are downloaded and converted server-side into one MBTiles per chart set.
// (NOAA is currently the only source of freely-downloadable ENC charts, hence
// the NOAA-specific labelling; the API/server modules keep the generic
// "custom-catalog" names.)

const CC_API_BASE = '/plugins/signalk-charts-provider-simple';

// Selected-area fill colours, by state.
const CC_RED = '#e53935'; // selected, needs download / out of date
const CC_YELLOW = '#f6c000'; // downloaded / in progress, not yet converted
const CC_GREEN = '#2e9e4f'; // downloaded + converted, up to date

interface CcBBox {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
}

interface Band4MapEntry {
  chartId: string;
  encEdUp: string;
  title: string;
  scale: number | null;
  bbox: CcBBox;
}

interface FootprintsResponse {
  band4: Band4MapEntry[];
  fetchedAt: number;
  stale: boolean;
}

type CustomCatalogStatus = 'empty' | 'out_of_date' | 'downloaded' | 'converted';

interface CustomCatalog {
  id: string;
  name: string;
  selectedBand4ChartIds: string[];
  includedChartIds: string[];
  convertedChartPath: string | null;
  status: CustomCatalogStatus;
  lastConvertedAt: string | null;
  // Decorated server-side fields.
  effectiveStatus: string;
  includedCount: number;
  updateReasons: string[];
  // Per-box freshness by NOAA edition: band-4 chartId -> 'up_to_date' | 'needs_refresh'.
  boxStates: Record<string, string>;
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

let ccInitialized = false;
let ccMap: L.Map | null = null;
let ccFootprintLayer: L.LayerGroup | null = null;
const ccRectByChartId = new Map<string, L.Rectangle>();
// Per-box bottom-to-top "fill" overlays, shown during download.
const ccFillRects = new Map<string, L.Rectangle>();
let ccBand4: Band4MapEntry[] = [];
let ccCatalogs: CustomCatalog[] = [];
let ccActiveId: string | null = null;
let ccBusy = false;
let ccDetail: CatalogProgressDetail | null = null;
let ccStatusPoll: ReturnType<typeof setInterval> | null = null;

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
          <input type="text" id="ccNewName" class="cc-input" placeholder="Catalog name" maxlength="120" />
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
        <div class="cc-map-note" id="ccMapNote">Loading NOAA coverage…</div>
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
  await Promise.all([loadCatalogs(), loadFootprints()]);
  // Both the catalog list (auto-selects the first) and the footprints are now
  // loaded. The map was created the instant this tab became visible, so Leaflet
  // may have cached a stale (zero) container size; recompute it, then frame the
  // active catalog (or all footprints if none). Deferred a tick so layout has
  // settled, and non-animated since it's the only fit now (drawFootprints no
  // longer fits, so there's nothing to race).
  window.setTimeout(() => {
    ccMap?.invalidateSize();
    const cat = ccActiveCatalog();
    if (cat && cat.selectedBand4ChartIds.length > 0) {
      fitMapToActiveCatalog({ animate: false });
    } else {
      fitMapToAllFootprints({ animate: false });
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
  ccMap = L.map(el, { worldCopyJump: true, minZoom: 2 }).setView([37.8, -96], 4);
  // OpenSeaMap = OSM base + a seamark overlay. Tiles need internet; if they
  // fail the footprints stay fully usable, so selection still works offline.
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18,
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(ccMap);
  L.tileLayer('https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png', {
    maxZoom: 18,
    attribution: 'Seamarks &copy; OpenSeaMap'
  }).addTo(ccMap);
  ccFootprintLayer = L.layerGroup().addTo(ccMap);
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
      return 'No coverage areas selected';
    default:
      return 'Needs download & convert';
  }
}

async function loadFootprints(forceRefresh = false): Promise<void> {
  const note = document.getElementById('ccMapNote');
  try {
    const resp = await fetch(
      `${CC_API_BASE}/custom-catalogs/noaa-enc-footprints${forceRefresh ? '?refresh=1' : ''}`
    );
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`);
    }
    const data = (await resp.json()) as FootprintsResponse;
    ccBand4 = data.band4;
    drawFootprints();
    if (note) {
      note.textContent = `${ccBand4.length} NOAA band-4 areas${
        data.stale ? ' (cached copy)' : ''
      } — click an area to add it to the selected chart set.`;
    }
  } catch {
    if (note) {
      note.textContent = "Could not load NOAA ENC coverage. Check the server's internet connection.";
    }
  }
}

function drawFootprints(): void {
  if (!ccMap || !ccFootprintLayer) {
    return;
  }
  ccFootprintLayer.clearLayers();
  ccRectByChartId.clear();
  ccFillRects.clear();
  for (const entry of ccBand4) {
    const rectBounds: L.LatLngBoundsExpression = [
      [entry.bbox.minLat, entry.bbox.minLon],
      [entry.bbox.maxLat, entry.bbox.maxLon]
    ];
    const rect = L.rectangle(rectBounds, ccClearStyle());
    rect.bindTooltip(`${entry.chartId} — ${entry.title}`, { sticky: true });
    rect.on('click', () => {
      void onAreaClick(entry.chartId);
    });
    rect.addTo(ccFootprintLayer);
    ccRectByChartId.set(entry.chartId, rect);
  }
  // Note: the map view is framed by init / selectCatalog (fitMapToActiveCatalog
  // or fitMapToAllFootprints), not here — a fit during draw competed with the
  // initial catalog fit and won the race, leaving the wide view.
  refreshAreaColors();
}

function refreshAreaColors(): void {
  const active = ccActiveCatalog();
  const selected = new Set(active?.selectedBand4ChartIds ?? []);
  // While downloading, each box shows a red base with a yellow fill rising
  // bottom-to-top by its own band-4 + nested-band-5 completed fraction.
  const downloading = ccBusy && ccDetail?.phase === 'downloading';
  // Idle colour is per-box, driven by NOAA-edition freshness (green = baked
  // editions still current, red = NOAA has a newer edition / never built).
  // Falls back to the catalog-level colour if the footprint index isn't loaded.
  const boxStates = active?.boxStates ?? {};
  const haveBoxStates = Object.keys(boxStates).length > 0;
  for (const [chartId, rect] of ccRectByChartId) {
    if (!active || !selected.has(chartId)) {
      rect.setStyle(ccClearStyle());
      continue;
    }
    let color: string;
    if (downloading) {
      color = CC_RED; // base; the fill overlay shows per-box progress
    } else if (ccBusy) {
      color = CC_YELLOW; // converting / combining
    } else if (haveBoxStates) {
      color = boxStates[chartId] === 'up_to_date' ? CC_GREEN : CC_RED;
    } else {
      color = ccStatusColor(active);
    }
    rect.setStyle(ccSelectedStyle(color));
  }
  updateFillOverlays(downloading, selected);
}

// Box fill fraction = (band-4 + nested band-5 charts downloaded) / (that
// box's total), 0..1.
function boxFillFraction(chartId: string): number {
  const cov = ccDetail?.coverageByBox?.[chartId];
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
  const entryById = new Map(ccBand4.map((e) => [e.chartId, e]));
  for (const chartId of selected) {
    const entry = entryById.get(chartId);
    const frac = boxFillFraction(chartId);
    if (!entry || frac <= 0) {
      removeFillOverlay(chartId);
      continue;
    }
    const { minLat, minLon, maxLat, maxLon } = entry.bbox;
    const topLat = minLat + frac * (maxLat - minLat);
    const bounds = L.latLngBounds([
      [minLat, minLon],
      [topLat, maxLon]
    ]);
    const existing = ccFillRects.get(chartId);
    if (existing) {
      existing.setBounds(bounds);
    } else {
      const overlay = L.rectangle(bounds, {
        stroke: false,
        fill: true,
        fillColor: CC_YELLOW,
        fillOpacity: 0.55,
        interactive: false
      });
      overlay.addTo(ccFootprintLayer);
      ccFillRects.set(chartId, overlay);
    }
  }
  // Drop overlays for boxes no longer selected.
  for (const id of [...ccFillRects.keys()]) {
    if (!selected.has(id)) {
      removeFillOverlay(id);
    }
  }
}

function removeFillOverlay(chartId: string): void {
  const overlay = ccFillRects.get(chartId);
  if (overlay) {
    ccFootprintLayer?.removeLayer(overlay);
    ccFillRects.delete(chartId);
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
        <span class="cc-list-meta">${cat.selectedBand4ChartIds.length}</span>
      </div>`
    )
    .join('');
}

function renderDetail(): void {
  const detail = document.getElementById('ccDetail');
  const dlBtn = document.getElementById('ccDownloadBtn') as HTMLButtonElement | null;
  const delBtn = document.getElementById('ccDeleteBtn') as HTMLButtonElement | null;
  const cat = ccActiveCatalog();

  if (dlBtn) {
    dlBtn.disabled = !cat || cat.selectedBand4ChartIds.length === 0 || ccBusy;
  }
  if (delBtn) {
    delBtn.disabled = !cat || ccBusy;
  }

  if (!detail) {
    return;
  }
  if (!cat) {
    detail.innerHTML = `<div class="cc-detail-empty">Select or create a chart set, then click coverage areas on the map.</div>`;
    return;
  }
  detail.innerHTML = `
    <div class="cc-detail-name">${ccEscHtml(cat.name)}</div>
    <div class="cc-detail-status cc-status-${ccStatusClass(cat)}">${ccEscHtml(ccStatusLabel(cat))}</div>
    <div class="cc-detail-meta">${cat.selectedBand4ChartIds.length} selected area(s) &rarr; ${
      cat.includedCount
    } ENC(s) incl. band 3/5</div>
    ${
      cat.updateReasons.length > 0
        ? `<ul class="cc-reasons">${cat.updateReasons
            .map((r) => `<li>${ccEscHtml(r)}</li>`)
            .join('')}</ul>`
        : ''
    }
    ${
      cat.lastConvertedAt
        ? `<div class="cc-detail-date">Last built ${ccEscHtml(
            new Date(cat.lastConvertedAt).toLocaleString()
          )}</div>`
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
  } else if (ccBusy && d?.phase === 'joining') {
    // The tile-join container job can't be interrupted (signalk-container's
    // runJob has no abort), so don't offer a Cancel that wouldn't work.
    cancelHtml = `<span class="cc-cancel-pending">Can't be interrupted</span>`;
  } else if (ccBusy) {
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

async function onAreaClick(chartId: string): Promise<void> {
  const cat = ccActiveCatalog();
  if (!cat) {
    const note = document.getElementById('ccMapNote');
    if (note) {
      note.textContent = 'Create or select a chart set first, then click coverage areas.';
    }
    return;
  }
  if (ccBusy) {
    return;
  }
  const selected = new Set(cat.selectedBand4ChartIds);
  if (selected.has(chartId)) {
    selected.delete(chartId);
  } else {
    selected.add(chartId);
  }
  cat.selectedBand4ChartIds = Array.from(selected);
  // Optimistic recolour; the PUT response refreshes counts/status.
  refreshAreaColors();
  await putSelection(cat);
}

async function putSelection(cat: CustomCatalog): Promise<void> {
  try {
    const resp = await fetch(`${CC_API_BASE}/custom-catalogs/${encodeURIComponent(cat.id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ selectedBand4ChartIds: cat.selectedBand4ChartIds })
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

// Center + zoom the map to the bounding box of the active catalog's selected
// band-4 areas. No-op if the map/footprints aren't ready or the catalog has
// no selection (we leave the current view rather than jumping to the world).
function fitMapToActiveCatalog(opts: { animate?: boolean } = {}): void {
  if (!ccMap) {
    return;
  }
  const cat = ccActiveCatalog();
  if (!cat || cat.selectedBand4ChartIds.length === 0) {
    return;
  }
  const entryById = new Map(ccBand4.map((e) => [e.chartId, e]));
  const points: L.LatLngExpression[] = [];
  for (const id of cat.selectedBand4ChartIds) {
    const e = entryById.get(id);
    if (e) {
      points.push([e.bbox.minLat, e.bbox.minLon], [e.bbox.maxLat, e.bbox.maxLon]);
    }
  }
  if (points.length === 0) {
    return;
  }
  // maxZoom keeps a single small box from zooming in uncomfortably far.
  ccMap.fitBounds(L.latLngBounds(points), {
    padding: [30, 30],
    maxZoom: 11,
    animate: opts.animate ?? true
  });
}

// Fit to all NOAA band-4 footprints — the fallback view when no catalog is
// selected (e.g. a fresh install with no catalogs yet).
function fitMapToAllFootprints(opts: { animate?: boolean } = {}): void {
  if (!ccMap || ccBand4.length === 0) {
    return;
  }
  const points: L.LatLngExpression[] = [];
  for (const e of ccBand4) {
    points.push([e.bbox.minLat, e.bbox.minLon], [e.bbox.maxLat, e.bbox.maxLon]);
  }
  ccMap.fitBounds(L.latLngBounds(points), { padding: [20, 20], animate: opts.animate ?? true });
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
  if (!cat || ccBusy || cat.selectedBand4ChartIds.length === 0) {
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
      default:
        break;
    }
  });

  output.addEventListener('keydown', (ev) => {
    const target = ev.target as HTMLElement | null;
    if (target?.id === 'ccNewName' && (ev).key === 'Enter') {
      ev.preventDefault();
      void createCatalog();
    }
  });

  output.dataset['ccWired'] = '1';
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
