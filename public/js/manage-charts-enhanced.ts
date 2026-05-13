// Enhanced Manage Charts functionality with folders, dates, enable/disable, drag-drop, upload

const MANAGE_API_BASE = '/plugins/signalk-charts-provider-simple';

interface ManageChart {
  relativePath: string;
  name: string;
  chartName?: string;
  folder: string;
  size?: number;
  dateCreated: number;
  dateModified: number;
  enabled: boolean;
  type?: string;
  isDirectory?: boolean;
  downloading?: boolean;
  converting?: boolean;
}

interface LocalChartsResponse {
  charts?: ManageChart[];
  folders?: string[];
  basePath?: string;
}

interface ChartMetadata {
  name?: string;
  description?: string;
  version?: string;
  type?: string;
  format?: string;
  bounds?: string | number[];
  minzoom?: number;
  maxzoom?: number;
  center?: string;
  tileCount?: number | string;
  attribution?: string;
  credits?: string;
  tags?: string;
  legend?: string;
  [key: string]: unknown;
}

interface DeleteConfirmOptions {
  type: 'chart' | 'folder';
  name: string;
  hasCharts?: boolean;
  onConfirm: () => void | Promise<void>;
}

interface DuplicateWarningOptions {
  duplicates: string[];
  folderName: string;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}

// State management
let chartsData: ManageChart[] = [];
let foldersData: string[] = [];
let basePath = '';
let selectedFolder: string | null = null; // null means show all folders
let viewMode: 'grid' | 'list' = 'grid';
let refreshInterval: ReturnType<typeof setInterval> | null = null;
let isUploadInProgress = false;

// Pending callback bookkeeping for the modal flows
let pendingDeleteConfirm: (() => void | Promise<void>) | null = null;
let pendingDuplicateConfirm: (() => void | Promise<void>) | null = null;
let pendingDuplicateCancel: (() => void) | null = null;
let pendingRename: { chartPath: string; currentName: string; folder: string } | null = null;

window.handleManageTabActive = function (): void {
  void loadCharts();
};

