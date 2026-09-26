// Chart Catalog tab — browse the merged chart catalog (chartcatalogs.github.io
// downloads plus curated online charts) and install charts from it

const CATALOG_API_BASE = '/plugins/signalk-charts-provider-simple';

type CatalogCategory = 'mbtiles' | 'rnc' | 'ienc' | 'general';

interface CatalogRegistryEntry {
  file: string;
  label: string;
  /** The download bucket (drives how a chart is fetched and converted). */
  category: CatalogCategory;
  chartCount: number | null;
  /** What the filters use; each absent when the catalog doesn't carry it. */
  facets?: { category?: string; format?: string; bbox?: number[] };
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

type CatalogFetchStatus = 'ok' | 'error' | 'incompatible' | 'never';

interface CatalogStatus {
  status: CatalogFetchStatus;
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  httpStatus: number | null;
  message: string | null;
}

interface CatalogSources {
  chartcatalogs: { homepage: string; issues: string };
  online: { homepage: string; issues: string };
}

type OnlineCategory = 'navigation' | 'weather' | 'depth' | 'basemap' | 'overlay';

/** A curated online chart, as the catalog lists it. */
interface OnlineCatalogChart {
  id: string;
  name: string;
  description: string;
  category: OnlineCategory | string;
  provider: string;
  license: string;
  licenseUrl: string;
  notForNavigation?: boolean;
  bbox: number[];
  /** Where the chart is useful, when narrower than bbox; for Near me only. */
  coverage?: unknown;
  chart: { type: string };
  temporal?: { kind: string };
}

interface CatalogRegistryResponse {
  registry?: CatalogRegistryEntry[];
  online?: OnlineCatalogChart[];
  /** catalogId → chart-folder paths of its .onlinechart.json files. */
  onlineAdded?: Record<string, string[]>;
  /** The boat's position, for "Near me"; null when the server has none. */
  position?: { latitude: number; longitude: number } | null;
  installed?: Record<string, CatalogInstall>;
  converting?: Record<string, boolean>;
  catalogStatus?: CatalogStatus;
  sources?: CatalogSources | null;
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
  catalogFile: string;
  title: string;
  installedDate: string;
  availableDate: string;
  downloadUrl: string;
  installedFolder: string;
}

interface QueuedCatalogUpdate {
  update: CatalogUpdate;
  targetFolder: string;
}

interface DownloadJobLite {
  id: string;
  // chartName on the server side is the chartNumber the catalog
  // download flow passes through createJob(). Used here to re-seed
  // catalogDownloadJobs after a page reload.
  chartName?: string;
  status: 'queued' | 'downloading' | 'extracting' | 'completed' | 'failed';
  progress?: number;
  downloadedBytes?: number;
  totalBytes?: number;
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
// Chart Catalog filters. Options within a group combine with OR (none
// selected means all); groups combine with AND.
interface CatalogFilters {
  use: 'all' | 'download' | 'stream';
  categories: string[];
  formats: string[];
  nearMe: boolean;
  showTypes: boolean;
}
const FILTERS_STORAGE_KEY = 'chartCatalogFilters';
let catalogFilters: CatalogFilters = loadCatalogFilters();
let vesselPosition: { latitude: number; longitude: number } | null = null;
let onlineCatalog: OnlineCatalogChart[] = [];
let onlineAdded: Record<string, string[]> = {};
const onlineAdding = new Set<string>();

// The list is sectioned by category, in this boater-friendly order; place
// is left to the Near me filter. A section's online charts share one card,
// whose key uses a prefix no chartcatalogs file name can have, so it can
// share expandedCatalogs with the download catalogs.
const ONLINE_KEY_PREFIX = 'online:';
const SECTION_LABELS: Record<string, string> = {
  navigation: 'Navigation Charts',
  weather: 'Weather',
  depth: 'Depth & Seabed',
  basemap: 'Base Maps & Imagery',
  overlay: 'Marine Overlays'
};
const OTHER_SECTION = 'other';
// A folder of its own means online charts can be switched off together
// (e.g. offshore, with no internet) by disabling one folder.
const ONLINE_DEFAULT_FOLDER = 'Online Charts';
const expandedCatalogs = new Set<string>();
const catalogChartData: Record<string, CatalogData> = {};
let catalogFolders: string[] = ['/'];

// Update queue management
let catalogUpdateQueue: QueuedCatalogUpdate[] = [];
let catalogUpdateQueueIndex = -1;
let catalogUpdateQueueRunning = false;
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
    // Run registry + folder list in parallel — a move can add/remove
    // folders, and the download-folder <select> in expanded catalog
    // rows is rendered from catalogFolders. Without this call the
    // dropdown stayed stale until the next download or tab re-init.
    const [registryOk] = await Promise.all([loadCatalogRegistry(), loadFolders()]);
    await Promise.all(
      // Online groups are rendered from the registry; there's nothing to fetch.
      wereExpanded
        .filter((key) => !key.startsWith(ONLINE_KEY_PREFIX))
        .map(async (catalogFile) => {
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
    // Don't overwrite the .catalog-error state loadCatalogRegistry
    // wrote into #catalogList on failure; rendering would replace it
    // with stale cards from whatever catalogRegistry held before.
    if (registryOk) {
      renderCatalogList();
    }
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
      <div id="catalogSourceNote" class="catalog-source-note">${sourceNoteHtml(null)}</div>
      <div id="catalogPodmanWarning"></div>
      <div id="catalogUpdatesSection"></div>
      <div id="catalogToolbar" class="catalog-toolbar">
        <button type="button" class="btn-catalog-refresh" data-catalog-refresh title="Download the latest chart catalog">
          <span class="btn-catalog-refresh-label">Refresh catalog index</span>
        </button>
      </div>
      <div id="catalogRegistryBanner"></div>
      <div id="catalogFilterBar"></div>
      <div id="catalogList">
        <div class="catalog-loading">
          <div class="spinner"></div>
          <div>Loading catalog registry...</div>
        </div>
      </div>
    </div>
  `;

  const registryOk = await loadCatalogRegistry();
  await loadFolders();
  await checkS57Status();
  await refreshUpdateBadge();
  // Re-seed catalogDownloadJobs from any in-flight server-side jobs.
  // Without this, a page reload during download loses the local
  // mapping and the catalog row renders the chart as "Download &
  // Convert" again (or — once the server finally flips converting
  // — as "Converting…" while the download is still running).
  await seedCatalogDownloadJobs();
  // Re-render now: loadCatalogRegistry rendered earlier when
  // catalogDownloadJobs was still empty, so without this call the
  // user briefly sees "Download & Convert" on actively-downloading
  // rows until the first pollCatalogDownloads tick (~2s later).
  // Skip on a failed load so we don't clobber the server-error message
  // loadCatalogRegistry wrote into #catalogList.
  if (registryOk) {
    renderCatalogList();
  }

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
    void refreshVesselPosition();
  }, 60000);
}

function wireCatalogClickHandlers(): void {
  const list = document.getElementById('catalogList');
  const filterBar = document.getElementById('catalogFilterBar');

  if (filterBar && !filterBar.dataset['catalogHandlerWired']) {
    filterBar.addEventListener('click', (ev) => {
      const target = (ev.target as HTMLElement | null)?.closest<HTMLButtonElement>(
        '[data-filter-group]'
      );
      if (!target || target.disabled) {
        return;
      }
      const group = target.dataset['filterGroup'];
      const value = target.dataset['filterValue'] ?? '';
      if (group) {
        applyCatalogFilter(group, value);
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

      // "Clear filters" in the empty-list message.
      if (target.closest('[data-filter-group="clear"]')) {
        applyCatalogFilter('clear', '');
        return;
      }

      const add = target.closest<HTMLElement>('[data-online-add]');
      if (add) {
        const catalogId = add.dataset['onlineAdd'];
        if (catalogId) {
          void addOnlineChart(catalogId);
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

  // Updates section uses event delegation on a stable parent container
  // since its content is replaced on every renderUpdatesSection() call.
  // The container itself is stable; only its innerHTML changes.
  const output = document.getElementById('catalogOutput');
  if (output && !output.dataset['catalogUpdateHandlerWired']) {
    output.addEventListener('click', (ev) => {
      const target = ev.target as HTMLElement | null;
      if (!target) {
        return;
      }

      const refreshBtn = target.closest<HTMLButtonElement>('[data-catalog-refresh]');
      if (refreshBtn) {
        void doCatalogRefresh(refreshBtn);
        return;
      }

      // "Update All" button - queue updates for sequential processing
      const updateAll = target.closest<HTMLElement>('[data-catalog-update-all]');
      if (updateAll) {
        // Ignore re-clicks while a queue is running — rebuilding the queue
        // mid-run would reset the index and drop in-flight items.
        if (catalogUpdateQueueRunning) {
          return;
        }
        const updatesToQueue: QueuedCatalogUpdate[] = [];
        for (const update of catalogUpdates) {
          const alreadyActive =
            catalogDownloadJobs[update.chartNumber] !== undefined ||
            catalogConverting[update.chartNumber];
          if (!alreadyActive) {
            const folderEl = document.getElementById(
              `catalog-update-folder-${catalogEscapeId(update.chartNumber)}`
            ) as HTMLSelectElement | null;
            updatesToQueue.push({
              update,
              targetFolder: folderEl ? folderEl.value : update.installedFolder
            });
          }
        }
        
        if (updatesToQueue.length > 0) {
          catalogUpdateQueue = updatesToQueue;
          catalogUpdateQueueIndex = 0;
          catalogUpdateQueueRunning = true;
          renderUpdatesSection();
          void processUpdateQueue();
        }
        return;
      }

      // Per-chart "Update" button
      const updateBtn = target.closest<HTMLElement>('[data-catalog-update]');
      if (updateBtn) {
        const chartNumber = updateBtn.dataset['catalogUpdate'];
        if (!chartNumber) {
          return;
        }
        const update = catalogUpdates.find((u) => u.chartNumber === chartNumber);
        if (!update) {
          return;
        }
        const folderEl = document.getElementById(
          `catalog-update-folder-${catalogEscapeId(chartNumber)}`
        ) as HTMLSelectElement | null;
        const targetFolder = folderEl ? folderEl.value : update.installedFolder;
        void downloadUpdateChart(update, targetFolder);
        return;
      }

      // Logs / Dismiss buttons rendered inside the updates panel. These
      // live under #catalogOutput, so the #catalogList handler never sees
      // them — wire them here too or they'd be dead in the updates panel.
      // #catalogList is also a descendant of #catalogOutput, so skip clicks
      // that originate there: its own handler already processes them and we
      // must not fire twice.
      if (!target.closest('#catalogList')) {
        const updateLog = target.closest<HTMLElement>('[data-catalog-log]');
        if (updateLog) {
          const chartNumber = updateLog.dataset['catalogLog'];
          if (chartNumber) {
            void showConversionLog(chartNumber);
          }
          return;
        }

        const updateDismiss = target.closest<HTMLElement>('[data-catalog-dismiss]');
        if (updateDismiss) {
          const chartNumber = updateDismiss.dataset['catalogDismiss'];
          if (chartNumber) {
            dismissConversionError(chartNumber);
          }
          return;
        }
      }
    });
    output.dataset['catalogUpdateHandlerWired'] = '1';
  }
}

// Bumped by every registry load/refresh; a stale async result whose seq no
// longer matches is ignored, so a slow initial load can't clobber a newer
// refresh (or vice versa).
let registryLoadSeq = 0;
let catalogRefreshInFlight = false;
// Last status from the registry endpoint, so renderCatalogList() can show an
// accurate empty-state message instead of a generic "No catalogs" that would
// clobber it on the next poll-driven re-render.
let lastCatalogStatus: CatalogStatus | undefined;

const DEFAULT_CATALOG_SOURCES: CatalogSources = {
  chartcatalogs: {
    homepage: 'https://chartcatalogs.github.io/',
    issues: 'https://github.com/chartcatalogs/catalogs/issues'
  },
  online: {
    homepage: 'https://github.com/dirkwa/signalk-charts-provider-simple',
    issues:
      'https://github.com/dirkwa/signalk-charts-provider-simple/issues/new?template=catalog-problem.yml'
  }
};

// Attribution for both halves of the merged catalog, each with the tracker
// its problems belong in. The links come from the catalog itself once loaded.
function sourceNoteHtml(sources: CatalogSources | null | undefined): string {
  const { chartcatalogs, online } = sources ?? DEFAULT_CATALOG_SOURCES;
  // The links come from a downloaded file; only ever render https hrefs.
  const link = (href: string, fallback: string, text: string) =>
    `<a href="${catalogEscapeAttr(/^https:\/\//.test(href) ? href : fallback)}" target="_blank" rel="noopener">${text}</a>`;
  const d = DEFAULT_CATALOG_SOURCES;
  return `
    Downloadable charts come from ${link(chartcatalogs.homepage, d.chartcatalogs.homepage, 'chartcatalogs.github.io')}
    &mdash; a community-maintained catalog. Download links may be outdated or unavailable;
    if a download fails, please report it to the ${link(chartcatalogs.issues, d.chartcatalogs.issues, 'chartcatalogs issue tracker')}.
    Problems with online charts can be reported ${link(online.issues, d.online.issues, 'here')}.`;
}

function renderSourceNote(sources: CatalogSources | null | undefined): void {
  const el = document.getElementById('catalogSourceNote');
  if (el) {
    el.innerHTML = sourceNoteHtml(sources);
  }
}

// HTML for the empty-list placeholder when there is no catalog to show. The
// server's message names the actual cause (offline, unavailable, damaged,
// or needs a plugin update).
function registryEmptyMessageHtml(status: CatalogStatus | undefined): string {
  if ((status?.status === 'error' || status?.status === 'incompatible') && status.message) {
    return `<div class="catalog-error">${catalogEscapeHtml(status.message)}</div>`;
  }
  return `<div class="catalog-error">No catalogs available yet. Click Refresh to download the chart catalog.</div>`;
}

// Non-destructive banner shown ABOVE a populated list when a refresh failed —
// so we never blank the cached cards just to report the failure.
function showRegistryBanner(
  status: CatalogStatus | undefined,
  source: 'catalog' | 'server' = 'catalog'
): void {
  const el = document.getElementById('catalogRegistryBanner');
  if (!el) {
    return;
  }
  let msg: string;
  if (source === 'server') {
    msg = 'Showing the last downloaded catalog. Could not reach the Signal K server to refresh it.';
  } else {
    msg = `Showing the last downloaded catalog. ${catalogEscapeHtml(status?.message ?? 'Could not download a newer one.')}`;
  }
  el.innerHTML = `<div class="catalog-banner catalog-banner-warning">${msg}</div>`;
}

function clearRegistryBanner(): void {
  const el = document.getElementById('catalogRegistryBanner');
  if (el) {
    el.innerHTML = '';
  }
}

// Apply a registry response: never replace a populated list with an empty one
// (keep cached cards + show a banner instead); render the accurate empty/error
// placeholder only when there's nothing cached to show.
function applyRegistryResponse(data: CatalogRegistryResponse): void {
  const incoming = data.registry ?? [];
  const status = data.catalogStatus;
  lastCatalogStatus = status;
  renderSourceNote(data.sources);

  if (incoming.length === 0 && catalogRegistry.length > 0) {
    showRegistryBanner(status);
    return;
  }

  catalogRegistry = incoming;
  onlineCatalog = data.online ?? [];
  onlineAdded = data.onlineAdded ?? {};
  vesselPosition = data.position ?? null;
  catalogInstalled = data.installed ?? {};
  catalogConverting = data.converting ?? {};
  renderFilterBar();
  // renderCatalogList handles both the populated and empty-registry cases
  // (the latter via registryEmptyMessageHtml + lastCatalogStatus), so a
  // later poll-driven re-render keeps showing the right message.
  renderCatalogList();
}

/**
 * Returns true on a successful registry load, false on network/HTTP failure
 * to OUR endpoint. Callers that chain follow-up renders skip them on failure.
 * Never blanks an already-populated list.
 */
async function loadCatalogRegistry(): Promise<boolean> {
  const seq = ++registryLoadSeq;
  try {
    const response = await fetch(`${CATALOG_API_BASE}/catalog-registry`);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const data = (await response.json()) as CatalogRegistryResponse;
    if (seq !== registryLoadSeq) {
      return true; // a newer load/refresh superseded this one
    }
    applyRegistryResponse(data);
    return true;
  } catch (error) {
    console.error('Failed to load catalog registry:', error);
    if (seq !== registryLoadSeq) {
      return false;
    }
    // Failure reaching OUR server (not the catalog). Keep a populated list.
    if (catalogRegistry.length === 0) {
      const listEl = document.getElementById('catalogList');
      if (listEl) {
        listEl.innerHTML = `<div class="catalog-error">Failed to load the catalog list from the Signal K server. Reload the page or click Refresh.</div>`;
      }
    } else {
      showRegistryBanner(undefined, 'server');
    }
    return false;
  }
}

// Refresh-button handler: re-download the catalog on demand, with a disabled/
// spinner state and the same never-blank + stale-guard rules as the load path.
async function doCatalogRefresh(btn: HTMLButtonElement): Promise<void> {
  if (catalogRefreshInFlight) {
    return;
  }
  catalogRefreshInFlight = true;
  const seq = ++registryLoadSeq;
  const label = btn.querySelector<HTMLElement>('.btn-catalog-refresh-label');
  const prevText = label?.textContent ?? 'Refresh catalog index';
  btn.disabled = true;
  btn.classList.add('loading');
  if (label) {
    label.textContent = 'Refreshing…';
  }
  try {
    const response = await fetch(`${CATALOG_API_BASE}/catalog-registry/refresh`, {
      method: 'POST'
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const data = (await response.json()) as CatalogRegistryResponse;
    if (seq !== registryLoadSeq) {
      return;
    }
    applyRegistryResponse(data);
  } catch (error) {
    console.error('Catalog refresh failed:', error);
    // A newer load/refresh already won — don't overwrite the fresh UI with
    // this stale failure.
    if (seq !== registryLoadSeq) {
      return;
    }
    if (catalogRegistry.length > 0) {
      showRegistryBanner(undefined, 'server');
    } else {
      const listEl = document.getElementById('catalogList');
      if (listEl) {
        listEl.innerHTML = `<div class="catalog-error">Refresh failed — could not reach the Signal K server.</div>`;
      }
    }
  } finally {
    catalogRefreshInFlight = false;
    btn.disabled = false;
    btn.classList.remove('loading');
    if (label) {
      label.textContent = prevText;
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

    renderUpdatesSection();
  } catch {
    // Ignore badge refresh errors
  }
}

function renderUpdatesSection(): void {
  const section = document.getElementById('catalogUpdatesSection');
  if (!section) {
    return;
  }

  if (catalogUpdates.length === 0) {
    section.innerHTML = '';
    return;
  }

  const rows = catalogUpdates
    .map((update) => {
      const installedDateStr = update.installedDate
        ? new Date(update.installedDate).toLocaleDateString()
        : '';
      const availableDateStr = update.availableDate
        ? new Date(update.availableDate).toLocaleDateString()
        : '';
      const escapedNum = catalogEscapeId(update.chartNumber);
      const isUpdating =
        catalogDownloadJobs[update.chartNumber] !== undefined ||
        catalogConverting[update.chartNumber];
      const conversionError = catalogConversionErrors[update.chartNumber];
      const isDownloading = catalogDownloadJobs[update.chartNumber] !== undefined;
      const queuePosition = getQueuePosition(update.chartNumber);
      const isInQueue = queuePosition !== null;
      const isWaiting = queuePosition !== null && queuePosition > 0;

      let actionHtml: string;
      if (conversionError) {
        actionHtml = `
          <div class="catalog-conversion-error">
            <span class="conversion-error-text">${catalogEscapeHtml(conversionError)}</span>
            <button class="btn-catalog-log" data-catalog-log="${catalogEscapeAttr(update.chartNumber)}">Logs</button>
            <button class="btn-catalog-dismiss" data-catalog-dismiss="${catalogEscapeAttr(update.chartNumber)}">Dismiss</button>
          </div>`;
      } else if (isWaiting) {
        actionHtml = `
          <div class="catalog-queue-waiting">
            <div class="spinner" style="width:16px;height:16px;border-width:2px;"></div>
            <span>Waiting in queue (position ${queuePosition})...</span>
          </div>`;
      } else if (isDownloading) {
        actionHtml = `
          <div class="catalog-download-progress" id="catalog-progress-${escapedNum}">
            <div class="progress-bar"><div class="progress-fill" style="width: 0%"></div></div>
            <span>Downloading...</span>
          </div>`;
      } else if (isUpdating) {
        const progress = catalogConversionProgress[update.chartNumber];
        const progressMsg = progress?.message ?? 'Converting S-57 to vector tiles...';
        actionHtml = `
          <div class="catalog-conversion-progress" id="catalog-conversion-${escapedNum}">
            <div class="spinner" style="width:16px;height:16px;border-width:2px;"></div>
            <span>${catalogEscapeHtml(progressMsg)}</span>
            <button class="btn-catalog-log" data-catalog-log="${catalogEscapeAttr(update.chartNumber)}">Logs</button>
          </div>`;
      } else {
        actionHtml = `<label class="catalog-folder-label" for="catalog-update-folder-${escapedNum}">Save to</label>
           <select class="catalog-folder-select catalog-update-folder-select" id="catalog-update-folder-${escapedNum}">
            ${buildFolderOptions(update.installedFolder)}
           </select>
           <button class="btn-catalog-download"
                   data-catalog-update="${catalogEscapeAttr(update.chartNumber)}"
                   data-catalog-update-file="${catalogEscapeAttr(update.catalogFile)}"
                   data-catalog-update-url="${catalogEscapeAttr(update.downloadUrl)}"
                   data-catalog-update-datetime="${catalogEscapeAttr(update.availableDate)}">
             Update
           </button>`;
      }

      return `
        <div class="catalog-update-row${isUpdating || isInQueue ? ' updating' : ''}" data-chart-number="${catalogEscapeAttr(update.chartNumber)}">
          <div class="catalog-update-row-info">
            <span class="catalog-update-row-title">${catalogEscapeHtml(update.title || update.chartNumber)}</span>
            <span class="catalog-update-row-dates">${catalogEscapeHtml(installedDateStr)} → ${catalogEscapeHtml(availableDateStr)}</span>
          </div>
          <div class="catalog-update-row-actions">
            ${actionHtml}
          </div>
        </div>`;
    })
    .join('');

  const allUpdating = catalogUpdates.every(
    (u) =>
      catalogDownloadJobs[u.chartNumber] !== undefined ||
      catalogConverting[u.chartNumber] ||
      catalogConversionErrors[u.chartNumber]
  );

  // Show queue progress in the button
  let updateAllButtonText = 'Update All';
  let updateAllDisabled = allUpdating;
  
  if (catalogUpdateQueueRunning && catalogUpdateQueueIndex >= 0) {
    const current = catalogUpdateQueueIndex + 1;
    const total = catalogUpdateQueue.length;
    updateAllButtonText = `Updating ${current} of ${total}...`;
    updateAllDisabled = true;
  }

  section.innerHTML = `
    <div class="catalog-updates-section">
      <div class="catalog-updates-header">
        <span class="catalog-updates-title">
          ${catalogUpdates.length} chart update${catalogUpdates.length !== 1 ? 's' : ''} available
        </span>
        <button class="btn-catalog-download" ${updateAllDisabled ? 'disabled' : ''}
                data-catalog-update-all>
          ${updateAllButtonText}
        </button>
      </div>
      <div class="catalog-updates-rows">
        ${rows}
      </div>
    </div>
  `;
}

async function downloadUpdateChart(
  update: CatalogUpdate,
  targetFolder: string
): Promise<void> {
  try {
    const response = await fetch(`${CATALOG_API_BASE}/catalog/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: update.downloadUrl,
        chartNumber: update.chartNumber,
        catalogFile: update.catalogFile,
        zipfileDatetime: update.availableDate,
        targetFolder
      })
    });
    if (!response.ok) {
      let errorText: string;
      try {
        const body = (await response.json()) as { error?: string };
        errorText = body.error ?? `HTTP ${response.status}`;
      } catch {
        errorText = `HTTP ${response.status}`;
      }
      failUpdate(update.chartNumber, errorText);
      return;
    }
    const result = (await response.json()) as CatalogDownloadResponse;
    if (result.success) {
      // A retry has started — drop any error from the previous attempt so
      // the row shows progress, not the stale failure (renderUpdatesSection
      // checks conversionError before the in-progress state).
      delete catalogConversionErrors[update.chartNumber];
      dismissedConversionErrors.delete(update.chartNumber);
      if (result.jobId && !result.jobId.startsWith('gshhg-')) {
        catalogDownloadJobs[update.chartNumber] = result.jobId;
      } else {
        catalogConverting[update.chartNumber] = true;
      }
      renderUpdatesSection();
    } else {
      failUpdate(update.chartNumber, result.error ?? 'Update failed');
    }
  } catch (error) {
    console.error('Failed to start chart update:', error);
    failUpdate(update.chartNumber, 'Failed to start update. Check your network connection.');
  }
}

