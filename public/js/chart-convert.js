// Convert tab - upload ZIP files containing S-57 ENC or BSB RNC charts for conversion

const CONVERT_API_BASE = '/plugins/signalk-charts-provider-simple';

let convertInitialized = false;
let convertPodmanAvailable = false;
let convertActiveJobs = {}; // id -> { status, message, chartNumber }

window.handleConvertTabActive = function () {
  if (!convertInitialized) {
    initConvertTab();
  }
};

async function initConvertTab() {
  convertInitialized = true;
  const output = document.getElementById('convertOutput');
  if (!output) return;

  // Check Podman
  try {
    const resp = await fetch(`${CONVERT_API_BASE}/catalog-s57-status`);
    if (resp.ok) {
      const data = await resp.json();
      convertPodmanAvailable = data.podmanAvailable || false;
    }
  } catch (_e) {
    convertPodmanAvailable = false;
  }

  output.innerHTML = `
    <div class="catalog-container">
      ${!convertPodmanAvailable ? `
        <div class="catalog-podman-warning">
          <strong>Podman not found.</strong>
          Chart conversion requires Podman.
          <a href="https://podman.io/docs/installation" target="_blank" rel="noopener">Install Podman</a>
          to enable chart conversion.
        </div>
      ` : ''}
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
          <input type="file" id="s57FileInput" accept=".zip" multiple style="display:none" onchange="handleConvertFile(this, 's57')">
        </div>
        <div class="convert-upload-options">
          <label>Zoom levels:</label>
          <select class="catalog-zoom-select" id="convertS57Minzoom">
            ${[6, 7, 8, 9, 10, 11, 12].map((z) => `<option value="${z}" ${z === 9 ? 'selected' : ''}>${z}</option>`).join('')}
          </select>
          <span class="catalog-zoom-dash">-</span>
          <select class="catalog-zoom-select" id="convertS57Maxzoom">
            ${[12, 13, 14, 15, 16, 17, 18].map((z) => `<option value="${z}" ${z === 16 ? 'selected' : ''}>${z}</option>`).join('')}
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
          <input type="file" id="rncFileInput" accept=".zip" style="display:none" onchange="handleConvertFile(this, 'rnc')">
        </div>
      </div>

      <div id="convertJobs"></div>
    </div>
  `;

  // Set up drag-and-drop and click handlers
  setupDropZone('s57DropZone', 's57FileInput');
  setupDropZone('rncDropZone', 'rncFileInput');

  // Poll for active conversion jobs
  setInterval(pollConvertJobs, 3000);
}

function setupDropZone(zoneId, inputId) {
  const zone = document.getElementById(zoneId);
  const input = document.getElementById(inputId);
  if (!zone || !input) return;

  zone.onclick = () => {
    if (!convertPodmanAvailable) {
      alert('Podman is required for chart conversion. Please install Podman first.');
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
      alert('Podman is required for chart conversion. Please install Podman first.');
      return;
    }
    const files = e.dataTransfer.files;
    const type = zoneId === 's57DropZone' ? 's57' : 'rnc';
    if (zoneId === 's57DropZone') {
      const zips = Array.from(files).filter((f) => f.name.endsWith('.zip'));
      (async () => {
        for (const f of zips) {
          await uploadConvertFile(f, type);
        }
      })();
    } else {
      if (files.length > 0 && files[0].name.endsWith('.zip')) {
        uploadConvertFile(files[0], type);
      }
    }
  };
}

window.handleConvertFile = async function (input, type) {
  if (input.files.length > 0) {
    const files = Array.from(input.files);
    input.value = '';
    for (const file of files) {
      await uploadConvertFile(file, type);
    }
  }
};

