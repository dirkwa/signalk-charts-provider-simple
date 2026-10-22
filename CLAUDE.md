# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Per project convention: `npm run format` → `npm run build` → `npm run test`.

- `npm run build` — `vite build` to `dist/` (`vite.config.ts`), one output file per source module so the raster worker, the catalog CLIs and the tests can load single modules; dependencies stay external. `vite-plugin-checker` runs `tsc` inside the build and fails it on the first type error, and `vite-plugin-dts` writes the `.d.ts` files. Then `build:public` compiles the webapp scripts with `tsc`.
- `npm run build:watch` — `vite build --watch`
- `npm run test` — runs `pretest` (build + `build:tests` + regenerate `test/fixtures/test-chart.mbtiles`), then `node --test --test-force-exit dist-test/**/*.test.js`
- Run a single test file: `npm run build && npm run build:tests && node --test --test-force-exit dist-test/<name>.test.js`
- Run a single test by name: append `--test-name-pattern "<regex>"` to the node command
- `npm run lint` / `npm run lint:fix` — ESLint (typescript-eslint `strictTypeChecked` over `src`, `test`, `e2e`, `public/js`, `playwright.config.ts`)
- `npm run format` — Prettier on `**/*.ts` under `src`, `test`, `e2e`, and `public/js` (plus `playwright.config.ts`), then `eslint --fix`
- `npm run format:check` — non-mutating CI check

Node ≥ 22.5 is required: the plugin reads MBTiles via the built-in `node:sqlite` module (no native compile). The `pretest` step regenerates the MBTiles test fixture; if a test reports "fixture missing", run `npm run test:fixtures`. The fixture scripts are TypeScript run directly by Node, which needs Node 22.18 or later for development (type stripping); the plugin itself still runs on 22.5.

## Architecture

This is a Signal K server plugin. The single entry is `src/index.ts`, which exports a `pluginConstructor(app)` factory returning the `Plugin` object Signal K calls (`start` / `stop` / `schema` / `registerWithRouter`). Built output lands in `dist/` and is what npm publishes alongside `assets/`, `public/`, and `docs/screenshots/`.

### Two responsibilities, one plugin

1. **Serve charts to Signal K** (display path, no container runtime needed).
   - `charts-loader.ts` walks the configured `chartPath` recursively and produces a `Record<string, ChartProvider>` keyed by identifier. It handles `.mbtiles` files, `.pmtiles` archives (`utils/pmtiles-reader.ts`, read by byte range with tiles served as stored), tilemap directories (with `tilemapresource.xml`), and online charts (`.onlinechart.json`, see below).
   - **Online charts** (`utils/online-charts.ts`): an online chart added from the Online Charts or Satellite tab is a small `<catalogId>.onlinechart.json` file in the chart folder holding its catalog id and display name. Being a file, it gets folders, enable/disable, move and delete for free. It is served (as `_fileFormat: 'online'`, no local tiles) only while the downloaded catalog lists its id, so catalog fixes reach every boat. In any code path that can receive either file kind, derive a chart's id from its file name with `chartIdFromFilename`. A chart's id is its file stem and is shared across the whole library, so new online chart files take an id no other chart uses. Online charts are served on the v2 API only.
   - **Time-varying online charts** (weather radar, satellite, forecasts): `utils/time-poller.ts` reads each served entry's GetCapabilities at its `refreshInterval` — one poll per catalog entry, only while a client is reading the chart (resource reads call `touch`), with one download per capabilities URL — and `utils/time-dimension.ts` turns the layer's TIME dimension into the chart resource's `time` block (Plotter Extensions `charts.time` convention), clamped to the entry's `window`. The update is applied to the served chart in place and emitted as a delta that differs only in `time`, which plotters absorb without reloading; keep everything else in the served chart stable between polls. The dimension is found with a targeted text scan, not a full XML parse, because some capabilities documents are megabytes.
   - `utils/mbtiles-reader.ts` opens MBTiles via `node:sqlite`. `utils/mbtiles-metadata.ts` reads/writes the `metadata` table (used for chart rename, which marks tiles "USER MODIFIED").
   - **Missing raster tiles** (`utils/raster-overzoom.ts`): a jpg/png MBTiles tile missing inside the zoom range is synthesized in worker threads from the nearest stored ancestor and the stored children. Synthesis is slow on a Raspberry Pi, so results sit in a small per-reader LRU and on disk under `<dataDir>/raster-tile-cache/`, which survives restarts. `utils/raster-tile-cache.ts` documents the cache key, size cap, eviction and pruning. Chart files and the chart folder are never written.
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
- `src/catalog/build-merged-catalog.ts` is pure (no I/O): merge, content hash, carry-forward of broken upstream files, the drop guard and the publish decision. `src/catalog/publish-catalog-cli.ts` is the I/O shell that `.github/workflows/publish-catalog.yml` runs; `src/catalog/preview-catalog-cli.ts` (`npm run catalog:preview`) runs it on each request to serve a contributor's working copy locally. Both are excluded from the npm package.
- `src/catalog/chartcatalogs-xml.ts` is the only chartcatalogs XML parser; the catalog manager and the build both use it.
- The content hash deliberately ignores timestamps and the upstream commit, so hourly chartcatalogs header-only commits don't republish.
- **ENC index** (`docs/enc-index.md`): `enc-index.json`, published beside the catalog by the same workflow job (a Pages deployment replaces the whole site), lists every free ENC as selectable map units. `src/catalog/enc-index-schema.ts` is its schema, `enc-outline.ts` the fixed outline simplification, `build-enc-index.ts` the pure assembly (reuse by archive version, carry-forward, drop guard), and `enc-index-cli.ts` the I/O shell (downloads, GDAL in the charts-toolbox image). The published index is the build's state between runs. NOAA unit ids and versions are NOAA's own chart ids and `enc_ed_up` tokens, so saved NOAA chart sets map onto it by name; every other cell gets a version token of the same form from its DSID. A cell several sources publish appears once, EuRIS first (`PREFERRED_SOURCE`). Bump `ARCHIVE_REVISION` when a change gives different units for the same archive.

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