/**
 * Record a failed update so the queue (via waitForConversion) stops on it
 * rather than silently skipping to the next chart, and the failure surfaces
 * in the UI. `dismissedConversionErrors` is cleared so a retry's error shows.
 */
function failUpdate(chartNumber: string, errorText: string): void {
  catalogConversionErrors[chartNumber] = errorText;
  dismissedConversionErrors.delete(chartNumber);
  renderUpdatesSection();
}

/**
 * Serialize catalog updates so only one download/conversion runs at a time.
 * `catalogUpdateQueueRunning` is true while the queue is active;
 * `catalogUpdateQueueIndex` tracks the current item. Recursion advances
 * to the next chart only after `waitForConversion` resolves.
 *
 * A failed item does NOT abort the run: its error is recorded in
 * `catalogConversionErrors` (shown per-row) and the queue continues, so one
 * bad chart in an "Update All" batch doesn't strand the rest. The user sees
 * exactly which charts failed and can retry those individually.
 */
async function processUpdateQueue(): Promise<void> {
  if (!catalogUpdateQueueRunning || catalogUpdateQueueIndex >= catalogUpdateQueue.length) {
    catalogUpdateQueue = [];
    catalogUpdateQueueIndex = -1;
    catalogUpdateQueueRunning = false;
    renderUpdatesSection();
    return;
  }

  const { update, targetFolder } = catalogUpdateQueue[catalogUpdateQueueIndex];
  await downloadUpdateChart(update, targetFolder);
  await waitForConversion(update.chartNumber);

  catalogUpdateQueueIndex++;
  renderUpdatesSection();
  await processUpdateQueue();
}

