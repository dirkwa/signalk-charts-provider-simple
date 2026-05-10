// Convert tab — upload ZIP files containing S-57 ENC or BSB RNC charts for conversion

const CONVERT_API_BASE = '/plugins/signalk-charts-provider-simple';

interface ConvertJob {
  status: 'uploading' | 'converting' | 'completed' | 'failed';
  message: string;
  fileName: string;
  type: 's57' | 'rnc';
  chartNumber?: string;
  log?: string[];
}

interface S57StatusResponse {
  podmanAvailable?: boolean;
  conversions?: Record<string, { status: string; message?: string; log?: string[] }>;
}

interface ConvertUploadResponse {
  success: boolean;
  chartNumber?: string;
  error?: string;
}

let convertInitialized = false;
let convertPodmanAvailable = false;
const convertActiveJobs: Record<string, ConvertJob> = {};
let convertPollInterval: ReturnType<typeof setInterval> | null = null;
// Monotonic counter — Date.now() can collide when two files complete in
// the same millisecond (sequential awaits in handleConvertFile don't
// guarantee a measurable time gap on every platform).
let nextConvertJobId = 0;

window.handleConvertTabActive = function (): void {
  if (!convertInitialized) {
    void initConvertTab();
  }
};

async function initConvertTab(): Promise<void> {
  convertInitialized = true;
  const output = document.getElementById('convertOutput');
  if (!output) {
    return;
  }

  // Check container runtime availability
  try {
    const resp = await fetch(`${CONVERT_API_BASE}/catalog-s57-status`);
    if (resp.ok) {
      const data = (await resp.json()) as S57StatusResponse;
      convertPodmanAvailable = data.podmanAvailable ?? false;
    }
  } catch {
    convertPodmanAvailable = false;
  }

  output.innerHTML = `
    <div class="catalog-container">
      ${
        !convertPodmanAvailable
          ? `
        <div class="catalog-podman-warning">
          <strong>Container runtime not reachable.</strong>
          Chart conversion needs a Docker- or Podman-compatible socket.
          <a href="https://github.com/dirkwa/signalk-charts-provider-simple/blob/main/docs/running-in-docker.md" target="_blank" rel="noopener">See setup notes</a>.
        </div>
      `
          : ''
      }
      <div class="convert-section">
        <h2>Convert S-57 ENC Charts</h2>
        <p class="description">
          Upload a ZIP file containing S-57 ENC files (.000) from your national hydrographic office.
          Charts will be converted to vector MBTiles using
          <a href="https://gdal.org/" target="_blank" rel="noopener">GDAL</a> and
          <a href="https://github.com/felt/tippecanoe" target="_blank" rel="noopener">tippecanoe</a> in Podman.
        </p>
        <div class="convert-upload-area" id="s57DropZone">
          <div class="convert-upload-icon">
            <svg viewBox="0 0 24 24" width="48" height="48" fill="currentColor" opacity="0.3">
              <path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM14 13v4h-4v-4H7l5-5 5 5h-3z"/>
            </svg>
          </div>
          <div class="convert-upload-text">Drop S-57 ENC ZIP files here or click to select</div>
          <input type="file" id="s57FileInput" accept=".zip" multiple style="display:none" data-convert-type="s57">
        </div>
        <div class="convert-upload-options">
          <label>Zoom levels:</label>
          <select class="catalog-zoom-select" id="convertS57Minzoom">
            ${[4, 5, 6, 7, 8, 9, 10, 11, 12]
              .map((z) => `<option value="${z}" ${z === 4 ? 'selected' : ''}>${z}</option>`)
              .join('')}
          </select>
          <span class="catalog-zoom-dash">-</span>
          <select class="catalog-zoom-select" id="convertS57Maxzoom">
            ${[12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22]
              .map((z) => `<option value="${z}" ${z === 18 ? 'selected' : ''}>${z}</option>`)
              .join('')}
          </select>
        </div>
      </div>

      <div class="convert-section">
        <h2>Convert BSB Raster Charts (RNC)</h2>
        <p class="description">
          Upload a ZIP file containing BSB raster charts (.kap files).
          Charts will be converted to MBTiles using
          <a href="https://gdal.org/" target="_blank" rel="noopener">GDAL</a> in Podman.
        </p>
        <div class="convert-upload-area" id="rncDropZone">
          <div class="convert-upload-icon">
            <svg viewBox="0 0 24 24" width="48" height="48" fill="currentColor" opacity="0.3">
              <path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM14 13v4h-4v-4H7l5-5 5 5h-3z"/>
            </svg>
          </div>
          <div class="convert-upload-text">Drop BSB/RNC ZIP here or click to select</div>
          <input type="file" id="rncFileInput" accept=".zip" style="display:none" data-convert-type="rnc">
        </div>
      </div>

      <div id="convertJobs"></div>
    </div>
  `;

  // Set up drag-and-drop and click handlers
  setupDropZone('s57DropZone', 's57FileInput');
  setupDropZone('rncDropZone', 'rncFileInput');

  // Hook the file inputs' change events here instead of inline onchange
  // (an inline `onchange="handleConvertFile(this, 's57')"` is the same
  // attribute-context-injection class the cancel-button refactor in #74
  // closed; bind in JS to keep value flows out of HTML).
  document.querySelectorAll<HTMLInputElement>('input[data-convert-type]').forEach((input) => {
    input.addEventListener('change', () => {
      const type = input.dataset['convertType'] as 's57' | 'rnc' | undefined;
      if (!type) {
        return;
      }
      void handleConvertFile(input, type);
    });
  });

  // Delegated click handler for the dynamically rendered "Logs" buttons.
  const convertJobs = document.getElementById('convertJobs');
  if (convertJobs && !convertJobs.dataset['convertHandlerWired']) {
    convertJobs.addEventListener('click', (ev) => {
      const target = (ev.target as HTMLElement | null)?.closest<HTMLElement>(
        '[data-convert-log-chart]'
      );
      if (!target) {
        return;
      }
      const chartNumber = target.dataset['convertLogChart'];
      if (chartNumber) {
        showConvertLog(chartNumber);
      }
    });
    convertJobs.dataset['convertHandlerWired'] = '1';
  }

  // Poll for active conversion jobs
  if (convertPollInterval !== null) {
    clearInterval(convertPollInterval);
  }
  convertPollInterval = setInterval(() => {
    void pollConvertJobs();
  }, 3000);
}

