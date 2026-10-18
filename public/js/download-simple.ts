// Simple download interface for charts from direct URLs

// API base path - routes are scoped under the plugin path via registerWithRouter
const DOWNLOAD_API_BASE = '/plugins/signalk-charts-provider-simple';
const ONLINE_CHARTS_FOLDER = 'Online Charts';

interface LocalChartsResponse {
  folders?: string[];
}

interface DownloadJob {
  id: string;
  url: string;
  status: 'queued' | 'downloading' | 'extracting' | 'completed' | 'failed';
  progress: number;
  downloadedBytes: number;
  totalBytes: number;
  completedAt?: number;
  error?: string;
  extractedFiles?: string[];
}

interface DownloadCreateResponse {
  success: boolean;
  jobId?: string;
  error?: string;
}

interface CancelResponse {
  success: boolean;
  error?: string;
}

// Module-scoped poll handle so a tab re-init doesn't stack multiple
// `setInterval` timers on top of each other (the previous JS version
// had this leak; converting to TS is a good moment to plug it).
let downloadPollInterval: ReturnType<typeof setInterval> | null = null;

// Tab activation handler - refreshes folder list when switching to this tab
window.handleDownloadTabActive = function (): void {
  void loadFoldersForDownload();
};

// Escape values that flow into innerHTML — chart URLs, server-supplied
// error strings, job IDs etc. all originate outside our trust boundary.
// Without this a malicious URL or compromised server can inject HTML or
// run JS in the admin UI's origin.
function downloadEscapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

