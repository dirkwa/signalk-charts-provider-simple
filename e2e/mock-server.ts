/**
 * Standalone test harness that serves the chart-provider frontend with a
 * mock backend.  Lets Playwright drive the UI without booting a real
 * SignalK server: the routes the frontend calls are stubbed here, the
 * static `public/` tree is served as-is, and tests interact with the
 * mock state via test-only `__mock` endpoints to drive scenarios.
 *
 * Why a custom harness vs a real signalk-server: speed + scope.  Real
 * SignalK boots in ~5–10s and requires plugin-config-data layouts on
 * disk; this server starts instantly, the mock state is fully in
 * memory, and we can drive UI states (mid-conversion, errored chart,
 * empty list, …) directly from a test without coordinating with a
 * real conversion pipeline.
 *
 * Mounted at the same `/plugins/signalk-charts-provider-simple/` path
 * the real SignalK uses, so the frontend's `API_BASE` URLs resolve
 * unchanged.  No frontend code changes needed for tests.
 */

import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import type { Request, Response } from 'express';

// ESM equivalent of CommonJS `__dirname` — resolved from the module URL.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Mock state.  Each top-level key is what the corresponding REST
// endpoint returns.  Tests overwrite via PUT /__mock/state, partial
// updates merge; full reset via POST /__mock/reset.
interface RegistryStatusMock {
  status: 'ok' | 'rate_limited' | 'error' | 'never';
  isRateLimited: boolean;
  remaining: number | null;
  resetAt: number | null;
  retryAfter: number | null;
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  httpStatus: number | null;
}

interface MockState {
  registry: {
    file: string;
    label: string;
    category: string;
    chartCount: number | null;
    cachedAt: string | null;
  }[];
  // Status surfaced with the registry; tests set this to drive rate-limit UI.
  registryStatus: RegistryStatusMock;
  // When set, POST /catalog-registry/refresh swaps the registry to this (and
  // optionally a new status) — lets a test script a refresh outcome.
  refreshRegistry: MockState['registry'] | null;
  refreshStatus: RegistryStatusMock | null;
  installed: Record<
    string,
    { catalogFile: string; zipfile_datetime_iso8601: string; installedAt: string }
  >;
  converting: Record<string, true>;
  conversions: Record<string, { status: string; message: string; log: string[] }>;
  catalogs: Record<
    string,
    {
      fetchedAt: string;
      catalogFile: string;
      header: { title: string };
      charts: {
        number: string;
        title: string;
        format: string;
        zipfile_location: string;
        zipfile_datetime_iso8601: string;
        urlClassification?: { supported: boolean; format: string; label: string };
      }[];
    }
  >;
  localCharts: {
    charts: {
      relativePath: string;
      name: string;
      folder: string;
      enabled: boolean;
      folderEnabled?: boolean;
      downloading?: boolean;
      converting?: boolean;
    }[];
    folders: string[];
    folderStates?: Record<string, { enabled: boolean; effectiveEnabled: boolean }>;
    basePath: string;
  };
  downloadJobs: {
    id: string;
    url: string;
    status: string;
    progress: number;
    downloadedBytes: number;
    error?: string;
  }[];
  catalogUpdates: {
    chartNumber: string;
    catalogFile: string;
    title: string;
    installedDate: string;
    availableDate: string;
    downloadUrl: string;
    installedFolder: string;
  }[];
  // When set, POST /catalog/download responds with this HTTP status and an
  // error body so tests can exercise the update-failure path.
  downloadFailStatus: number | null;
  s57PodmanAvailable: boolean;
  podmanVersion: string | null;
  containerRuntimeEngine: string | null;
}

const okStatus: RegistryStatusMock = {
  status: 'ok',
  isRateLimited: false,
  remaining: 50,
  resetAt: null,
  retryAfter: null,
  lastAttemptAt: null,
  lastSuccessAt: null,
  httpStatus: 200
};