async function loadCharts(silent = false): Promise<void> {
  const manageOutput = document.getElementById('manageOutput');
  if (!manageOutput) {
    return;
  }

  if (!silent) {
    manageOutput.innerHTML =
      '<div class="empty-state"><div class="spinner"></div><div class="empty-state-text">Loading charts...</div></div>';
  }

  try {
    const response = await fetch(`${MANAGE_API_BASE}/local-charts`);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const data = (await response.json()) as LocalChartsResponse;

    chartsData = data.charts ?? [];
    foldersData = data.folders ?? [];
    basePath = data.basePath ?? '';

    renderChartsUI();
    setupAutoRefresh();
  } catch (error) {
    console.error('Error fetching local charts:', error);
    if (!silent) {
      const message = error instanceof Error ? error.message : String(error);
      manageOutput.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon" style="font-size: 4rem;">${window.getIcon('warning')}</div>
          <div class="empty-state-text">Error loading charts</div>
          <div class="empty-state-subtext">${manageEscapeHtml(message)}</div>
        </div>
      `;
    }
  }
}

function setupAutoRefresh(): void {
  if (refreshInterval !== null) {
    clearInterval(refreshInterval);
    refreshInterval = null;
  }

  const hasActive = chartsData.some((chart) => chart.downloading || chart.converting);

  if (hasActive) {
    refreshInterval = setInterval(() => {
      void (async () => {
        try {
          const response = await fetch(`${MANAGE_API_BASE}/local-charts`);
          if (!response.ok) {
            return;
          }
          const data = (await response.json()) as LocalChartsResponse;
          const newCharts = data.charts ?? [];

          let needsFullRender = false;

          if (newCharts.length !== chartsData.length) {
            needsFullRender = true;
          } else {
            for (const newChart of newCharts) {
              const old = chartsData.find((c) => c.relativePath === newChart.relativePath);
              if (!old) {
                needsFullRender = true;
                break;
              }
              if (
                old.downloading !== newChart.downloading ||
                old.converting !== newChart.converting
              ) {
                needsFullRender = true;
                break;
              }
            }
          }

          chartsData = newCharts;
          foldersData = data.folders ?? [];
          basePath = data.basePath ?? '';

          if (needsFullRender) {
            renderChartsUI();
          }

          if (!chartsData.some((c) => c.downloading || c.converting)) {
            if (refreshInterval !== null) {
              clearInterval(refreshInterval);
              refreshInterval = null;
            }
          }
        } catch {
          // ignore poll errors
        }
      })();
    }, 2000);
  }
}

function renderChartsUI(): void {
  // Skip re-rendering if an upload is in progress (prevents upload overlay from being removed)
  if (isUploadInProgress) {
    return;
  }

  const manageOutput = document.getElementById('manageOutput');
  if (!manageOutput) {
    return;
  }

  if (chartsData.length === 0) {
    selectedFolder = '/';
    manageOutput.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">
          <svg viewBox="0 0 24 24" width="80" height="80" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M3 7v13a2 2 0 002 2h14a2 2 0 002-2V7M3 7l3-4h12l3 4M3 7h18"/>
            <path d="M9 11h6M9 15h6"/>
          </svg>
        </div>
        <div class="empty-state-text">Welcome to Charts Provider Simple!</div>
        <div class="empty-state-subtext">
          <p style="margin-bottom: 16px;">Get started by downloading nautical charts:</p>
          <ol style="text-align: left; display: inline-block; margin: 0 auto 20px; line-height: 1.8;">
            <li>Go to the <strong>"Download from URL"</strong> tab</li>
            <li>Enter a chart URL (or find free charts from the links provided)</li>
            <li>Optionally create folders to organize your charts</li>
            <li>Download charts and they'll appear here</li>
          </ol>
          <p style="margin-top: 16px; font-size: 0.9em; opacity: 0.8;">
            You can also manually upload .mbtiles files from your computer or add them to:<br>
            <code style="background: rgba(0,0,0,0.2); padding: 4px 8px; border-radius: 4px; font-size: 0.85em;">${manageEscapeHtml(basePath)}</code>
          </p>
        </div>
        <div style="display: flex; gap: 12px; justify-content: center; margin-top: 24px;">
          <button class="btn btn-primary" onclick="openTab(event, 'download')" style="padding: 12px 24px;">
            Download Charts
          </button>
          <button class="btn btn-secondary" onclick="triggerUploadEmpty()" style="padding: 12px 24px;">
            Upload from Computer
          </button>
        </div>
      </div>
      <input type="file" id="chartUploadInputEmpty" accept=".mbtiles" multiple style="display: none;" onchange="handleFileUpload(event)">
    `;
    return;
  }

  let html = '';

  // Toolbar
  html += `
    <div class="charts-toolbar">
      <div class="toolbar-left">
        <h3>Chart Manager</h3>
        <span class="chart-count">${chartsData.length} chart${chartsData.length !== 1 ? 's' : ''}</span>
      </div>
      <div class="toolbar-right">
        <button class="btn btn-secondary" onclick="showCreateFolderDialog()" title="Create New Folder">
          + New Folder
        </button>
        ${selectedFolder && selectedFolder !== '/' ? `<button class="btn btn-danger" onclick="deleteSelectedFolder()" title="Delete Selected Folder">Delete Folder</button>` : ''}
        <button class="btn btn-primary" onclick="triggerUpload()" title="Upload charts to ${manageEscapeAttr(selectedFolder ?? '/')}">Upload</button>
        <button class="btn btn-icon ${viewMode === 'grid' ? 'active' : ''}" onclick="setViewMode('grid')" title="Grid View">
          <svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M3 3h8v8H3zm10 0h8v8h-8zM3 13h8v8H3zm10 0h8v8h-8z"/></svg>
        </button>
        <button class="btn btn-icon ${viewMode === 'list' ? 'active' : ''}" onclick="setViewMode('list')" title="List View">
          <svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M3 4h18v2H3zm0 7h18v2H3zm0 7h18v2H3z"/></svg>
        </button>
      </div>
    </div>
  `;

  // Folder navigation
  if (foldersData.length > 1) {
    const folderIcon = window.getIcon('folder', true);
    html += `<div class="folder-nav">`;
    html += `<button class="folder-btn ${selectedFolder === null ? 'active' : ''}" onclick="selectFolder(null)">All Folders</button>`;
    foldersData.forEach((folder) => {
      const isActive = selectedFolder === folder;
      html += `<button class="folder-btn ${isActive ? 'active' : ''}" onclick="selectFolder('${manageEscapeAttr(folder)}')" ondragover="handleFolderDragOver(event)" ondrop="handleDropOnFolder(event, '${manageEscapeAttr(folder)}')" ondragleave="handleFolderDragLeave(event)">
        ${folderIcon} ${manageEscapeHtml(folder)}
      </button>`;
    });
    html += `</div>`;
  }

  // Filter charts by selected folder
  const filteredCharts =
    selectedFolder === null ? chartsData : chartsData.filter((c) => c.folder === selectedFolder);

  if (filteredCharts.length === 0) {
    html += `
      <div class="empty-state">
        <div class="empty-state-icon">
          <svg viewBox="0 0 24 24" width="60" height="60" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/>
          </svg>
        </div>
        <div class="empty-state-text">No charts in this folder</div>
      </div>
    `;
  } else {
    html += `<div class="chart-${viewMode}">`;
    filteredCharts.forEach((chart) => {
      html += renderChartCard(chart);
    });
    html += `</div>`;
  }

  html += `<input type="file" id="chartUploadInput" accept=".mbtiles" multiple style="display: none;" onchange="handleFileUpload(event)">`;

  manageOutput.innerHTML = html;

  initTouchDragDrop();
}

function renderChartCard(chart: ManageChart): string {
  const isDir = chart.isDirectory;
  let displaySize: string | null;
  if (chart.size !== undefined && chart.size > 0) {
    const sizeInMB = (chart.size / (1024 * 1024)).toFixed(2);
    const sizeInGB = (chart.size / (1024 * 1024 * 1024)).toFixed(2);
    displaySize = parseFloat(sizeInGB) >= 1 ? `${sizeInGB} GB` : `${sizeInMB} MB`;
  } else {
    displaySize = null;
  }

  const dateCreated = new Date(chart.dateCreated).toLocaleDateString();
  const dateModified = new Date(chart.dateModified).toLocaleDateString();

  const folderDisplay = chart.folder;

  const downloadingBadge = chart.downloading
    ? `<span class="downloading-badge"><span class="spinner-small"></span> Downloading</span>`
    : chart.converting
      ? `<span class="downloading-badge"><span class="spinner-small"></span> Converting</span>`
      : '';

  const typeBadge = isDir
    ? `<span class="chart-type-badge enc">${manageEscapeHtml((chart.type ?? 'S-57').toUpperCase())}</span>`
    : '';

  const escName = manageEscapeHtml(chart.name);
  const attrPath = manageEscapeAttr(chart.relativePath);
  const attrFolder = manageEscapeAttr(chart.folder);
  const attrName = manageEscapeAttr(chart.name);

  if (viewMode === 'grid') {
    return `
      <div class="chart-card ${chart.enabled ? '' : 'disabled'} ${chart.downloading || chart.converting ? 'downloading' : ''}" draggable="true" ondragstart="handleDragStart(event, '${attrPath}')" ondragover="handleDragOver(event)" ondrop="handleDrop(event, '${attrFolder}')" data-chart-path="${attrPath}">
        <div class="chart-card-header">
          <div class="chart-status">
            <button class="btn-toggle ${chart.enabled ? 'enabled' : 'disabled'}" onclick="toggleChart('${attrPath}')" title="${chart.enabled ? 'Disable' : 'Enable'} chart">
              ${chart.enabled ? window.getIcon('checkmark') : window.getIcon('cross')}
            </button>
          </div>
          <h4>${escName} ${downloadingBadge}</h4>
        </div>
        <div class="chart-card-body">
          ${
            displaySize
              ? `
          <div class="chart-meta-row">
            <span class="meta-label">${window.getIcon('size')} Size:</span>
            <span class="meta-value">${manageEscapeHtml(displaySize)}</span>
          </div>
          `
              : ''
          }
          ${
            chart.chartName
              ? `
          <div class="chart-meta-row">
            <span class="meta-label">📊 Chart:</span>
            <span class="meta-value" style="font-weight: 500; color: var(--accent-primary);">${manageEscapeHtml(chart.chartName)}</span>
          </div>
          `
              : ''
          }
          <div class="chart-meta-row">
            <span class="meta-label">${window.getIcon('folder')} Folder:</span>
            <span class="meta-value">${manageEscapeHtml(folderDisplay)}</span>
          </div>
          <div class="chart-meta-row">
            <span class="meta-label">${window.getIcon('calendar')} Created:</span>
            <span class="meta-value">${manageEscapeHtml(dateCreated)}</span>
          </div>
          <div class="chart-meta-row">
            <span class="meta-label">${window.getIcon('clock')} Modified:</span>
            <span class="meta-value">${manageEscapeHtml(dateModified)}</span>
          </div>
        </div>
        <div class="chart-card-footer">
          ${typeBadge}
          ${
            !isDir
              ? `<button class="btn btn-sm btn-info" onclick="showChartInfo('${attrPath}')" title="View chart metadata">
            Meta
          </button>
          <button class="btn btn-sm btn-secondary" onclick="showRenameDialog('${attrPath}', '${attrName}', '${attrFolder}')" title="Rename chart">
            Rename
          </button>`
              : ''
          }
          <button class="btn btn-sm btn-danger" onclick="deleteChart('${attrPath}', '${attrName}')">
            Delete
          </button>
        </div>
      </div>
    `;
  } else {
    return `
      <div class="chart-list-item ${chart.enabled ? '' : 'disabled'} ${chart.downloading || chart.converting ? 'downloading' : ''}" draggable="true" ondragstart="handleDragStart(event, '${attrPath}')" data-chart-path="${attrPath}">
        <div class="chart-list-status">
          <button class="btn-toggle ${chart.enabled ? 'enabled' : 'disabled'}" onclick="toggleChart('${attrPath}')" title="${chart.enabled ? 'Disable' : 'Enable'} chart">
            ${chart.enabled ? window.getIcon('checkmark') : window.getIcon('cross')}
          </button>
        </div>
        <div class="chart-list-info">
          <div class="chart-list-name">${escName} ${downloadingBadge}</div>
          <div class="chart-list-meta">
            ${displaySize ? `<span>${manageEscapeHtml(displaySize)}</span>` : ''}
            <span>${manageEscapeHtml(folderDisplay)}</span>
            <span>${manageEscapeHtml(dateCreated)}</span>
            <span>${manageEscapeHtml(dateModified)}</span>
          </div>
        </div>
        <div class="chart-list-actions">
          ${typeBadge}
          ${
            !isDir
              ? `<button class="btn btn-sm btn-info" onclick="showChartInfo('${attrPath}')" title="View chart metadata">
            Meta
          </button>
          <button class="btn btn-sm btn-secondary" onclick="showRenameDialog('${attrPath}', '${attrName}', '${attrFolder}')" title="Rename chart">
            Rename
          </button>`
              : ''
          }
          <button class="btn btn-sm btn-danger" onclick="deleteChart('${attrPath}', '${attrName}')">
            Delete
          </button>
        </div>
      </div>
    `;
  }
}

function setViewMode(mode: 'grid' | 'list'): void {
  viewMode = mode;
  renderChartsUI();
}

function selectFolder(folder: string | null): void {
  selectedFolder = folder;
  renderChartsUI();
}

async function toggleChart(relativePath: string): Promise<void> {
  const chart = chartsData.find((c) => c.relativePath === relativePath);
  if (!chart) {
    return;
  }

  const newEnabledState = !chart.enabled;

  try {
    const response = await fetch(
      `${MANAGE_API_BASE}/charts/${encodeURIComponent(relativePath)}/toggle`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: newEnabledState })
      }
    );

    if (response.ok) {
      chart.enabled = newEnabledState;
      renderChartsUI();
      showToggleNotification(chart.name, newEnabledState);
    } else {
      const errorText = await response.text();
      showErrorNotification(`Failed to toggle chart: ${errorText}`);
    }
  } catch (error) {
    console.error('Error toggling chart:', error);
    const message = error instanceof Error ? error.message : String(error);
    alert('Error toggling chart: ' + message);
  }
}

