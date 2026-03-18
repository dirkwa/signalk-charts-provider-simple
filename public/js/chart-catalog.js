// Chart Catalog tab - browse and download charts from chartcatalogs.github.io

const CATALOG_API_BASE = '/plugins/signalk-charts-provider-simple';

let catalogInitialized = false;
let catalogRegistry = [];
let catalogInstalled = {};
let catalogUpdates = [];
let activeCategoryFilter = 'all';
let expandedCatalogs = new Set();
let catalogChartData = {}; // catalogFile -> parsed chart data
let catalogFolders = ['/']; // available folders for download target
let catalogDownloadJobs = {}; // chartNumber -> jobId
let catalogConverting = {}; // chartNumber -> true (S-57 conversion in progress)
let catalogConversionProgress = {}; // chartNumber -> { status, message, map, zoom, percent }
let s57PodmanAvailable = false;

// Tab activation handler
window.handleCatalogTabActive = function () {
  if (!catalogInitialized) {
    initCatalogTab();
  } else {
    refreshUpdateBadge();
  }
};

async function initCatalogTab() {
  catalogInitialized = true;
  const output = document.getElementById('catalogOutput');
  if (!output) return;

  output.innerHTML = `
    <div class="catalog-container">
      <div id="catalogPodmanWarning"></div>
      <div id="catalogFilterBar"></div>
      <div id="catalogList">
        <div class="catalog-loading">
          <div class="spinner"></div>
          <div>Loading catalog registry...</div>
        </div>
      </div>
      <div class="catalog-source-link">
        Source:
        <a href="https://chartcatalogs.github.io/" target="_blank" rel="noopener">chartcatalogs.github.io</a>
        &mdash; Community-maintained nautical chart catalogs
      </div>
    </div>
  `;

  await loadCatalogRegistry();
  await loadFolders();
  await checkS57Status();
  refreshUpdateBadge();

  // Poll for updates every 60 seconds
  setInterval(refreshUpdateBadge, 60000);

  // Poll for active download jobs and conversions every 2 seconds
  setInterval(pollCatalogDownloads, 2000);
  setInterval(pollConversions, 3000);
}

