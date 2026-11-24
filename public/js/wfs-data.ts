// WFS Data tab: the WFS servers the local WFS proxy keeps for other plugins,
// what it keeps from each, and deleting it. Seeing it needs read access;
// changing it needs an administrator, which the server enforces.

const WFS_API = '/plugins/signalk-charts-provider-simple/wfs';

interface WfsLayerView {
  typeName: string;
  areas: number;
  staleAreas: number;
  features: number;
  bytes: number;
  oldest: number | null;
  newest: number | null;
}

interface WfsSourceView {
  url: string;
  name?: string;
  answersByBox?: boolean;
  answerMargin?: number;
  idProperty?: string;
  stats: (Omit<WfsLayerView, 'typeName'> & { layers: WfsLayerView[] }) | null;
}

interface WfsOverviewView {
  enabled: boolean;
  running: boolean;
  maxAgeDays: number;
  limitBytes: number;
  store: { fileBytes: number; usedBytes: number } | null;
  sources: WfsSourceView[];
}

let wfsOverview: WfsOverviewView | null = null;
/** The URL of the source the form edits; null while it adds one. */
let wfsEditing: string | null = null;
let wfsLoad = 0;
/** How many times the view was drawn: a form drawn since a save began is not that save's. */
let wfsDrawn = 0;
let wfsBusy = false;

function wfsEsc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function wfsSize(bytes: number): string {
  if (bytes >= 1024 ** 3) {
    return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  }
  if (bytes >= 1024 ** 2) {
    return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  }
  return `${String(Math.ceil(bytes / 1024))} kB`;
}

function wfsDate(ms: number | null): string {
  return ms === null ? '–' : new Date(ms).toLocaleString();
}

function wfsCount(n: number, one: string, many: string): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

async function wfsRequest(path: string, init?: RequestInit): Promise<void> {
  const resp = await fetch(`${WFS_API}${path}`, init);
  if (!resp.ok) {
    let message = `HTTP ${String(resp.status)}`;
    try {
      const body = (await resp.json()) as { error?: string; details?: string[] };
      message = [body.error, ...(body.details ?? [])].filter(Boolean).join(': ') || message;
    } catch {
      // Not JSON: the status says it.
    }
    throw new Error(message);
  }
}

function wfsShowStatus(text: string, ok: boolean): void {
  const el = document.getElementById('wfsMessage');
  if (el) {
    el.textContent = text;
    el.className = `download-status ${ok ? 'success' : 'error'}`;
  }
}

function wfsStatusHtml(o: WfsOverviewView): string {
  if (!o.enabled) {
    return 'The proxy is off. Turn on “Keep the WFS data other plugins read” in the plugin settings.';
  }
  if (!o.running || !o.store) {
    return 'The proxy is starting.';
  }
  const limit = o.limitBytes > 0 ? ` of ${wfsSize(o.limitBytes)}` : '';
  return `Kept: <strong>${wfsSize(o.store.usedBytes)}</strong>${limit} (file ${wfsSize(
    o.store.fileBytes
  )}). An area is downloaded again when it is read after ${wfsCount(
    o.maxAgeDays,
    'day',
    'days'
  )}.`;
}

function wfsRuleText(s: WfsSourceView): string {
  const rule = s.answersByBox
    ? `Answers a box with every feature reaching it, up to ${String(s.answerMargin ?? 0)} of the box past it`
    : 'Kept areas are read again for the same box only';
  return s.idProperty ? `${rule} · features named by ${s.idProperty}` : rule;
}