function setupDropZone(zoneId: string, inputId: string): void {
  const zone = document.getElementById(zoneId);
  const input = document.getElementById(inputId) as HTMLInputElement | null;
  if (!zone || !input) {
    return;
  }

  zone.onclick = () => {
    if (!convertPodmanAvailable) {
      alert(
        'Chart conversion needs a Docker- or Podman-compatible socket. See the warning above.'
      );
      return;
    }
    input.click();
  };

  zone.ondragover = (e) => {
    e.preventDefault();
    zone.classList.add('dragover');
  };

  zone.ondragleave = () => {
    zone.classList.remove('dragover');
  };

  zone.ondrop = (e) => {
    e.preventDefault();
    zone.classList.remove('dragover');
    if (!convertPodmanAvailable) {
      alert(
        'Chart conversion needs a Docker- or Podman-compatible socket. See the warning above.'
      );
      return;
    }
    const dt = e.dataTransfer;
    if (!dt) {
      return;
    }
    const files = dt.files;
    const type: 's57' | 'rnc' = zoneId === 's57DropZone' ? 's57' : 'rnc';
    if (zoneId === 's57DropZone') {
      const zips = Array.from(files).filter((f) => f.name.endsWith('.zip'));
      void (async () => {
        for (const f of zips) {
          await uploadConvertFile(f, type);
        }
      })();
    } else {
      if (files.length > 0 && files[0]?.name.endsWith('.zip')) {
        void uploadConvertFile(files[0], type);
      }
    }
  };
}

async function handleConvertFile(input: HTMLInputElement, type: 's57' | 'rnc'): Promise<void> {
  if (input.files && input.files.length > 0) {
    const files = Array.from(input.files);
    input.value = '';
    for (const file of files) {
      await uploadConvertFile(file, type);
    }
  }
}