/**
 * Relative queue position for a chart number. Returns `0` when the chart
 * is currently processing, a positive number when waiting, and `null`
 * when the queue is not running or the chart is not queued.
 */
function getQueuePosition(chartNumber: string): number | null {
  if (!catalogUpdateQueueRunning) {
    return null;
  }
  const index = catalogUpdateQueue.findIndex(u => u.update.chartNumber === chartNumber);
  if (index === -1) {
    return null;
  }
  return index - catalogUpdateQueueIndex; // 0 = currently processing, >0 = waiting
}

/**
 * Poll until a chart's conversion is complete (success or failure)
 */
async function waitForConversion(chartNumber: string): Promise<void> {
  const maxWait = 10 * 60 * 1000; // 10 minutes max
  const pollInterval = 2000; // 2 seconds
  const startTime = Date.now();

  while (true) {
    const stillDownloading = catalogDownloadJobs[chartNumber] !== undefined;
    const stillConverting = catalogConverting[chartNumber];

    if (stillDownloading || stillConverting) {
      // Hard timeout: a stuck download/conversion (hung runtime, lost
      // progress updates) must not block the queue forever. Record a
      // terminal error and stop waiting so the queue advances and the UI
      // shows the failure instead of a permanent "Updating…" spinner.
      if (Date.now() - startTime >= maxWait) {
        delete catalogDownloadJobs[chartNumber];
        delete catalogConverting[chartNumber];
        failUpdate(chartNumber, 'Timed out waiting for conversion (10 min)');
        return;
      }
      await new Promise(resolve => setTimeout(resolve, pollInterval));
      continue;
    }

    // Not downloading or converting any more: complete (success) or failed
    // — either way the chart left the active maps, so stop waiting.
    return;
  }
}