function wfsSourceHtml(s: WfsSourceView, running: boolean): string {
  const st = s.stats;
  const kept = st
    ? `${wfsCount(st.areas, 'area', 'areas')}${
        st.staleAreas > 0 ? ` (${String(st.staleAreas)} due for download)` : ''
      } · ${wfsCount(st.features, 'feature', 'features')} · ${wfsSize(st.bytes)} · downloaded ${wfsDate(
        st.oldest
      )} – ${wfsDate(st.newest)}`
    : 'Nothing kept yet.';
  const layers =
    st && st.layers.length > 0
      ? `<ul class="wfs-layers">${st.layers
          .map(
            (l) =>
              `<li><code>${wfsEsc(l.typeName)}</code>: ${wfsCount(l.areas, 'area', 'areas')}, ${wfsCount(
                l.features,
                'feature',
                'features'
              )}, ${wfsSize(l.bytes)}</li>`
          )
          .join('')}</ul>`
      : '';
  const url = wfsEsc(s.url);
  return `
    <div class="wfs-source">
      <div class="wfs-source-head">
        <div class="wfs-source-title">
          <strong>${wfsEsc(s.name ?? s.url)}</strong>
          ${s.name ? `<div class="wfs-source-url">${url}</div>` : ''}
        </div>
        <div class="wfs-source-actions">
          <button class="btn btn-sm btn-secondary" data-needs="admin" data-wfs-action="edit" data-wfs-url="${url}">Edit</button>
          <button class="btn btn-sm btn-secondary" data-needs="admin" data-wfs-action="delete-data" data-wfs-url="${url}" ${
            st && running ? '' : 'disabled'
          }>Delete data</button>
          <button class="btn btn-sm btn-danger" data-needs="admin" data-wfs-action="remove" data-wfs-url="${url}">Remove</button>
        </div>
      </div>
      <div class="wfs-source-rule">${wfsEsc(wfsRuleText(s))}</div>
      <div class="wfs-source-kept">${kept}</div>
      ${layers}
    </div>`;
}

function wfsRender(): void {
  const el = document.getElementById('wfsOutput');
  const o = wfsOverview;
  if (!el || !o) {
    return;
  }
  wfsDrawn++;
  const editing = wfsEditing === null ? undefined : o.sources.find((s) => s.url === wfsEditing);
  if (wfsEditing !== null && !editing) {
    wfsEditing = null;
  }
  const f: Omit<WfsSourceView, 'stats'> = editing ?? { url: '', answersByBox: false, answerMargin: 0 };
  const anyKept = o.sources.some((s) => s.stats !== null);
  el.innerHTML = `
    <div class="download-container">
      <div class="info-section">
        <h2>WFS Data</h2>
        <p class="description">
          Other plugins on this server read the WFS servers listed here through this plugin, from
          this machine alone: each area is downloaded once, kept, and read from the server's disk
          the next time. A plugin reads any WFS server not listed directly.
        </p>
        <p class="wfs-store">${wfsStatusHtml(o)}</p>
        <div class="wfs-toolbar">
          <button class="btn btn-sm btn-secondary" data-wfs-action="refresh">Refresh</button>
          <button class="btn btn-sm btn-danger" data-needs="admin" data-wfs-action="clear" ${
            anyKept && o.running ? '' : 'disabled'
          }>Delete all kept data</button>
        </div>
        <div id="wfsMessage" class="download-status"></div>
      </div>

      <div class="info-section">
        <h2>Servers kept</h2>
        ${
          o.sources.length === 0
            ? '<p class="description">No WFS servers yet. Add one below.</p>'
            : o.sources.map((s) => wfsSourceHtml(s, o.running)).join('')
        }
      </div>

      <div class="info-section" data-needs="admin">
        <h2>${editing ? 'Edit a WFS server' : 'Add a WFS server'}</h2>
        <div class="form-group">
          <label for="wfsName">Name</label>
          <input type="text" id="wfsName" class="input-field" maxlength="120" placeholder="e.g. Depth areas" value="${wfsEsc(
            f.name ?? ''
          )}" />
        </div>
        <div class="form-group">
          <label for="wfsUrl">Base URL</label>
          <input type="text" id="wfsUrl" class="input-field" placeholder="https://example.org/geoserver/wfs" value="${wfsEsc(
            f.url
          )}" ${editing ? 'readonly' : ''} />
          <p class="form-hint">The WFS service URL with no query, as the plugins reading it use it.${
            editing ? ' To change it, remove the server and add it again.' : ''
          }</p>
        </div>
        <div class="form-group">
          <label class="checkbox-label">
            <input type="checkbox" id="wfsByBox" ${f.answersByBox ? 'checked' : ''} />
            Answers a box with every feature reaching it
          </label>
          <p class="form-hint">
            On for a server that returns every feature whose geometry reaches the box asked for, as
            GeoServer and MapServer do: each feature is kept once, and any box inside the areas kept
            is read from the store. Off: a kept area is read again only for the same box.
          </p>
        </div>
        <div class="form-group">
          <label for="wfsMargin">How far past a box it answers (share of the box size)</label>
          <input type="number" id="wfsMargin" class="input-field" min="0" max="1" step="0.01" value="${String(
            f.answerMargin ?? 0
          )}" ${f.answersByBox ? '' : 'disabled'} />
          <p class="form-hint">
            A server that reads a box in its own grid, turned against latitude and longitude, also
            returns features that far outside it: about 0.1 for a grid turned by 6°, a little more
            to be safe. 0 for a server that answers the box exactly.
          </p>
        </div>
        <div class="form-group">
          <label for="wfsIdProperty">Feature property that identifies a feature</label>
          <input type="text" id="wfsIdProperty" class="input-field" maxlength="120" placeholder="Empty when features have an id" value="${wfsEsc(
            f.idProperty ?? ''
          )}" />
          <p class="form-hint">Only for a server whose GeoJSON features have no id.</p>
        </div>
        <p class="form-hint">Changing how a server answers, or its feature property, deletes what was kept from it.</p>
        <button class="btn btn-primary" data-needs="admin" data-wfs-action="save" ${wfsBusy ? 'disabled' : ''}>${
          editing ? 'Save' : 'Add WFS server'
        }</button>
        ${editing ? '<button class="btn btn-secondary" data-wfs-action="cancel-edit">Cancel</button>' : ''}
      </div>
    </div>`;
}

