// Online Charts and Satellite tabs — the merged catalog's curated online
// charts, which stream from their provider, plus a form for adding a service
// by URL. Satellite imagery has a tab of its own so the sources can be
// compared side by side; both tabs are an OnlineChartPanel.

const ONLINE_API_BASE = '/plugins/signalk-charts-provider-simple';
// A folder of its own means online charts can be switched off together
// (e.g. offshore, with no internet) by disabling one folder.
const ONLINE_CHARTS_FOLDER = 'Online Charts';
const ONLINE_ISSUES_URL =
  'https://github.com/dirkwa/signalk-charts-provider-simple/issues/new?template=catalog-problem.yml';
const IMAGERY_CATEGORY = 'imagery';

/** A curated online chart, as the catalog lists it. */
interface OnlineCatalogChart {
  id: string;
  name: string;
  description: string;
  category: string;
  provider: string;
  license: string;
  licenseUrl: string;
  notForNavigation?: boolean;
  bbox: number[];
  /** Where the chart is useful, when narrower than bbox; for Near me only. */
  coverage?: unknown;
  chart: { type: string };
  temporal?: { kind: string };
  /** Whether the server keeps the tiles it fetches; decided by the server, which keeps them. */
  keptOffline?: boolean;
}

interface OnlineRegistryResponse {
  online?: OnlineCatalogChart[];
  /** catalogId → chart-folder paths of its .onlinechart.json files. */
  onlineAdded?: Record<string, string[]>;
  position?: { latitude: number; longitude: number } | null;
  sources?: { online?: { issues?: string } } | null;
}

/** What these tabs need of an added chart's Manage Charts entry. */
interface OnlineLocalChart {
  name: string;
  chartName?: string;
  enabled?: boolean;
  /** False when the chart's folder (or an ancestor) is disabled. */
  folderEnabled?: boolean;
  online?: {
    catalogId: string;
    available?: boolean;
    areaDownload?: boolean;
    areaDownloadLimits?: AreaDownloadLimits;
    keptOffline?: boolean;
    chartId?: string;
    minzoom?: number | null;
    maxzoom?: number | null;
  };
}

interface OnlineLocalChartsResponse {
  charts?: OnlineLocalChart[];
  folders?: string[];
}

interface OnlineFilters {
  categories: string[];
  nearMe: boolean;
}

interface OnlineChartPanelConfig {
  /** Prefix of the panel's element ids. */
  id: string;
  outputId: string;
  storageKey: string;
  /** Section labels in display order; a category not listed goes under Other. */
  sections: Record<string, string>;
  includes: (chart: OnlineCatalogChart) => boolean;
  intro: string;
  empty: string;
  /** Extra markup after the list. */
  footer?: string;
}