async function loadCatalogRegistry() {
  try {
    const response = await fetch(`${CATALOG_API_BASE}/catalog-registry`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    catalogRegistry = data.registry || [];
    catalogInstalled = data.installed || {};
    catalogConverting = data.converting || {};
    renderFilterBar();
    renderCatalogList();
  } catch (error) {
    console.error('Failed to load catalog registry:', error);
    const listEl = document.getElementById('catalogList');
    if (listEl) {
      listEl.innerHTML = `<div class="catalog-error">Failed to load catalog registry. Please try again later.</div>`;
    }
  }
}

async function loadFolders() {
  try {
    const response = await fetch(`${CATALOG_API_BASE}/local-charts`);
    if (!response.ok) return;
    const data = await response.json();
    catalogFolders = data.folders || ['/'];
  } catch (_e) {
    // Ignore folder load errors
  }
}

async function checkS57Status() {
  try {
    const response = await fetch(`${CATALOG_API_BASE}/catalog-s57-status`);
    if (!response.ok) return;
    const data = await response.json();
    s57PodmanAvailable = data.podmanAvailable || false;
  } catch (_e) {
    s57PodmanAvailable = false;
  }

  const warningEl = document.getElementById('catalogPodmanWarning');
  if (warningEl) {
    if (!s57PodmanAvailable) {
      warningEl.innerHTML = `
        <div class="catalog-podman-warning">
          <strong>Podman not found.</strong>
          IENC (S-57) and RNC (BSB raster) chart conversion is not available.
          <a href="https://podman.io/docs/installation" target="_blank" rel="noopener">Install Podman</a>
          to enable chart conversion.
        </div>`;
    } else {
      warningEl.innerHTML = '';
    }
  }
}

async function refreshUpdateBadge() {
  try {
    const response = await fetch(`${CATALOG_API_BASE}/catalog-updates`);
    if (!response.ok) return;
    catalogUpdates = await response.json();

    const badge = document.getElementById('catalogBadge');
    if (badge) {
      if (catalogUpdates.length > 0) {
        badge.textContent = catalogUpdates.length;
        badge.style.display = 'inline-flex';
      } else {
        badge.style.display = 'none';
      }
    }
  } catch (_e) {
    // Ignore badge refresh errors
  }
}

function renderFilterBar() {
  const filterBar = document.getElementById('catalogFilterBar');
  if (!filterBar) return;

  const categories = [
    { key: 'all', label: 'All' },
    { key: 'mbtiles', label: 'MBTiles' },
    { key: 'rnc', label: 'RNC' },
    { key: 'ienc', label: 'IENC' },
    { key: 'general', label: 'General' }
  ];

  const counts = { all: catalogRegistry.length };
  catalogRegistry.forEach((c) => {
    counts[c.category] = (counts[c.category] || 0) + 1;
  });

  filterBar.innerHTML = `
    <div class="category-filter">
      ${categories
        .map(
          (cat) => `
        <button class="category-filter-btn ${activeCategoryFilter === cat.key ? 'active' : ''}"
                onclick="setCatalogFilter('${cat.key}')">
          ${cat.label}
          <span class="category-count">${counts[cat.key] || 0}</span>
        </button>
      `
        )
        .join('')}
    </div>
  `;
}

window.setCatalogFilter = function (category) {
  activeCategoryFilter = category;
  renderFilterBar();
  renderCatalogList();
};

function renderCatalogList() {
  const listEl = document.getElementById('catalogList');
  if (!listEl) return;

  const filtered =
    activeCategoryFilter === 'all'
      ? catalogRegistry
      : catalogRegistry.filter((c) => c.category === activeCategoryFilter);

  if (filtered.length === 0) {
    listEl.innerHTML = `<div class="catalog-empty">No catalogs in this category.</div>`;
    return;
  }

  listEl.innerHTML = filtered.map((catalog) => renderCatalogCard(catalog)).join('');
}

function renderCatalogCard(catalog) {
  const isExpanded = expandedCatalogs.has(catalog.file);
  const chartCountText = catalog.chartCount !== null ? `${catalog.chartCount} charts` : '';

  return `
    <div class="catalog-card ${isExpanded ? 'expanded' : ''}" id="catalog-card-${escapeId(catalog.file)}">
      <div class="catalog-card-header" onclick="toggleCatalog('${escapeAttr(catalog.file)}')">
        <div class="catalog-expand-icon">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
            <path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/>
          </svg>
        </div>
        <div class="catalog-card-title">${escapeHtml(catalog.label)}</div>
        <div class="catalog-card-meta">
          <span class="catalog-chart-count">${chartCountText}</span>
          <span class="format-badge ${catalog.category}">${categoryLabel(catalog.category)}</span>
        </div>
      </div>
      <div class="catalog-card-body" id="catalog-body-${escapeId(catalog.file)}">
        ${isExpanded && catalogChartData[catalog.file] ? renderChartList(catalog.file) : ''}
      </div>
    </div>
  `;
}

window.toggleCatalog = async function (catalogFile) {
  if (expandedCatalogs.has(catalogFile)) {
    expandedCatalogs.delete(catalogFile);
    renderCatalogList();
    return;
  }

  expandedCatalogs.add(catalogFile);
  renderCatalogList();

  // Load chart data if not already cached
  if (!catalogChartData[catalogFile]) {
    const bodyEl = document.getElementById(`catalog-body-${escapeId(catalogFile)}`);
    if (bodyEl) {
      bodyEl.innerHTML = `<div class="catalog-loading"><div class="spinner"></div><div>Loading charts...</div></div>`;
    }

    try {
      const response = await fetch(`${CATALOG_API_BASE}/catalog/${encodeURIComponent(catalogFile)}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      catalogChartData[catalogFile] = data;

      // Update chart count in registry
      const regEntry = catalogRegistry.find((r) => r.file === catalogFile);
      if (regEntry && data.charts) {
        regEntry.chartCount = data.charts.length;
      }
    } catch (error) {
      console.error(`Failed to load catalog ${catalogFile}:`, error);
      const bodyEl = document.getElementById(`catalog-body-${escapeId(catalogFile)}`);
      if (bodyEl) {
        bodyEl.innerHTML = `<div class="catalog-error">Failed to load catalog. Check your network connection.</div>`;
      }
      return;
    }
  }

  // Re-render to show charts
  renderCatalogList();
};

function renderChartList(catalogFile) {
  const data = catalogChartData[catalogFile];
  if (!data || !data.charts || data.charts.length === 0) {
    return `<div class="catalog-empty">No charts in this catalog.</div>`;
  }

  return data.charts
    .map((chart) => {
      const cls = chart.urlClassification || { supported: false, format: 'unknown', label: 'Unknown' };
      const isConverting = !!catalogConverting[chart.number];
      const isInstalled = chart.installed && !isConverting;
      const hasUpdate =
        isInstalled &&
        catalogUpdates.some((u) => u.chartNumber === chart.number);
      const isDownloading = !!catalogDownloadJobs[chart.number];
      const date = chart.zipfile_datetime_iso8601
        ? new Date(chart.zipfile_datetime_iso8601).toLocaleDateString()
        : '';

      let actionHtml = '';
      if (isDownloading) {
        actionHtml = `
          <div class="catalog-download-progress" id="catalog-progress-${escapeId(chart.number)}">
            <div class="progress-bar"><div class="progress-fill" style="width: 0%"></div></div>
            <span>Downloading...</span>
          </div>`;
      } else if (isConverting) {
        const progress = catalogConversionProgress[chart.number];
        const progressMsg = progress ? progress.message : 'Converting S-57 to vector tiles...';
        actionHtml = `
          <div class="catalog-download-progress">
            <div class="spinner" style="width:16px;height:16px;border-width:2px;"></div>
            <span>${escapeHtml(progressMsg)}</span>
            <button class="btn-catalog-log" onclick="showConversionLog('${escapeAttr(chart.number)}')">Logs</button>
          </div>`;
      } else if (hasUpdate) {
        actionHtml = `
          <span class="update-badge" onclick="downloadCatalogChart('${escapeAttr(chart.number)}', '${escapeAttr(catalogFile)}', '${escapeAttr(chart.zipfile_location)}', '${escapeAttr(chart.zipfile_datetime_iso8601)}')">
            Update available
          </span>`;
      } else if (isInstalled) {
        actionHtml = `<span class="installed-badge">Installed</span>`;
      } else if (cls.supported) {
        const needsConversion = cls.format === 's57-zip' || cls.format === 'rnc-zip';
        const btnLabel = needsConversion ? 'Download & Convert' : 'Download';
        const btnDisabled = needsConversion && !s57PodmanAvailable ? 'disabled' : '';
        const podmanHint = needsConversion && !s57PodmanAvailable
          ? `<span class="format-badge unsupported">Podman required</span>`
          : '';

        actionHtml = `
          ${podmanHint}
          <select class="catalog-folder-select" id="catalog-folder-${escapeId(chart.number)}">
            ${catalogFolders.map((f) => `<option value="${escapeAttr(f)}">${escapeHtml(f)}</option>`).join('')}
          </select>
          <button class="btn-catalog-download" ${btnDisabled}
                  onclick="downloadCatalogChart('${escapeAttr(chart.number)}', '${escapeAttr(catalogFile)}', '${escapeAttr(chart.zipfile_location)}', '${escapeAttr(chart.zipfile_datetime_iso8601)}')">
            ${btnLabel}
          </button>`;
      } else {
        actionHtml = `<span class="format-badge unsupported">${escapeHtml(cls.label)}</span>`;
      }

      return `
        <div class="catalog-chart-row ${cls.supported || isInstalled ? '' : 'unsupported'}">
          <div class="chart-row-info">
            <div class="chart-row-number">${escapeHtml(chart.number)}</div>
            ${chart.title !== chart.number ? `<div class="chart-row-title">${escapeHtml(chart.title)}</div>` : ''}
          </div>
          <div class="chart-row-date">${date}</div>
          <div class="chart-row-actions">
            ${actionHtml}
          </div>
        </div>`;
    })
    .join('');
}

window.downloadCatalogChart = async function (chartNumber, catalogFile, url, zipfileDatetime) {
  const folderSelect = document.getElementById(`catalog-folder-${escapeId(chartNumber)}`);
  const targetFolder = folderSelect ? folderSelect.value : '/';

  try {
    const response = await fetch(`${CATALOG_API_BASE}/catalog/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url,
        chartNumber,
        catalogFile,
        zipfileDatetime,
        targetFolder
      })
    });

    const result = await response.json();
    if (result.success) {
      catalogDownloadJobs[chartNumber] = result.jobId;
      // Re-render the expanded catalog (shows downloading state)
      renderCatalogList();
    } else {
      alert(`Download failed: ${result.error}`);
    }
  } catch (error) {
    console.error('Failed to start catalog download:', error);
    alert('Failed to start download. Check your network connection.');
  }
};