/**
 * Reads the overview again and draws it. Returns why it could not, else undefined: a view
 * drawn before stays, with the reason under its Refresh button; with none, a Retry button.
 */
async function wfsRefresh(): Promise<string | undefined> {
  const el = document.getElementById('wfsOutput');
  if (!el) {
    return undefined;
  }
  const load = ++wfsLoad;
  try {
    const resp = await fetch(WFS_API);
    if (!resp.ok) {
      throw new Error(`HTTP ${String(resp.status)}`);
    }
    const overview = (await resp.json()) as WfsOverviewView;
    if (load === wfsLoad) {
      wfsOverview = overview;
      wfsRender();
    }
    return undefined;
  } catch (err) {
    const why = `Could not read the WFS data: ${err instanceof Error ? err.message : String(err)}`;
    if (load !== wfsLoad) {
      return why;
    }
    if (wfsOverview && document.getElementById('wfsMessage')) {
      wfsShowStatus(why, false);
    } else {
      el.innerHTML = `<div class="empty-state"><div class="empty-state-text">${wfsEsc(why)}</div>
        <button class="btn btn-sm btn-secondary" data-wfs-action="refresh">Retry</button></div>`;
    }
    return why;
  }
}

/** Reads the overview again after `done`, saying so; returns why it could not, else undefined. */
async function wfsRefreshAfter(done: string): Promise<string | undefined> {
  const why = await wfsRefresh();
  wfsShowStatus(why === undefined ? done : `${done} ${why}`, why === undefined);
  return why;
}

function wfsFormValue(id: string): string {
  return (document.getElementById(id) as HTMLInputElement | null)?.value.trim() ?? '';
}