function deleteChart(relativePath: string, name: string): void {
  showDeleteConfirmation({
    type: 'chart',
    name: name,
    onConfirm: async () => {
      try {
        const response = await fetch(
          `${MANAGE_API_BASE}/local-charts/${encodeURIComponent(relativePath)}`,
          { method: 'DELETE' }
        );

        if (response.ok) {
          // Tell the Catalog tab to drop its cached chart data and
          // re-fetch the registry; otherwise the "Installed" badge
          // sticks until a hard browser reload even though the server
          // already cleared the install record.
          document.dispatchEvent(new CustomEvent('charts-changed'));
          void loadCharts();
        } else {
          const errorText = await response.text();
          alert(`Failed to delete chart: ${errorText}`);
        }
      } catch (error) {
        console.error('Error deleting chart:', error);
        const message = error instanceof Error ? error.message : String(error);
        alert('Error deleting chart: ' + message);
      }
    }
  });
}

function triggerUpload(): void {
  document.getElementById('chartUploadInput')?.click();
}

function triggerUploadEmpty(): void {
  document.getElementById('chartUploadInputEmpty')?.click();
}

function handleFileUpload(event: Event): void {
  const target = event.target as HTMLInputElement | null;
  const files = target?.files;
  if (!files || files.length === 0) {
    return;
  }

  const formData = new FormData();
  let validFileCount = 0;

  // Add target folder FIRST (before files) so busboy processes it first
  formData.append('targetFolder', selectedFolder ?? '/');

  // Check for existing files in target folder
  const targetFolderCharts = chartsData.filter((c) => c.folder === selectedFolder);
  const duplicates: string[] = [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    if (!file) {
      continue;
    }
    if (!file.name.endsWith('.mbtiles')) {
      alert(`File "${file.name}" is not an .mbtiles file and will be skipped.`);
      continue;
    }

    const existingChart = targetFolderCharts.find(
      (c) => c.name === file.name || c.name === file.name.replace('.mbtiles', '')
    );
    if (existingChart) {
      duplicates.push(file.name);
    }

    formData.append('charts', file);
    validFileCount++;
  }

  if (validFileCount === 0) {
    if (target) {
      target.value = '';
    }
    return;
  }

  if (duplicates.length > 0) {
    const folderName = selectedFolder ?? '/';
    showDuplicateWarning({
      duplicates: duplicates,
      folderName: folderName,
      onConfirm: () => {
        performUpload(formData, validFileCount, files);
      },
      onCancel: () => {
        if (target) {
          target.value = '';
        }
      }
    });
    return;
  }

  performUpload(formData, validFileCount, files);
  if (target) {
    target.value = '';
  }
}

// Chunk size for large file uploads (50 MB)
const CHUNK_SIZE = 50 * 1024 * 1024;

function performUpload(formData: FormData, validFileCount: number, files: FileList): void {
  isUploadInProgress = true;

  const manageOutput = document.getElementById('manageOutput');
  if (!manageOutput) {
    isUploadInProgress = false;
    return;
  }

  const validFiles = Array.from(files).filter((f) => f.name.endsWith('.mbtiles'));
  const fileList = validFiles
    .map((f) => `<li>${manageEscapeHtml(f.name)} (${(f.size / (1024 * 1024)).toFixed(2)} MB)</li>`)
    .join('');

  manageOutput.innerHTML = `
    <div class="upload-progress-overlay">
      <div class="upload-progress-card">
        <div class="upload-progress-header">
          <div class="spinner"></div>
          <h3>Uploading Charts...</h3>
        </div>
        <div class="upload-progress-body">
          <p>Uploading ${validFileCount} file${validFileCount !== 1 ? 's' : ''} to ${window.getIcon('folder', true)} <strong>${manageEscapeHtml(selectedFolder ?? '/')}</strong></p>
          <ul class="upload-file-list">
            ${fileList}
          </ul>
          <div class="progress-bar-container">
            <div class="progress-bar" id="uploadProgressBar"></div>
          </div>
          <p class="upload-status" id="uploadStatus">Starting upload...</p>
        </div>
      </div>
    </div>
  `;

  const needsChunked = validFiles.some((f) => f.size > CHUNK_SIZE);

  if (needsChunked) {
    void performChunkedUpload(validFiles, validFileCount);
  } else {
    performSimpleUpload(formData, validFileCount);
  }
}

function performSimpleUpload(formData: FormData, validFileCount: number): void {
  const xhr = new XMLHttpRequest();

  xhr.upload.addEventListener('progress', (e) => {
    if (e.lengthComputable) {
      updateUploadProgress(e.loaded, e.total);
    }
  });

  xhr.addEventListener('load', () => {
    isUploadInProgress = false;
    if (xhr.status === 200) {
      void loadCharts();
      showUploadNotification(validFileCount);
    } else {
      void loadCharts();
      showErrorNotification(`Upload failed: ${xhr.responseText}`);
    }
  });

  xhr.addEventListener('error', () => {
    isUploadInProgress = false;
    console.error('Error uploading files');
    void loadCharts();
    showErrorNotification('Error uploading files. Please try again.');
  });

  xhr.open('POST', `${MANAGE_API_BASE}/upload`);
  xhr.send(formData);
}

