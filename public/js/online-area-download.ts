/**
 * "Offline area" dialog for online charts kept offline: show the chart on a
 * map, take the visible part of the map as the area, pick zoom levels, and
 * have the server fetch and keep every tile in it. A chart whose provider
 * allows no area downloads gets the same dialog with only its kept tiles.
 */

const AREA_API_BASE = '/plugins/signalk-charts-provider-simple';
const AREA_TILE_BASE = '/signalk/v1/api/resources/charts';
/** Matches MAX_AREA_TILES on the server, which has the final say. */
const AREA_MAX_TILES = 100_000;
const AREA_MAX_LAT = 85.0511287798066;

type AreaBbox = [number, number, number, number];

interface AreaJob {
  id: string;
  chartId: string;
  status: 'running' | 'completed' | 'cancelled' | 'failed';
  total: number;
  done: number;
  fetched: number;
  failed: number;
  error?: string;
}

interface AreaDialogState {
  chartId: string;
  minzoom: number;
  maxzoom: number;
  /** Null for a chart whose provider allows no area downloads. */
  map: L.Map | null;
  poll: ReturnType<typeof setInterval> | null;
  /** The download running now, if any. */
  jobId: string | null;
  /** The download on show, kept after it ends so its outcome stays visible. */
  shownJobId: string | null;
}

let areaDialog: AreaDialogState | null = null;