async function wfsSave(): Promise<void> {
  const answersByBox =
    (document.getElementById('wfsByBox') as HTMLInputElement | null)?.checked === true;
  const margin = Number(wfsFormValue('wfsMargin') || '0');
  if (answersByBox && !(margin >= 0 && margin <= 1)) {
    wfsShowStatus('The margin is a share of the box size, from 0 to 1.', false);
    return;
  }
  const name = wfsFormValue('wfsName');
  const idProperty = wfsFormValue('wfsIdProperty');
  const body = {
    url: wfsFormValue('wfsUrl'),
    ...(name ? { name } : {}),
    answersByBox,
    ...(answersByBox ? { answerMargin: margin } : {}),
    ...(idProperty ? { idProperty } : {})
  };
  const editing = wfsEditing !== null;
  await wfsRequest('/sources', {
    method: editing ? 'PUT' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const edited = wfsEditing;
  const drawn = wfsDrawn;
  wfsEditing = null;
  const why = await wfsRefreshAfter(
    editing ? 'Saved.' : 'Added. Plugins reading it now go through the proxy.'
  );
  // Not drawn again meanwhile, the form is still the edit form of that server: a save again
  // is an edit. One drawn since, by another refresh, is the form its state says.
  if (why !== undefined && wfsDrawn === drawn) {
    wfsEditing = edited;
  }
}

async function wfsAct(action: string, url: string | undefined): Promise<void> {
  const label = (u: string): string =>
    wfsOverview?.sources.find((s) => s.url === u)?.name ?? u;
  switch (action) {
    case 'refresh':
      await wfsRefresh();
      return;
    case 'save':
      await wfsSave();
      return;
    case 'edit':
      wfsEditing = url ?? null;
      wfsRender();
      document.getElementById('wfsName')?.focus();
      return;
    case 'cancel-edit':
      wfsEditing = null;
      wfsRender();
      return;
    case 'delete-data':
      if (url === undefined || !confirm(`Delete what is kept from ${label(url)}?`)) {
        return;
      }
      await wfsRequest(`/data?url=${encodeURIComponent(url)}`, { method: 'DELETE' });
      await wfsRefreshAfter('Deleted. Its areas are downloaded again when next read.');
      return;
    case 'remove':
      if (
        url === undefined ||
        !confirm(`Remove ${label(url)}? What is kept from it is deleted, and plugins read it directly.`)
      ) {
        return;
      }
      await wfsRequest(`/sources?url=${encodeURIComponent(url)}`, { method: 'DELETE' });
      await wfsRefreshAfter('Removed.');
      return;
    case 'clear':
      if (!confirm('Delete everything kept from every WFS server?')) {
        return;
      }
      await wfsRequest('/data', { method: 'DELETE' });
      await wfsRefreshAfter('Deleted. Areas are downloaded again when next read.');
      return;
  }
}

document.addEventListener('click', (event) => {
  const target = event.target instanceof Element ? event.target : null;
  const button = target?.closest<HTMLElement>('#wfsOutput [data-wfs-action]');
  const action = button?.dataset['wfsAction'];
  if (!button || action === undefined || wfsBusy) {
    return;
  }
  wfsBusy = true;
  wfsAct(action, button.dataset['wfsUrl'])
    .catch((err: unknown) => {
      wfsShowStatus(err instanceof Error ? err.message : String(err), false);
    })
    .finally(() => {
      wfsBusy = false;
      // Drawn again while busy, the form's button came out disabled.
      const save = document.querySelector<HTMLButtonElement>('#wfsOutput [data-wfs-action="save"]');
      if (save) {
        save.disabled = false;
      }
    });
});

document.addEventListener('change', (event) => {
  const target = event.target;
  if (target instanceof HTMLInputElement && target.id === 'wfsByBox') {
    const margin = document.getElementById('wfsMargin') as HTMLInputElement | null;
    if (margin) {
      margin.disabled = !target.checked;
    }
  }
});

window.handleWfsTabActive = (): void => {
  void wfsRefresh();
};