async function uploadConvertFile(file: File, type: 's57' | 'rnc'): Promise<void> {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('type', type);

  if (type === 's57') {
    const minzoom = document.getElementById('convertS57Minzoom') as HTMLSelectElement | null;
    const maxzoom = document.getElementById('convertS57Maxzoom') as HTMLSelectElement | null;
    if (minzoom) {
      formData.append('minzoom', minzoom.value);
    }
    if (maxzoom) {
      formData.append('maxzoom', maxzoom.value);
    }
  }

  nextConvertJobId += 1;
  const jobId = `convert_${nextConvertJobId}`;
  convertActiveJobs[jobId] = {
    status: 'uploading',
    message: `Uploading ${file.name}...`,
    fileName: file.name,
    type
  };
  renderConvertJobs();

  try {
    const resp = await fetch(`${CONVERT_API_BASE}/convert-upload`, {
      method: 'POST',
      body: formData
    });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`);
    }

    const result = (await resp.json()) as ConvertUploadResponse;
    if (result.success) {
      convertActiveJobs[jobId] = {
        status: 'converting',
        message: `Converting ${file.name}...`,
        fileName: file.name,
        type,
        chartNumber: result.chartNumber
      };
    } else {
      convertActiveJobs[jobId] = {
        status: 'failed',
        message: result.error || 'Upload failed',
        fileName: file.name,
        type
      };
    }
    renderConvertJobs();
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Upload failed';
    convertActiveJobs[jobId] = {
      status: 'failed',
      message,
      fileName: file.name,
      type
    };
    renderConvertJobs();
  }
}

async function pollConvertJobs(): Promise<void> {
  const activeIds = Object.keys(convertActiveJobs).filter(
    (id) => convertActiveJobs[id]?.status === 'converting'
  );
  if (activeIds.length === 0) {
    return;
  }

  try {
    const resp = await fetch(`${CONVERT_API_BASE}/catalog-s57-status`);
    if (!resp.ok) {
      return;
    }
    const data = (await resp.json()) as S57StatusResponse;
    const conversions = data.conversions ?? {};

    for (const id of activeIds) {
      const job = convertActiveJobs[id];
      if (!job) {
        continue;
      }
      const progress = job.chartNumber ? conversions[job.chartNumber] : undefined;
      if (progress) {
        if (progress.status === 'failed') {
          job.status = 'failed';
          job.message = progress.message ?? 'Conversion failed';
        } else {
          job.message = progress.message ?? 'Converting...';
          job.log = progress.log;
        }
      } else if (job.chartNumber) {
        // Conversion finished (progress tracking was cleaned up on success)
        job.status = 'completed';
        job.message = 'Conversion complete!';
        // Trigger Manage Charts refresh so the new chart appears
        window.handleManageTabActive?.();
      }
    }

    let needsFullRender = false;
    for (const id of activeIds) {
      const job = convertActiveJobs[id];
      if (job?.status === 'completed' || job?.status === 'failed') {
        needsFullRender = true;
        break;
      }
    }

    if (needsFullRender) {
      renderConvertJobs();
    } else {
      updateConvertJobsInPlace();
    }
  } catch {
    // ignore
  }
}

function updateConvertJobsInPlace(): void {
  for (const [id, job] of Object.entries(convertActiveJobs)) {
    const el = document.getElementById(`convert-job-${id}`);
    if (el) {
      const textEl = el.querySelector<HTMLElement>('.progress-text');
      if (textEl) {
        textEl.textContent = job.message || 'Converting...';
      }
    }
  }
}

function renderConvertJobs(): void {
  const container = document.getElementById('convertJobs');
  if (!container) {
    return;
  }

  const jobs = Object.entries(convertActiveJobs);
  if (jobs.length === 0) {
    container.innerHTML = '';
    return;
  }

  container.innerHTML = `
    <h3>Conversion Jobs</h3>
    ${jobs
      .map(([id, job]) => {
        const statusClass =
          job.status === 'completed'
            ? 'status-completed'
            : job.status === 'failed'
              ? 'status-failed'
              : 'status-downloading';
        const logsBtn =
          job.status === 'converting' && job.chartNumber
            ? `<button class="btn-catalog-log" data-convert-log-chart="${convertEscapeAttr(job.chartNumber)}">Logs</button>`
            : '';
        return `
          <div class="download-job ${statusClass}" id="convert-job-${convertEscapeAttr(id)}">
            <div class="job-header">
              <span class="job-name">${convertEscapeHtml(job.fileName)}</span>
              <span class="job-status">${convertEscapeHtml(job.status)}</span>
            </div>
            <div class="job-url">${convertEscapeHtml(job.type === 's57' ? 'S-57 ENC' : 'BSB Raster')} conversion</div>
            <div style="display:flex;align-items:center;gap:8px;">
              ${job.status === 'converting' ? '<div class="spinner" style="width:14px;height:14px;border-width:2px;"></div>' : ''}
              <span class="progress-text">${convertEscapeHtml(job.message)}</span>
              ${logsBtn}
            </div>
          </div>
        `;
      })
      .join('')}
  `;
}

function showConvertLog(chartNumber: string): void {
  // Delegate to the catalog tab's log modal. If chart-catalog hasn't
  // been loaded (or the global hasn't been wired yet) the click would
  // silently no-op; surface the script-load-order issue in the console
  // so it doesn't manifest as "the button just doesn't work."
  if (window.showConversionLog) {
    void window.showConversionLog(chartNumber);
  } else {
    console.warn(
      `[chart-convert] showConvertLog(${chartNumber}): window.showConversionLog is unavailable — chart-catalog.ts not loaded?`
    );
  }
}

function convertEscapeHtml(str: string | undefined | null): string {
  if (!str) {
    return '';
  }
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function convertEscapeAttr(str: string | undefined | null): string {
  if (!str) {
    return '';
  }
  return str
    .replace(/&/g, '&amp;')
    .replace(/'/g, '&#39;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

window.handleConvertFile = handleConvertFile;
window.showConvertLog = showConvertLog;