async function performChunkedUpload(validFiles: File[], validFileCount: number): Promise<void> {
  const targetFolder = selectedFolder ?? '/';
  let totalBytes = 0;
  for (const f of validFiles) {
    totalBytes += f.size;
  }
  let bytesSent = 0;

  try {
    for (const file of validFiles) {
      const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

      for (let i = 0; i < totalChunks; i++) {
        const start = i * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, file.size);
        const chunk = file.slice(start, end);

        await sendChunk(chunk, file.name, i, totalChunks, targetFolder, (chunkLoaded) => {
          updateUploadProgress(bytesSent + chunkLoaded, totalBytes);
        });

        bytesSent += end - start;
        updateUploadProgress(bytesSent, totalBytes);
      }
    }

    isUploadInProgress = false;
    void loadCharts();
    showUploadNotification(validFileCount);
  } catch (error) {
    isUploadInProgress = false;
    console.error('Chunked upload failed:', error);
    void loadCharts();
    const message = error instanceof Error ? error.message : 'Unknown error';
    showErrorNotification(`Upload failed: ${message}`);
  }
}

function sendChunk(
  chunk: Blob,
  filename: string,
  chunkIndex: number,
  totalChunks: number,
  targetFolder: string,
  onProgress: (loaded: number) => void
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();

    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) {
        onProgress(e.loaded);
      }
    });

    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
      } else {
        reject(new Error(xhr.responseText || `HTTP ${xhr.status}`));
      }
    });

    xhr.addEventListener('error', () => {
      reject(new Error('Network error'));
    });

    xhr.open('PUT', `${MANAGE_API_BASE}/upload-chunk`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('X-Upload-Filename', filename);
    xhr.setRequestHeader('X-Chunk-Index', String(chunkIndex));
    xhr.setRequestHeader('X-Total-Chunks', String(totalChunks));
    xhr.setRequestHeader('X-Target-Folder', targetFolder);
    xhr.send(chunk);
  });
}

function updateUploadProgress(loaded: number, total: number): void {
  const percentComplete = Math.round((loaded / total) * 100);
  const progressBar = document.getElementById('uploadProgressBar');
  const statusText = document.getElementById('uploadStatus');

  if (progressBar) {
    progressBar.style.width = `${percentComplete}%`;
  }
  if (statusText) {
    const uploadedMB = (loaded / (1024 * 1024)).toFixed(2);
    const totalMB = (total / (1024 * 1024)).toFixed(2);
    statusText.textContent = `Uploading... ${percentComplete}% (${uploadedMB} / ${totalMB} MB)`;
  }
}

// Drag and drop handlers
let draggedChartPath: string | null = null;

function handleDragStart(event: DragEvent, chartPath: string): void {
  draggedChartPath = chartPath;
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move';
  }
}

function handleDragOver(event: DragEvent): void {
  event.preventDefault();
  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = 'move';
  }
}

function handleDrop(event: DragEvent, _targetFolder: string): void {
  event.preventDefault();
  if (!draggedChartPath) {
    return;
  }
  // For dropping on chart cards (not folder drops)
  draggedChartPath = null;
}

function handleFolderDragOver(event: DragEvent): void {
  event.preventDefault();
  event.stopPropagation();
  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = 'move';
  }
  (event.currentTarget as HTMLElement | null)?.classList.add('drag-over');
}

function handleFolderDragLeave(event: DragEvent): void {
  (event.currentTarget as HTMLElement | null)?.classList.remove('drag-over');
}

async function handleDropOnFolder(event: DragEvent, targetFolder: string): Promise<void> {
  event.preventDefault();
  event.stopPropagation();
  (event.currentTarget as HTMLElement | null)?.classList.remove('drag-over');

  if (!draggedChartPath) {
    return;
  }

  const chart = chartsData.find((c) => c.relativePath === draggedChartPath);
  if (!chart) {
    draggedChartPath = null;
    return;
  }

  if (chart.folder === targetFolder) {
    draggedChartPath = null;
    return;
  }

  const targetFolderCharts = chartsData.filter((c) => c.folder === targetFolder);
  const duplicate = targetFolderCharts.find((c) => c.name === chart.name);

  if (duplicate) {
    const path = draggedChartPath;
    showDuplicateWarning({
      duplicates: [chart.name + '.mbtiles'],
      folderName: targetFolder,
      onConfirm: async () => {
        await performChartMove(path, targetFolder);
        draggedChartPath = null;
      },
      onCancel: () => {
        draggedChartPath = null;
      }
    });
    return;
  }

  await performChartMove(draggedChartPath, targetFolder);
  draggedChartPath = null;
}

// Touch drag and drop support for mobile devices (iOS Safari)
let touchDragElement: HTMLElement | null = null;
let touchDragChartPath: string | null = null;
let touchStartY = 0;
let touchStartX = 0;
let isDragging = false;
const DRAG_THRESHOLD = 15;
let longPressTimer: ReturnType<typeof setTimeout> | null = null;
let longPressTriggered = false;
let touchHandlersInitialized = false;