async function pollCatalogDownloads() {
  const activeCharts = Object.keys(catalogDownloadJobs);
  if (activeCharts.length === 0) return;

  try {
    const response = await fetch(`${CATALOG_API_BASE}/download-jobs`);
    if (!response.ok) return;
    const jobs = await response.json();

    for (const chartNumber of activeCharts) {
      const jobId = catalogDownloadJobs[chartNumber];
      const job = jobs.find((j) => j.id === jobId);

      if (!job) continue;

      const progressEl = document.getElementById(`catalog-progress-${escapeId(chartNumber)}`);

      if (job.status === 'completed') {
        // For S-57, the download completes but conversion runs after.
        // Show "Converting..." briefly, then refresh on next poll cycle.
        if (progressEl) {
          const textEl = progressEl.querySelector('span');
          if (textEl && job.url && job.url.endsWith('.zip')) {
            textEl.textContent = 'Converting S-57...';
          }
        }
        delete catalogDownloadJobs[chartNumber];
        // Refresh installed info and re-render
        await loadCatalogRegistry();
        await loadFolders();
        renderCatalogList();
      } else if (job.status === 'failed') {
        delete catalogDownloadJobs[chartNumber];
        renderCatalogList();
      } else if (progressEl) {
        const fillEl = progressEl.querySelector('.progress-fill');
        const textEl = progressEl.querySelector('span');
        if (fillEl) fillEl.style.width = `${job.progress || 0}%`;
        if (textEl) {
          if (job.status === 'extracting') {
            textEl.textContent = 'Extracting...';
          } else if (job.progress > 0) {
            textEl.textContent = `Downloading ${job.progress}%`;
          } else {
            textEl.textContent = 'Downloading...';
          }
        }
      }
    }
  } catch (_e) {
    // Ignore poll errors
  }
}

