// Chart Catalog tab — browse and download charts from chartcatalogs.github.io

const CATALOG_API_BASE = '/plugins/signalk-charts-provider-simple';

type CatalogCategory = 'mbtiles' | 'rnc' | 'ienc' | 'general';

interface CatalogRegistryEntry {
  file: string;
  label: string;
  category: CatalogCategory;
  chartCount: number | null;
}

interface UrlClassification {
  supported: boolean;
  format: string;
  label: string;
}

interface CatalogChart {
  number: string;
  title: string;
  zipfile_location: string;
  zipfile_datetime_iso8601: string;
  installed?: boolean;
  urlClassification?: UrlClassification;
}

interface CatalogData {
  charts?: CatalogChart[];
}

interface CatalogInstall {
  catalogFile: string;
}

interface CatalogRegistryResponse {
  registry?: CatalogRegistryEntry[];
  installed?: Record<string, CatalogInstall>;
  converting?: Record<string, boolean>;
}

interface LocalChartsResponse {
  folders?: string[];
}

interface S57StatusCatalogResponse {
  podmanAvailable?: boolean;
  conversions?: Record<string, ConversionProgress>;
}

interface ConversionProgress {
  status: string;
  message?: string;
  log?: string[];
}

interface CatalogUpdate {
  chartNumber: string;
}

interface DownloadJobLite {
  id: string;
  status: 'queued' | 'downloading' | 'extracting' | 'completed' | 'failed';
  progress?: number;
  downloadedBytes?: number;
  url?: string;
  error?: string;
}

interface CatalogDownloadResponse {
  success: boolean;
  jobId?: string;
  error?: string;
}

interface S57LogResponse {
  log?: string[];
  status?: string;
}

let catalogInitialized = false;
let catalogRegistry: CatalogRegistryEntry[] = [];
let catalogInstalled: Record<string, CatalogInstall> = {};
let catalogUpdates: CatalogUpdate[] = [];
let activeCategoryFilter: CatalogCategory | 'all' = 'all';
const expandedCatalogs = new Set<string>();
const catalogChartData: Record<string, CatalogData> = {};
let catalogFolders: string[] = ['/'];
const catalogDownloadJobs: Record<string, string> = {};
let catalogConverting: Record<string, boolean> = {};
let catalogConversionProgress: Record<string, ConversionProgress> = {};
const catalogConversionErrors: Record<string, string> = {};
// Tracks chart numbers whose error the user has dismissed; keeps poll
// from silently re-injecting the same error on the next tick.
const dismissedConversionErrors = new Set<string>();
let s57PodmanAvailable = false;

let catalogDownloadPollInterval: ReturnType<typeof setInterval> | null = null;
let catalogConversionPollInterval: ReturnType<typeof setInterval> | null = null;
let catalogUpdateBadgeInterval: ReturnType<typeof setInterval> | null = null;

// Cross-tab notification: Manage Charts dispatches `charts-changed` after
// any operation that moves the on-disk chart inventory (delete, move,
// rename). Drop our cached chart data and re-fetch the registry so the
// "Installed" badges reflect server state without a hard browser reload.
//
// Catalog rows the user had expanded need their chart data re-fetched
// too — otherwise renderCatalogCard sees `expandedCatalogs.has(file)`
// is true but `catalogChartData[file]` is missing and renders an empty
// body. Snapshot the expanded set, clear the cache, then re-fetch in
// parallel for those catalogs.
document.addEventListener('charts-changed', () => {
  if (!catalogInitialized) {
    return;
  }
  const wereExpanded = Array.from(expandedCatalogs);
  for (const key of Object.keys(catalogChartData)) {
    delete catalogChartData[key];
  }
  void (async () => {
    await loadCatalogRegistry();
    await Promise.all(
      wereExpanded.map(async (catalogFile) => {
        try {
          const resp = await fetch(
            `${CATALOG_API_BASE}/catalog/${encodeURIComponent(catalogFile)}`
          );
          if (resp.ok) {
            catalogChartData[catalogFile] = (await resp.json()) as CatalogData;
          }
        } catch {
          // Network blip — leave the entry empty; the user can
          // collapse/expand to retry.
        }
      })
    );
    renderCatalogList();
  })();
});

window.handleCatalogTabActive = function (): void {
  if (!catalogInitialized) {
    void initCatalogTab();
  } else {
    void refreshUpdateBadge();
  }
};