// Initialize the download interface
function initDownloadInterface(): void {
  const output = document.getElementById('chartLockerOutput');
  if (!output) {
    return;
  }

  output.innerHTML = `
    <div class="download-container">
      <div class="info-section">
        <h2>Download Charts from URL</h2>
        <p class="description">
          Download chart files directly from URLs. Supports .mbtiles and .pmtiles files, and .zip archives containing .mbtiles files.
        </p>

        <div class="form-group">
          <label for="downloadUrl">Chart URL</label>
          <input
            type="text"
            id="downloadUrl"
            placeholder="https://example.com/chart.mbtiles or chart.zip"
            class="input-field"
          />
        </div>

        <div class="form-group">
          <label for="downloadChartName">Chart Name</label>
          <input
            type="text"
            id="downloadChartName"
            placeholder="e.g. NOAA Chesapeake Bay"
            class="input-field"
          />
        </div>

        <div class="form-group">
          <label for="downloadFolder">Target Folder</label>
          <select id="downloadFolder" class="input-field">
            <option value="/">/</option>
          </select>
        </div>

        <button onclick="startDownload()" class="btn btn-primary">
          Download Chart
        </button>

        <div id="downloadStatus" class="download-status"></div>
      </div>

      <div id="activeDownloads" class="active-downloads"></div>

      <div class="info-section">
        <h2>Add an Online Chart by URL</h2>
        <p class="description">
          Show a tile service or WMS that the Chart Catalog does not list, such as your country's
          chart service. The chart streams from its provider and appears in Manage Charts like a
          catalog chart.
        </p>

        <div class="form-group">
          <label for="onlineChartName">Chart Name</label>
          <input type="text" id="onlineChartName" placeholder="e.g. Harbour charts" class="input-field" />
        </div>

        <div class="form-group">
          <label for="onlineChartType">Service Type</label>
          <select id="onlineChartType" class="input-field" onchange="onlineChartTypeChanged()">
            <option value="tilelayer">Tile URL</option>
            <option value="WMS">WMS</option>
          </select>
        </div>

        <div class="form-group">
          <label for="onlineChartUrl">URL</label>
          <input
            type="text"
            id="onlineChartUrl"
            placeholder="https://example.com/tiles/{z}/{x}/{y}.png"
            class="input-field"
          />
          <p class="form-hint" id="onlineChartUrlHint">
            Use {z}, {x} and {y}, or {-y} for a TMS row and {z-2} for a service whose levels start
            at zoom 2. For a single-image request, {bbox} gives the tile extent in degrees and
            {bbox_3857} in Web Mercator metres.
          </p>
        </div>

        <div class="form-group" id="onlineChartLayersGroup" style="display: none;">
          <label for="onlineChartLayers">Layers</label>
          <input type="text" id="onlineChartLayers" placeholder="layer1, layer2" class="input-field" />
        </div>

        <div class="form-row">
          <div class="form-group">
            <label for="onlineChartMinzoom">Lowest Zoom</label>
            <input type="number" id="onlineChartMinzoom" min="0" max="24" placeholder="0" class="input-field" />
          </div>
          <div class="form-group">
            <label for="onlineChartMaxzoom">Highest Zoom</label>
            <input type="number" id="onlineChartMaxzoom" min="0" max="24" placeholder="18" class="input-field" />
          </div>
        </div>

        <div class="form-group">
          <label for="onlineChartFolder">Target Folder</label>
          <select id="onlineChartFolder" class="input-field"></select>
        </div>

        <div class="form-group">
          <label class="checkbox-label">
            <input type="checkbox" id="onlineChartKeep" />
            Keep tiles for offline use
          </label>
          <p class="form-hint">
            The server then keeps every tile it fetches, and Manage Charts can download an area
            ahead of a passage. Only tick this if the provider's terms allow storing its tiles.
          </p>
        </div>

        <button onclick="addOnlineChartByUrl()" class="btn btn-primary">Add Online Chart</button>

        <div id="onlineChartStatus" class="download-status"></div>
      </div>

      <div class="info-section">
        <h3>Where to Find Charts</h3>
        <ul>
          <li><a href="https://chartlocker.brucebalan.com/" target="_blank">Bruce's Chart Locker</a> - Community-maintained chart collection</li>
          <li><a href="#" onclick="openTab(null, 'customCatalogs'); return false;">NOAA Nautical Charts</a> - build a chart set in the NOAA Charts tab</li>
        </ul>
      </div>
    </div>
  `;

  void loadFoldersForDownload();
  void loadActiveDownloads();

  // Poll for download updates every 2 seconds. Clear any prior interval
  // first so a tab re-init doesn't accumulate timers.
  if (downloadPollInterval !== null) {
    clearInterval(downloadPollInterval);
  }
  downloadPollInterval = setInterval(() => {
    void loadActiveDownloads();
  }, 2000);

  // Delegated click handler for the dynamically rendered Cancel buttons.
  // Avoids inline onclick="cancelDownload('${id}')" which would leave
  // job.id parsed twice (HTML-decoded into a JS string literal) — the
  // second decode is the XSS vector downloadEscapeHtml can't close.
  const activeDownloads = document.getElementById('activeDownloads');
  if (activeDownloads && !activeDownloads.dataset['cancelHandlerWired']) {
    activeDownloads.addEventListener('click', (ev) => {
      const target = ev.target as HTMLElement | null;
      if (!target) {
        return;
      }
      const button = target.closest<HTMLElement>('[data-cancel-job-id]');
      if (!button) {
        return;
      }
      const jobId = button.dataset['cancelJobId'];
      if (jobId) {
        void cancelDownload(jobId);
      }
    });
    activeDownloads.dataset['cancelHandlerWired'] = '1';
  }
}

async function loadFoldersForDownload(): Promise<void> {
  try {
    const response = await fetch(`${DOWNLOAD_API_BASE}/local-charts`);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const data = (await response.json()) as LocalChartsResponse;

    fillOnlineChartFolders(data.folders ?? []);

    const folderSelect = document.getElementById('downloadFolder') as HTMLSelectElement | null;
    if (!folderSelect) {
      return;
    }

    folderSelect.innerHTML = '<option value="/">/</option>';

    if (data.folders) {
      data.folders.forEach((folder) => {
        if (folder !== '/') {
          const option = document.createElement('option');
          option.value = folder;
          option.textContent = folder;
          folderSelect.appendChild(option);
        }
      });
    }
  } catch (error) {
    console.error('Error loading folders:', error);
  }
}

