// Masked chart versions in Manage Charts: the "+Water only" and "+Land only"
// checkboxes in a kept online chart's Edit dialog, the warning a Land only
// version needs, the one-time shoreline data download masked versions need,
// and the status of versions still waiting for it.

const MASKS_API_BASE = '/plugins/signalk-charts-provider-simple';

interface LandIndexInfo {
  status: 'absent' | 'building' | 'ready' | 'failed';
  /** The user agreed to the download; a build that failed resumes on restart. */
  requested: boolean;
  progress?: { receivedBytes: number; totalBytes: number | null; polygons: number };
  error?: string;
  diskBytes?: number;
  /** Masked chart versions anywhere in the library. */
  maskedVersions: number;
  approxDownloadBytes: number;
  approxDiskBytes: number;
}

interface MaskOption {
  mask: string;
  label: string;
  hint: string;
}

const MASK_OPTIONS: MaskOption[] = [
  {
    mask: 'water-only',
    label: 'Water only',
    hint: 'Adds this chart again with the land cut away, so satellite imagery or another chart underneath shows on land. Lights, landmarks and labels the chart draws ashore go with it.'
  },
  {
    mask: 'land-only',
    label: 'Land only',
    hint: 'Adds this chart again with the water cut away, so it can lie on top of your other charts and show the land over them. It starts at 70% opacity.'
  }
];

let landIndexInfo: LandIndexInfo | null = null;
let landIndexPoll: ReturnType<typeof setInterval> | null = null;
/** The user agreed to the shoreline download while editing; it starts when they save. */
let shorelineDownloadAgreed = false;
/** The user acknowledged the Land only warning while editing. */
let landOnlyAcknowledged = false;
let pendingShorelineChoice: ((agreed: boolean) => void) | null = null;