const CATEGORY_LABELS: Record<string, string> = {
  navigation: 'Navigation',
  weather: 'Weather',
  depth: 'Depth & Seabed',
  basemap: 'Base maps',
  overlay: 'Overlays'
};

const FORMAT_LABELS: Record<string, string> = {
  mbtiles: 'MBTiles',
  enc: 'ENC (S-57)',
  rnc: 'Raster (RNC)',
  shapefile: 'Shapefile',
  wms: 'WMS',
  wmts: 'WMTS',
  mapstyle: 'Map style',
  tiles: 'Tiles'
};

// An online chart's Type-filter facet, from its chart resource type.
const ONLINE_TYPE_FORMATS: Record<string, string> = {
  WMS: 'wms',
  WMTS: 'wmts',
  mapstyleJSON: 'mapstyle',
  tilelayer: 'tiles',
  tileJSON: 'tiles'
};

// How far outside a chart's box still counts as "near": about 60 nm, so a
// boat just off a coverage edge (or at anchor outside a harbor chart's box)
// still sees it.
const NEAR_ME_MARGIN_DEG = 1;

/**
 * Follow a GPS fix that arrives (or is lost) after the tab opened, so Near
 * me enables itself without a reload. Only re-renders when that changes
 * what the filters can show.
 */
async function refreshVesselPosition(): Promise<void> {
  try {
    const response = await fetch(`${CATALOG_API_BASE}/vessel-position`);
    if (!response.ok) {
      return;
    }
    const { position } = (await response.json()) as {
      position: { latitude: number; longitude: number } | null;
    };
    const moved =
      (position === null) !== (vesselPosition === null) ||
      (position !== null &&
        vesselPosition !== null &&
        (Math.abs(position.latitude - vesselPosition.latitude) > 0.05 ||
          Math.abs(position.longitude - vesselPosition.longitude) > 0.05));
    if (moved) {
      vesselPosition = position;
      renderFilterBar();
      renderCatalogList();
    }
  } catch {
    // Next minute's poll will try again.
  }
}