async function initCatalogTab(): Promise<void> {
  catalogInitialized = true;
  const output = document.getElementById('catalogOutput');
  if (!output) {
    return;
  }

  output.innerHTML = `
    <div class="catalog-container">
      <div class="catalog-source-note">
        Chart data sourced from
        <a href="https://chartcatalogs.github.io/" target="_blank" rel="noopener">chartcatalogs.github.io</a>
        &mdash; a community-maintained catalog. Download links may be outdated or unavailable.
        If a download fails, please report it to the
        <a href="https://github.com/chartcatalogs/catalogs/issues" target="_blank" rel="noopener">catalog issue tracker</a>.
      </div>
      <div id="catalogPodmanWarning"></div>
      <div id="catalogFilterBar"></div>
      <div id="catalogList">
        <div class="catalog-loading">
          <div class="spinner"></div>
          <div>Loading catalog registry...</div>
        </div>
      </div>
    </div>
  `;

  await loadCatalogRegistry();
  await loadFolders();
  await checkS57Status();
  await refreshUpdateBadge();

  // Wire delegated click handlers — every action that previously used
  // inline `onclick="X('${catalogEscapeAttr(value)}')"` now reads a data-*
  // attribute. Inline-JS-context interpolation is the XSS class the
  // PR-B (#74) refactor closed; same fix applied here.
  wireCatalogClickHandlers();

  // Poll for active download jobs and conversions
  if (catalogDownloadPollInterval !== null) {
    clearInterval(catalogDownloadPollInterval);
  }
  catalogDownloadPollInterval = setInterval(() => {
    void pollCatalogDownloads();
  }, 2000);

  if (catalogConversionPollInterval !== null) {
    clearInterval(catalogConversionPollInterval);
  }
  catalogConversionPollInterval = setInterval(() => {
    void pollConversions();
  }, 3000);

  if (catalogUpdateBadgeInterval !== null) {
    clearInterval(catalogUpdateBadgeInterval);
  }
  catalogUpdateBadgeInterval = setInterval(() => {
    void refreshUpdateBadge();
  }, 60000);
}

function wireCatalogClickHandlers(): void {
  const list = document.getElementById('catalogList');
  const filterBar = document.getElementById('catalogFilterBar');

  if (filterBar && !filterBar.dataset['catalogHandlerWired']) {
    filterBar.addEventListener('click', (ev) => {
      const target = (ev.target as HTMLElement | null)?.closest<HTMLElement>(
        '[data-catalog-filter]'
      );
      if (!target) {
        return;
      }
      const cat = target.dataset['catalogFilter'] as CatalogCategory | 'all' | undefined;
      if (cat) {
        setCatalogFilter(cat);
      }
    });
    filterBar.dataset['catalogHandlerWired'] = '1';
  }

  if (list && !list.dataset['catalogHandlerWired']) {
    list.addEventListener('click', (ev) => {
      const target = ev.target as HTMLElement | null;
      if (!target) {
        return;
      }

      const expand = target.closest<HTMLElement>('[data-catalog-toggle]');
      if (expand) {
        const file = expand.dataset['catalogToggle'];
        if (file) {
          void toggleCatalog(file);
        }
        return;
      }

      const dl = target.closest<HTMLElement>('[data-catalog-download]');
      if (dl) {
        const chartNumber = dl.dataset['catalogDownload'];
        const catalogFile = dl.dataset['catalogFile'];
        const url = dl.dataset['catalogUrl'];
        const datetime = dl.dataset['catalogDatetime'];
        if (chartNumber && catalogFile && url && datetime) {
          void downloadCatalogChart(chartNumber, catalogFile, url, datetime);
        }
        return;
      }

      const log = target.closest<HTMLElement>('[data-catalog-log]');
      if (log) {
        const chartNumber = log.dataset['catalogLog'];
        if (chartNumber) {
          void showConversionLog(chartNumber);
        }
        return;
      }

      const dismiss = target.closest<HTMLElement>('[data-catalog-dismiss]');
      if (dismiss) {
        const chartNumber = dismiss.dataset['catalogDismiss'];
        if (chartNumber) {
          dismissConversionError(chartNumber);
        }
        return;
      }
    });
    list.dataset['catalogHandlerWired'] = '1';
  }
}

