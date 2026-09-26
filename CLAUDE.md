# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Per project convention: `npm run format` → `npm run build` → `npm run test`.

- `npm run build` — `tsc` to `dist/` (sources in `src/**/*.ts`, target ES2023, ESM/NodeNext, strict)
- `npm run build:watch` — incremental compile
- `npm run test` — runs `pretest` (build + `build:tests` + regenerate `test/fixtures/test-chart.mbtiles`), then `node --test --test-force-exit dist-test/**/*.test.js`
- Run a single test file: `npm run build && npm run build:tests && node --test --test-force-exit dist-test/<name>.test.js`
- Run a single test by name: append `--test-name-pattern "<regex>"` to the node command
- `npm run lint` / `npm run lint:fix` — ESLint (typescript-eslint `strictTypeChecked` over `src`, `test`, `e2e`, `public/js`, `playwright.config.ts`)
- `npm run format` — Prettier on `**/*.ts` under `src`, `test`, `e2e`, and `public/js` (plus `playwright.config.ts`), then `eslint --fix`
- `npm run format:check` — non-mutating CI check

Node ≥ 22.5 is required: the plugin reads MBTiles via the built-in `node:sqlite` module (no native compile). The `pretest` step regenerates the MBTiles test fixture; if a test reports "fixture missing", run `npm run test:fixtures`.

## Architecture

This is a Signal K server plugin. The single entry is `src/index.ts`, which exports a `pluginConstructor(app)` factory returning the `Plugin` object Signal K calls (`start` / `stop` / `schema` / `registerWithRouter`). Built output lands in `dist/` and is what npm publishes alongside `assets/`, `public/`, and `docs/screenshots/`.

### Two responsibilities, one plugin