async function startDownload(): Promise<void> {
  const urlInput = document.getElementById('downloadUrl') as HTMLInputElement | null;
  const chartNameInput = document.getElementById('downloadChartName') as HTMLInputElement | null;
  const folderInput = document.getElementById('downloadFolder') as HTMLSelectElement | null;
  const statusDiv = document.getElementById('downloadStatus');

  if (!urlInput || !chartNameInput || !folderInput || !statusDiv) {
    return;
  }

  const url = urlInput.value.trim();
  const chartName = chartNameInput.value.trim();
  const folder = folderInput.value;

  if (!url) {
    statusDiv.innerHTML = '<div class="error-message">Please enter a URL</div>';
    return;
  }

  if (!chartName) {
    statusDiv.innerHTML = '<div class="error-message">Please enter a chart name</div>';
    return;
  }

  // The server rejects these with a 400 (the chart name becomes a
  // filename); catch them here too so the user gets immediate feedback
  // instead of a round-trip. The server stays the authoritative guard.
  if (chartName.includes('/') || chartName.includes('\\') || chartName.includes('..')) {
    statusDiv.innerHTML =
      '<div class="error-message">Chart name cannot contain / \\ or ..</div>';
    return;
  }

  // Basic URL validation
  try {
    new URL(url);
  } catch {
    statusDiv.innerHTML = '<div class="error-message">Invalid URL format</div>';
    return;
  }

  statusDiv.innerHTML = '<div class="info-message">Creating download job...</div>';

  try {
    const formData = new FormData();
    formData.append('url', url);
    formData.append('targetFolder', folder);
    formData.append('chartName', chartName);

    const response = await fetch(`${DOWNLOAD_API_BASE}/download-chart-locker`, {
      method: 'POST',
      body: formData
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const result = (await response.json()) as DownloadCreateResponse;

    if (result.success) {
      statusDiv.innerHTML = `<div class="success-message">Download started! Job ID: ${downloadEscapeHtml(result.jobId ?? '')}</div>`;
      urlInput.value = '';
      chartNameInput.value = '';
      setTimeout(() => {
        void loadActiveDownloads();
      }, 500);
    } else {
      statusDiv.innerHTML = `<div class="error-message">Error: ${downloadEscapeHtml(result.error ?? 'Unknown error')}</div>`;
    }
  } catch (error) {
    console.error('Download error:', error);
    const message = error instanceof Error ? error.message : String(error);
    statusDiv.innerHTML = `<div class="error-message">Failed to start download: ${downloadEscapeHtml(message)}</div>`;
  }
}

let previousJobCount = 0;

async function loadActiveDownloads(): Promise<void> {
  try {
    const response = await fetch(`${DOWNLOAD_API_BASE}/download-jobs`);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const jobs = (await response.json()) as DownloadJob[];

    const container = document.getElementById('activeDownloads');
    if (!container) {
      return;
    }

    if (!jobs || jobs.length === 0) {
      if (container.innerHTML !== '') {
        container.innerHTML = '';
      }
      previousJobCount = 0;
      return;
    }

    const recentJobs = jobs.filter(
      (job) =>
        job.status === 'queued' ||
        job.status === 'downloading' ||
        job.status === 'extracting' ||
        (job.completedAt !== undefined && Date.now() - job.completedAt < 300000)
    );

    if (recentJobs.length === 0) {
      if (container.innerHTML !== '') {
        container.innerHTML = '';
      }
      previousJobCount = 0;
      return;
    }

    // Rebuild whenever the count changes OR a new job's wrapper isn't
    // in the DOM yet (e.g. one job aged out of the 5-min window and a
    // new one arrived in the same poll — count is unchanged but the new
    // row would otherwise be silently skipped).
    const needsRebuild =
      recentJobs.length !== previousJobCount ||
      recentJobs.some((job) => !document.getElementById(`job-${job.id}`));

    if (needsRebuild) {
      container.innerHTML = `
        <h3>Download Jobs</h3>
        ${recentJobs.map((job) => `<div id="job-${downloadEscapeHtml(job.id)}">${renderDownloadJob(job)}</div>`).join('')}
      `;
      previousJobCount = recentJobs.length;
    } else {
      for (const job of recentJobs) {
        const el = document.getElementById(`job-${job.id}`);
        if (el) {
          el.innerHTML = renderDownloadJob(job);
        }
      }
    }
  } catch (error) {
    console.error('Error loading download jobs:', error);
  }
}

function renderDownloadJob(job: DownloadJob): string {
  const statusClass =
    {
      queued: 'status-queued',
      downloading: 'status-downloading',
      extracting: 'status-extracting',
      completed: 'status-completed',
      failed: 'status-failed'
    }[job.status] || '';

  const statusText =
    {
      queued: 'Queued',
      downloading: 'Downloading',
      extracting: 'Extracting',
      completed: 'Completed',
      failed: 'Failed'
    }[job.status] || job.status;

  // Clamp before interpolating into a CSS width and visible text — even
  // though the type says number, the wire value comes from the server
  // and could be NaN, negative, or > 100.
  const safeProgress = Number.isFinite(job.progress)
    ? Math.max(0, Math.min(100, job.progress))
    : 0;

  // Some servers (e.g. vaarweginformatie.nl) don't report Content-Length
  // so totalBytes stays 0 and the percentage can't be computed. Switch
  // to an indeterminate barberpole and show just the downloaded byte
  // count instead of "0% - X MB / 0 B".
  const totalKnown = Number.isFinite(job.totalBytes) && job.totalBytes > 0;
  const fillClass = totalKnown ? 'progress-fill' : 'progress-fill progress-fill-indeterminate';
  const fillStyle = totalKnown ? `style="width: ${safeProgress}%"` : '';
  // 'extracting' uses the same indeterminate bar but its byte count is
  // the now-stale download total — show an explicit label instead so
  // we don't display "142 MB downloaded" while the bar spins on extract.
  const progressText =
    job.status === 'extracting'
      ? 'Extracting...'
      : totalKnown
        ? `${safeProgress}% - ${formatBytes(job.downloadedBytes)} / ${formatBytes(job.totalBytes)}`
        : `${formatBytes(job.downloadedBytes)} downloaded`;

  const progressBar =
    job.status === 'downloading' || job.status === 'extracting'
      ? `<div class="progress-bar">
         <div class="${fillClass}" ${fillStyle}></div>
       </div>
       <div class="progress-text">${progressText}</div>`
      : '';

  const errorMessage = job.error
    ? `<div class="error-text">Error: ${downloadEscapeHtml(job.error)}</div>`
    : '';

  const extractedFiles =
    job.extractedFiles && job.extractedFiles.length > 0
      ? `<div class="extracted-files">Files: ${job.extractedFiles.map(downloadEscapeHtml).join(', ')}</div>`
      : '';

  // Job ID is server-supplied. The id flows into a `data-cancel-job-id`
  // attribute (HTML-escaped only — never injected into a JS string
  // context); a delegated click listener on #activeDownloads reads
  // event.target.dataset.cancelJobId and calls cancelDownload(). This
  // avoids the inline-onclick path where the browser HTML-decodes the
  // attribute into a JS literal, which would let `'); alert();//`
  // escape downloadEscapeHtml's protection.
  const cancelButton =
    job.status === 'queued' || job.status === 'downloading' || job.status === 'extracting'
      ? `<button class="btn btn-danger btn-sm" data-cancel-job-id="${downloadEscapeHtml(job.id)}">Cancel</button>`
      : '';

  const urlFilename = job.url.split('/').pop()?.split('?')[0] || 'Download';

  return `
    <div class="download-job ${statusClass}">
      <div class="job-header">
        <span class="job-name">${downloadEscapeHtml(urlFilename)}</span>
        <div class="job-header-right">
          <span class="job-status">${statusText}</span>
          ${cancelButton}
        </div>
      </div>
      <div class="job-url">${downloadEscapeHtml(truncateUrl(job.url))}</div>
      ${progressBar}
      ${errorMessage}
      ${extractedFiles}
    </div>
  `;
}

async function cancelDownload(jobId: string): Promise<void> {
  try {
    const response = await fetch(
      `${DOWNLOAD_API_BASE}/cancel-download/${encodeURIComponent(jobId)}`,
      { method: 'POST' }
    );
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const result = (await response.json()) as CancelResponse;

    if (result.success) {
      console.log(`Download ${jobId} cancelled`);
      void loadActiveDownloads();
    } else {
      console.error(`Failed to cancel download: ${result.error ?? ''}`);
      alert(`Failed to cancel download: ${result.error ?? ''}`);
    }
  } catch (error) {
    console.error('Error cancelling download:', error);
    const message = error instanceof Error ? error.message : String(error);
    alert(`Error cancelling download: ${message}`);
  }
}

function formatBytes(bytes: number): string {
  // Server values are typed as `number`, but a negative or non-finite
  // input would produce "NaN undefined" via the index lookup below.
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B';
  }
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

function truncateUrl(url: string, maxLength = 60): string {
  if (url.length <= maxLength) {
    return url;
  }
  return url.substring(0, maxLength - 3) + '...';
}

/** Online charts go to the catalog's default folder unless the user picks another. */
function fillOnlineChartFolders(folders: string[]): void {
  const select = document.getElementById('onlineChartFolder') as HTMLSelectElement | null;
  if (!select) {
    return;
  }
  const previous = select.value;
  const options = ['/', ...folders.filter((f) => f !== '/')];
  if (!options.includes(ONLINE_CHARTS_FOLDER)) {
    options.push(ONLINE_CHARTS_FOLDER);
  }
  select.replaceChildren(
    ...options.map((folder) => {
      const option = document.createElement('option');
      option.value = folder;
      option.textContent = folder;
      return option;
    })
  );
  select.value = previous && options.includes(previous) ? previous : ONLINE_CHARTS_FOLDER;
}

function onlineChartTypeChanged(): void {
  const type = (document.getElementById('onlineChartType') as HTMLSelectElement | null)?.value;
  const layers = document.getElementById('onlineChartLayersGroup');
  const hint = document.getElementById('onlineChartUrlHint');
  const url = document.getElementById('onlineChartUrl') as HTMLInputElement | null;
  const wms = type === 'WMS';
  if (layers) {
    layers.style.display = wms ? '' : 'none';
  }
  if (hint) {
    hint.style.display = wms ? 'none' : '';
  }
  if (url) {
    url.placeholder = wms
      ? 'https://example.com/wms'
      : 'https://example.com/tiles/{z}/{x}/{y}.png';
  }
}

function onlineChartInput(id: string): string {
  return (document.getElementById(id) as HTMLInputElement | null)?.value.trim() ?? '';
}

async function addOnlineChartByUrl(): Promise<void> {
  const statusDiv = document.getElementById('onlineChartStatus');
  if (!statusDiv) {
    return;
  }
  const showError = (message: string): void => {
    statusDiv.innerHTML = `<div class="error-message">${downloadEscapeHtml(message)}</div>`;
  };
  const name = onlineChartInput('onlineChartName');
  const type = onlineChartInput('onlineChartType');
  const url = onlineChartInput('onlineChartUrl');
  const layers = onlineChartInput('onlineChartLayers')
    .split(',')
    .map((l) => l.trim())
    .filter((l) => l !== '');
  const zoom = (id: string): number | undefined => {
    const value = onlineChartInput(id);
    return value === '' ? undefined : Number(value);
  };
  const minzoom = zoom('onlineChartMinzoom');
  const maxzoom = zoom('onlineChartMaxzoom');
  const keepOffline =
    (document.getElementById('onlineChartKeep') as HTMLInputElement | null)?.checked ?? false;

  if (!name) {
    showError('Please enter a chart name');
    return;
  }
  if (!url) {
    showError('Please enter a URL');
    return;
  }
  if (type === 'WMS' && layers.length === 0) {
    showError('Please enter at least one layer');
    return;
  }

  const chart = {
    type,
    url,
    ...(type === 'WMS' ? { layers } : {}),
    ...(minzoom !== undefined ? { minzoom } : {}),
    ...(maxzoom !== undefined ? { maxzoom } : {}),
    keepOffline
  };
  statusDiv.innerHTML = '<div class="info-message">Adding chart...</div>';
  try {
    const response = await fetch(`${DOWNLOAD_API_BASE}/online-charts/custom`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, folder: onlineChartInput('onlineChartFolder') || ONLINE_CHARTS_FOLDER, chart })
    });
    const result = (await response.json().catch(() => ({}))) as {
      success?: boolean;
      error?: string;
    };
    if (!response.ok || !result.success) {
      showError(result.error ?? `Failed to add the chart (HTTP ${String(response.status)})`);
      return;
    }
    statusDiv.innerHTML = `<div class="success-message">Added ${downloadEscapeHtml(name)}. It is listed in Manage Charts.</div>`;
    for (const id of ['onlineChartName', 'onlineChartUrl', 'onlineChartLayers']) {
      const input = document.getElementById(id) as HTMLInputElement | null;
      if (input) {
        input.value = '';
      }
    }
  } catch (error) {
    showError(`Failed to add the chart: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// Expose inline-onclick handlers used by the rendered HTML.
window.addOnlineChartByUrl = addOnlineChartByUrl;
window.onlineChartTypeChanged = onlineChartTypeChanged;
window.startDownload = startDownload;
window.cancelDownload = cancelDownload;

// Initialize when the page loads
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initDownloadInterface);
} else {
  initDownloadInterface();
}