async function loadCatalogRegistry(): Promise<void> {
  try {
    const response = await fetch(`${CATALOG_API_BASE}/catalog-registry`);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const data = (await response.json()) as CatalogRegistryResponse;
    catalogRegistry = data.registry ?? [];
    catalogInstalled = data.installed ?? {};
    catalogConverting = data.converting ?? {};
    renderFilterBar();
    if (catalogRegistry.length === 0) {
      const listEl = document.getElementById('catalogList');
      if (listEl) {
        listEl.innerHTML = `<div class="catalog-error">No catalogs available. The catalog index could not be fetched — you may be offline. Previously cached catalogs will appear after reconnecting.</div>`;
      }
    } else {
      renderCatalogList();
    }
  } catch (error) {
    console.error('Failed to load catalog registry:', error);
    const listEl = document.getElementById('catalogList');
    if (listEl) {
      listEl.innerHTML = `<div class="catalog-error">Failed to load catalog registry. You may be offline.</div>`;
    }
  }
}

async function loadFolders(): Promise<void> {
  try {
    const response = await fetch(`${CATALOG_API_BASE}/local-charts`);
    if (!response.ok) {
      return;
    }
    const data = (await response.json()) as LocalChartsResponse;
    catalogFolders = data.folders ?? ['/'];
  } catch {
    // Ignore folder load errors
  }
}

async function checkS57Status(): Promise<void> {
  try {
    const response = await fetch(`${CATALOG_API_BASE}/catalog-s57-status`);
    if (!response.ok) {
      return;
    }
    const data = (await response.json()) as S57StatusCatalogResponse;
    s57PodmanAvailable = data.podmanAvailable ?? false;
  } catch {
    s57PodmanAvailable = false;
  }

  const warningEl = document.getElementById('catalogPodmanWarning');
  if (warningEl) {
    if (!s57PodmanAvailable) {
      warningEl.innerHTML = `
        <div class="catalog-podman-warning">
          <strong>Container runtime not reachable.</strong>
          IENC (S-57) and RNC (BSB raster) chart conversion needs a Docker- or Podman-compatible socket.
          <a href="https://github.com/dirkwa/signalk-charts-provider-simple/blob/main/docs/running-in-docker.md" target="_blank" rel="noopener">See setup notes</a>.
        </div>`;
    } else {
      warningEl.innerHTML = '';
    }
  }
}

async function refreshUpdateBadge(): Promise<void> {
  try {
    const response = await fetch(`${CATALOG_API_BASE}/catalog-updates`);
    if (!response.ok) {
      return;
    }
    catalogUpdates = (await response.json()) as CatalogUpdate[];

    const badge = document.getElementById('catalogBadge');
    if (badge) {
      if (catalogUpdates.length > 0) {
        badge.textContent = String(catalogUpdates.length);
        badge.style.display = 'inline-flex';
      } else {
        badge.style.display = 'none';
      }
    }
  } catch {
    // Ignore badge refresh errors
  }
}

function renderFilterBar(): void {
  const filterBar = document.getElementById('catalogFilterBar');
  if (!filterBar) {
    return;
  }

  const categories: { key: CatalogCategory | 'all'; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'mbtiles', label: 'MBTiles' },
    { key: 'rnc', label: 'RNC' },
    { key: 'ienc', label: 'IENC' },
    { key: 'general', label: 'General' }
  ];

  const counts: Record<string, number> = { all: catalogRegistry.length };
  catalogRegistry.forEach((c) => {
    counts[c.category] = (counts[c.category] ?? 0) + 1;
  });

  filterBar.innerHTML = `
    <div class="category-filter">
      ${categories
        .map(
          (cat) => `
        <button class="category-filter-btn ${activeCategoryFilter === cat.key ? 'active' : ''}"
                data-catalog-filter="${catalogEscapeAttr(cat.key)}">
          ${catalogEscapeHtml(cat.label)}
          <span class="category-count">${counts[cat.key] ?? 0}</span>
        </button>
      `
        )
        .join('')}
    </div>
  `;
}

function setCatalogFilter(category: CatalogCategory | 'all'): void {
  activeCategoryFilter = category;
  renderFilterBar();
  renderCatalogList();
}