function initTouchDragDrop(): void {
  if (touchHandlersInitialized) {
    return;
  }

  const chartsContainer = document.getElementById('manageOutput');
  if (!chartsContainer) {
    return;
  }

  touchHandlersInitialized = true;

  chartsContainer.addEventListener(
    'touchstart',
    (event) => {
      const target = event.target as HTMLElement | null;
      if (!target) {
        return;
      }
      if (
        target.tagName === 'BUTTON' ||
        target.closest('button') ||
        target.tagName === 'INPUT' ||
        target.closest('input')
      ) {
        return;
      }

      const chartCard = target.closest<HTMLElement>('.chart-card, .chart-list-item');
      if (!chartCard) {
        return;
      }

      const chartPath = chartCard.getAttribute('data-chart-path');
      if (!chartPath) {
        return;
      }

      const touch = event.touches[0];
      if (!touch) {
        return;
      }
      touchStartX = touch.clientX;
      touchStartY = touch.clientY;
      touchDragChartPath = chartPath;
      touchDragElement = chartCard;
      isDragging = false;
      longPressTriggered = false;

      longPressTimer = setTimeout(() => {
        longPressTriggered = true;
        if (touchDragElement) {
          touchDragElement.style.opacity = '0.6';
          touchDragElement.style.transform = 'scale(0.98)';
          touchDragElement.style.boxShadow = '0 8px 16px rgba(0,0,0,0.3)';
        }
      }, 300);
    },
    { passive: false }
  );

  chartsContainer.addEventListener(
    'touchmove',
    (event) => {
      if (!touchDragChartPath) {
        return;
      }

      const touch = event.touches[0];
      if (!touch) {
        return;
      }
      const deltaX = Math.abs(touch.clientX - touchStartX);
      const deltaY = Math.abs(touch.clientY - touchStartY);

      if (!longPressTriggered && (deltaX > DRAG_THRESHOLD || deltaY > DRAG_THRESHOLD)) {
        if (longPressTimer !== null) {
          clearTimeout(longPressTimer);
          longPressTimer = null;
        }
        touchDragChartPath = null;
        touchDragElement = null;
        return;
      }

      if (longPressTriggered) {
        event.preventDefault();
        event.stopPropagation();

        if (!isDragging && (deltaX > DRAG_THRESHOLD || deltaY > DRAG_THRESHOLD)) {
          isDragging = true;
        }

        const elementUnderTouch = document.elementFromPoint(touch.clientX, touch.clientY);
        document.querySelectorAll('.folder-btn').forEach((btn) => {
          btn.classList.remove('drag-over');
        });

        if (elementUnderTouch && elementUnderTouch.classList.contains('folder-btn')) {
          elementUnderTouch.classList.add('drag-over');
        }
      }
    },
    { passive: false }
  );

  chartsContainer.addEventListener(
    'touchend',
    (event) => {
      if (longPressTimer !== null) {
        clearTimeout(longPressTimer);
        longPressTimer = null;
      }

      if (!touchDragChartPath) {
        return;
      }

      if (touchDragElement) {
        touchDragElement.style.opacity = '1';
        touchDragElement.style.transform = 'scale(1)';
        touchDragElement.style.boxShadow = '';
      }

      void (async () => {
        if (isDragging && longPressTriggered) {
          const touch = event.changedTouches[0];
          if (!touch) {
            return;
          }
          const elementUnderTouch = document.elementFromPoint(touch.clientX, touch.clientY);

          document.querySelectorAll('.folder-btn').forEach((btn) => {
            btn.classList.remove('drag-over');
          });

          if (elementUnderTouch && elementUnderTouch.classList.contains('folder-btn')) {
            const onclickAttr = elementUnderTouch.getAttribute('onclick');
            const folderMatch = onclickAttr?.match(/selectFolder\('([^']*)'\)/);

            if (folderMatch) {
              const targetFolder = folderMatch[1];
              if (targetFolder === undefined || !touchDragChartPath) {
                return;
              }
              const chart = chartsData.find((c) => c.relativePath === touchDragChartPath);

              if (chart && chart.folder !== targetFolder) {
                const targetFolderCharts = chartsData.filter((c) => c.folder === targetFolder);
                const duplicate = targetFolderCharts.find((c) => c.name === chart.name);

                if (duplicate) {
                  const path = touchDragChartPath;
                  showDuplicateWarning({
                    duplicates: [chart.name + '.mbtiles'],
                    folderName: targetFolder,
                    onConfirm: async () => {
                      await performChartMove(path, targetFolder);
                    },
                    onCancel: () => {
                      // intentional no-op
                    }
                  });
                } else {
                  await performChartMove(touchDragChartPath, targetFolder);
                }
              }
            }
          }
        }

        touchDragChartPath = null;
        touchDragElement = null;
        isDragging = false;
        longPressTriggered = false;
      })();
    },
    { passive: true }
  );

  chartsContainer.addEventListener(
    'touchcancel',
    () => {
      if (longPressTimer !== null) {
        clearTimeout(longPressTimer);
        longPressTimer = null;
      }
      if (touchDragElement) {
        touchDragElement.style.opacity = '1';
        touchDragElement.style.transform = 'scale(1)';
        touchDragElement.style.boxShadow = '';
      }
      touchDragChartPath = null;
      touchDragElement = null;
      isDragging = false;
      longPressTriggered = false;
    },
    { passive: true }
  );
}

async function performChartMove(chartPath: string, targetFolder: string): Promise<void> {
  try {
    const response = await fetch(`${MANAGE_API_BASE}/move-chart`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chartPath, targetFolder })
    });

    if (response.ok) {
      document.dispatchEvent(new CustomEvent('charts-changed'));
      void loadCharts();
    } else {
      const errorText = await response.text();
      alert(`Failed to move chart: ${errorText}`);
    }
  } catch (error) {
    console.error('Error moving chart:', error);
    const message = error instanceof Error ? error.message : String(error);
    alert('Error moving chart: ' + message);
  }
}

// Folder management functions
function deleteSelectedFolder(): void {
  if (!selectedFolder || selectedFolder === '/') {
    alert('Please select a folder to delete (cannot delete /).');
    return;
  }
  deleteFolder(selectedFolder);
}

function showCreateFolderDialog(): void {
  const folderIcon = window.getIcon('folder', true);

  const modalHTML = `
    <div class="delete-modal-overlay" id="createFolderModal" onclick="closeCreateFolderModal(event)">
      <div class="delete-modal" onclick="event.stopPropagation()">
        <div class="delete-modal-header">
          <div class="delete-modal-icon" style="color: var(--accent-primary);">${folderIcon}</div>
          <h3>Create New Folder</h3>
        </div>
        <div class="delete-modal-body">
          <label for="newFolderName" style="display: block; margin-bottom: 8px; color: var(--text-primary); font-weight: 500;">Folder Name:</label>
          <input
            type="text"
            id="newFolderName"
            class="text-input"
            placeholder="e.g., North Atlantic Charts"
            style="width: 100%; padding: 12px; margin-bottom: 12px; background: var(--bg-secondary); border: 2px solid var(--border-color); border-radius: 8px; color: var(--text-primary); font-size: 1rem;"
            onkeypress="if(event.key==='Enter') confirmCreateFolder()"
          />
          <p style="font-size: 0.9rem; color: var(--text-secondary); margin: 0;">Use only letters, numbers, spaces, and dashes.</p>
        </div>
        <div class="delete-modal-actions">
          <button class="btn btn-secondary" onclick="closeCreateFolderModal()">Cancel</button>
          <button class="btn btn-primary" onclick="confirmCreateFolder()">Create Folder</button>
        </div>
      </div>
    </div>
  `;

  document.body.insertAdjacentHTML('beforeend', modalHTML);

  setTimeout(() => {
    document.getElementById('newFolderName')?.focus();
  }, 100);
}

function closeCreateFolderModal(event?: Event): void {
  if (event && (event.target as HTMLElement).id !== 'createFolderModal') {
    return;
  }
  document.getElementById('createFolderModal')?.remove();
}

function confirmCreateFolder(): void {
  const input = document.getElementById('newFolderName') as HTMLInputElement | null;
  const folderName = input?.value.trim();

  if (!folderName) {
    input?.focus();
    return;
  }

  if (folderName.includes('..') || folderName.includes('/') || folderName.includes('\\')) {
    alert('Invalid folder name. Please use only letters, numbers, spaces, and dashes.');
    input?.focus();
    return;
  }

  closeCreateFolderModal();
  void createFolder(folderName);
}