/** Safe in element text and in quoted attributes alike. */
function masksEscape(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function approxSize(bytes: number): string {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${String(Math.round(bytes / 1e6))} MB`;
}

async function fetchLandIndexInfo(): Promise<LandIndexInfo | null> {
  try {
    const response = await fetch(`${MASKS_API_BASE}/land-index`);
    if (!response.ok) {
      return null;
    }
    landIndexInfo = (await response.json()) as LandIndexInfo;
    return landIndexInfo;
  } catch {
    return null;
  }
}

function landIndexPercent(info: LandIndexInfo): string {
  const total = info.progress?.totalBytes;
  if (!info.progress || !total) {
    return '';
  }
  return ` ${String(Math.min(99, Math.floor((info.progress.receivedBytes / total) * 100)))}%`;
}

/**
 * The badge of a masked version that is not served yet, and the action that
 * moves it on: a masked version appears in chart plotters only once the
 * shoreline data is downloaded and built.
 */
function maskWaitingState(): { badge: string; action: string } {
  const info = landIndexInfo;
  const cancel = `<button class="btn btn-sm btn-secondary" onclick="cancelShorelineDownload()">Cancel</button>`;
  if (info?.status === 'failed') {
    return {
      badge: `<span class="folder-off-badge" title="${masksEscape(info.error ?? 'The download failed')}">Shoreline data download failed</span>`,
      action: `<button class="btn btn-sm btn-primary" onclick="startShorelineDownload()">Retry download</button> ${cancel}`
    };
  }
  if (info?.status === 'building') {
    return {
      badge: `<span class="folder-off-badge" title="Shown in chart plotters once the shoreline data is ready">Waiting for shoreline data${landIndexPercent(info)}</span>`,
      action: cancel
    };
  }
  return {
    badge: `<span class="folder-off-badge" title="Needs the shoreline data, which is not downloaded">Needs shoreline data</span>`,
    action: `<button class="btn btn-sm btn-primary" onclick="askShorelineDownload()">Download</button>`
  };
}

/**
 * Keep the cards of masked versions current while the shoreline data
 * downloads, and reload the list once it is ready or has failed.
 */
function watchLandIndex(charts: { online?: { mask?: string; maskReady?: boolean } }[]): void {
  const waiting = charts.some((c) => c.online?.mask && !c.online.maskReady);
  // A build resumed on start shows as absent but agreed to until it begins.
  const changing =
    landIndexInfo?.status === 'building' ||
    (landIndexInfo?.status === 'absent' && landIndexInfo.requested);
  if (!waiting || !changing) {
    if (landIndexPoll !== null) {
      clearInterval(landIndexPoll);
      landIndexPoll = null;
    }
    return;
  }
  if (landIndexPoll !== null) {
    return;
  }
  landIndexPoll = setInterval(() => {
    void (async () => {
      const info = await fetchLandIndexInfo();
      if (!info) {
        return;
      }
      if (info.status === 'building' || (info.status === 'absent' && info.requested)) {
        window.renderManageCharts();
      } else {
        if (landIndexPoll !== null) {
          clearInterval(landIndexPoll);
          landIndexPoll = null;
        }
        window.reloadManageCharts();
      }
    })();
  }, 2000);
}

/**
 * The masked versions row of a chart's metadata: which exist, or in edit
 * mode a checkbox per version. Empty for charts that cannot have them.
 */
function renderMaskRows(masks: Record<string, boolean> | undefined, editing: boolean): string {
  if (!masks) {
    return '';
  }
  const value = editing
    ? MASK_OPTIONS.map(
        (o) => `
          <label class="mask-option">
            <input type="checkbox" id="maskOption-${o.mask}" ${masks[o.mask] ? 'checked' : ''} onchange="maskOptionChanged(this, '${o.mask}')" />
            +${masksEscape(o.label)}
          </label>
          <div class="mask-option-hint">${masksEscape(o.hint)}</div>`
      ).join('')
    : MASK_OPTIONS.filter((o) => masks[o.mask])
        .map((o) => masksEscape(o.label))
        .join(', ') ||
      '<span style="color: var(--text-secondary); font-style: italic;">None</span>';
  const info = landIndexInfo;
  let shorelineValue = '';
  if (info?.status === 'ready') {
    shorelineValue = `${approxSize(info.diskBytes ?? 0)} on disk
          ${info.maskedVersions === 0 ? '<button class="btn btn-sm btn-danger" onclick="deleteShorelineData()">Delete</button>' : ''}`;
  } else if (info?.status === 'building') {
    shorelineValue = `Downloading${landIndexPercent(info)}
          <button class="btn btn-sm btn-secondary" onclick="cancelShorelineDownload()">Cancel</button>`;
  } else if (info?.status === 'failed') {
    shorelineValue = `Download failed: ${masksEscape(info.error ?? '')}
          <button class="btn btn-sm btn-primary" onclick="startShorelineDownload()">Retry</button>
          <button class="btn btn-sm btn-secondary" onclick="cancelShorelineDownload()">Cancel</button>`;
  }
  const shoreline =
    !editing && shorelineValue
      ? `
      <div class="chart-info-row">
        <div class="chart-info-label">Shoreline data:</div>
        <div class="chart-info-value">${shorelineValue}</div>
      </div>`
      : '';
  return `
      <div class="chart-info-row">
        <div class="chart-info-label">Masked versions:</div>
        <div class="chart-info-value">${value}</div>
      </div>${shoreline}`;
}

/**
 * Ticking a version for the first time while the shoreline data is not on
 * disk asks before anything is downloaded; cancelling unticks it.
 */
async function maskOptionChanged(input: HTMLInputElement, mask: string): Promise<void> {
  if (!input.checked) {
    return;
  }
  if (mask === 'land-only' && !landOnlyAcknowledged) {
    landOnlyAcknowledged = await askShoreline({
      icon: 'warning',
      title: 'Land only is not for navigation',
      body: `
          <p>A Land only version cuts the water away using OpenStreetMap's land polygons, so it can lie on top of your other charts. Those polygons:</p>
          <ul>
            <li>count lakes, the Great Lakes included, and most rivers as land, so there it covers the charts underneath;</li>
            <li>do not match a chart's coastline exactly: the land is pulled back 2 pixels from the shore, but near the shore it can still cover rocks, buoys and other features a chart draws.</li>
          </ul>
          <p>It starts at 70% opacity, so the charts underneath stay visible. Never rely on it to see hazards.</p>`,
      confirm: 'Add Land only',
      danger: true,
      acknowledge: 'I understand that a Land only layer can hide charted hazards.'
    });
    if (!landOnlyAcknowledged) {
      input.checked = false;
      return;
    }
  }
  if (shorelineDownloadAgreed) {
    return;
  }
  const info = await fetchLandIndexInfo();
  if (!info || info.status === 'ready' || info.status === 'building' || info.requested) {
    return;
  }
  const agreed = await confirmShorelineDownload(info, true);
  if (agreed) {
    shorelineDownloadAgreed = true;
  } else {
    input.checked = false;
  }
}

/** Ask a yes/no question about the shoreline data, over the dialog that led to it. */
function askShoreline(options: {
  icon: string;
  title: string;
  body: string;
  confirm: string;
  danger?: boolean;
  /** A statement the user must tick before the confirm button works. */
  acknowledge?: string;
}): Promise<boolean> {
  // A question still open (reached by keyboard behind this one) is answered no.
  shorelineChoice(false);
  const modalHTML = `
    <div class="delete-modal-overlay" id="shorelineModal">
      <div class="delete-modal" onclick="event.stopPropagation()">
        <div class="delete-modal-header">
          <div class="delete-modal-icon"${options.danger ? '' : ' style="color: var(--accent-primary);"'}>${window.getIcon(options.icon)}</div>
          <h3>${options.title}</h3>
        </div>
        <div class="delete-modal-body">${options.body}${
          options.acknowledge
            ? `<label class="mask-option"><input type="checkbox" onchange="document.getElementById('shorelineConfirm').disabled = !this.checked" /> ${options.acknowledge}</label>`
            : ''
        }</div>
        <div class="delete-modal-actions">
          <button class="btn btn-secondary" onclick="shorelineChoice(false)">Cancel</button>
          <button class="btn ${options.danger ? 'btn-danger' : 'btn-primary'}" id="shorelineConfirm" onclick="shorelineChoice(true)"${options.acknowledge ? ' disabled' : ''}>${options.confirm}</button>
        </div>
      </div>
    </div>`;
  document.body.insertAdjacentHTML('beforeend', modalHTML);
  return new Promise((resolve) => {
    pendingShorelineChoice = resolve;
  });
}

/** `whenSaved`: the download starts when the Edit dialog is saved, not on this answer. */
function confirmShorelineDownload(info: LandIndexInfo, whenSaved: boolean): Promise<boolean> {
  return askShoreline({
    icon: 'download',
    title: 'Download shoreline data?',
    body: `
          <p>Masked chart versions cut the land or the water away using OpenStreetMap's land polygons. This needs a one-time download of the shoreline data:</p>
          <div class="delete-modal-item shoreline-sizes">
            <div>Download: about ${approxSize(info.approxDownloadBytes)}</div>
            <div>Disk space once built: about ${approxSize(info.approxDiskBytes)}</div>
          </div>
          <p>It takes a few minutes, longer on a slow connection or a Raspberry Pi. The masked versions appear in chart plotters once it is ready.${whenSaved ? ' Nothing is downloaded until you save.' : ''}</p>`,
    confirm: 'Download'
  });
}

function shorelineChoice(agreed: boolean): void {
  document.getElementById('shorelineModal')?.remove();
  const resolve = pendingShorelineChoice;
  pendingShorelineChoice = null;
  resolve?.(agreed);
}

/** Start editing a chart's masked versions afresh. */
function resetMaskEdit(): void {
  shorelineDownloadAgreed = false;
  landOnlyAcknowledged = false;
  void fetchLandIndexInfo();
}

/**
 * Add or remove the versions whose checkbox changed, starting the shoreline
 * download first if the user agreed to it. Returns the versions as they now
 * are, or null when a change failed.
 */
async function saveMaskOptions(
  chartPath: string,
  masks: Record<string, boolean>
): Promise<Record<string, boolean> | null> {
  const next = { ...masks };
  const changes = MASK_OPTIONS.map((o) => ({
    mask: o.mask,
    enabled: (document.getElementById(`maskOption-${o.mask}`) as HTMLInputElement | null)?.checked
  })).filter((c) => c.enabled !== undefined && c.enabled !== (masks[c.mask] ?? false));
  for (const change of changes) {
    const response = await fetch(`${MASKS_API_BASE}/online-charts/masked-version`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chartPath,
        mask: change.mask,
        enabled: change.enabled,
        ...(change.mask === 'land-only' ? { acknowledged: landOnlyAcknowledged } : {})
      })
    });
    if (!response.ok) {
      return null;
    }
    next[change.mask] = change.enabled === true;
  }
  // Only once a version waits for it: a failed add must not leave a
  // gigabyte downloading for nothing.
  if (changes.some((c) => c.enabled) && shorelineDownloadAgreed) {
    const response = await fetch(`${MASKS_API_BASE}/land-index/download`, { method: 'POST' });
    if (!response.ok) {
      return null;
    }
    shorelineDownloadAgreed = false;
  }
  await fetchLandIndexInfo();
  return next;
}

/** Ask, then start the download, for masked versions left waiting without it. */
async function askShorelineDownload(): Promise<void> {
  const info = await fetchLandIndexInfo();
  if (info && (await confirmShorelineDownload(info, false))) {
    await startShorelineDownload();
  }
}

async function startShorelineDownload(): Promise<void> {
  const response = await fetch(`${MASKS_API_BASE}/land-index/download`, { method: 'POST' });
  if (!response.ok) {
    window.showManageError('Could not start the shoreline data download');
    return;
  }
  await fetchLandIndexInfo();
  window.reloadManageCharts();
}

async function cancelShorelineDownload(): Promise<void> {
  const agreed = await askShoreline({
    icon: 'warning',
    title: 'Cancel the shoreline data download?',
    body: '<p>The masked chart versions stay, but are not shown in chart plotters until the shoreline data is downloaded.</p>',
    confirm: 'Cancel download',
    danger: true
  });
  if (!agreed) {
    return;
  }
  const response = await fetch(`${MASKS_API_BASE}/land-index`, { method: 'DELETE' });
  if (!response.ok) {
    window.showManageError('Could not cancel the shoreline data download');
  }
  await fetchLandIndexInfo();
  window.closeChartInfoModal();
  window.reloadManageCharts();
}

async function deleteShorelineData(): Promise<void> {
  const agreed = await askShoreline({
    icon: 'trash',
    title: 'Delete shoreline data?',
    body: `<p>No masked chart version uses it now. Adding one again needs the one-time download of about ${approxSize(landIndexInfo?.approxDownloadBytes ?? 0)} again.</p>`,
    confirm: 'Delete',
    danger: true
  });
  if (!agreed) {
    return;
  }
  const response = await fetch(`${MASKS_API_BASE}/land-index`, { method: 'DELETE' });
  if (!response.ok) {
    window.showManageError('The shoreline data is still in use');
    return;
  }
  await fetchLandIndexInfo();
  window.closeChartInfoModal();
}

window.maskOptionChanged = maskOptionChanged;
window.shorelineChoice = shorelineChoice;
window.askShorelineDownload = askShorelineDownload;
window.startShorelineDownload = startShorelineDownload;
window.deleteShorelineData = deleteShorelineData;
window.cancelShorelineDownload = cancelShorelineDownload;
window.renderMaskRows = renderMaskRows;
window.resetMaskEdit = resetMaskEdit;
window.saveMaskOptions = saveMaskOptions;
window.maskWaitingState = maskWaitingState;
window.watchLandIndex = watchLandIndex;
window.fetchLandIndexInfo = fetchLandIndexInfo;