function areaEscape(str: string): string {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function areaLonToX(lon: number, z: number): number {
  const n = 2 ** z;
  return Math.min(n - 1, Math.max(0, Math.floor(((lon + 180) / 360) * n)));
}

function areaLatToY(lat: number, z: number): number {
  const n = 2 ** z;
  const r = (Math.max(-AREA_MAX_LAT, Math.min(AREA_MAX_LAT, lat)) * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n);
  return Math.min(n - 1, Math.max(0, y));
}

/** Same count as the server's countAreaTiles. */
function areaTileCount(bbox: AreaBbox, minzoom: number, maxzoom: number): number {
  const [west, south, east, north] = bbox;
  let total = 0;
  for (let z = minzoom; z <= maxzoom; z++) {
    const rows = areaLatToY(south, z) - areaLatToY(north, z) + 1;
    const from = areaLonToX(west, z);
    const to = areaLonToX(east, z);
    // Matches the server: an antimeridian area whose halves meet spans the row once.
    const cols = west <= east ? to - from + 1 : to >= from ? 2 ** z : 2 ** z - from + to + 1;
    total += rows * cols;
  }
  return total;
}

function wrapLon(lon: number): number {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

/** The visible part of the map as an area, wrapped onto -180..180. */
function areaFromMap(map: L.Map): AreaBbox {
  const b = map.getBounds();
  const south = Math.max(-AREA_MAX_LAT, b.getSouth());
  const north = Math.min(AREA_MAX_LAT, b.getNorth());
  if (b.getEast() - b.getWest() >= 360) {
    return [-180, south, 180, north];
  }
  const east = wrapLon(b.getEast());
  // An east edge on the date line is 180, not -180, or the area would read
  // as crossing it.
  return [wrapLon(b.getWest()), south, east === -180 ? 180 : east, north];
}

function areaFormatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${String(Math.round(bytes / 1024))} KB`;
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function areaEl(id: string): HTMLElement | null {
  return document.getElementById(id);
}

function zoomOptions(from: number, to: number, selected: number): string {
  let html = '';
  for (let z = from; z <= to; z++) {
    html += `<option value="${String(z)}" ${z === selected ? 'selected' : ''}>${String(z)}</option>`;
  }
  return html;
}

function selectedZooms(): { from: number; to: number } {
  const from = Number((areaEl('areaZoomFrom') as HTMLSelectElement | null)?.value ?? 0);
  const to = Number((areaEl('areaZoomTo') as HTMLSelectElement | null)?.value ?? 0);
  return { from, to };
}

function updateAreaEstimate(): void {
  if (!areaDialog?.map) {
    return;
  }
  const { from, to } = selectedZooms();
  const estimate = areaEl('areaEstimate');
  const start = (areaEl('areaStart') as HTMLButtonElement | null);
  if (!estimate || !start) {
    return;
  }
  if (from > to) {
    estimate.textContent = 'The first zoom level must not be above the last.';
    start.disabled = true;
    return;
  }
  const count = areaTileCount(areaFromMap(areaDialog.map), from, to);
  const tooMany = count > AREA_MAX_TILES;
  estimate.textContent = tooMany
    ? `${count.toLocaleString()} tiles: too many. Zoom the map in or lower the last zoom level (at most ${AREA_MAX_TILES.toLocaleString()}).`
    : `${count.toLocaleString()} tiles in the visible area.`;
  estimate.classList.toggle('area-too-many', tooMany);
  start.disabled = tooMany || areaDialog.jobId !== null;
}

async function refreshKeptStats(): Promise<void> {
  if (!areaDialog) {
    return;
  }
  const el = areaEl('areaKept');
  try {
    const res = await fetch(
      `${AREA_API_BASE}/online-charts/${encodeURIComponent(areaDialog.chartId)}/offline`
    );
    if (!res.ok || !el) {
      return;
    }
    const { tiles, bytes } = (await res.json()) as { tiles: number; bytes: number };
    el.textContent =
      tiles > 0
        ? `Kept on the server: ${tiles.toLocaleString()} tiles (${areaFormatBytes(bytes)}).`
        : 'No tiles kept on the server yet.';
    const clear = (areaEl('areaClear') as HTMLButtonElement | null);
    if (clear) {
      clear.disabled = tiles === 0 || areaDialog.jobId !== null;
    }
  } catch {
    // The stats line is informational only.
  }
}

function showAreaJob(job: AreaJob | null): void {
  const progress = areaEl('areaProgress');
  const cancel = (areaEl('areaCancel') as HTMLButtonElement | null);
  if (!progress || !cancel || !areaDialog) {
    return;
  }
  if (!job) {
    progress.innerHTML = '';
    cancel.hidden = true;
    return;
  }
  const pct = job.total > 0 ? Math.floor((job.done / job.total) * 100) : 100;
  const label =
    job.status === 'running'
      ? `Downloading: ${job.done.toLocaleString()} of ${job.total.toLocaleString()} tiles`
      : job.status === 'completed'
        ? `Done: ${job.fetched.toLocaleString()} tiles downloaded, the rest were already kept`
        : job.status === 'cancelled'
          ? 'Stopped'
          : (job.error ?? 'Failed');
  const failed =
    job.failed > 0 ? ` <span class="area-failed">${job.failed.toLocaleString()} failed</span>` : '';
  progress.innerHTML = `
    <div class="area-progress-bar"><div style="width: ${String(pct)}%"></div></div>
    <div class="area-progress-label">${areaEscape(label)}${failed}</div>`;
  cancel.hidden = job.status !== 'running';
}

async function pollAreaJob(): Promise<void> {
  const dialog = areaDialog;
  if (!dialog) {
    return;
  }
  try {
    const res = await fetch(`${AREA_API_BASE}/online-area-downloads`);
    if (!res.ok) {
      return;
    }
    const { jobs } = (await res.json()) as { jobs: AreaJob[] };
    if (areaDialog !== dialog) {
      return;
    }
    const mine = jobs.filter((j) => j.chartId === dialog.chartId);
    const job =
      mine.find((j) => j.status === 'running') ??
      mine.find((j) => j.id === dialog.shownJobId) ??
      null;
    showAreaJob(job);
    const wasRunning = dialog.jobId !== null;
    dialog.shownJobId = job?.id ?? null;
    dialog.jobId = job?.status === 'running' ? job.id : null;
    if (dialog.jobId === null && dialog.poll) {
      clearInterval(dialog.poll);
      dialog.poll = null;
    }
    if (wasRunning && dialog.jobId === null) {
      void refreshKeptStats();
    }
    updateAreaEstimate();
  } catch {
    // Try again on the next tick.
  }
}

function startAreaPolling(): void {
  if (areaDialog && !areaDialog.poll) {
    areaDialog.poll = setInterval(() => void pollAreaJob(), 1000);
  }
}

async function startAreaDownload(): Promise<void> {
  const dialog = areaDialog;
  if (!dialog?.map) {
    return;
  }
  const { from, to } = selectedZooms();
  let res: Response;
  try {
    res = await fetch(
      `${AREA_API_BASE}/online-charts/${encodeURIComponent(dialog.chartId)}/area-download`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bbox: areaFromMap(dialog.map), minzoom: from, maxzoom: to })
      }
    );
  } catch {
    alert('Could not reach the server to start the download.');
    return;
  }
  const body = (await res.json().catch(() => ({}))) as { job?: AreaJob; error?: string };
  if (!res.ok || !body.job) {
    alert(body.error ?? `Could not start the download (HTTP ${String(res.status)})`);
    return;
  }
  // The job runs on the server whether or not the dialog is still open.
  if (areaDialog !== dialog) {
    return;
  }
  dialog.jobId = body.job.id;
  dialog.shownJobId = body.job.id;
  showAreaJob(body.job);
  updateAreaEstimate();
  startAreaPolling();
}

async function cancelAreaDownload(): Promise<void> {
  if (!areaDialog?.jobId) {
    return;
  }
  try {
    await fetch(
      `${AREA_API_BASE}/online-area-downloads/${encodeURIComponent(areaDialog.jobId)}`,
      { method: 'DELETE' }
    );
  } catch {
    // The next poll shows whether it stopped.
  }
  void pollAreaJob();
}

async function clearKeptTiles(): Promise<void> {
  if (!areaDialog || !confirm('Delete every tile of this chart kept on the server?')) {
    return;
  }
  let res: Response;
  try {
    res = await fetch(
      `${AREA_API_BASE}/online-charts/${encodeURIComponent(areaDialog.chartId)}/offline`,
      { method: 'DELETE' }
    );
  } catch {
    alert('Could not reach the server to delete the kept tiles.');
    return;
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    alert(body.error ?? `Could not delete the kept tiles (HTTP ${String(res.status)})`);
  }
  void refreshKeptStats();
}

function closeAreaDialog(event?: Event): void {
  if (event && (event.target as HTMLElement).id !== 'areaModal') {
    return;
  }
  if (areaDialog) {
    if (areaDialog.poll) {
      clearInterval(areaDialog.poll);
    }
    areaDialog.map?.remove();
    areaDialog = null;
  }
  document.getElementById('areaModal')?.remove();
}

async function showOfflineArea(
  chartId: string,
  name: string,
  minzoom: number | null,
  maxzoom: number | null,
  areaDownload: boolean
): Promise<void> {
  closeAreaDialog();
  const lowest = minzoom ?? 0;
  const highest = Math.max(lowest, maxzoom ?? 18);
  if (!areaDownload) {
    showKeptTiles(chartId, name, lowest, highest);
    return;
  }
  document.body.insertAdjacentHTML(
    'beforeend',
    `
    <div class="delete-modal-overlay" id="areaModal" onclick="closeAreaDialog(event)">
      <div class="delete-modal area-modal" onclick="event.stopPropagation()">
        <div class="delete-modal-header">
          <h3>Offline area: ${areaEscape(name)}</h3>
        </div>
        <div class="delete-modal-body">
          <p class="area-help">Move and zoom the map to the area you want to have without internet. Everything you see is downloaded and kept on the server, and stays there until you delete it here or delete the chart: only tiles kept while browsing make room when the server's space for online charts is full.</p>
          <div id="areaMap" class="area-map"></div>
          <div class="area-zooms">
            <label>From zoom <select id="areaZoomFrom">${zoomOptions(lowest, highest, lowest)}</select></label>
            <label>to <select id="areaZoomTo">${zoomOptions(lowest, highest, Math.min(highest, 14))}</select></label>
          </div>
          <div id="areaEstimate" class="area-estimate"></div>
          <div id="areaProgress"></div>
          <div class="area-kept"><span id="areaKept"></span>
            <button class="btn btn-sm btn-danger" id="areaClear" onclick="clearKeptTiles()" disabled>Delete kept tiles</button>
          </div>
        </div>
        <div class="delete-modal-actions">
          <button class="btn btn-secondary" onclick="closeAreaDialog()">Close</button>
          <button class="btn btn-danger" id="areaCancel" onclick="cancelAreaDownload()" hidden>Stop</button>
          <button class="btn btn-primary" id="areaStart" onclick="startAreaDownload()">Download area</button>
        </div>
      </div>
    </div>`
  );
  const mapEl = areaEl('areaMap');
  if (!mapEl || typeof L === 'undefined') {
    return;
  }
  const map = L.map(mapEl, { worldCopyJump: true, minZoom: 1 }).setView([20, 0], 2);
  // See noaa-chart-selector.ts: OSM blocks tiles sent without a referrer.
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18,
    referrerPolicy: 'origin',
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(map);
  L.tileLayer(`${AREA_TILE_BASE}/${encodeURIComponent(chartId)}/{z}/{x}/{y}`, {
    maxZoom: 18
  }).addTo(map);
  areaDialog = {
    chartId,
    minzoom: lowest,
    maxzoom: highest,
    map,
    poll: null,
    jobId: null,
    shownJobId: null
  };
  map.on('moveend', updateAreaEstimate);
  areaEl('areaZoomFrom')?.addEventListener('change', updateAreaEstimate);
  areaEl('areaZoomTo')?.addEventListener('change', updateAreaEstimate);

  try {
    const res = await fetch(`${AREA_API_BASE}/vessel-position`);
    const { position } = (await res.json()) as {
      position: { latitude: number; longitude: number } | null;
    };
    if (position && areaDialog?.map === map) {
      map.setView([position.latitude, position.longitude], 9);
    }
  } catch {
    // Without a position the dialog starts on the whole world.
  }
  updateAreaEstimate();
  void refreshKeptStats();
  await pollAreaJob();
  if (areaDialog?.map === map && areaDialog.jobId !== null) {
    startAreaPolling();
  }
}

function showKeptTiles(chartId: string, name: string, minzoom: number, maxzoom: number): void {
  document.body.insertAdjacentHTML(
    'beforeend',
    `
    <div class="delete-modal-overlay" id="areaModal" onclick="closeAreaDialog(event)">
      <div class="delete-modal area-modal" onclick="event.stopPropagation()">
        <div class="delete-modal-header">
          <h3>Kept tiles: ${areaEscape(name)}</h3>
        </div>
        <div class="delete-modal-body">
          <p class="area-help">The server keeps every tile of this chart a chart plotter shows, so areas you have already looked at work without internet until the server's space for online charts is full and the oldest of them make room. Its provider does not allow downloading areas in advance.</p>
          <div class="area-kept"><span id="areaKept"></span>
            <button class="btn btn-sm btn-danger" id="areaClear" onclick="clearKeptTiles()" disabled>Delete kept tiles</button>
          </div>
        </div>
        <div class="delete-modal-actions">
          <button class="btn btn-secondary" onclick="closeAreaDialog()">Close</button>
        </div>
      </div>
    </div>`
  );
  areaDialog = { chartId, minzoom, maxzoom, map: null, poll: null, jobId: null, shownJobId: null };
  void refreshKeptStats();
}

window.showOfflineArea = showOfflineArea;
window.closeAreaDialog = closeAreaDialog;
window.startAreaDownload = startAreaDownload;
window.cancelAreaDownload = cancelAreaDownload;
window.clearKeptTiles = clearKeptTiles;