async function createFolder(folderName: string): Promise<void> {
  try {
    const response = await fetch(`${MANAGE_API_BASE}/folders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderPath: folderName })
    });

    if (response.ok) {
      void loadCharts();
    } else {
      const errorText = await response.text();
      console.error('Failed to create folder:', errorText);
      alert(`Failed to create folder: ${errorText}`);
    }
  } catch (error) {
    console.error('Error creating folder:', error);
    const message = error instanceof Error ? error.message : String(error);
    alert('Error creating folder: ' + message);
  }
}

function showRenameDialog(chartPath: string, currentName: string, folder: string): void {
  const nameWithoutExtension = currentName.replace(/\.mbtiles$/, '');

  const modalHTML = `
    <div class="delete-modal-overlay" id="renameModal" onclick="closeRenameModal(event)">
      <div class="delete-modal" onclick="event.stopPropagation()">
        <div class="delete-modal-header">
          <div class="delete-modal-icon" style="color: var(--accent-primary);">
            <svg viewBox="0 0 24 24" width="48" height="48" fill="currentColor">
              <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/>
            </svg>
          </div>
          <h3>Rename Chart</h3>
        </div>
        <div class="delete-modal-body">
          <p style="margin-bottom: 16px;">Enter a new name for the chart:</p>
          <div style="margin-bottom: 12px;">
            <label for="newChartName" style="display: block; margin-bottom: 8px; color: var(--text-primary); font-weight: 500;">Chart Name:</label>
            <div style="display: flex; align-items: center; gap: 8px;">
              <input
                type="text"
                id="newChartName"
                class="text-input"
                value="${manageEscapeAttr(nameWithoutExtension)}"
                style="flex: 1; padding: 12px; background: var(--bg-secondary); border: 2px solid var(--border-color); border-radius: 8px; color: var(--text-primary); font-size: 1rem;"
                onkeypress="if(event.key==='Enter') confirmRename()"
              />
              <span style="color: var(--text-secondary); font-weight: 500; white-space: nowrap;">.mbtiles</span>
            </div>
          </div>
          <p style="font-size: 0.9rem; color: var(--text-secondary); margin: 0;">Use only letters, numbers, spaces, underscores, and dashes.</p>
        </div>
        <div class="delete-modal-actions">
          <button class="btn btn-secondary" onclick="closeRenameModal()">Cancel</button>
          <button class="btn btn-primary" onclick="confirmRename()">Rename</button>
        </div>
      </div>
    </div>
  `;

  pendingRename = { chartPath, currentName, folder };

  document.body.insertAdjacentHTML('beforeend', modalHTML);

  setTimeout(() => {
    const input = document.getElementById('newChartName') as HTMLInputElement | null;
    if (input) {
      input.focus();
      input.select();
    }
  }, 100);
}

function closeRenameModal(event?: Event): void {
  if (event && (event.target as HTMLElement).id !== 'renameModal') {
    return;
  }
  document.getElementById('renameModal')?.remove();
  pendingRename = null;
}

async function confirmRename(): Promise<void> {
  const input = document.getElementById('newChartName') as HTMLInputElement | null;
  const newName = input?.value.trim();

  if (!newName) {
    input?.focus();
    return;
  }

  if (newName.includes('..') || newName.includes('/') || newName.includes('\\')) {
    alert('Invalid chart name. Please use only letters, numbers, spaces, underscores, and dashes.');
    input?.focus();
    return;
  }

  if (!pendingRename) {
    return;
  }
  const { chartPath, currentName, folder } = pendingRename;
  const newNameWithExtension = newName + '.mbtiles';
  const currentNameWithExtension = currentName.endsWith('.mbtiles')
    ? currentName
    : currentName + '.mbtiles';

  if (newNameWithExtension === currentNameWithExtension) {
    closeRenameModal();
    return;
  }

  const folderCharts = chartsData.filter((c) => c.folder === folder);
  const duplicate = folderCharts.find(
    (c) =>
      (c.name === newNameWithExtension || c.name === newName) && c.relativePath !== chartPath
  );

  if (duplicate) {
    showErrorNotification(
      `A chart named "${newNameWithExtension}" already exists in folder "${folder}". Please choose a different name.`
    );
    input?.focus();
    return;
  }

  closeRenameModal();

  try {
    const response = await fetch(`${MANAGE_API_BASE}/rename-chart`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chartPath, newName: newNameWithExtension })
    });

    if (response.ok) {
      document.dispatchEvent(new CustomEvent('charts-changed'));
      void loadCharts();
      showRenameNotification(currentNameWithExtension, newNameWithExtension);
    } else {
      const errorText = await response.text();
      alert(`Failed to rename chart: ${errorText}`);
    }
  } catch (error) {
    console.error('Error renaming chart:', error);
    const message = error instanceof Error ? error.message : String(error);
    alert('Error renaming chart: ' + message);
  }
}

function deleteFolder(folder: string): void {
  const folderHasCharts = chartsData.some((chart) => chart.folder === folder);

  showDeleteConfirmation({
    type: 'folder',
    name: folder,
    hasCharts: folderHasCharts,
    onConfirm: async () => {
      try {
        const response = await fetch(
          `${MANAGE_API_BASE}/folders/${encodeURIComponent(folder)}`,
          { method: 'DELETE' }
        );

        if (response.ok) {
          if (selectedFolder === folder) {
            selectedFolder = null;
          }
          void loadCharts();
        } else {
          const errorText = await response.text();
          alert(`Failed to delete folder: ${errorText}`);
        }
      } catch (error) {
        console.error('Error deleting folder:', error);
        const message = error instanceof Error ? error.message : String(error);
        alert('Error deleting folder: ' + message);
      }
    }
  });
}

function showDeleteConfirmation({ type, name, hasCharts, onConfirm }: DeleteConfirmOptions): void {
  const isChart = type === 'chart';
  const isFolder = type === 'folder';
  const icon = window.getIcon('trash');
  const title = isChart ? 'Delete Chart' : 'Delete Folder';

  let warningText: string;
  if (isChart) {
    warningText =
      window.getIcon('warning') +
      ' This action cannot be undone. The chart file will be permanently deleted.';
  } else if (isFolder && hasCharts) {
    warningText =
      window.getIcon('warning') +
      ' This folder contains charts and cannot be deleted. Please move or delete all charts from this folder first.';
  } else {
    warningText = window.getIcon('warning') + ' This will delete the empty folder.';
  }

  const modalHTML = `
    <div class="delete-modal-overlay" id="deleteModal" onclick="closeDeleteModal(event)">
      <div class="delete-modal" onclick="event.stopPropagation()">
        <div class="delete-modal-header">
          <div class="delete-modal-icon">${icon}</div>
          <h3>${title}</h3>
        </div>
        <div class="delete-modal-body">
          <p>Are you sure you want to delete this ${type}?</p>
          <div class="delete-modal-item">
            <div class="delete-modal-item-name">${manageEscapeHtml(name)}</div>
          </div>
          <div class="delete-modal-warning">${warningText}</div>
        </div>
        <div class="delete-modal-actions">
          <button class="btn btn-secondary" onclick="closeDeleteModal()">Cancel</button>
          ${!(isFolder && hasCharts) ? '<button class="btn btn-danger" onclick="confirmDelete()">Delete</button>' : ''}
        </div>
      </div>
    </div>
  `;

  pendingDeleteConfirm = onConfirm;

  document.body.insertAdjacentHTML('beforeend', modalHTML);
}

function closeDeleteModal(event?: Event): void {
  if (event && (event.target as HTMLElement).id !== 'deleteModal') {
    return;
  }
  document.getElementById('deleteModal')?.remove();
  pendingDeleteConfirm = null;
}

function confirmDelete(): void {
  const callback = pendingDeleteConfirm;
  closeDeleteModal();
  if (callback) {
    void callback();
  }
}

function showDuplicateWarning({
  duplicates,
  folderName,
  onConfirm,
  onCancel
}: DuplicateWarningOptions): void {
  const icon = window.getIcon('warning');
  const duplicateList = duplicates.map((d) => `<li>${manageEscapeHtml(d)}</li>`).join('');

  const modalHTML = `
    <div class="delete-modal-overlay" id="duplicateModal" onclick="closeDuplicateModal(event)">
      <div class="delete-modal" onclick="event.stopPropagation()">
        <div class="delete-modal-header">
          <div class="delete-modal-icon">${icon}</div>
          <h3>Overwrite Existing Chart${duplicates.length > 1 ? 's' : ''}?</h3>
        </div>
        <div class="delete-modal-body">
          <p>The following chart${duplicates.length > 1 ? 's' : ''} already exist${duplicates.length === 1 ? 's' : ''} in <strong>${manageEscapeHtml(folderName)}</strong>:</p>
          <ul class="upload-file-list" style="margin: 12px 0;">
            ${duplicateList}
          </ul>
          <div class="delete-modal-warning">${window.getIcon('warning')} Continuing will overwrite the existing file${duplicates.length > 1 ? 's' : ''}.</div>
        </div>
        <div class="delete-modal-actions">
          <button class="btn btn-secondary" onclick="closeDuplicateModal()">Cancel</button>
          <button class="btn btn-primary" onclick="confirmDuplicate()">Continue Upload</button>
        </div>
      </div>
    </div>
  `;

  pendingDuplicateConfirm = onConfirm;
  pendingDuplicateCancel = onCancel;

  document.body.insertAdjacentHTML('beforeend', modalHTML);
}

function closeDuplicateModal(event?: Event): void {
  if (event && (event.target as HTMLElement).id !== 'duplicateModal') {
    return;
  }
  document.getElementById('duplicateModal')?.remove();

  if (pendingDuplicateCancel) {
    pendingDuplicateCancel();
  }
  pendingDuplicateConfirm = null;
  pendingDuplicateCancel = null;
}

function confirmDuplicate(): void {
  const callback = pendingDuplicateConfirm;
  document.getElementById('duplicateModal')?.remove();
  pendingDuplicateConfirm = null;
  pendingDuplicateCancel = null;
  if (callback) {
    void callback();
  }
}

// Notification helpers
function showToggleNotification(chartName: string, enabled: boolean): void {
  const html = `
    <div class="notification-toast" id="toggleNotification">
      <div class="notification-content">
        <div class="notification-icon ${enabled ? 'success' : 'warning'}">
          ${enabled ? window.getIcon('checkmark') : window.getIcon('circle')}
        </div>
        <div class="notification-text">
          <div class="notification-title">${enabled ? 'Chart Enabled' : 'Chart Disabled'}</div>
          <div class="notification-message">${manageEscapeHtml(chartName)}</div>
        </div>
      </div>
    </div>
  `;
  fadeOutNotification('toggleNotification', html);
}

function showErrorNotification(message: string): void {
  const html = `
    <div class="notification-toast error" id="errorNotification">
      <div class="notification-content">
        <div class="notification-icon error">${window.getIcon('cross')}</div>
        <div class="notification-text">
          <div class="notification-title">Error</div>
          <div class="notification-message">${manageEscapeHtml(message)}</div>
        </div>
      </div>
    </div>
  `;
  fadeOutNotification('errorNotification', html);
}

function showRenameNotification(oldName: string, newName: string): void {
  const html = `
    <div class="notification-toast" id="renameNotification">
      <div class="notification-content">
        <div class="notification-icon success">
          <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor">
            <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/>
          </svg>
        </div>
        <div class="notification-text">
          <div class="notification-title">Chart Renamed</div>
          <div class="notification-message">${manageEscapeHtml(oldName)} → ${manageEscapeHtml(newName)}</div>
        </div>
      </div>
    </div>
  `;
  fadeOutNotification('renameNotification', html);
}

function showUploadNotification(fileCount: number): void {
  const html = `
    <div class="notification-toast" id="uploadNotification">
      <div class="notification-content">
        <div class="notification-icon success">
          ${window.getIcon('checkmark')}
        </div>
        <div class="notification-text">
          <div class="notification-title">Upload Complete</div>
          <div class="notification-message">${fileCount} chart${fileCount !== 1 ? 's' : ''} uploaded successfully</div>
        </div>
      </div>
    </div>
  `;
  fadeOutNotification('uploadNotification', html);
}

function showSuccessNotification(message: string): void {
  const html = `
    <div class="notification-toast" id="successNotification">
      <div class="notification-content">
        <div class="notification-icon success">
          ${window.getIcon('checkmark')}
        </div>
        <div class="notification-text">
          <div class="notification-title">Success</div>
          <div class="notification-message">${manageEscapeHtml(message)}</div>
        </div>
      </div>
    </div>
  `;
  fadeOutNotification('successNotification', html);
}

function fadeOutNotification(id: string, html: string): void {
  document.getElementById(id)?.remove();
  document.body.insertAdjacentHTML('beforeend', html);
  setTimeout(() => {
    const notification = document.getElementById(id);
    if (notification) {
      notification.classList.add('fade-out');
      setTimeout(() => {
        notification.remove();
      }, 300);
    }
  }, 5000);
}

// Chart info modal
let currentChartPath: string | null = null;
let currentMetadata: ChartMetadata | null = null;
let isEditMode = false;

async function showChartInfo(chartPath: string): Promise<void> {
  try {
    currentChartPath = chartPath;
    isEditMode = false;

    const response = await fetch(
      `${MANAGE_API_BASE}/chart-metadata/${encodeURIComponent(chartPath)}`
    );

    if (!response.ok) {
      const errorText = await response.text();
      showErrorNotification(`Failed to load chart information: ${errorText}`);
      return;
    }

    const metadata = (await response.json()) as ChartMetadata;
    currentMetadata = metadata;

    renderMetadataModal(metadata);
  } catch (error) {
    console.error('Error fetching chart info:', error);
    const message = error instanceof Error ? error.message : String(error);
    showErrorNotification('Error loading chart information: ' + message);
  }
}

function renderMetadataModal(metadata: ChartMetadata): void {
  // Coerce an unknown metadata value to a displayable string. Primitives
  // pass through; objects/arrays go via JSON so the user sees real
  // content rather than "[object Object]".
  const safeStr = (v: unknown): string => {
    if (typeof v === 'string') {
      return v;
    }
    if (typeof v === 'number' || typeof v === 'boolean') {
      return String(v);
    }
    return JSON.stringify(v);
  };

  const formatValue = (key: string, value: unknown, isEditable = false): string => {
    if (value === null || value === undefined || value === '') {
      return '<span style="color: var(--text-secondary); font-style: italic;">Not specified</span>';
    }

    if (isEditMode && isEditable && key === 'name') {
      return `<input type="text" id="editChartName" class="text-input" value="${manageEscapeAttr(safeStr(value))}" style="width: 100%; padding: 8px;" />`;
    }

    switch (key) {
      case 'bounds':
        try {
          const boundsArr =
            typeof value === 'string'
              ? value.split(',').map((v) => parseFloat(v.trim()))
              : (value as number[]);
          return `
            <div style="font-family: monospace; font-size: 0.9em;">
              SW: ${boundsArr[0]?.toFixed(4)}°, ${boundsArr[1]?.toFixed(4)}°<br>
              NE: ${boundsArr[2]?.toFixed(4)}°, ${boundsArr[3]?.toFixed(4)}°
            </div>
          `;
        } catch {
          return manageEscapeHtml(safeStr(value));
        }
      case 'tileCount':
        return parseInt(safeStr(value), 10).toLocaleString();
      case 'minzoom':
      case 'maxzoom':
        return `Level ${manageEscapeHtml(safeStr(value))}`;
      case 'legend':
        return '<span style="color: var(--text-secondary); font-style: italic;">Available (not displayed)</span>';
      default:
        return manageEscapeHtml(safeStr(value));
    }
  };

  const metadataRows: { label: string; key: keyof ChartMetadata; editable?: boolean }[] = [
    { label: 'Chart Name', key: 'name', editable: true },
    { label: 'Description', key: 'description' },
    { label: 'Version', key: 'version' },
    { label: 'Type', key: 'type' },
    { label: 'Format', key: 'format' },
    { label: 'Bounds', key: 'bounds' },
    { label: 'Min Zoom', key: 'minzoom' },
    { label: 'Max Zoom', key: 'maxzoom' },
    { label: 'Center', key: 'center' },
    { label: 'Tile Count', key: 'tileCount' },
    { label: 'Attribution', key: 'attribution' },
    { label: 'Credits', key: 'credits' },
    { label: 'Tags', key: 'tags' },
    { label: 'Legend', key: 'legend' }
  ];

  const metadataHTML = metadataRows
    .filter((row) => metadata[row.key] !== undefined)
    .map(
      (row) => `
      <div class="chart-info-row">
        <div class="chart-info-label">${row.label}:</div>
        <div class="chart-info-value">${formatValue(String(row.key), metadata[row.key], row.editable)}</div>
      </div>
    `
    )
    .join('');

  const infoIcon = window.getIcon('info', true);

  const warningHTML = isEditMode
    ? `
    <div class="delete-modal-warning" style="margin-bottom: 16px;">
      ${window.getIcon('warning')} <strong>Legal Notice:</strong> You are about to modify chart metadata. The Signal K community is not responsible for any illegal use of this feature. Charts must only be modified for personal use. Distribution of modified charts may violate copyright laws.
    </div>
  `
    : '';

  const modalHTML = `
    <div class="delete-modal-overlay" id="chartInfoModal" onclick="closeChartInfoModal(event)">
      <div class="delete-modal chart-info-modal" onclick="event.stopPropagation()">
        <div class="delete-modal-header">
          <div class="delete-modal-icon" style="color: var(--accent-primary);">${infoIcon}</div>
          <h3>Chart Metadata ${isEditMode ? '(Edit Mode)' : ''}</h3>
        </div>
        <div class="delete-modal-body">
          ${warningHTML}
          <div class="chart-info-container">
            ${metadataHTML}
          </div>
        </div>
        <div class="delete-modal-actions">
          ${
            isEditMode
              ? '<button class="btn btn-secondary" onclick="cancelEditMetadata()">Cancel</button><button class="btn btn-primary" onclick="saveChartMetadata()">Save</button>'
              : '<button class="btn btn-secondary" onclick="editChartMetadata()">Edit</button><button class="btn btn-primary" onclick="closeChartInfoModal()">Close</button>'
          }
        </div>
      </div>
    </div>
  `;

  document.getElementById('chartInfoModal')?.remove();

  document.body.insertAdjacentHTML('beforeend', modalHTML);
}

function editChartMetadata(): void {
  if (!currentMetadata) {
    return;
  }
  isEditMode = true;
  renderMetadataModal(currentMetadata);
}

function cancelEditMetadata(): void {
  if (!currentMetadata) {
    return;
  }
  isEditMode = false;
  renderMetadataModal(currentMetadata);
}

async function saveChartMetadata(): Promise<void> {
  const input = document.getElementById('editChartName') as HTMLInputElement | null;
  const newChartName = input?.value.trim();

  if (!newChartName) {
    showErrorNotification('Chart name cannot be empty');
    return;
  }

  if (!currentChartPath) {
    return;
  }

  try {
    const response = await fetch(
      `${MANAGE_API_BASE}/chart-metadata/${encodeURIComponent(currentChartPath)}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newChartName })
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      showErrorNotification(`Failed to save metadata: ${errorText}`);
      return;
    }

    if (currentMetadata) {
      currentMetadata.name = newChartName;
      currentMetadata.description = 'USER MODIFIED - DO NOT DISTRIBUTE - PERSONAL USE ONLY';
      isEditMode = false;
      renderMetadataModal(currentMetadata);
    }

    showSuccessNotification('Chart metadata updated successfully');
  } catch (error) {
    console.error('Error saving chart metadata:', error);
    const message = error instanceof Error ? error.message : String(error);
    showErrorNotification('Error saving chart metadata: ' + message);
  }
}

