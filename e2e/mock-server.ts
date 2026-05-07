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
interface MockState {
  registry: {
    file: string;
    label: string;
    category: string;
    chartCount: number | null;
    cachedAt: string | null;
  }[];
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
      downloading?: boolean;
      converting?: boolean;
    }[];
    folders: string[];
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
  s57PodmanAvailable: boolean;
  podmanVersion: string | null;
  containerRuntimeEngine: string | null;
}

const initialState: MockState = {
  registry: [],
  installed: {},
  converting: {},
  conversions: {},
  catalogs: {},
  localCharts: { charts: [], folders: ['/'], basePath: '/tmp/charts' },
  downloadJobs: [],
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

  // ---- Test-only mock control endpoints --------------------------------
  // POST /__mock/reset → clear state to initialState
  app.post('/__mock/reset', (_req: Request, res: Response) => {
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
  app.put('/__mock/state', (req: Request, res: Response) => {
    state = { ...state, ...(req.body as Partial<MockState>) };
    res.json({ ok: true });
  });

  // ---- Frontend REST stubs ---------------------------------------------
  // The frontend hits these at API_BASE.  Each returns whatever the
  // current mock state says; the test sets state ahead of time.
  app.get(`${PLUGIN_BASE}/local-charts`, (_req, res) => {
    res.json(state.localCharts);
  });

  app.get(`${PLUGIN_BASE}/catalog-registry`, (_req, res) => {
    res.json({
      registry: state.registry,
      installed: state.installed,
      converting: state.converting
    });
  });

  app.get(`${PLUGIN_BASE}/catalog/:file`, (req, res) => {
    const file = decodeURIComponent(req.params.file);
    const cat = state.catalogs[file];
    if (!cat) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.json(cat);
  });

  app.get(`${PLUGIN_BASE}/catalog-s57-status`, (_req, res) => {
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

  app.get(`${PLUGIN_BASE}/catalog-updates`, (_req, res) => {
    res.json([]);
  });

  app.get(`${PLUGIN_BASE}/download-jobs`, (_req, res) => {
    res.json(state.downloadJobs);
  });

  // POST /catalog/download → kick off a "download".  Test scenarios push
  // a download job into state ahead of time and assert the UI behaves;
  // alternatively the test calls this endpoint directly and checks
  // state was mutated.
  app.post(`${PLUGIN_BASE}/catalog/download`, (req, res) => {
    const { chartNumber } = req.body as { chartNumber?: string };
    if (!chartNumber) {
      res.status(400).json({ error: 'chartNumber required' });
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