function loadCatalogFilters(): CatalogFilters {
  const defaults: CatalogFilters = {
    use: 'all',
    categories: [],
    formats: [],
    nearMe: false,
    showTypes: false
  };
  let saved: Record<string, unknown> = {};
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(FILTERS_STORAGE_KEY) ?? 'null');
    if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
      saved = raw as Record<string, unknown>;
    }
  } catch {
    // Unreadable or unavailable storage: start from the defaults.
  }
  // Each field falls back on its own, so one bad value (a hand edit, an
  // older version's format) can't leave the tab stuck on an empty list.
  const strings = (v: unknown) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  const use = saved.use;
  return {
    use: use === 'download' || use === 'stream' ? use : defaults.use,
    categories: strings(saved.categories),
    formats: strings(saved.formats),
    nearMe: saved.nearMe === true,
    showTypes: saved.showTypes === true
  };
}

function saveCatalogFilters(): void {
  try {
    localStorage.setItem(FILTERS_STORAGE_KEY, JSON.stringify(catalogFilters));
  } catch {
    // Remembering filters is a convenience; private windows may refuse it.
  }
}

/** One thing the filters apply to: a downloadable catalog or an online chart. */
interface FilterItem {
  use: 'download' | 'stream';
  category: string | undefined;
  format: string | undefined;
  bbox: number[] | undefined;
}

/** A label map lookup that never picks up Object.prototype names. */
function ownLabel(map: Record<string, string>, key: string): string | undefined {
  return Object.hasOwn(map, key) ? map[key] : undefined;
}

function isBbox(v: unknown): v is number[] {
  return Array.isArray(v) && v.length === 4 && v.every((n) => Number.isFinite(n));
}

function registryFilterItem(entry: CatalogRegistryEntry): FilterItem {
  return {
    use: 'download',
    category: entry.facets?.category,
    format: entry.facets?.format,
    bbox: entry.facets?.bbox
  };
}

function onlineFilterItem(chart: OnlineCatalogChart): FilterItem {
  return {
    use: 'stream',
    category: chart.category,
    format: ownLabel(ONLINE_TYPE_FORMATS, chart.chart.type),
    // A satellite's full disk is its bbox, but only its useful coverage
    // should count as "near".
    bbox: isBbox(chart.coverage) ? chart.coverage : chart.bbox
  };
}

/** Whether `bbox` ([w, s, e, n], west > east crossing the antimeridian) is near the boat. */
function isNearVessel(bbox: number[] | undefined): boolean {
  if (!vesselPosition || !isBbox(bbox)) {
    return false;
  }
  const [west = 0, south = 0, east = 0, north = 0] = bbox;
  const { latitude, longitude } = vesselPosition;
  const m = NEAR_ME_MARGIN_DEG;
  if (latitude < south - m || latitude > north + m) {
    return false;
  }
  // A degree of longitude shrinks toward the poles; widen the margin so it
  // stays about the same distance.
  const mLon = m / Math.max(Math.cos((latitude * Math.PI) / 180), 0.05);
  const span = west <= east ? east - west : east + 360 - west;
  if (span + 2 * mLon >= 360) {
    return true;
  }
  // Measure eastward from the widened west edge, modulo 360, so boxes and
  // margins that cross the antimeridian need no special case.
  const offset = (((longitude - (west - mLon)) % 360) + 360) % 360;
  return offset <= span + 2 * mLon;
}

type FilterGroup = 'use' | 'categories' | 'formats' | 'nearMe';

/** Whether an item passes every active filter group except `skip`. */
function passesFilters(item: FilterItem, skip?: FilterGroup): boolean {
  const f = catalogFilters;
  if (skip !== 'use' && f.use !== 'all' && item.use !== f.use) {
    return false;
  }
  if (
    skip !== 'categories' &&
    f.categories.length > 0 &&
    !f.categories.includes(item.category ?? '')
  ) {
    return false;
  }
  if (skip !== 'formats' && f.formats.length > 0 && !f.formats.includes(item.format ?? '')) {
    return false;
  }
  // Without a position Near me can't apply (and its button is disabled), so
  // a saved "on" must not hide everything.
  if (skip !== 'nearMe' && f.nearMe && vesselPosition !== null && !isNearVessel(item.bbox)) {
    return false;
  }
  return true;
}

function allFilterItems(): FilterItem[] {
  return [...catalogRegistry.map(registryFilterItem), ...onlineCatalog.map(onlineFilterItem)];
}

/**
 * How many items an option would show given the other active groups, which
 * is what a faceted filter's count should promise.
 */
function optionCount(group: FilterGroup, matches: (item: FilterItem) => boolean): number {
  return allFilterItems().filter((item) => passesFilters(item, group) && matches(item)).length;
}

