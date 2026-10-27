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
  conversions?: Record<string, { status: string; message?: string; log?: string[] }>;
  conversionAvailable?: boolean;
  conversionEngine?: 'container' | 'wasm';
  conversionEnginePreference?: 'auto' | 'container' | 'wasm';
  wasmConverter?: string;
  containerRuntimeVersion?: string | null;
}

interface ConvertUploadResponse {
  success: boolean;
  chartNumber?: string;
  error?: string;
}

interface ConvertLocalResponse extends ConvertUploadResponse {
  looseFiles?: number;
  zips?: number;
  unreadableZips?: number;
}

let convertInitialized = false;
const convertActiveJobs: Record<string, ConvertJob> = {};
let convertPollInterval: ReturnType<typeof setInterval> | null = null;
// Monotonic counter — Date.now() can collide when two files complete in
// the same millisecond (sequential awaits in handleConvertFile don't
// guarantee a measurable time gap on every platform).
let nextConvertJobId = 0;

window.handleConvertTabActive = function (): void {
  if (!convertInitialized) {
    initConvertTab();
  }
};

function initConvertTab(): void {
  convertInitialized = true;
  const output = document.getElementById('convertOutput');
  if (!output) {
    return;
  }

  output.innerHTML = `
    <div class="catalog-container">
      <div id="convertEngineNote" class="catalog-source-note" hidden></div>
      <div class="convert-section">
        <h2>Convert S-57 ENC Charts</h2>
        <p class="description">
          Upload a ZIP file containing S-57 ENC files (.000) from your national hydrographic office,
          or convert a folder of them that is already on the Signal K server.
          Charts are converted to vector MBTiles with
          <a href="https://gdal.org/" target="_blank" rel="noopener">GDAL</a> and
          <a href="https://github.com/felt/tippecanoe" target="_blank" rel="noopener">tippecanoe</a>
          in a helper container when one is available, or inside Signal K with GDAL compiled to
          WebAssembly (<a href="https://gdal3.js.org/" target="_blank" rel="noopener">gdal3.js</a>),
          which needs no container runtime.
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
        <div class="convert-local">
          <label for="s57LocalPath">Or convert charts already on the Signal K server</label>
          <div class="convert-local-row">
            <input type="text" id="s57LocalPath" class="input-field" placeholder="~/charts/ENC_ROOT"
              spellcheck="false" autocomplete="off" data-convert-local-input="s57">
            <button type="button" class="btn btn-primary" data-convert-local="s57">Convert</button>
          </div>
          <div class="convert-local-hint">
            The full path of a folder holding S-57 cells (.000), loose or in ZIP files, or of one ZIP file.
            ~ is the server's home folder. The folder is only read.
          </div>
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
          Upload a ZIP file containing BSB raster charts (.kap files), or convert a folder of
          them that is already on the Signal K server.
          Charts are converted to MBTiles with
          <a href="https://gdal.org/" target="_blank" rel="noopener">GDAL</a>, in a helper container
          when one is available, or inside Signal K with GDAL compiled to WebAssembly.
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
        <div class="convert-local">
          <label for="rncLocalPath">Or convert charts already on the Signal K server</label>
          <div class="convert-local-row">
            <input type="text" id="rncLocalPath" class="input-field" placeholder="~/charts/BSB_ROOT"
              spellcheck="false" autocomplete="off" data-convert-local-input="rnc">
            <button type="button" class="btn btn-primary" data-convert-local="rnc">Convert</button>
          </div>
          <div class="convert-local-hint">
            The full path of a folder holding BSB charts (.kap), loose or in ZIP files, or of one ZIP file.
            ~ is the server's home folder. The folder is only read.
          </div>
        </div>
      </div>

      <div id="convertJobs"></div>
    </div>
  `;
  void showConvertEngine();

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

  document.querySelectorAll<HTMLButtonElement>('button[data-convert-local]').forEach((button) => {
    button.addEventListener('click', () => {
      const type = button.dataset['convertLocal'] as 's57' | 'rnc' | undefined;
      if (type) {
        void convertLocalPath(type);
      }
    });
  });
  document.querySelectorAll<HTMLInputElement>('input[data-convert-local-input]').forEach((input) => {
    input.addEventListener('keydown', (ev) => {
      const type = input.dataset['convertLocalInput'] as 's57' | 'rnc' | undefined;
      if (ev.key === 'Enter' && type) {
        void convertLocalPath(type);
      }
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

/** Say which toolchain converts charts on this server. */
async function showConvertEngine(): Promise<void> {
  const note = document.getElementById('convertEngineNote');
  if (!note) {
    return;
  }
  let data: S57StatusResponse;
  try {
    const resp = await fetch(`${CONVERT_API_BASE}/catalog-s57-status`);
    if (!resp.ok) {
      return;
    }
    data = (await resp.json()) as S57StatusResponse;
  } catch {
    return;
  }
  const wasm = `the built-in GDAL (WebAssembly${
    data.wasmConverter ? `, ${convertEscapeHtml(data.wasmConverter)}` : ''
  })`;
  const container = `GDAL and tippecanoe in a helper container${
    data.containerRuntimeVersion ? ` (${convertEscapeHtml(data.containerRuntimeVersion)})` : ''
  }`;
  const signalkContainer =
    '<a href="https://github.com/dirkwa/signalk-container" target="_blank" rel="noopener">signalk-container</a>';
  if (data.conversionAvailable === false) {
    note.innerHTML =
      `<strong>Chart conversion is set to use a helper container, but none is available.</strong> ` +
      `Install the ${signalkContainer} plugin from the App Store, or set the conversion engine ` +
      `to automatic in the plugin configuration.`;
  } else if (data.conversionEngine === 'container') {
    note.innerHTML =
      `Charts are converted with ${container}, through the ${signalkContainer} plugin.` +
      (data.conversionEnginePreference === 'container'
        ? ''
        : ` If a conversion cannot run there, ${wasm} converts it instead.`);
  } else if (data.conversionEnginePreference === 'wasm') {
    note.innerHTML = `Charts are converted with ${wasm}, as set in the plugin configuration.`;
  } else if (data.conversionEngine === 'wasm') {
    note.innerHTML =
      `Charts are converted with ${wasm}; no container runtime is needed. ` +
      `With the ${signalkContainer} plugin and Docker or Podman, they are converted with GDAL ` +
      `and tippecanoe in a helper container instead.`;
  } else {
    return;
  }
  note.hidden = false;
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

/** The zoom levels chosen for S-57 conversion. */
function s57ZoomLevels(): { minzoom?: number; maxzoom?: number } {
  const minzoom = document.getElementById('convertS57Minzoom') as HTMLSelectElement | null;
  const maxzoom = document.getElementById('convertS57Maxzoom') as HTMLSelectElement | null;
  return {
    minzoom: minzoom ? Number(minzoom.value) : undefined,
    maxzoom: maxzoom ? Number(maxzoom.value) : undefined
  };
}

/** Plural-aware count, such as "1 ZIP file" or "3 ZIP files". */
function convertCount(n: number, noun: string): string {
  return `${String(n)} ${noun}${n === 1 ? '' : 's'}`;
}

async function convertLocalPath(type: 's57' | 'rnc'): Promise<void> {
  const input = document.getElementById(`${type}LocalPath`) as HTMLInputElement | null;
  const localPath = input?.value.trim() ?? '';
  if (!input || localPath === '') {
    input?.focus();
    return;
  }

  nextConvertJobId += 1;
  const jobId = `convert_${nextConvertJobId}`;
  convertActiveJobs[jobId] = {
    status: 'uploading',
    message: `Reading ${localPath}...`,
    fileName: localPath,
    type
  };
  renderConvertJobs();

  try {
    const resp = await fetch(`${CONVERT_API_BASE}/convert-local`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, path: localPath, ...(type === 's57' ? s57ZoomLevels() : {}) })
    });
    let result: ConvertLocalResponse;
    try {
      result = (await resp.json()) as ConvertLocalResponse;
    } catch {
      throw new Error(`HTTP ${String(resp.status)}`);
    }
    if (result.success) {
      const found: string[] = [];
      if (result.looseFiles) {
        found.push(convertCount(result.looseFiles, type === 's57' ? 'cell' : 'chart file'));
      }
      if (result.zips) {
        found.push(convertCount(result.zips, 'ZIP file'));
      }
      const skipped = result.unreadableZips
        ? ` (skipped ${convertCount(result.unreadableZips, 'unreadable ZIP file')})`
        : '';
      convertActiveJobs[jobId] = {
        status: 'converting',
        message: `Converting ${found.join(' and ')}${skipped}...`,
        fileName: localPath,
        type,
        chartNumber: result.chartNumber
      };
      input.value = '';
    } else {
      convertActiveJobs[jobId] = {
        status: 'failed',
        message: result.error || `HTTP ${String(resp.status)}`,
        fileName: localPath,
        type
      };
    }
  } catch (err) {
    convertActiveJobs[jobId] = {
      status: 'failed',
      message: err instanceof Error ? err.message : 'Conversion failed to start',
      fileName: localPath,
      type
    };
  }
  renderConvertJobs();
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