async function pollConversions() {
  // If there are active conversions, refresh registry and progress
  if (Object.keys(catalogConverting).length === 0) return;

  try {
    // Fetch conversion progress (s57-tiler status)
    const statusResp = await fetch(`${CATALOG_API_BASE}/catalog-s57-status`);
    if (statusResp.ok) {
      const statusData = await statusResp.json();
      catalogConversionProgress = statusData.conversions || {};
    }

    // Fetch registry to check if conversions finished
    const regResp = await fetch(`${CATALOG_API_BASE}/catalog-registry`);
    if (regResp.ok) {
      const regData = await regResp.json();
      const prevConverting = { ...catalogConverting };
      catalogConverting = regData.converting || {};
      catalogInstalled = regData.installed || {};

      // If any conversion just finished, invalidate cached catalog data and refresh
      const justFinished = Object.keys(prevConverting).filter((k) => !catalogConverting[k]);
      if (justFinished.length > 0) {
        // Clear cached chart data for catalogs that had conversions finish
        // so the next expand re-fetches with updated installed status
        for (const chartNum of justFinished) {
          const install = catalogInstalled[chartNum];
          if (install && install.catalogFile) {
            delete catalogChartData[install.catalogFile];
          }
        }
        await loadFolders();
      }
    }

    // Always re-render to update progress text
    renderCatalogList();
  } catch (_e) {
    // ignore
  }
}

// Conversion log modal
let logPollInterval = null;

window.showConversionLog = async function (chartNumber) {
  // Create modal
  const modal = document.createElement('div');
  modal.id = 'conversionLogModal';
  modal.className = 'catalog-log-modal-overlay';
  modal.onclick = function (e) {
    if (e.target === modal) closeConversionLog();
  };
  modal.innerHTML = `
    <div class="catalog-log-modal">
      <div class="catalog-log-header">
        <h3>Conversion Log: ${escapeHtml(chartNumber)}</h3>
        <button class="btn btn-sm btn-secondary" onclick="closeConversionLog()">Close</button>
      </div>
      <pre class="catalog-log-content" id="conversionLogContent">Loading...</pre>
    </div>
  `;
  document.body.appendChild(modal);

  // Poll log
  async function refreshLog() {
    try {
      const resp = await fetch(
        `${CATALOG_API_BASE}/catalog-s57-log/${encodeURIComponent(chartNumber)}`
      );
      if (!resp.ok) return;
      const data = await resp.json();
      const logEl = document.getElementById('conversionLogContent');
      if (logEl && data.log) {
        logEl.textContent = data.log.join('\n');
        logEl.scrollTop = logEl.scrollHeight;
      }
      // Stop polling if conversion is done
      if (!data.status) {
        clearInterval(logPollInterval);
        logPollInterval = null;
      }
    } catch (_e) {
      // ignore
    }
  }

  await refreshLog();
  logPollInterval = setInterval(refreshLog, 2000);
};

window.closeConversionLog = function () {
  if (logPollInterval) {
    clearInterval(logPollInterval);
    logPollInterval = null;
  }
  const modal = document.getElementById('conversionLogModal');
  if (modal) modal.remove();
};

// Utility functions

function categoryLabel(category) {
  const labels = {
    mbtiles: 'MBTiles',
    rnc: 'RNC',
    ienc: 'IENC',
    general: 'General'
  };
  return labels[category] || category;
}

function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function escapeAttr(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/'/g, '&#39;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeId(str) {
  if (!str) return '';
  return str.replace(/[^a-zA-Z0-9_-]/g, '_');
}