`public/` is a static webapp served by Signal K at `/plugins/signalk-charts-provider-simple/`. It talks to Express routes registered in `index.ts` via `registerWithRouter`. The UI has seven tabs: Manage Charts / Download from URL / Convert / Chart Catalog / Online Charts / Satellite / NOAA Charts. The merged catalog's downloadable charts are in Chart Catalog (`public/js/chart-catalog.ts`); its online charts are in Online Charts, except those of category `imagery`, which the Satellite tab lists. Both are an `OnlineChartPanel` in `public/js/online-charts.ts`, which also holds the add-by-URL form; all three read `/catalog-registry`. Scripts are plain `<script>` tags (no bundler); cross-file references go through `window.X`. The NOAA Charts tab (`public/js/noaa-chart-selector.ts`) uses Leaflet, vendored under `public/vendor/leaflet/` so the map UI loads offline (only basemap tiles need a network); `@types/leaflet` types the global `L` for the strict `public/js` build.

### Type extensions

`@signalk/server-api`'s `ServerAPI` type is missing `app.config` and Express route helpers that the real server provides; `src/types.ts` defines `ExtendedServerAPI` for those. When adding new server-API uses, extend that interface rather than casting.

### Tests

Plain Node test runner against compiled output in `dist-test/**/*.test.js`. Test sources are TypeScript (`test/**/*.ts`) compiled via `tsconfig.test.json`; `pretest` runs `build`, `build:tests`, and `test:fixtures` in that order. `test/integration.test.ts` exercises the loader against `test/fixtures/test-chart.mbtiles` (regenerated by `test/fixtures/create-test-mbtiles.ts`, run directly by Node's type stripping).

## Releases

release-please cuts releases; never bump `package.json`'s version by hand. Squash-merge PRs with a Conventional Commit title: `feat` gives a minor release, `fix`/`perf`/`revert`/`build(deps)` a patch, and `!` or a `BREAKING CHANGE:` footer a major one. release-please keeps a `chore(release): X.Y.Z` PR open, and merging it tags the release, creates the GitHub Release and dispatches `publish.yml`. `.github/workflows/label-by-title.yml` labels each PR from its title, and `.github/release.yml` groups the release notes by those labels. A `-beta.N` pre-release is still tagged by hand: bump `package.json` on a branch, then push the tag.

## Code conventions

- TypeScript strict mode + `strictTypeChecked` lints. `eqeqeq`, `curly: all`, `no-var`, `prefer-const` are enforced; `no-console` is intentionally off (the plugin logs through `console`).
- Prettier is wired through ESLint, so `prettier/prettier` violations fail lint.
- Schemas use the unscoped `typebox` package (1.x), not `@sinclair/typebox`, which stopped at 0.34. TypeBox 1 was published under a new name rather than a major bump, so `npm outdated` never points at it. Validation errors carry `instancePath`, and a self-referencing schema is a `Type.Cyclic` with `Type.Ref`.