function renderCatalogList(): void {
  const listEl = document.getElementById('catalogList');
  if (!listEl) {
    return;
  }

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

function renderCatalogCard(catalog: CatalogRegistryEntry): string {
  const isExpanded = expandedCatalogs.has(catalog.file);
  const chartCountText = catalog.chartCount !== null ? `${catalog.chartCount} charts` : '';

  return `
    <div class="catalog-card ${isExpanded ? 'expanded' : ''}" id="catalog-card-${catalogEscapeId(catalog.file)}">
      <div class="catalog-card-header" data-catalog-toggle="${catalogEscapeAttr(catalog.file)}">
        <div class="catalog-expand-icon">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
            <path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/>
          </svg>
        </div>
        <div class="catalog-card-title">${catalogEscapeHtml(catalog.label)}</div>
        <div class="catalog-card-meta">
          <span class="catalog-chart-count">${catalogEscapeHtml(chartCountText)}</span>
          <span class="format-badge ${catalogEscapeAttr(catalog.category)}">${catalogEscapeHtml(categoryLabel(catalog.category))}</span>
        </div>
      </div>
      <div class="catalog-card-body" id="catalog-body-${catalogEscapeId(catalog.file)}">
        ${isExpanded && catalogChartData[catalog.file] ? renderChartList(catalog.file) : ''}
      </div>
    </div>
  `;
}

async function toggleCatalog(catalogFile: string): Promise<void> {
  if (expandedCatalogs.has(catalogFile)) {
    expandedCatalogs.delete(catalogFile);
    renderCatalogList();
    return;
  }

  expandedCatalogs.add(catalogFile);
  renderCatalogList();

  // Load chart data if not already cached
  if (!catalogChartData[catalogFile]) {
    const bodyEl = document.getElementById(`catalog-body-${catalogEscapeId(catalogFile)}`);
    if (bodyEl) {
      bodyEl.innerHTML = `<div class="catalog-loading"><div class="spinner"></div><div>Loading charts...</div></div>`;
    }

    try {
      const response = await fetch(
        `${CATALOG_API_BASE}/catalog/${encodeURIComponent(catalogFile)}`
      );
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const data = (await response.json()) as CatalogData;
      catalogChartData[catalogFile] = data;

      // Update chart count in registry
      const regEntry = catalogRegistry.find((r) => r.file === catalogFile);
      if (regEntry && data.charts) {
        regEntry.chartCount = data.charts.length;
      }
    } catch (error) {
      console.error(`Failed to load catalog ${catalogFile}:`, error);
      const bodyEl = document.getElementById(`catalog-body-${catalogEscapeId(catalogFile)}`);
      if (bodyEl) {
        bodyEl.innerHTML = `<div class="catalog-error">Failed to load catalog. Check your network connection.</div>`;
      }
      return;
    }
  }

  // Re-render to show charts
  renderCatalogList();
}

function renderChartList(catalogFile: string): string {
  const data = catalogChartData[catalogFile];
  if (!data?.charts || data.charts.length === 0) {
    return `<div class="catalog-empty">No charts in this catalog.</div>`;
  }

  return data.charts
    .map((chart) => {
      const cls = chart.urlClassification ?? {
        supported: false,
        format: 'unknown',
        label: 'Unknown'
      };
      const isConverting = catalogConverting[chart.number];
      const conversionError = catalogConversionErrors[chart.number];
      const isInstalled = chart.installed && !isConverting;
      const hasUpdate =
        isInstalled && catalogUpdates.some((u) => u.chartNumber === chart.number);
      const isDownloading = catalogDownloadJobs[chart.number] !== undefined;
      const date = chart.zipfile_datetime_iso8601
        ? new Date(chart.zipfile_datetime_iso8601).toLocaleDateString()
        : '';

      let actionHtml = '';
      if (conversionError) {
        actionHtml = `
          <div class="catalog-conversion-error">
            <span class="conversion-error-text">${catalogEscapeHtml(conversionError)}</span>
            <button class="btn-catalog-log" data-catalog-log="${catalogEscapeAttr(chart.number)}">Logs</button>
            <button class="btn-catalog-dismiss" data-catalog-dismiss="${catalogEscapeAttr(chart.number)}">Dismiss</button>
          </div>`;
      } else if (isDownloading) {
        actionHtml = `
          <div class="catalog-download-progress" id="catalog-progress-${catalogEscapeId(chart.number)}">
            <div class="progress-bar"><div class="progress-fill" style="width: 0%"></div></div>
            <span>Downloading...</span>
          </div>`;
      } else if (isConverting) {
        const progress = catalogConversionProgress[chart.number];
        const progressMsg = progress?.message ?? 'Converting S-57 to vector tiles...';
        actionHtml = `
          <div class="catalog-conversion-progress" id="catalog-conversion-${catalogEscapeId(chart.number)}">
            <div class="spinner" style="width:16px;height:16px;border-width:2px;"></div>
            <span>${catalogEscapeHtml(progressMsg)}</span>
            <button class="btn-catalog-log" data-catalog-log="${catalogEscapeAttr(chart.number)}">Logs</button>
          </div>`;
      } else if (hasUpdate) {
        actionHtml = `
          <span class="update-badge"
                data-catalog-download="${catalogEscapeAttr(chart.number)}"
                data-catalog-file="${catalogEscapeAttr(catalogFile)}"
                data-catalog-url="${catalogEscapeAttr(chart.zipfile_location)}"
                data-catalog-datetime="${catalogEscapeAttr(chart.zipfile_datetime_iso8601)}">
            Update available
          </span>`;
      } else if (isInstalled) {
        actionHtml = `<span class="installed-badge">Installed</span>`;
      } else if (cls.supported) {
        const needsConversion = ['s57-zip', 'rnc-zip', 'gshhg', 'pilot-tar', 'shp-basemap'].includes(
          cls.format
        );
        const showZoomSelector =
          needsConversion && !['gshhg', 'pilot-tar', 'shp-basemap'].includes(cls.format);
        const btnLabel = needsConversion ? 'Download & Convert' : 'Download';
        const btnDisabled = needsConversion && !s57PodmanAvailable ? 'disabled' : '';
        const podmanHint =
          needsConversion && !s57PodmanAvailable
            ? `<span class="format-badge unsupported">Container runtime required</span>`
            : '';

        const zoomHtml =
          showZoomSelector && s57PodmanAvailable
            ? `
          <span class="catalog-zoom-label">Zoom</span>
          <select class="catalog-zoom-select" id="catalog-minzoom-${catalogEscapeId(chart.number)}">
            ${[6, 7, 8, 9, 10, 11, 12]
              .map((z) => `<option value="${z}" ${z === 9 ? 'selected' : ''}>${z}</option>`)
              .join('')}
          </select>
          <span class="catalog-zoom-dash">-</span>
          <select class="catalog-zoom-select" id="catalog-maxzoom-${catalogEscapeId(chart.number)}">
            ${[12, 13, 14, 15, 16, 17, 18]
              .map((z) => `<option value="${z}" ${z === 16 ? 'selected' : ''}>${z}</option>`)
              .join('')}
          </select>
        `
            : '';

        actionHtml = `
          ${podmanHint}
          ${zoomHtml}
          <select class="catalog-folder-select" id="catalog-folder-${catalogEscapeId(chart.number)}">
            ${catalogFolders.map((f) => `<option value="${catalogEscapeAttr(f)}">${catalogEscapeHtml(f)}</option>`).join('')}
          </select>
          <button class="btn-catalog-download" ${btnDisabled}
                  data-catalog-download="${catalogEscapeAttr(chart.number)}"
                  data-catalog-file="${catalogEscapeAttr(catalogFile)}"
                  data-catalog-url="${catalogEscapeAttr(chart.zipfile_location)}"
                  data-catalog-datetime="${catalogEscapeAttr(chart.zipfile_datetime_iso8601)}">
            ${catalogEscapeHtml(btnLabel)}
          </button>`;
      } else {
        actionHtml = `<span class="format-badge unsupported">${catalogEscapeHtml(cls.label)}</span>`;
      }

      return `
        <div class="catalog-chart-row ${cls.supported || isInstalled ? '' : 'unsupported'}">
          <div class="chart-row-info">
            <div class="chart-row-number">${catalogEscapeHtml(chart.number)}</div>
            ${chart.title !== chart.number ? `<div class="chart-row-title">${catalogEscapeHtml(chart.title)}</div>` : ''}
          </div>
          <div class="chart-row-date">${catalogEscapeHtml(date)}</div>
          <div class="chart-row-actions">
            ${actionHtml}
          </div>
        </div>`;
    })
    .join('');
}

async function downloadCatalogChart(
  chartNumber: string,
  catalogFile: string,
  url: string,
  zipfileDatetime: string
): Promise<void> {
  const folderSelect = document.getElementById(
    `catalog-folder-${catalogEscapeId(chartNumber)}`
  ) as HTMLSelectElement | null;
  const targetFolder = folderSelect ? folderSelect.value : '/';

  const minzoomSelect = document.getElementById(
    `catalog-minzoom-${catalogEscapeId(chartNumber)}`
  ) as HTMLSelectElement | null;
  const maxzoomSelect = document.getElementById(
    `catalog-maxzoom-${catalogEscapeId(chartNumber)}`
  ) as HTMLSelectElement | null;
  const minzoom = minzoomSelect ? parseInt(minzoomSelect.value, 10) : undefined;
  const maxzoom = maxzoomSelect ? parseInt(maxzoomSelect.value, 10) : undefined;

  try {
    const response = await fetch(`${CATALOG_API_BASE}/catalog/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url,
        chartNumber,
        catalogFile,
        zipfileDatetime,
        targetFolder,
        minzoom,
        maxzoom
      })
    });
    if (!response.ok) {
      // Server may have returned an error JSON; try to read it for the alert.
      let errorText: string;
      try {
        const body = (await response.json()) as { error?: string };
        errorText = body.error ?? `HTTP ${response.status}`;
      } catch {
        errorText = `HTTP ${response.status}`;
      }
      alert(`Download failed: ${errorText}`);
      return;
    }

    const result = (await response.json()) as CatalogDownloadResponse;
    if (result.success) {
      // GSHHG doesn't use DownloadManager — goes straight to converting
      if (result.jobId && !result.jobId.startsWith('gshhg-')) {
        catalogDownloadJobs[chartNumber] = result.jobId;
      } else {
        catalogConverting[chartNumber] = true;
      }
      renderCatalogList();
    } else {
      alert(`Download failed: ${result.error ?? ''}`);
    }
  } catch (error) {
    console.error('Failed to start catalog download:', error);
    alert('Failed to start download. Check your network connection.');
  }
}

function dismissConversionError(chartNumber: string): void {
  delete catalogConversionErrors[chartNumber];
  dismissedConversionErrors.add(chartNumber);
  renderCatalogList();
}

async function pollCatalogDownloads(): Promise<void> {
  const activeCharts = Object.keys(catalogDownloadJobs);
  if (activeCharts.length === 0) {
    return;
  }

  try {
    const response = await fetch(`${CATALOG_API_BASE}/download-jobs`);
    if (!response.ok) {
      return;
    }
    const jobs = (await response.json()) as DownloadJobLite[];

    for (const chartNumber of activeCharts) {
      const jobId = catalogDownloadJobs[chartNumber];
      const job = jobs.find((j) => j.id === jobId);
      if (!job) {
        continue;
      }

      const progressEl = document.getElementById(`catalog-progress-${catalogEscapeId(chartNumber)}`);

      if (job.status === 'completed') {
        // For S-57, the download completes but conversion runs after.
        if (progressEl) {
          const textEl = progressEl.querySelector<HTMLElement>('span');
          // Use URL pathname so query-stringed/CDN-signed URLs
          // (`…/chart.zip?token=abc`) still match.
          if (textEl && job.url) {
            let isZip = false;
            try {
              isZip = new URL(job.url).pathname.endsWith('.zip');
            } catch {
              isZip = job.url.endsWith('.zip');
            }
            if (isZip) {
              textEl.textContent = 'Converting S-57...';
            }
          }
        }
        delete catalogDownloadJobs[chartNumber];
        await loadCatalogRegistry();
        await loadFolders();
        // Re-fetch chart data for catalogs containing this chart so "Installed" shows
        const install = catalogInstalled[chartNumber];
        if (install?.catalogFile) {
          try {
            const catFile = install.catalogFile;
            const resp = await fetch(
              `${CATALOG_API_BASE}/catalog/${encodeURIComponent(catFile)}`
            );
            if (resp.ok) {
              catalogChartData[catFile] = (await resp.json()) as CatalogData;
            }
          } catch {
            // ignore, will re-fetch on next expand
          }
        }
        renderCatalogList();
      } else if (job.status === 'failed') {
        delete catalogDownloadJobs[chartNumber];
        if (progressEl) {
          const textEl = progressEl.querySelector<HTMLElement>('span');
          const fillEl = progressEl.querySelector<HTMLElement>('.progress-fill');
          if (fillEl) {
            fillEl.style.display = 'none';
          }
          if (textEl) {
            textEl.textContent = job.error ?? 'Download failed';
            textEl.style.color = 'var(--md-sys-color-error, #ef4444)';
          }
        }
        setTimeout(() => {
          renderCatalogList();
        }, 5000);
      } else if (progressEl) {
        const fillEl = progressEl.querySelector<HTMLElement>('.progress-fill');
        const textEl = progressEl.querySelector<HTMLElement>('span');
        const safeProgress = Number.isFinite(job.progress)
          ? Math.max(0, Math.min(100, job.progress ?? 0))
          : 0;
        if (fillEl) {
          fillEl.style.width = `${safeProgress}%`;
        }
        if (textEl) {
          if (job.status === 'extracting') {
            textEl.textContent = 'Extracting...';
          } else if (safeProgress > 0) {
            textEl.textContent = `Downloading ${safeProgress}%`;
          } else if ((job.downloadedBytes ?? 0) > 0) {
            const mb = ((job.downloadedBytes ?? 0) / (1024 * 1024)).toFixed(1);
            textEl.textContent = `Downloading ${mb} MB...`;
          } else {
            textEl.textContent = 'Downloading...';
          }
        }
      }
    }
  } catch {
    // Ignore poll errors
  }
}

/** Serialize the current converting+error key set so we can cheaply
 *  detect whether it changed since the last poll tick. Sorted to make
 *  {a,b} and {b,a} compare equal. */
function catalogActiveStateKey(): string {
  const conv = Object.keys(catalogConverting).sort().join(',');
  const err = Object.keys(catalogConversionErrors).sort().join(',');
  return `c=${conv}|e=${err}`;
}

let catalogPrevActiveStateKey = '';

function updateConversionMessagesInPlace(): void {
  for (const chartNumber of Object.keys(catalogConverting)) {
    const pill = document.getElementById(`catalog-conversion-${catalogEscapeId(chartNumber)}`);
    if (!pill) {
      continue;
    }
    const span = pill.querySelector<HTMLElement>('span');
    if (!span) {
      continue;
    }
    const progress = catalogConversionProgress[chartNumber];
    const msg = progress?.message ?? 'Converting S-57 to vector tiles...';
    if (span.textContent !== msg) {
      span.textContent = msg;
    }
  }
}

async function pollConversions(): Promise<void> {
  // Declared at function scope: a previous bug had it inside the
  // `if (regResp.ok)` block, then referenced it on the outer-scope
  // `hasActive` line, which silently threw a ReferenceError into the
  // catch and left the UI stuck at "Generating tiles: 100%".
  let justFinished: string[] = [];

  try {
    const statusResp = await fetch(`${CATALOG_API_BASE}/catalog-s57-status`);
    if (statusResp.ok) {
      const statusData = (await statusResp.json()) as S57StatusCatalogResponse;
      catalogConversionProgress = statusData.conversions ?? {};
    }

    const regResp = await fetch(`${CATALOG_API_BASE}/catalog-registry`);
    if (regResp.ok) {
      const regData = (await regResp.json()) as CatalogRegistryResponse;
      const prevConverting = { ...catalogConverting };
      catalogConverting = { ...(regData.converting ?? {}) };
      for (const key of Object.keys(catalogConversionProgress)) {
        const convStatus = catalogConversionProgress[key]?.status;
        if (
          convStatus === 'converting' ||
          convStatus === 'extracting' ||
          convStatus === 'pulling'
        ) {
          catalogConverting[key] = true;
          // A re-running conversion supersedes any prior dismissal.
          dismissedConversionErrors.delete(key);
        } else if (convStatus === 'failed' || convStatus === 'error') {
          if (!dismissedConversionErrors.has(key)) {
            catalogConversionErrors[key] =
              catalogConversionProgress[key]?.message ?? 'Conversion failed';
          }
        }
      }
      catalogInstalled = regData.installed ?? {};

      // If any conversion just finished, invalidate cached catalog data and refresh
      justFinished = Object.keys(prevConverting).filter((k) => !catalogConverting[k]);
      if (justFinished.length > 0) {
        for (const chartNum of justFinished) {
          const install = catalogInstalled[chartNum];
          if (install?.catalogFile) {
            delete catalogChartData[install.catalogFile];
          }
        }
        await loadFolders();
      }
    }

    // Decide between full re-render (action-column shape changed:
    // conversion started, finished, errored, or was dismissed) and
    // in-place message update (same set of charts converting; only
    // their progress message text differs).
    const activeStateKey = catalogActiveStateKey();
    const stateChanged =
      activeStateKey !== catalogPrevActiveStateKey || justFinished.length > 0;
    catalogPrevActiveStateKey = activeStateKey;

    const hasActive =
      Object.keys(catalogConverting).length > 0 ||
      Object.keys(catalogConversionErrors).length > 0 ||
      justFinished.length > 0;
    if (!hasActive) {
      return;
    }
    if (stateChanged) {
      renderCatalogList();
    } else {
      updateConversionMessagesInPlace();
    }
  } catch {
    // ignore
  }
}

// Conversion log modal
let logPollInterval: ReturnType<typeof setInterval> | null = null;

async function showConversionLog(chartNumber: string): Promise<void> {
  // Close any prior modal first — otherwise the second call would create
  // a duplicate `id="conversionLogModal"` (and `id="conversionLogContent"`)
  // and getElementById would target the older one, leaving the new
  // modal stuck on "Loading…".
  closeConversionLog();

  const modal = document.createElement('div');
  modal.id = 'conversionLogModal';
  modal.className = 'catalog-log-modal-overlay';
  modal.onclick = function (e: MouseEvent): void {
    if (e.target === modal) {
      closeConversionLog();
    }
  };
  modal.innerHTML = `
    <div class="catalog-log-modal">
      <div class="catalog-log-header">
        <h3>Conversion Log: ${catalogEscapeHtml(chartNumber)}</h3>
        <button class="btn btn-sm btn-secondary" data-conversion-log-close>Close</button>
      </div>
      <pre class="catalog-log-content" id="conversionLogContent">Loading...</pre>
    </div>
  `;
  modal
    .querySelector<HTMLButtonElement>('[data-conversion-log-close]')
    ?.addEventListener('click', closeConversionLog);
  document.body.appendChild(modal);

  async function refreshLog(): Promise<void> {
    try {
      const resp = await fetch(
        `${CATALOG_API_BASE}/catalog-s57-log/${encodeURIComponent(chartNumber)}`
      );
      if (!resp.ok) {
        return;
      }
      const data = (await resp.json()) as S57LogResponse;
      const logEl = document.getElementById('conversionLogContent');
      if (logEl && data.log) {
        logEl.textContent = data.log.join('\n');
        logEl.scrollTop = logEl.scrollHeight;
      }
      // Stop polling on any terminal state — completion (no status field)
      // or explicit failure. Without the failure branch the interval kept
      // firing until the user manually closed the modal.
      const isTerminal =
        !data.status || data.status === 'failed' || data.status === 'error';
      if (isTerminal) {
        if (logPollInterval !== null) {
          clearInterval(logPollInterval);
          logPollInterval = null;
        }
      }
    } catch {
      // ignore
    }
  }

  await refreshLog();
  // Defensive: clear any prior interval before installing a new one. A
  // previous showConversionLog() may have left a timer alive if the
  // modal was closed by external means.
  if (logPollInterval !== null) {
    clearInterval(logPollInterval);
  }
  logPollInterval = setInterval(() => {
    void refreshLog();
  }, 2000);
}

function closeConversionLog(): void {
  if (logPollInterval !== null) {
    clearInterval(logPollInterval);
    logPollInterval = null;
  }
  const modal = document.getElementById('conversionLogModal');
  if (modal) {
    modal.remove();
  }
}

function categoryLabel(category: CatalogCategory | string): string {
  const labels: Record<string, string> = {
    mbtiles: 'MBTiles',
    rnc: 'RNC',
    ienc: 'IENC',
    general: 'General'
  };
  return labels[category] ?? category;
}

function catalogEscapeHtml(str: string | undefined | null): string {
  if (!str) {
    return '';
  }
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function catalogEscapeAttr(str: string | undefined | null): string {
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

function catalogEscapeId(str: string | undefined | null): string {
  if (!str) {
    return '';
  }
  // Percent-encode then swap '%' for '__' so the result is collision-
  // free (a/b.json, a_b.json, and a/b/json no longer all map to a_b_json)
  // while still being a valid HTML id. Round-trip not needed; ids are
  // only used for getElementById lookups, never decoded.
  return encodeURIComponent(str).replace(/%/g, '__');
}

window.setCatalogFilter = setCatalogFilter;
window.toggleCatalog = toggleCatalog;
window.downloadCatalogChart = downloadCatalogChart;
window.dismissConversionError = dismissConversionError;
window.showConversionLog = showConversionLog;
window.closeConversionLog = closeConversionLog;