async function uploadConvertFile(file, type) {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('type', type);

  if (type === 's57') {
    const minzoom = document.getElementById('convertS57Minzoom');
    const maxzoom = document.getElementById('convertS57Maxzoom');
    if (minzoom) formData.append('minzoom', minzoom.value);
    if (maxzoom) formData.append('maxzoom', maxzoom.value);
  }

  const jobId = `convert_${Date.now()}`;
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

    const result = await resp.json();
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
    convertActiveJobs[jobId] = {
      status: 'failed',
      message: err.message || 'Upload failed',
      fileName: file.name,
      type
    };
    renderConvertJobs();
  }
}

async function pollConvertJobs() {
  const activeIds = Object.keys(convertActiveJobs).filter(
    (id) => convertActiveJobs[id].status === 'converting'
  );
  if (activeIds.length === 0) return;

  try {
    const resp = await fetch(`${CONVERT_API_BASE}/catalog-s57-status`);
    if (!resp.ok) return;
    const data = await resp.json();
    const conversions = data.conversions || {};

    for (const id of activeIds) {
      const job = convertActiveJobs[id];
      const progress = conversions[job.chartNumber];
      if (progress) {
        if (progress.status === 'failed') {
          job.status = 'failed';
          job.message = progress.message || 'Conversion failed';
        } else {
          job.message = progress.message || 'Converting...';
          job.log = progress.log;
        }
      } else if (job.chartNumber) {
        // Conversion finished (progress tracking was cleaned up on success)
        job.status = 'completed';
        job.message = 'Conversion complete!';
        // Trigger Manage Charts refresh so the new chart appears
        if (window.handleManageTabActive) {
          window.handleManageTabActive();
        }
      }
    }
    let needsFullRender = false;
    for (const id of activeIds) {
      const job = convertActiveJobs[id];
      if (job.status === 'completed' || job.status === 'failed') {
        needsFullRender = true;
        break;
      }
    }

    if (needsFullRender) {
      renderConvertJobs();
    } else {
      updateConvertJobsInPlace();
    }
  } catch (_e) {
    // ignore
  }
}

function updateConvertJobsInPlace() {
  for (const [id, job] of Object.entries(convertActiveJobs)) {
    const el = document.getElementById(`convert-job-${id}`);
    if (el) {
      const textEl = el.querySelector('.progress-text');
      if (textEl) textEl.textContent = job.message || 'Converting...';
    }
  }
}

function renderConvertJobs() {
  const container = document.getElementById('convertJobs');
  if (!container) return;

  const jobs = Object.entries(convertActiveJobs);
  if (jobs.length === 0) {
    container.innerHTML = '';
    return;
  }

  container.innerHTML = `
    <h3>Conversion Jobs</h3>
    ${jobs
      .map(([id, job]) => {
        const statusClass = job.status === 'completed' ? 'status-completed'
          : job.status === 'failed' ? 'status-failed'
          : 'status-downloading';
        const logsBtn = job.status === 'converting' && job.chartNumber
          ? `<button class="btn-catalog-log" onclick="showConvertLog('${escapeConvertAttr(job.chartNumber)}')">Logs</button>`
          : '';
        return `
          <div class="download-job ${statusClass}" id="convert-job-${id}">
            <div class="job-header">
              <span class="job-name">${escapeConvertHtml(job.fileName)}</span>
              <span class="job-status">${escapeConvertHtml(job.status)}</span>
            </div>
            <div class="job-url">${escapeConvertHtml(job.type === 's57' ? 'S-57 ENC' : 'BSB Raster')} conversion</div>
            <div style="display:flex;align-items:center;gap:8px;">
              ${job.status === 'converting' ? '<div class="spinner" style="width:14px;height:14px;border-width:2px;"></div>' : ''}
              <span class="progress-text">${escapeConvertHtml(job.message)}</span>
              ${logsBtn}
            </div>
          </div>
        `;
      })
      .join('')}
  `;
}

window.showConvertLog = function (chartNumber) {
  // Reuse the catalog log modal
  if (window.showConversionLog) {
    window.showConversionLog(chartNumber);
  }
};

function escapeConvertHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function escapeConvertAttr(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/'/g, '&#39;').replace(/"/g, '&quot;');
}