function onlineEscape(str: string | undefined | null): string {
  return (str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Percent-encoded with '%' swapped for '__': a valid, collision-free HTML id.
function onlineEscapeId(str: string): string {
  return encodeURIComponent(str).replace(/%/g, '__');
}

const ONLINE_OTHER_SECTION = 'other';

interface OnlineData {
  registry: OnlineRegistryResponse;
  local: OnlineLocalChartsResponse;
}

// One fetch of both endpoints serves both tabs; a change to the charts drops it.
let onlineDataRequest: Promise<OnlineData> | null = null;

function fetchOnlineData(): Promise<OnlineData> {
  onlineDataRequest ??= (async () => {
    const [registryResponse, localResponse] = await Promise.all([
      fetch(`${ONLINE_API_BASE}/catalog-registry`),
      fetch(`${ONLINE_API_BASE}/local-charts`)
    ]);
    if (!registryResponse.ok || !localResponse.ok) {
      throw new Error(
        `HTTP ${String(registryResponse.ok ? localResponse.status : registryResponse.status)}`
      );
    }
    return {
      registry: (await registryResponse.json()) as OnlineRegistryResponse,
      local: (await localResponse.json()) as OnlineLocalChartsResponse
    };
  })();
  const request = onlineDataRequest;
  // A failed load is retried on the next activation rather than kept.
  request.catch(() => {
    if (onlineDataRequest === request) {
      onlineDataRequest = null;
    }
  });
  return request;
}

/** Whether a chart in Manage Charts is served, so its offline area can be opened. */
function onlineChartServed(chart: OnlineLocalChart): boolean {
  return (
    chart.enabled !== false && chart.folderEnabled !== false && chart.online?.available !== false
  );
}

document.addEventListener('charts-changed', () => {
  onlineDataRequest = null;
});

class OnlineChartPanel {
  private initialized = false;
  private loadSeq = 0;
  private loadFailed = false;
  private charts: OnlineCatalogChart[] = [];
  private added: Record<string, string[]> = {};
  private issuesUrl = ONLINE_ISSUES_URL;
  private position: { latitude: number; longitude: number } | null = null;
  folders: string[] = ['/'];
  /** catalogId → its first chart in Manage Charts, for the offline-area button. */
  private localCharts = new Map<string, OnlineLocalChart>();
  private readonly adding = new Set<string>();
  private filters: OnlineFilters;

  constructor(private readonly config: OnlineChartPanelConfig) {
    this.filters = this.loadFilters();
    // Deleting or moving a chart in Manage Charts changes what is added.
    document.addEventListener('charts-changed', () => {
      if (this.initialized) {
        void this.load();
      }
    });
  }

  activate(): void {
    if (!this.initialized) {
      this.init();
    }
    // Each visit picks up charts changed elsewhere since the last.
    onlineDataRequest = null;
    void this.load();
  }

  private el(suffix: string): HTMLElement | null {
    return document.getElementById(`${this.config.id}${suffix}`);
  }

  private loadFilters(): OnlineFilters {
    let saved: Record<string, unknown> = {};
    try {
      const raw: unknown = JSON.parse(localStorage.getItem(this.config.storageKey) ?? 'null');
      if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
        saved = raw as Record<string, unknown>;
      }
    } catch {
      // Unreadable or unavailable storage: start with no filters.
    }
    return {
      categories: Array.isArray(saved.categories)
        ? saved.categories.filter((c): c is string => typeof c === 'string')
        : [],
      nearMe: saved.nearMe === true
    };
  }

  private saveFilters(): void {
    try {
      localStorage.setItem(this.config.storageKey, JSON.stringify(this.filters));
    } catch {
      // Remembering filters is a convenience; private windows may refuse it.
    }
  }

  private init(): void {
    this.initialized = true;
    const output = document.getElementById(this.config.outputId);
    if (!output) {
      return;
    }
    const id = this.config.id;
    output.innerHTML = `
      <div class="catalog-container">
        <div id="${id}SourceNote" class="catalog-source-note"></div>
        <div id="${id}FilterBar"></div>
        <div id="${id}List">
          <div class="catalog-loading">
            <div class="spinner"></div>
            <div>Loading charts...</div>
          </div>
        </div>
      </div>
      ${this.config.footer ?? ''}
    `;
    this.renderSourceNote();

    this.el('FilterBar')?.addEventListener('click', (ev) => {
      const target = (ev.target as HTMLElement | null)?.closest<HTMLButtonElement>(
        '[data-online-filter]'
      );
      if (target && !target.disabled) {
        this.applyFilter(target.dataset['onlineFilter'] ?? '', target.dataset['filterValue'] ?? '');
      }
    });

    this.el('List')?.addEventListener('click', (ev) => {
      const target = ev.target as HTMLElement | null;
      if (!target) {
        return;
      }
      const add = target.closest<HTMLElement>('[data-online-add]');
      if (add?.dataset['onlineAdd']) {
        void this.addChart(add.dataset['onlineAdd']);
        return;
      }
      const area = target.closest<HTMLElement>('[data-online-area]');
      if (area?.dataset['onlineArea']) {
        this.openArea(area.dataset['onlineArea']);
        return;
      }
      if (target.closest('[data-online-filter="clear"]')) {
        this.applyFilter('clear', '');
      }
    });
  }

  /** Loads the curated charts and what is added; never blanks a list that loaded before. */
  async load(): Promise<void> {
    const seq = ++this.loadSeq;
    try {
      const { registry, local } = await fetchOnlineData();
      if (seq !== this.loadSeq) {
        return;
      }
      this.loadFailed = false;
      this.charts = (registry.online ?? []).filter((c) => this.config.includes(c));
      this.added = registry.onlineAdded ?? {};
      this.position = registry.position ?? null;
      const issues = registry.sources?.online?.issues;
      this.issuesUrl = issues && /^https:\/\//.test(issues) ? issues : ONLINE_ISSUES_URL;
      this.folders = ['/', ...(local.folders ?? []).filter((f) => f !== '/')];
      this.localCharts = new Map();
      // A catalog chart can be added more than once; prefer a copy that is served.
      for (const chart of local.charts ?? []) {
        const catalogId = chart.online?.catalogId;
        const kept = catalogId ? this.localCharts.get(catalogId) : undefined;
        if (catalogId && (!kept || (!onlineChartServed(kept) && onlineChartServed(chart)))) {
          this.localCharts.set(catalogId, chart);
        }
      }
    } catch (error) {
      console.error('Failed to load online charts:', error);
      if (seq !== this.loadSeq) {
        return;
      }
      this.loadFailed = true;
    }
    this.renderSourceNote();
    this.renderFilterBar();
    this.renderList();
    this.onLoaded?.();
  }

  /** Called after every load, for whatever the tab shows beside the list. */
  onLoaded?: () => void;

  private renderSourceNote(): void {
    const el = this.el('SourceNote');
    if (el) {
      el.innerHTML = `${this.config.intro} Problems with these charts can be reported
        <a href="${onlineEscape(this.issuesUrl)}" target="_blank" rel="noopener">here</a>.`;
    }
  }

  private sectionOf(category: string): string {
    return Object.hasOwn(this.config.sections, category) ? category : ONLINE_OTHER_SECTION;
  }

  private sectionLabel(section: string): string {
    return Object.hasOwn(this.config.sections, section)
      ? (this.config.sections[section] ?? section)
      : 'Other Charts';
  }

  /** Sections that have charts, or a saved filter that must stay switchable off. */
  private sectionOrder(): string[] {
    return [...Object.keys(this.config.sections), ONLINE_OTHER_SECTION].filter(
      (section) =>
        this.charts.some((c) => this.sectionOf(c.category) === section) ||
        this.filters.categories.includes(section)
    );
  }

  private static nearBox(chart: OnlineCatalogChart): number[] | undefined {
    // A satellite's full disk is its bbox, but only its useful coverage
    // should count as "near".
    return window.isBoundingBox(chart.coverage) ? chart.coverage : chart.bbox;
  }

  private passes(chart: OnlineCatalogChart, skip?: 'categories' | 'nearMe'): boolean {
    const f = this.filters;
    if (
      skip !== 'categories' &&
      f.categories.length > 0 &&
      !f.categories.includes(this.sectionOf(chart.category))
    ) {
      return false;
    }
    // Without a position Near me can't apply (and its button is disabled), so
    // a saved "on" must not hide everything.
    if (
      skip !== 'nearMe' &&
      f.nearMe &&
      this.position !== null &&
      !window.isNearPosition(OnlineChartPanel.nearBox(chart), this.position)
    ) {
      return false;
    }
    return true;
  }

  private static filterButton(
    group: string,
    value: string,
    label: string,
    active: boolean,
    count: number | null,
    extra = ''
  ): string {
    return `
      <button type="button" class="category-filter-btn ${active ? 'active' : ''}" aria-pressed="${active ? 'true' : 'false'}"
              data-online-filter="${onlineEscape(group)}" data-filter-value="${onlineEscape(value)}" ${extra}>
        ${onlineEscape(label)}
        ${count !== null ? `<span class="category-count">${String(count)}</span>` : ''}
      </button>`;
  }

  private renderFilterBar(): void {
    const bar = this.el('FilterBar');
    if (!bar) {
      return;
    }
    const f = this.filters;
    const count = (skip: 'categories' | 'nearMe', matches: (c: OnlineCatalogChart) => boolean) =>
      this.charts.filter((c) => this.passes(c, skip) && matches(c)).length;
    const sections = this.sectionOrder();
    // One section needs no section filter.
    const categories =
      sections.length > 1
        ? `${sections
            .map((section) =>
              OnlineChartPanel.filterButton(
                'categories',
                section,
                this.sectionLabel(section),
                f.categories.includes(section),
                count('categories', (c) => this.sectionOf(c.category) === section)
              )
            )
            .join('')}
          <span class="catalog-filter-divider"></span>`
        : '';
    const position = this.position;
    // The reason Near me is off must be readable on a touch screen, where a
    // tooltip never shows, so it goes in the label.
    const nearMe = OnlineChartPanel.filterButton(
      'nearMe',
      '',
      position ? 'Near me' : 'Near me (no position yet)',
      f.nearMe && position !== null,
      position
        ? count('nearMe', (c) => window.isNearPosition(OnlineChartPanel.nearBox(c), position))
        : null,
      position ? 'title="Charts that cover the boat\'s current position"' : 'disabled'
    );
    bar.innerHTML = `
      <div class="category-filter catalog-filter-categories">
        ${categories}
        ${nearMe}
      </div>`;
  }

  private applyFilter(group: string, value: string): void {
    const f = this.filters;
    if (group === 'categories') {
      f.categories = f.categories.includes(value)
        ? f.categories.filter((c) => c !== value)
        : [...f.categories, value];
    } else if (group === 'nearMe') {
      f.nearMe = !f.nearMe;
    } else if (group === 'clear') {
      this.filters = { categories: [], nearMe: false };
    } else {
      return;
    }
    this.saveFilters();
    this.renderFilterBar();
    this.renderList();
  }

  private renderList(): void {
    const list = this.el('List');
    if (!list) {
      return;
    }
    if (this.charts.length === 0) {
      list.innerHTML = this.loadFailed
        ? '<div class="catalog-error">Failed to load the charts from the Signal K server. Reload the page to try again.</div>'
        : `<div class="catalog-error">${this.config.empty}</div>`;
      return;
    }
    const charts = this.charts.filter((c) => this.passes(c));
    if (charts.length === 0) {
      list.innerHTML = `
        <div class="catalog-empty">
          No charts match these filters.
          <button type="button" class="catalog-filter-more" data-online-filter="clear" data-filter-value="">Clear filters</button>
        </div>`;
      return;
    }
    // Re-rendering must not undo a folder picked on a row not yet added.
    const picked = new Map(
      Array.from(list.querySelectorAll<HTMLSelectElement>('select.catalog-folder-select')).map(
        (select) => [select.id, select.value]
      )
    );
    list.innerHTML = this.sectionOrder()
      .map((section) => {
        const rows = charts.filter((c) => this.sectionOf(c.category) === section);
        if (rows.length === 0) {
          return '';
        }
        return `
          <section class="catalog-section">
            <h2 class="catalog-section-title">${onlineEscape(this.sectionLabel(section))}</h2>
            <div class="catalog-card online-chart-list">
              ${rows.map((chart) => this.renderRow(chart)).join('')}
            </div>
          </section>`;
      })
      .join('');
    for (const [id, value] of picked) {
      const select = document.getElementById(id) as HTMLSelectElement | null;
      if (select && Array.from(select.options).some((o) => o.value === value)) {
        select.value = value;
      }
    }
  }

  /** Where an online chart has been added; an own-key lookup, so no id reads an inherited value. */
  private addedPaths(catalogId: string): string[] {
    return Object.hasOwn(this.added, catalogId) ? (this.added[catalogId] ?? []) : [];
  }

  folderOptions(): string {
    const folders = this.folders.includes(ONLINE_CHARTS_FOLDER)
      ? this.folders
      : [...this.folders, ONLINE_CHARTS_FOLDER];
    return folders
      .map((folder) => {
        const label = folder === '/' ? '/' : `/${folder}`;
        const isNew = !this.folders.includes(folder);
        return `<option value="${onlineEscape(folder)}"${folder === ONLINE_CHARTS_FOLDER ? ' selected' : ''}${isNew ? ' class="catalog-folder-option-new"' : ''}>${onlineEscape(label)}${isNew ? ' (new)' : ''}</option>`;
      })
      .join('');
  }

  private renderRow(chart: OnlineCatalogChart): string {
    const added = this.addedPaths(chart.id).length > 0;
    const adding = this.adding.has(chart.id);
    const rowId = `${this.config.id}-${onlineEscapeId(chart.id)}`;
    const licenseLink = /^https:\/\//.test(chart.licenseUrl)
      ? `<a href="${onlineEscape(chart.licenseUrl)}" target="_blank" rel="noopener">${onlineEscape(chart.license)}</a>`
      : onlineEscape(chart.license);
    const badges = [
      chart.keptOffline
        ? '<span class="online-badge offline" title="Served through your server, which keeps every tile it fetches: areas already viewed work without internet">Kept offline</span>'
        : '<span class="online-badge" title="Streamed from its provider; shows nothing without an internet connection">Needs internet</span>',
      chart.temporal
        ? `<span class="online-badge live" title="Updates automatically; recent images can be played back">${chart.temporal.kind === 'forecast' ? 'Forecast' : 'Live'}</span>`
        : '',
      chart.notForNavigation ? '<span class="online-badge caution">Not for navigation</span>' : ''
    ].join('');
    let action: string;
    if (added) {
      const localChart = this.localCharts.get(chart.id);
      // A switched-off chart is not served, so its offline area cannot be reached.
      const local =
        localChart && onlineChartServed(localChart) ? localChart.online : undefined;
      let area = '';
      if (local?.chartId && local.areaDownload) {
        area = `<button class="btn btn-sm btn-primary" data-online-area="${onlineEscape(chart.id)}" title="Download an area to use without internet">Offline area</button>`;
      } else if (local?.chartId && local.keptOffline) {
        area = `<button class="btn btn-sm btn-secondary" data-online-area="${onlineEscape(chart.id)}" title="See and delete the tiles kept on the server">Kept tiles</button>`;
      }
      action = `<span class="installed-badge">Added</span>${area}`;
    } else {
      action = `
        <label class="catalog-folder-label" for="${rowId}-folder">Save to</label>
        <select class="catalog-folder-select" id="${rowId}-folder">
          ${this.folderOptions()}
        </select>
        <button class="btn-catalog-download" data-online-add="${onlineEscape(chart.id)}" ${adding ? 'disabled' : ''}>
          ${adding ? 'Adding…' : 'Add'}
        </button>`;
    }
    return `
      <div class="catalog-chart-row online-chart-row">
        <div class="chart-row-info">
          <div class="chart-row-number">${onlineEscape(chart.name)} ${badges}</div>
          <div class="chart-row-title">${onlineEscape(chart.description)}</div>
          <div class="online-row-source">${onlineEscape(chart.provider)} · ${licenseLink}</div>
        </div>
        <div class="chart-row-actions">${action}</div>
      </div>`;
  }

  private openArea(catalogId: string): void {
    const chart = this.localCharts.get(catalogId);
    const online = chart?.online;
    if (!chart || !online?.chartId) {
      return;
    }
    void window.showOfflineArea(
      online.chartId,
      chart.chartName ?? chart.name,
      online.minzoom ?? null,
      online.maxzoom ?? null,
      online.areaDownload === true,
      online.areaDownloadLimits ?? {}
    );
  }

  private async addChart(catalogId: string): Promise<void> {
    if (this.adding.has(catalogId)) {
      return;
    }
    const folderEl = document.getElementById(
      `${this.config.id}-${onlineEscapeId(catalogId)}-folder`
    ) as HTMLSelectElement | null;
    const folder = folderEl?.value ?? ONLINE_CHARTS_FOLDER;
    this.adding.add(catalogId);
    this.renderList();
    let added = false;
    try {
      const response = await fetch(`${ONLINE_API_BASE}/online-charts`, {
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
        throw new Error(result.error ?? `HTTP ${String(response.status)}`);
      }
      this.added[catalogId] = [...this.addedPaths(catalogId), result.relativePath];
      added = true;
    } catch (error) {
      console.error('Failed to add online chart:', error);
      alert(`Could not add the chart: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.adding.delete(catalogId);
      this.renderList();
    }
    // Reloads both tabs, which picks up the chart's offline-area details.
    if (added) {
      document.dispatchEvent(new CustomEvent('charts-changed'));
    }
  }
}

const KEPT_OFFLINE_INTRO = `These charts stream from their provider and need an internet connection,
  except where they say <strong>Kept offline</strong>: then your server keeps every tile it
  fetches, and areas already viewed work without internet.`;

const onlineChartsPanel = new OnlineChartPanel({
  id: 'online',
  outputId: 'onlineChartsOutput',
  storageKey: 'onlineChartFilters',
  sections: {
    navigation: 'Navigation Charts',
    depth: 'Depth & Seabed',
    weather: 'Weather',
    basemap: 'Base Maps',
    overlay: 'Marine Overlays'
  },
  includes: (chart) => chart.category !== IMAGERY_CATEGORY,
  intro: `${KEPT_OFFLINE_INTRO} Satellite imagery has a tab of its own.`,
  empty: 'No online charts yet. Download the chart catalog in the Chart Catalog tab.',
  footer: `
    <div class="download-container">
      <div class="info-section">
        <h2>Add an Online Chart by URL</h2>
        <p class="description">
          Show a tile service or WMS that the list above does not have, such as your country's
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
            The server then keeps every tile it fetches, and an area can be downloaded ahead of a
            passage. Only tick this if the provider's terms allow storing its tiles.
          </p>
        </div>

        <button onclick="addOnlineChartByUrl()" class="btn btn-primary">Add Online Chart</button>

        <div id="onlineChartStatus" class="download-status"></div>
      </div>
    </div>
  `
});
onlineChartsPanel.onLoaded = () => {
  fillOnlineChartFolders(onlineChartsPanel.folderOptions());
};

// Satellite and aerial imagery, side by side so the sources can be compared:
// sharper, newer, cloud-free, or free for any use. Weather satellites stay
// with the weather.
const satellitePanel = new OnlineChartPanel({
  id: 'satellite',
  outputId: 'satelliteOutput',
  storageKey: 'satelliteChartFilters',
  sections: { [IMAGERY_CATEGORY]: 'Satellite & Aerial Imagery' },
  includes: (chart) => chart.category === IMAGERY_CATEGORY,
  intro: `Satellite and aerial images of the land and shallow water, to show beneath or instead
    of a chart. They differ in sharpness, age, cloud cover and licence; each says where it comes
    from. ${KEPT_OFFLINE_INTRO}`,
  empty: 'No satellite imagery yet. Download the chart catalog in the Chart Catalog tab.'
});

window.handleOnlineChartsTabActive = function (): void {
  onlineChartsPanel.activate();
};

window.handleSatelliteTabActive = function (): void {
  satellitePanel.activate();
};

/** Online charts go to their own folder unless the user picks another. */
function fillOnlineChartFolders(options: string): void {
  const select = document.getElementById('onlineChartFolder') as HTMLSelectElement | null;
  if (!select) {
    return;
  }
  const previous = select.value;
  select.innerHTML = options;
  if (previous && Array.from(select.options).some((o) => o.value === previous)) {
    select.value = previous;
  }
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
    statusDiv.innerHTML = `<div class="error-message">${onlineEscape(message)}</div>`;
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
    const response = await fetch(`${ONLINE_API_BASE}/online-charts/custom`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        folder: onlineChartInput('onlineChartFolder') || ONLINE_CHARTS_FOLDER,
        chart
      })
    });
    const result = (await response.json().catch(() => ({}))) as {
      success?: boolean;
      error?: string;
    };
    if (!response.ok || !result.success) {
      showError(result.error ?? `Failed to add the chart (HTTP ${String(response.status)})`);
      return;
    }
    statusDiv.innerHTML = `<div class="success-message">Added ${onlineEscape(name)}. It is listed in Manage Charts.</div>`;
    for (const id of ['onlineChartName', 'onlineChartUrl', 'onlineChartLayers']) {
      const input = document.getElementById(id) as HTMLInputElement | null;
      if (input) {
        input.value = '';
      }
    }
    document.dispatchEvent(new CustomEvent('charts-changed'));
  } catch (error) {
    showError(`Failed to add the chart: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// Expose inline-onclick handlers used by the rendered HTML.
window.addOnlineChartByUrl = addOnlineChartByUrl;
window.onlineChartTypeChanged = onlineChartTypeChanged;