function closeChartInfoModal(event?: Event): void {
  if (event && (event.target as HTMLElement).id !== 'chartInfoModal') {
    return;
  }
  document.getElementById('chartInfoModal')?.remove();
}

// Escape helpers (per-file naming because module: "none" makes
// duplicate top-level identifiers collide at link time).
function manageEscapeHtml(str: string | undefined | null): string {
  if (!str) {
    return '';
  }
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function manageEscapeAttr(str: string | undefined | null): string {
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

// Globals exposed for inline `onclick` handlers
window.setViewMode = setViewMode;
window.selectFolder = selectFolder;
window.toggleChart = toggleChart;
window.deleteChart = deleteChart;
window.triggerUpload = triggerUpload;
window.triggerUploadEmpty = triggerUploadEmpty;
window.handleFileUpload = handleFileUpload;
window.handleDragStart = handleDragStart;
window.handleDragOver = handleDragOver;
window.handleDrop = handleDrop;
window.handleFolderDragOver = handleFolderDragOver;
window.handleFolderDragLeave = handleFolderDragLeave;
window.handleDropOnFolder = handleDropOnFolder;
window.deleteSelectedFolder = deleteSelectedFolder;
window.showCreateFolderDialog = showCreateFolderDialog;
window.closeCreateFolderModal = closeCreateFolderModal;
window.confirmCreateFolder = confirmCreateFolder;
window.showRenameDialog = showRenameDialog;
window.closeRenameModal = closeRenameModal;
window.confirmRename = confirmRename;
window.deleteFolder = deleteFolder;
window.closeDeleteModal = closeDeleteModal;
window.confirmDelete = confirmDelete;
window.closeDuplicateModal = closeDuplicateModal;
window.confirmDuplicate = confirmDuplicate;
window.showChartInfo = showChartInfo;
window.editChartMetadata = editChartMetadata;
window.cancelEditMetadata = cancelEditMetadata;
window.saveChartMetadata = saveChartMetadata;
window.closeChartInfoModal = closeChartInfoModal;