const initialState: MockState = {
  registry: [],
  registryStatus: okStatus,
  refreshRegistry: null,
  refreshStatus: null,
  installed: {},
  converting: {},
  conversions: {},
  catalogs: {},
  localCharts: {
    charts: [],
    folders: ['/'],
    folderStates: { '/': { enabled: true, effectiveEnabled: true } },
    basePath: '/tmp/charts'
  },
  downloadJobs: [],
  catalogUpdates: [],
  downloadFailStatus: null,
  s57PodmanAvailable: true,
  podmanVersion: 'podman version 5.4.2',
  containerRuntimeEngine: 'podman'
};

let state: MockState = structuredClone(initialState);

export function startMockServer(
  port: number
): Promise<{ url: string; close: () => Promise<void> }> {
  // Resolve `public/` once.  Compiled mock-server lives at
  // `dist-e2e/e2e/mock-server.js`; `public/` is two levels up at the
  // repo root.
  const publicDir = path.resolve(__dirname, '..', '..', 'public');

  const app = express();
  app.use(express.json({ limit: '10mb' }));

  const PLUGIN_BASE = '/plugins/signalk-charts-provider-simple';

  // Routes hang off an express.Router instead of the bare `app` for two
  // reasons: it's the same shape a real Signal K plugin uses (the
  // server hands plugins a Router via registerWithRouter), and it
  // sidesteps the SignalK plugin-CI `app.<verb>(...)` lint rule that
  // would otherwise (correctly) flag a real plugin doing this — but
  // false-positive on this test harness, which IS a server, not a
  // plugin.
  const router = express.Router();

  // ---- Test-only mock control endpoints --------------------------------
  // POST /__mock/reset → clear state to initialState
  router.post('/__mock/reset', (_req: Request, res: Response) => {
    state = structuredClone(initialState);
    res.json({ ok: true });
  });
  // PUT /__mock/state → shallow-merge body into state.  Top-level keys
  // are replaced wholesale; nested objects are NOT deep-merged
  // (a request that sets `conversions: { '2': … }` fully replaces
  // `state.conversions`).  Tests that need to add to a nested map
  // should read state out via the GET endpoints first or send the
  // complete map.  Kept shallow on purpose — deep-merge surprises
  // are worse than the explicit replace.
  router.put('/__mock/state', (req: Request, res: Response) => {
    state = { ...state, ...(req.body as Partial<MockState>) };
    res.json({ ok: true });
  });

  // ---- Frontend REST stubs ---------------------------------------------
  // The frontend hits these at API_BASE.  Each returns whatever the
  // current mock state says; the test sets state ahead of time.
  router.get(`${PLUGIN_BASE}/local-charts`, (_req, res) => {
    res.json(state.localCharts);
  });

  // POST /folders/toggle → flip a folder's enabled flag and cascade the
  // effective state to descendant folders and their charts, mirroring the
  // real plugin's ancestor-aware semantics closely enough for UI tests.
  router.post(`${PLUGIN_BASE}/folders/toggle`, (req, res) => {
    const { folderPath, enabled } = req.body as { folderPath?: string; enabled?: boolean };
    if (!folderPath || typeof enabled !== 'boolean') {
      res.status(400).json({ error: 'folderPath and enabled required' });
      return;
    }
    const folderStates = (state.localCharts.folderStates ??= {});
    const prior = folderStates[folderPath] ?? { enabled: true, effectiveEnabled: true };
    folderStates[folderPath] = { enabled, effectiveEnabled: enabled && prior.effectiveEnabled };
    let chartsAffected = 0;
    for (const [folder, folderState] of Object.entries(folderStates)) {
      if (folder === folderPath || folder.startsWith(`${folderPath}/`)) {
        folderState.effectiveEnabled = enabled && folderState.enabled;
      }
    }
    for (const chart of state.localCharts.charts) {
      if (chart.folder === folderPath || chart.folder.startsWith(`${folderPath}/`)) {
        chart.folderEnabled = enabled;
        chartsAffected++;
      }
    }
    res.json({
      success: true,
      message: `Folder ${enabled ? 'enabled' : 'disabled'}`,
      folderPath,
      enabled,
      chartsAffected
    });
  });

  router.get(`${PLUGIN_BASE}/catalog-registry`, (_req, res) => {
    res.json({
      registry: state.registry,
      installed: state.installed,
      converting: state.converting,
      registryStatus: state.registryStatus
    });
  });

  router.post(`${PLUGIN_BASE}/catalog-registry/refresh`, (_req, res) => {
    // Apply the scripted refresh outcome, if a test set one.
    if (state.refreshRegistry !== null) {
      state.registry = state.refreshRegistry;
    }
    if (state.refreshStatus !== null) {
      state.registryStatus = state.refreshStatus;
    }
    res.json({
      registry: state.registry,
      installed: state.installed,
      converting: state.converting,
      registryStatus: state.registryStatus
    });
  });

  router.get(`${PLUGIN_BASE}/catalog/:file`, (req, res) => {
    const file = decodeURIComponent(req.params.file);
    const cat = state.catalogs[file];
    if (!cat) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.json(cat);
  });

  router.get(`${PLUGIN_BASE}/catalog-s57-status`, (_req, res) => {
    res.json({
      containerRuntimeAvailable: state.s57PodmanAvailable,
      containerRuntimeVersion: state.podmanVersion,
      containerRuntimeEngine: state.containerRuntimeEngine,
      containerRuntimeSocketPath: null,
      podmanAvailable: state.s57PodmanAvailable,
      podmanVersion: state.podmanVersion,
      conversions: state.conversions
    });
  });

  router.get(`${PLUGIN_BASE}/catalog-updates`, (_req, res) => {
    res.json(state.catalogUpdates);
  });

  router.get(`${PLUGIN_BASE}/download-jobs`, (_req, res) => {
    res.json(state.downloadJobs);
  });

  // POST /catalog/download → kick off a "download".  Test scenarios push
  // a download job into state ahead of time and assert the UI behaves;
  // alternatively the test calls this endpoint directly and checks
  // state was mutated.
  router.post(`${PLUGIN_BASE}/catalog/download`, (req, res) => {
    const { chartNumber } = req.body as { chartNumber?: string };
    if (!chartNumber) {
      res.status(400).json({ error: 'chartNumber required' });
      return;
    }
    if (state.downloadFailStatus !== null) {
      res.status(state.downloadFailStatus).json({ error: 'mock download failure' });
      return;
    }
    const jobId = `mock-${chartNumber}-${Date.now()}`;
    state.downloadJobs.push({
      id: jobId,
      url: '',
      status: 'in_progress',
      progress: 0,
      downloadedBytes: 0
    });
    res.json({ ok: true, jobId });
  });

  app.use(router);

  // ---- Static assets ----------------------------------------------------
  // The frontend's index.html links css/js relative to the plugin root.
  app.use(PLUGIN_BASE, express.static(publicDir));
  // Some files are referenced without the plugin prefix (legacy).
  app.use(express.static(publicDir));

  return new Promise((resolve, reject) => {
    const server = app.listen(port, '127.0.0.1', () => {
      // Successful listen: detach the error listener so a later
      // server-lifecycle error doesn't try to reject an already-resolved
      // promise (and so a one-shot `EADDRINUSE` after a re-listen
      // doesn't get swallowed silently elsewhere).
      server.off('error', reject);
      const addr = server.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : port;
      const url = `http://127.0.0.1:${actualPort}${PLUGIN_BASE}/`;
      resolve({
        url,
        close: () =>
          new Promise<void>((closeResolve, closeReject) => {
            server.close((err) => {
              if (err) {
                closeReject(err);
              } else {
                closeResolve();
              }
            });
          })
      });
    });
    // EADDRINUSE etc. surface as 'error' events on the server object.
    // Without this listener Node would crash with an unhandled error
    // and the Promise would never settle.
    server.on('error', reject);
  });
}

// Standalone entry: `node e2e/mock-server.js` (compiled) starts the
// harness on PORT (default 4567) and stays running. Used by the
// playwright `webServer` config. ESM equivalent of CommonJS
// `require.main === module`: compare process.argv[1] to the module URL.
const isMainModule =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMainModule) {
  const port = Number(process.env.PORT ?? '4567');
  void startMockServer(port).then(({ url }) => {
    console.log(`mock chart-provider frontend ready at ${url}`);
  });
}