1. **Serve charts to Signal K** (display path, no container runtime needed).
   - `charts-loader.ts` walks the configured `chartPath` recursively and produces a `Record<string, ChartProvider>` keyed by identifier. It handles `.mbtiles` files, tilemap directories (with `tilemapresource.xml`), and online charts (`.onlinechart.json`, see below).
   - **Online charts** (`utils/online-charts.ts`): an online chart added from the Chart Catalog is a small `<catalogId>.onlinechart.json` file in the chart folder holding its catalog id and display name. Being a file, it gets folders, enable/disable, move and delete for free. It is served (as `_fileFormat: 'online'`, no local tiles) only while the downloaded catalog lists its id, so catalog fixes reach every boat. In any code path that can receive either file kind, derive a chart's id from its file name with `chartIdFromFilename`. A chart's id is its file stem and is shared across the whole library, so new online chart files take an id no other chart uses. Online charts are served on the v2 API only.
   - `utils/mbtiles-reader.ts` opens MBTiles via `node:sqlite`. `utils/mbtiles-metadata.ts` reads/writes the `metadata` table (used for chart rename, which marks tiles "USER MODIFIED").
   - `ChartProvider` exposes both `v1` and `v2` shapes (see `src/types.ts`) so the plugin works on Signal K v1 and v2 servers; `serverMajorVersion` is sniffed from `app.config.version`.
   - `utils/chart-state.ts` persists per-chart enable/disable in the plugin data dir; `utils/folder-state.ts` does the same per folder (a disabled folder hides all descendant folders' charts; effective visibility is chart-enabled AND folder-path-enabled); `utils/file-scanner.ts` enumerates folders for the management UI.

2. **Convert charts on demand** (write path, requires Docker/Podman via the `signalk-container` plugin — see the integration section below for the API contract).
   - `utils/container-manager.ts` is the discovery + waiting layer for the `signalk-container` plugin's manager API. Converters call `getContainerManager()` after `start()` has resolved it; they never import `dockerode` directly.
   - `utils/s57-converter.ts` runs GDAL → tippecanoe pipelines for S-57 ENC, GSHHG, and SHP basemaps. `utils/s57-band.ts` sorts S-57 cells by chart-band and feeds tippecanoe per-band layers. `processS57Directory` is the reusable core (convert an already-extracted ENC tree); `processS57Zip` is a thin wrapper that extracts one ZIP then delegates to it.
   - `utils/rnc-converter.ts` runs GDAL pipelines for BSB/KAP raster (`processRncZip`) and Pilot tarballs (`processPilotTar`).
   - `utils/concurrency.ts` is the **single source of truth for CPU usage**. The plugin config exposes a `cpuBudget` enum (`single-core` / `half` / `all`); `setCpuBudget` is called from `start()` and `getCpuBudget()` returns the live `{ maxConcurrentConversions, tippecanoeThreadsPerJob, gdalExportParallelism }` so converters pick up changes between jobs without a restart. Don't reimplement CPU/concurrency logic elsewhere — read it from this module.
   - `utils/catalog-manager.ts` downloads and caches the merged chart catalog from this repo's GitHub Pages (see *Merged chart catalog* below; `CHARTS_CATALOG_URL` overrides the URL for development against a fork) and tracks installed catalog charts so update notifications can fire.
   - `utils/download-manager.ts` is a queue with progress for direct-URL downloads and ZIP extraction.
   - **NOAA Charts** (the `NOAA Charts` tab; UI calls each bundle a "chart set"): `utils/noaa-enc-footprints.ts` fetches + disk-caches NOAA's `enc.geojson`, reprojects EPSG:3857→4326, and exposes the band-4 map list plus the band-3/4/5 bbox-overlap inclusion math (all pure/testable). `utils/custom-catalog-manager.ts` persists each chart set as JSON under `<dataDir>/custom-catalogs/` (safe-slug ids, path-traversal-checked) and evaluates freshness. `utils/custom-catalog-download.ts` stages every selected ENC ZIP into one combined tree (zip-slip-safe). The `/custom-catalogs*` routes in `index.ts` drive download → `processS57Directory` (one combined conversion) → quarantine promote, producing one MBTiles per chart set. Server-side modules/routes keep the generic `custom-catalog` names; only the UI (tab `public/js/noaa-chart-selector.ts`) is NOAA-specific, since NOAA is currently the only free ENC source.

### Merged chart catalog (`src/catalog/`, `catalog/`)

The Chart Catalog is backed by one merged catalog file that this repo publishes to GitHub Pages (see `docs/chart-catalog.md` for the why). It combines chartcatalogs.github.io (downloadable charts) with the curated online charts in `catalog/online-charts.json`, plus the per-file facets (label, category, format, regions, bbox) in `catalog/chartcatalogs-index.json`.

- `src/catalog/merged-catalog-schema.ts` holds **all** catalog schemas: strict ones for the hand-edited sources, tolerant ones for the published file. Published-file compatibility policy: additive changes keep `schemaVersion`; consumers ignore unknown fields and skip entries they can't interpret, never the whole file.
- `src/catalog/build-merged-catalog.ts` is pure (no I/O): merge, content hash, carry-forward of broken upstream files, the drop guard and the publish decision. `src/catalog/publish-catalog-cli.ts` is the I/O shell that `.github/workflows/publish-catalog.yml` runs; it is excluded from the npm package.
- `src/catalog/chartcatalogs-xml.ts` is the only chartcatalogs XML parser; the catalog manager and the build both use it.
- The content hash deliberately ignores timestamps and the upstream commit, so hourly chartcatalogs header-only commits don't republish.

### `signalk-container` integration

From 2.0 onward, every container-runtime call (image pulls, helper-job execution, mount resolution, orphan cleanup) goes through the `signalk-container` plugin instead of `dockerode`. `utils/container-manager.ts` is a thin shim:

- Defines a local `ContainerManagerApi` type that is a **subset** of `signalk-container`'s published API — only the methods chart-provider calls (`runJob`, `resolveSignalkDataMount`, `resolveHostPath`, `cleanupOrphanedJobs`, `getRuntime`, `pullImage`, `imageExists`, plus the optional `whenReady`). We don't `import` from `signalk-container` because it's a peer plugin (loaded by Signal K, not bundled), so the shim is the API contract we depend on.
- `waitForContainerManager()` discovers the manager on `(globalThis as any).__signalk_containerManager`. Plugin load order is non-deterministic, so it polls up to 30 s.
  - **signalk-container >= 1.6.0**: uses `manager.whenReady()` — a single await that resolves when runtime detection has settled. Faster than polling and avoids busy-checking `getRuntime()` every second.
  - **signalk-container < 1.6.0**: falls back to the original `while (!getRuntime()) await sleep` loop. The `whenReady?():` declaration is intentionally optional so older versions keep working.
  - Contract: `waitForContainerManager()` never rejects. `whenReady()` rejections are swallowed and treated as "detection didn't settle in time". The caller's job is to handle a `null` return by surfacing `setPluginError`, not to handle thrown errors.

If `signalk-container` is missing, the plugin still loads and **serves charts** (display path needs no runtime); only the convert path is disabled, with `setPluginError` pointing the user at the App Store.

### Hot-apply config and the path marker

`start()` is called fresh on every config save (Signal K restarts the plugin, not the whole server). `utils/path-marker.ts` writes `.charts-provider-marker.json` into the chart path on each start, recording plugin version, container hints, and effective UID — useful when diagnosing host-vs-container path mismatches.

### Web UI

`public/` is a static webapp served by Signal K at `/plugins/signalk-charts-provider-simple/`. It talks to Express routes registered in `index.ts` via `registerWithRouter`. The UI has five tabs: Manage Charts / Download from URL / Convert / Chart Catalog / NOAA Charts. Scripts are plain `<script>` tags (no bundler); cross-file references go through `window.X`. The NOAA Charts tab (`public/js/noaa-chart-selector.ts`) uses Leaflet, vendored under `public/vendor/leaflet/` so the map UI loads offline (only basemap tiles need a network); `@types/leaflet` types the global `L` for the strict `public/js` build.

### Type extensions

`@signalk/server-api`'s `ServerAPI` type is missing `app.config` and Express route helpers that the real server provides; `src/types.ts` defines `ExtendedServerAPI` for those. When adding new server-API uses, extend that interface rather than casting.

### Tests

Plain Node test runner against compiled output in `dist-test/**/*.test.js`. Test sources are TypeScript (`test/**/*.ts`) compiled via `tsconfig.test.json`; `pretest` runs `build`, `build:tests`, and `test:fixtures` in that order. `test/integration.test.ts` exercises the loader against `test/fixtures/test-chart.mbtiles` (regenerated by `test/fixtures/create-test-mbtiles.cjs`).

## Code conventions

- TypeScript strict mode + `strictTypeChecked` lints. `eqeqeq`, `curly: all`, `no-var`, `prefer-const` are enforced; `no-console` is intentionally off (the plugin logs through `console`).
- Prettier is wired through ESLint, so `prettier/prettier` violations fail lint.