function filterButton(
  group: string,
  value: string,
  label: string,
  active: boolean,
  count: number | null,
  extra = ''
): string {
  return `
    <button type="button" class="category-filter-btn ${active ? 'active' : ''}" aria-pressed="${active ? 'true' : 'false'}"
            data-filter-group="${catalogEscapeAttr(group)}" data-filter-value="${catalogEscapeAttr(value)}" ${extra}>
      ${catalogEscapeHtml(label)}
      ${count !== null ? `<span class="category-count">${count}</span>` : ''}
    </button>`;
}

function renderFilterBar(): void {
  const filterBar = document.getElementById('catalogFilterBar');
  if (!filterBar) {
    return;
  }
  const f = catalogFilters;
  const items = allFilterItems();
  const present = (
    key: 'category' | 'format',
    labels: Record<string, string>,
    selected: string[]
  ) => {
    // Selected options always show, even at 0, so a saved choice the
    // catalog no longer uses can still be switched off.
    const keys = new Set([
      ...items.map((i) => i[key]).filter((v): v is string => v !== undefined),
      ...selected
    ]);
    // Known values in their fixed order, then anything newer the catalog uses.
    return [
      ...Object.keys(labels).filter((k) => keys.has(k)),
      ...[...keys].filter((k) => !Object.hasOwn(labels, k)).sort()
    ];
  };

  const useOptions: [CatalogFilters['use'], string][] = [
    ['all', 'All'],
    ['download', 'Download (works offline)'],
    ['stream', 'Stream (needs internet)']
  ];
  const useRow = useOptions
    .map(([value, label]) =>
      filterButton(
        'use',
        value,
        label,
        f.use === value,
        optionCount('use', (i) => value === 'all' || i.use === value)
      )
    )
    .join('');

  const categoryRow = present('category', CATEGORY_LABELS, f.categories)
    .map((c) =>
      filterButton(
        'categories',
        c,
        ownLabel(CATEGORY_LABELS, c) ?? c,
        f.categories.includes(c),
        optionCount('categories', (i) => i.category === c)
      )
    )
    .join('');

  // The reason Near me is off must be readable on a touch screen, where a
  // tooltip never shows, so it goes in the label.
  const nearMe = filterButton(
    'nearMe',
    '',
    vesselPosition ? 'Near me' : 'Near me (no position yet)',
    f.nearMe && vesselPosition !== null,
    vesselPosition ? optionCount('nearMe', (i) => isNearVessel(i.bbox)) : null,
    vesselPosition ? 'title="Charts that cover the boat\'s current position"' : 'disabled'
  );

  const typeRow = f.showTypes
    ? `<div class="category-filter catalog-filter-types">
        ${present('format', FORMAT_LABELS, f.formats)
          .map((t) =>
            filterButton(
              'formats',
              t,
              ownLabel(FORMAT_LABELS, t) ?? t,
              f.formats.includes(t),
              optionCount('formats', (i) => i.format === t)
            )
          )
          .join('')}
      </div>`
    : '';

  filterBar.innerHTML = `
    <div class="category-filter catalog-filter-use">${useRow}</div>
    <div class="category-filter catalog-filter-categories">
      ${categoryRow}
      <span class="catalog-filter-divider"></span>
      ${nearMe}
      <button type="button" class="catalog-filter-more" aria-expanded="${f.showTypes ? 'true' : 'false'}" data-filter-group="showTypes" data-filter-value="">
        ${f.showTypes ? 'Fewer filters' : 'More filters'}${f.formats.length > 0 ? ` (${f.formats.length})` : ''}
      </button>
    </div>
    ${typeRow}
  `;
}

function applyCatalogFilter(group: string, value: string): void {
  const f = catalogFilters;
  const toggle = (list: string[]) =>
    list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
  switch (group) {
    case 'use':
      if (value === 'all' || value === 'download' || value === 'stream') {
        f.use = value;
      }
      break;
    case 'categories':
      f.categories = toggle(f.categories);
      break;
    case 'formats':
      f.formats = toggle(f.formats);
      break;
    case 'nearMe':
      f.nearMe = !f.nearMe;
      break;
    case 'showTypes':
      f.showTypes = !f.showTypes;
      break;
    case 'clear':
      catalogFilters = { ...f, use: 'all', categories: [], formats: [], nearMe: false };
      break;
    default:
      return;
  }
  saveCatalogFilters();
  renderFilterBar();
  renderCatalogList();
}

function renderCatalogList(): void {
  const listEl = document.getElementById('catalogList');
  if (!listEl) {
    return;
  }
  // Whole registry empty → show the status-aware reason (incompatible /
  // offline / "click Refresh"), not a generic line that would clobber the
  // message a poll-driven re-render would otherwise wipe.
  if (catalogRegistry.length === 0 && onlineCatalog.length === 0) {
    listEl.innerHTML = registryEmptyMessageHtml(lastCatalogStatus);
    return;
  }

  // A populated list may still be the last good catalog after a failed
  // refresh; say so rather than implying it is current.
  if (lastCatalogStatus?.status === 'error' || lastCatalogStatus?.status === 'incompatible') {
    showRegistryBanner(lastCatalogStatus);
  } else {
    clearRegistryBanner();
  }

  const filtered = catalogRegistry.filter((c) => passesFilters(registryFilterItem(c)));
  const online = onlineCatalog.filter((c) => passesFilters(onlineFilterItem(c)));

  if (filtered.length === 0 && online.length === 0) {
    listEl.innerHTML = `
      <div class="catalog-empty">
        No charts match these filters.
        <button type="button" class="catalog-filter-more" data-filter-group="clear" data-filter-value="">Clear filters</button>
      </div>`;
    return;
  }

  listEl.innerHTML = catalogSections(filtered, online)
    .map((section) => renderCatalogSection(section))
    .join('');
}

interface CatalogSection {
  category: string;
  online: OnlineCatalogChart[];
  downloads: CatalogRegistryEntry[];
}

function sectionOf(category: string | undefined): string {
  return category && ownLabel(SECTION_LABELS, category) ? category : OTHER_SECTION;
}

/** Everything that passed the filters, sectioned by category in a fixed order. */
function catalogSections(
  downloads: CatalogRegistryEntry[],
  online: OnlineCatalogChart[]
): CatalogSection[] {
  const sections = new Map<string, CatalogSection>();
  const sectionFor = (category: string) => {
    let section = sections.get(category);
    if (!section) {
      section = { category, online: [], downloads: [] };
      sections.set(category, section);
    }
    return section;
  };
  for (const chart of online) {
    sectionFor(sectionOf(chart.category)).online.push(chart);
  }
  for (const catalog of downloads) {
    sectionFor(sectionOf(catalog.facets?.category)).downloads.push(catalog);
  }
  const order = Object.keys(SECTION_LABELS);
  const rank = (c: string) => (order.includes(c) ? order.indexOf(c) : order.length);
  return [...sections.values()]
    .sort((a, b) => rank(a.category) - rank(b.category))
    .map((section) => ({
      ...section,
      // Most download catalogs are named for a country or waterway.
      downloads: section.downloads.sort((a, b) => a.label.localeCompare(b.label))
    }));
}

function renderCatalogSection(section: CatalogSection): string {
  const label = ownLabel(SECTION_LABELS, section.category) ?? 'Other Charts';
  return `
    <section class="catalog-section">
      <h2 class="catalog-section-title">${catalogEscapeHtml(label)}</h2>
      ${section.online.length > 0 ? renderOnlineGroupCard(section.category, section.online) : ''}
      ${section.downloads.map((catalog) => renderCatalogCard(catalog)).join('')}
    </section>`;
}

function renderOnlineGroupCard(category: string, charts: OnlineCatalogChart[]): string {
  const key = ONLINE_KEY_PREFIX + category;
  const isExpanded = expandedCatalogs.has(key);
  const label = 'Online charts';
  return `
    <div class="catalog-card online ${isExpanded ? 'expanded' : ''}" id="catalog-card-${catalogEscapeId(key)}">
      <div class="catalog-card-header" data-catalog-toggle="${catalogEscapeAttr(key)}">
        <div class="catalog-expand-icon">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
            <path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/>
          </svg>
        </div>
        <div class="catalog-card-title">${catalogEscapeHtml(label)}</div>
        <div class="catalog-card-meta">
          <span class="catalog-chart-count">${charts.length} ${charts.length === 1 ? 'chart' : 'charts'}</span>
          <span class="format-badge online">Online</span>
        </div>
      </div>
      <div class="catalog-card-body" id="catalog-body-${catalogEscapeId(key)}">
        ${isExpanded ? renderOnlineChartList(charts) : ''}
      </div>
    </div>
  `;
}

/** Where an online chart has been added; an own-key lookup, so no id reads an inherited value. */
function addedPaths(catalogId: string): string[] {
  return Object.hasOwn(onlineAdded, catalogId) ? (onlineAdded[catalogId] ?? []) : [];
}

function renderOnlineChartList(charts: OnlineCatalogChart[]): string {
  return charts
    .map((chart) => {
      const added = addedPaths(chart.id).length > 0;
      const adding = onlineAdding.has(chart.id);
      const licenseLink = /^https:\/\//.test(chart.licenseUrl)
        ? `<a href="${catalogEscapeAttr(chart.licenseUrl)}" target="_blank" rel="noopener">${catalogEscapeHtml(chart.license)}</a>`
        : catalogEscapeHtml(chart.license);
      const badges = [
        '<span class="online-badge" title="Streamed from its provider; shows nothing without an internet connection">Needs internet</span>',
        chart.temporal
          ? `<span class="online-badge live" title="Updates automatically; recent images can be played back">${chart.temporal.kind === 'forecast' ? 'Forecast' : 'Live'}</span>`
          : '',
        chart.notForNavigation
          ? '<span class="online-badge caution">Not for navigation</span>'
          : ''
      ].join('');
      const action = added
        ? '<span class="installed-badge">Added</span>'
        : `
          <label class="catalog-folder-label" for="online-folder-${catalogEscapeId(chart.id)}">Save to</label>
          <select class="catalog-folder-select" id="online-folder-${catalogEscapeId(chart.id)}">
            ${buildFolderOptions(ONLINE_DEFAULT_FOLDER)}
          </select>
          <button class="btn-catalog-download" data-online-add="${catalogEscapeAttr(chart.id)}" ${adding ? 'disabled' : ''}>
            ${adding ? 'Adding…' : 'Add'}
          </button>`;
      return `
        <div class="catalog-chart-row online-chart-row">
          <div class="chart-row-info">
            <div class="chart-row-number">${catalogEscapeHtml(chart.name)} ${badges}</div>
            <div class="chart-row-title">${catalogEscapeHtml(chart.description)}</div>
            <div class="online-row-source">${catalogEscapeHtml(chart.provider)} · ${licenseLink}</div>
          </div>
          <div class="chart-row-actions">${action}</div>
        </div>`;
    })
    .join('');
}

async function addOnlineChart(catalogId: string): Promise<void> {
  if (onlineAdding.has(catalogId)) {
    return;
  }
  const folderEl = document.getElementById(
    `online-folder-${catalogEscapeId(catalogId)}`
  ) as HTMLSelectElement | null;
  const folder = folderEl?.value ?? ONLINE_DEFAULT_FOLDER;
  onlineAdding.add(catalogId);
  renderCatalogList();
  try {
    const response = await fetch(`${CATALOG_API_BASE}/online-charts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ catalogId, folder })
    });
    let result: { success?: boolean; relativePath?: string; error?: string } = {};
    try {
      result = (await response.json()) as typeof result;
    } catch {
      // A proxy error page isn't JSON; report the HTTP status instead.
    }
    if (!response.ok || !result.success || !result.relativePath) {
      throw new Error(result.error ?? `HTTP ${response.status}`);
    }
    onlineAdded[catalogId] = [...addedPaths(catalogId), result.relativePath];
    if (!catalogFolders.includes(folder)) {
      catalogFolders = [...catalogFolders, folder];
    }
    document.dispatchEvent(new CustomEvent('charts-changed'));
  } catch (error) {
    console.error('Failed to add online chart:', error);
    alert(`Could not add the chart: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    onlineAdding.delete(catalogId);
    renderCatalogList();
  }
}

function renderCatalogCard(catalog: CatalogRegistryEntry): string {
  const isExpanded = expandedCatalogs.has(catalog.file);
  const chartCountText =
    catalog.chartCount !== null
      ? `${catalog.chartCount} ${catalog.chartCount === 1 ? 'chart' : 'charts'}`
      : '';

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
        ${isExpanded && catalogChartData[catalog.file] ? renderChartList(catalog.file, catalog.label) : ''}
      </div>
    </div>
  `;
}

async function toggleCatalog(catalogFile: string): Promise<void> {
  // Online groups are already in memory; there is nothing to fetch.
  if (catalogFile.startsWith(ONLINE_KEY_PREFIX)) {
    if (expandedCatalogs.has(catalogFile)) {
      expandedCatalogs.delete(catalogFile);
    } else {
      expandedCatalogs.add(catalogFile);
    }
    renderCatalogList();
    return;
  }
  if (expandedCatalogs.has(catalogFile)) {
    expandedCatalogs.delete(catalogFile);
    renderCatalogList();
    renderUpdatesSection();
    return;
  }

  expandedCatalogs.add(catalogFile);
  renderCatalogList();
  renderUpdatesSection();

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

function renderChartList(catalogFile: string, catalogLabel: string): string {
  const data = catalogChartData[catalogFile];
  if (!data?.charts || data.charts.length === 0) {
    return `<div class="catalog-empty">No charts in this catalog.</div>`;
  }
  const defaultFolder = catalogLabelToFolder(catalogLabel);

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

      let actionHtml: string;
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
          <select class="catalog-zoom-select" id="catalog-minzoom-${downloadRowId(catalogFile, chart.number)}">
            ${[4, 5, 6, 7, 8, 9, 10, 11, 12]
              .map((z) => `<option value="${z}" ${z === 4 ? 'selected' : ''}>${z}</option>`)
              .join('')}
          </select>
          <span class="catalog-zoom-dash">-</span>
          <select class="catalog-zoom-select" id="catalog-maxzoom-${downloadRowId(catalogFile, chart.number)}">
            ${[12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22]
              .map((z) => `<option value="${z}" ${z === 18 ? 'selected' : ''}>${z}</option>`)
              .join('')}
          </select>
        `
            : '';

        actionHtml = `
          ${podmanHint}
          ${zoomHtml}
          <label class="catalog-folder-label" for="catalog-folder-${downloadRowId(catalogFile, chart.number)}">Save to</label>
          <select class="catalog-folder-select" id="catalog-folder-${downloadRowId(catalogFile, chart.number)}">
            ${buildFolderOptions(defaultFolder)}
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
    `catalog-folder-${downloadRowId(catalogFile, chartNumber)}`
  ) as HTMLSelectElement | null;
  const targetFolder = folderSelect ? folderSelect.value : '/';

  const minzoomSelect = document.getElementById(
    `catalog-minzoom-${downloadRowId(catalogFile, chartNumber)}`
  ) as HTMLSelectElement | null;
  const maxzoomSelect = document.getElementById(
    `catalog-maxzoom-${downloadRowId(catalogFile, chartNumber)}`
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

/**
 * On tab init / page reload, fetch the server's current download jobs
 * and rebuild `catalogDownloadJobs` from anything that's still in
 * flight (queued / downloading / extracting). Without this the catalog
 * loses its local mapping and the row re-renders without a download
 * pill until the next user action.
 */
async function seedCatalogDownloadJobs(): Promise<void> {
  try {
    const response = await fetch(`${CATALOG_API_BASE}/download-jobs`);
    if (!response.ok) {
      return;
    }
    const jobs = (await response.json()) as DownloadJobLite[];
    for (const job of jobs) {
      if (
        job.chartName &&
        (job.status === 'queued' ||
          job.status === 'downloading' ||
          job.status === 'extracting')
      ) {
        catalogDownloadJobs[job.chartName] = job.id;
      }
    }
  } catch {
    // Network blip — first poll cycle will do the right thing once
    // the user clicks something or 2s elapses.
  }
}

function dismissConversionError(chartNumber: string): void {
  delete catalogConversionErrors[chartNumber];
  dismissedConversionErrors.add(chartNumber);
  renderCatalogList();
  renderUpdatesSection();
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
        // Re-fetch the updates list so the just-updated chart drops out of
        // the panel/badge; the in-memory catalogUpdates is otherwise stale
        // and the row keeps showing "update available" until the tab is
        // re-opened. refreshUpdateBadge() re-renders the section itself.
        void refreshUpdateBadge();
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
          renderUpdatesSection();
        }, 5000);
      } else if (progressEl) {
        const fillEl = progressEl.querySelector<HTMLElement>('.progress-fill');
        const textEl = progressEl.querySelector<HTMLElement>('span');
        const safeProgress = Number.isFinite(job.progress)
          ? Math.max(0, Math.min(100, job.progress ?? 0))
          : 0;
        // No Content-Length from the server → switch the fill into the
        // animated barberpole (CSS class), drop the explicit width.
        // Otherwise drive width by progress and clear the modifier.
        const totalKnown =
          Number.isFinite(job.totalBytes) && (job.totalBytes ?? 0) > 0;
        if (fillEl) {
          if (totalKnown) {
            fillEl.classList.remove('progress-fill-indeterminate');
            fillEl.style.width = `${safeProgress}%`;
          } else {
            fillEl.classList.add('progress-fill-indeterminate');
            fillEl.style.width = '';
          }
        }
        if (textEl) {
          if (job.status === 'extracting') {
            textEl.textContent = 'Extracting...';
          } else if (totalKnown && safeProgress > 0) {
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

      // If any conversion just finished, invalidate cached catalog
      // data and refresh. For catalogs the user already has expanded
      // we re-fetch so the card stays open with the new "Installed"
      // badge — without this the card body's empty (cached data was
      // dropped) but the .expanded class is still on, so the arrow
      // points down with nothing visible underneath.
      justFinished = Object.keys(prevConverting).filter((k) => !catalogConverting[k]);
      if (justFinished.length > 0) {
        const affectedCatalogs = new Set<string>();
        for (const chartNum of justFinished) {
          const install = catalogInstalled[chartNum];
          if (install?.catalogFile) {
            delete catalogChartData[install.catalogFile];
            if (expandedCatalogs.has(install.catalogFile)) {
              affectedCatalogs.add(install.catalogFile);
            }
          }
        }
        await loadFolders();
        await Promise.all(
          [...affectedCatalogs].map(async (catalogFile) => {
            try {
              const resp = await fetch(
                `${CATALOG_API_BASE}/catalog/${encodeURIComponent(catalogFile)}`
              );
              if (resp.ok) {
                catalogChartData[catalogFile] = (await resp.json()) as CatalogData;
              }
            } catch {
              // Network blip — the next user expand/collapse will retry.
            }
          })
        );
        // A finished conversion means the chart is now up to date — re-fetch
        // the updates list so it drops out of the panel/badge. Without this
        // the in-memory catalogUpdates stays stale and the row keeps showing
        // "update available" until the tab is re-opened.
        await refreshUpdateBadge();
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
      renderUpdatesSection();
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

/**
 * Derive a filesystem-safe folder name from a catalog label.
 * Strips path separators and illegal characters, collapses whitespace, removes
 * leading dots/spaces, and rejects a result of '.' or '..' so a label can't
 * resolve to a traversal or a hidden/relative folder. Falls back to '/' when
 * nothing usable remains.
 */
function catalogLabelToFolder(label: string | undefined | null): string {
  if (!label) {
    return '/';
  }
  const safe = label
    .replace(/[/\\:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+/, '')
    .trim();
  return safe && safe !== '.' && safe !== '..' ? safe : '/';
}

function folderDisplayName(folder: string): string {
  return folder === '/' ? '/' : `/${folder}`;
}

function buildFolderOptions(defaultFolder: string): string {
  const isNew = defaultFolder !== '/' && !catalogFolders.includes(defaultFolder);
  const options: string[] = [];

  if (isNew) {
    options.push(
      `<option value="${catalogEscapeAttr(defaultFolder)}" selected class="catalog-folder-option-new">${catalogEscapeHtml(folderDisplayName(defaultFolder))} (new)</option>`
    );
  }

  for (const folder of catalogFolders) {
    const selected = !isNew && folder === defaultFolder ? ' selected' : '';
    options.push(
      `<option value="${catalogEscapeAttr(folder)}"${selected}>${catalogEscapeHtml(folderDisplayName(folder))}</option>`
    );
  }

  return options.join('');
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

/**
 * The id suffix for a download row's controls. Two catalogs can list the
 * same chart number, so the catalog is part of it.
 */
function downloadRowId(catalogFile: string, chartNumber: string): string {
  return catalogEscapeId(JSON.stringify([catalogFile, chartNumber]));
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

window.toggleCatalog = toggleCatalog;
window.downloadCatalogChart = downloadCatalogChart;
window.dismissConversionError = dismissConversionError;
window.showConversionLog = showConversionLog;
window.closeConversionLog = closeConversionLog;
