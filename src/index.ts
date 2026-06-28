import type { Path, Plugin } from '@signalk/server-api';
import { SKVersion } from '@signalk/server-api';
import { Type } from '@sinclair/typebox';
import Busboy from 'busboy';
import fs from 'fs';
import https from 'https';
import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import { findCharts, findRepairableCharts } from './charts-loader.js';
import {
  checkForUpdates,
  classifyUrl,
  fetchCatalog,
  fetchCatalogRegistry,
  getCachedCatalog,
  getCatalogRegistry,
  getCatalogsWithInstalledCharts,
  getConvertingCharts,
  getConvertingCount,
  getInstalledCatalogCharts,
  getRegistryStatus,
  initCatalogManager,
  pruneStaleInstalls,
  removeInstall,
  removeInstallByFilename,
  renameInstallFilename,
  rollbackInstall,
  setConvertingState,
  setInstallFilename,
  trackInstall
} from './utils/catalog-manager.js';
import { cleanCatalogTitle } from './utils/catalog-title.js';
import { initChartState, isChartEnabled, setChartEnabled } from './utils/chart-state.js';
import { getCpuBudget, setCpuBudget } from './utils/concurrency.js';
import { PLUGIN_OWNER_ID } from './utils/container-jobs.js';
import { getContainerManager, waitForContainerManager } from './utils/container-manager.js';
import { downloadManager } from './utils/download-manager.js';
import { scanAllFolders, scanChartsRecursively } from './utils/file-scanner.js';
import { repairMbtilesMetadata, setMbtilesDisplayName } from './utils/mbtiles-metadata.js';
import { open as openMbtilesReader } from './utils/mbtiles-reader.js';
import { writeChartPathMarker } from './utils/path-marker.js';
import { getBlankTileReplacement, getOverzoomedTile } from './utils/tile-overzoom.js';
import {
  arePairWithinBase,
  classifyChartDirAccess,
  hasHostChartsMountEnv,
  isHostMountPath,
  isWithinBase,
  resolveDefaultChartsPath,
  validateChartName
} from './utils/path-safety.js';
import { parsePluginConfig } from './utils/plugin-config-schema.js';
import {
  cleanupQuarantineDir,
  makeQuarantineDir,
  promoteQuarantine,
  sweepStaleQuarantineDirs
} from './utils/quarantine.js';
import { parseBody, parseShape } from './utils/rest-validation.js';
import {
  getAllConversionProgress as getAllRncProgress,
  getConversionProgress as getRncProgress,
  initRncConverter,
  processPilotTar,
  processRncZip,
  setConversionFailed as setRncFailed
} from './utils/rnc-converter.js';
import {
  getAllConversionProgress as getAllS57Progress,
  getConversionProgress as getS57Progress,
  initS57Converter,
  processGshhg,
  processS57Directory,
  processS57Zip,
  processShpBasemap,
  setConversionFailed as setS57Failed
} from './utils/s57-converter.js';
import {
  band4MapEntries,
  computeInclusion,
  coverageByBox,
  getFootprintIndex,
  initNoaaEncFootprints,
  peekFootprintIndex
} from './utils/noaa-enc-footprints.js';
import {
  appendCatalogLog,
  boxStatesForCatalog,
  clearCatalogCancel,
  clearCatalogProgress,
  createCustomCatalog,
  type CustomCatalog,
  deleteCustomCatalog,
  evaluateFreshness,
  getCatalogDetail,
  getCatalogProgress,
  getCustomCatalog,
  initCustomCatalogManager,
  isCatalogBusy,
  isCatalogCancelRequested,
  isValidCatalogId,
  listCustomCatalogs,
  registerCatalogAbort,
  requestCatalogCancel,
  saveCustomCatalog,
  setCatalogBusy,
  setCatalogDetail,
  setCatalogFailed,
  setCatalogProgress
} from './utils/custom-catalog-manager.js';
import { downloadAndExtractEncs } from './utils/custom-catalog-download.js';

// JSON import with type attribute (NodeNext ESM). package.json's `version`
// is what the marker file records so users can confirm the running build.
import packageJson from '../package.json' with { type: 'json' };
import type {
  ChartProvider,
  DownloadJob,
  ExtendedServerAPI,
  IRouter,
  PluginConfig,
  Request,
  Response,
  SanitizedChart
} from './types.js';
const pluginVersion: string = (packageJson as { version: string }).version;

// Single source of truth lives in container-jobs.ts as PLUGIN_OWNER_ID
// (used as the `ownerPluginId` label on every runJob call). The plugin
// id Signal K uses must match exactly so `cleanupOrphanedJobs` reaps
// the right containers — alias rather than duplicate the literal.
const PLUGIN_ID = PLUGIN_OWNER_ID;
// Tile URLs live under the Signal K v1 charts namespace so non-admin
// users (readwrite/readonly) can fetch tiles. Routes under /plugins/* are
// gated by adminAuthenticationMiddleware in the server, which blocks tile
// rendering for non-admin sessions (issue #99). The v1 api namespace is
// only http_authorize-gated, so any authenticated user can read tiles.
const chartTilesPath = `/signalk/v1/api/resources/charts`;

const pluginConstructor = (app: ExtendedServerAPI): Plugin => {
  let chartProviders: Record<string, ChartProvider> = {};
  let props: PluginConfig = {
    chartPath: ''
  };

  let catalogUpdateInterval: ReturnType<typeof setInterval> | null = null;
  let pluginDataDir = '';
  let defaultChartsPath = '';
  let serverMajorVersion = 1;

  // The effective default chart directory. When Signal K runs in a container
  // (signalk-universal-installer), the installer can mount a host folder the
  // user shares with other chart apps (OpenCPN/qtVlm/...) and inject its
  // in-container path via SIGNALK_CHARTS_HOST_PATH. When that env is present we
  // default to it instead of the in-data-volume `charts-simple` dir, so a
  // container user gets the shared host folder out of the box with no config —
  // and so the chartPath field is never the free-text foot-gun that pointed at
  // an unmounted host path. A user can still override via the chartPath setting.
  function getDefaultChartsPath(): string {
    if (!defaultChartsPath) {
      pluginDataDir = app.getDataDirPath();
      serverMajorVersion = app.config?.version ? parseInt(app.config.version.split('.')[0], 10) : 1;
      const configBasePath = path.dirname(path.dirname(pluginDataDir));
      const inDataVolumeDefault = path.join(configBasePath, 'charts-simple');
      defaultChartsPath = resolveDefaultChartsPath(
        process.env.SIGNALK_CHARTS_HOST_PATH,
        inDataVolumeDefault
      );
    }
    return defaultChartsPath;
  }

  const plugin: Plugin = {
    id: PLUGIN_ID,
    name: 'Charts Provider Simple',
    schema: () => ({
      title: 'Charts Provider Simple',
      type: 'object',
      properties: {
        chartPath: {
          type: 'string',
          title: 'Chart path',
          description:
            (hasHostChartsMountEnv(process.env.SIGNALK_CHARTS_HOST_PATH)
              ? `Main directory for chart files. Defaults to the shared host charts folder mounted by the installer. ` +
                `Leave this blank to use it; only change it if you know the path is reachable inside the container. `
              : `Main directory for chart files. Defaults to "${getDefaultChartsPath()}". `) +
            `Subfolders will be scanned recursively.`,
          default: getDefaultChartsPath()
        },
        cpuBudget: {
          type: 'string',
          title: 'CPU budget for chart conversion',
          description:
            'How much of the host CPU chart conversion may use. ' +
            '"single-core" keeps Signal K maximally responsive but conversions are slowest. ' +
            '"half" (default) balances conversion speed and Signal K responsiveness. ' +
            '"all" uses every core for fastest single-bundle conversion; Signal K may be sluggish during a conversion.',
          enum: ['single-core', 'half', 'all'],
          default: 'half'
        },
        // A `null`-typed field renders as a section header in the admin UI,
        // visually separating this toggle from the CPU-budget setting above.
        _notificationsHeader: {
          type: 'null',
          title: 'Notifications'
        },
        disableUpdateNotifications: {
          type: 'boolean',
          title: 'Disable chart update notifications',
          description:
            'When enabled, suppresses Signal K warn notifications about available chart catalog updates.',
          default: false
        }
      }
    }),
    uiSchema: () => ({}),
    start: (settings) => {
      // Validate the saved config against the TypeBox schema before doing
      // anything with it. Bad shapes show up as a clear plugin error in
      // the admin UI instead of crashing several frames into doStartup.
      let config: PluginConfig;
      try {
        config = parsePluginConfig(settings);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        app.setPluginError(msg);
        return;
      }
      // Signal K does not await start(); run async init in a self-contained
      // promise that handles its own errors so a setPluginError surfaces
      // anything we couldn't recover from (e.g. signalk-container missing).
      doStartup(config).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        app.setPluginError(`Startup failed: ${msg}`);
      });
    },
    stop: () => {
      if (catalogUpdateInterval) {
        clearInterval(catalogUpdateInterval);
        catalogUpdateInterval = null;
      }
      app.setPluginStatus('stopped');
    },
    registerWithRouter: (router) => {
      registerRoutes(router);
    },
    signalKApiRoutes: (router) => {
      app.debug('** Registering v1 API paths via signalKApiRoutes **');

      // Tile route must be registered BEFORE the metadata route so Express
      // matches /:identifier/:z/:x/:y first. The metadata route's
      // /:identifier only matches single-segment paths, so order is
      // strictly defensive — but keep them in this order anyway.
      router.get(
        '/resources/charts/:identifier/:z([0-9]+)/:x([0-9]+)/:y([0-9]+)',
        (req: Request, res: Response) => {
          const { identifier, z, x, y } = req.params as Record<string, string>;
          const ix = parseInt(x);
          const iy = parseInt(y);
          const iz = parseInt(z);
          const provider = chartProviders[identifier];
          if (!provider) {
            res.sendStatus(404);
            return;
          }
          switch (provider._fileFormat) {
            case 'directory':
              serveTileFromFilesystem(res, provider, iz, ix, iy);
              return;
            case 'mbtiles':
              serveTileFromMbtiles(res, provider, iz, ix, iy);
              return;
            default:
              console.log(`Unknown chart provider fileformat ${String(provider._fileFormat)}`);
              res.status(500).send();
          }
        }
      );

      router.get('/resources/charts/:identifier', (req: Request, res: Response) => {
        const { identifier } = req.params as Record<string, string>;
        const provider = chartProviders[identifier];
        if (provider) {
          res.json(sanitizeProvider(provider));
        } else {
          res.status(404).send('Not found');
        }
      });

      router.get('/resources/charts', (_req: Request, res: Response) => {
        const sanitized = Object.fromEntries(
          Object.entries(chartProviders).map(([k, provider]) => [k, sanitizeProvider(provider)])
        );
        res.json(sanitized);
      });

      return router;
    }
  };

  const doStartup = async (config: PluginConfig): Promise<void> => {
    app.debug(`** loaded config: ${JSON.stringify(config)}`);
    props = { ...config };

    setCpuBudget(props.cpuBudget);

    getDefaultChartsPath(); // ensure lazy init
    const chartPath = props.chartPath || defaultChartsPath;

    // Is the effective path the host folder the installer bind-mounted (via
    // SIGNALK_CHARTS_HOST_PATH)? If so we must NOT create it on demand: that
    // folder is supposed to already exist (the installer made it and mounted
    // it), so a missing dir means a missing mount — and `mkdir`-ing it would
    // silently shadow the absent mount with an ephemeral in-container dir whose
    // charts vanish on container recreate. isHostMountPath normalizes both
    // sides so a trailing slash / `.`/`..` can't divert the mount into the
    // mkdir branch.
    const isHostMount = isHostMountPath(chartPath, process.env.SIGNALK_CHARTS_HOST_PATH);

    let exists: boolean;
    let createdOrWritable: boolean;
    if (isHostMount) {
      // Probe, never create.
      exists = fs.existsSync(chartPath);
      createdOrWritable = exists && isDirWritable(chartPath);
    } else {
      // In-data-volume default or a user-typed path: create-on-demand, then
      // verify it is an actually-writable directory. ensureDirectoryExists
      // returns true for any path that already exists, so without the
      // isDirWritable probe an existing read-only dir (or a regular file at
      // that path) would slip through as usable and only fail on first write.
      createdOrWritable = ensureDirectoryExists(chartPath) && isDirWritable(chartPath);
      exists = fs.existsSync(chartPath);
    }

    const access = classifyChartDirAccess(isHostMount, exists, createdOrWritable);
    if (!access.ok) {
      if (access.reason === 'mount-missing') {
        // NB: clearing the Chart path setting does NOT help here — with
        // SIGNALK_CHARTS_HOST_PATH still set, the default resolves right back to
        // this same (missing) mount. The real fixes are restoring the mount or
        // removing the installer env / pointing at a reachable in-container dir.
        app.setPluginError(
          `Shared charts folder is not mounted into the container at ${chartPath}. ` +
            `Charts live in a host folder the installer shares with the container; that ` +
            `mount appears to be missing. Re-run the installer to restore it, remove the ` +
            `installer-provided SIGNALK_CHARTS_HOST_PATH setting, or set Chart path to a ` +
            `directory that is reachable inside the container.`
        );
      } else if (access.reason === 'exists-unwritable') {
        app.setPluginError(
          `Chart directory exists but is not writable by Signal K: ${chartPath}. ` +
            `In a container this is usually a folder-ownership mismatch — make sure the ` +
            `host folder is owned by the user that runs Signal K.`
        );
      } else {
        app.setPluginError(`Chart directory is not writable: ${chartPath}`);
      }
      app.setPluginStatus('Started (no chart directory)');
      return;
    }

    // Drop a marker file at the resolved chart path. Lets users (especially
    // running under Docker/Podman) confirm the bind mount points where they
    // expect by looking for this file on the host filesystem.
    const marker = writeChartPathMarker(chartPath, pluginVersion, {
      onError: (msg) => app.debug(msg)
    });
    if (marker) {
      console.log(`[charts-provider] chartPath resolved to ${chartPath} (marker: ${marker})`);
    } else {
      console.log(`[charts-provider] chartPath resolved to ${chartPath} (marker write failed)`);
    }

    initChartState(pluginDataDir);

    const dataDir = pluginDataDir;
    initCatalogManager(dataDir, app.debug.bind(app));
    initNoaaEncFootprints(dataDir, app.debug.bind(app));
    initCustomCatalogManager(dataDir, app.debug.bind(app));

    const tempDirPattern =
      /^(s57-download-|rnc-download-|pilot-download-|shp-download-|gshhg-|convert-upload-|custom-catalog-)\d+$/;
    try {
      const dataDirEntries = fs.readdirSync(dataDir, { withFileTypes: true });
      for (const entry of dataDirEntries) {
        if (entry.isDirectory() && tempDirPattern.test(entry.name)) {
          const fullPath = path.join(dataDir, entry.name);
          console.log(`[charts-provider] Removing leftover temp directory: ${entry.name}`);
          cleanupDir(fullPath);
        }
      }
    } catch (e) {
      app.debug(
        `Error scanning for temp directories: ${e instanceof Error ? e.message : String(e)}`
      );
    }

    initS57Converter(app.debug.bind(app));
    initRncConverter(app.debug.bind(app));

    // Bring up the display path (chart loading + resource-provider
    // registration) BEFORE discovering signalk-container. Display does not
    // need the container runtime, and gating registration behind the
    // up-to-30s container wait left Freeboard-SK's GET
    // /signalk/v2/api/resources/charts returning 404 until the wait
    // resolved — so charts vanished from the chart list on hosts without
    // signalk-container installed.
    app.debug(`Start chart provider. Chart path: ${chartPath}`);
    const loadOk = await loadChartProviders(chartPath);

    if (serverMajorVersion === 2) {
      app.debug('** Registering v2 API paths **');
      registerAsProvider();
    }

    // Report Started for the display path. Don't clobber a load error
    // (loadChartProviders sets one) — a later setPluginError from the
    // signalk-container discovery below is allowed to win, since that
    // message tells the user conversion needs the container plugin.
    if (loadOk) {
      app.setPluginStatus('Started');
    }

    // Discover the signalk-container plugin's manager API.  Chart conversion
    // (S-57, BSB raster, Pilot, basemaps) goes through it from 2.0 onward;
    // the App Store's `signalk.recommends` declaration in our package.json
    // ensures users are prompted to install signalk-container, but plugin
    // load order is not deterministic, so we wait up to 30 s before giving
    // up.  A missing manager surfaces as setPluginError but does NOT abort
    // startup — chart *display* (serving tiles for already-converted
    // .mbtiles) doesn't need the runtime layer and remains functional.
    // Wipe any quarantine subdirs left behind by a previous server
    // lifecycle. Conversions write into <dataDir>/in-progress/<chartNumber>/
    // and only promote to chartPath on success — if Signal K crashed
    // mid-conversion the partial .mbtiles is in the quarantine and
    // safe to drop. Runs unconditionally (independent of whether
    // signalk-container is reachable) because it only touches our
    // own filesystem state.
    try {
      const swept = sweepStaleQuarantineDirs(app.getDataDirPath());
      if (swept > 0) {
        console.log(
          `[charts-provider] Swept ${swept} stale conversion quarantine dir(s) from a previous lifecycle`
        );
      }
    } catch (err) {
      app.debug(`Quarantine sweep failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    const containerManager = await waitForContainerManager({
      // Don't overwrite the display path's "Started" status with a waiting
      // message: when charts have already loaded, serving is live and a
      // "Waiting for signalk-container..." status would be misleading.
      onWaitingStatus: () => {
        if (!loadOk) {
          app.setPluginStatus('Waiting for signalk-container...');
        }
      }
    });
    if (!containerManager) {
      app.setPluginError(
        'signalk-container plugin required for chart conversion. Install it from the App Store and restart Signal K. Chart display continues to work without it.'
      );
    } else {
      const runtime = containerManager.getRuntime();
      app.debug(
        `signalk-container detected: ${runtime?.runtime ?? 'unknown'} ${runtime?.version ?? ''}`.trim()
      );

      // Reap any helper containers leaked by a previous Signal K
      // crash mid-conversion. Each reaped orphan clears the
      // matching install record and converting flag so the catalog
      // UI doesn't show "Installed" or "Converting…" for a job
      // that no longer exists. Requires signalk-container >= 1.3.0;
      // older versions don't have the API and we just skip.
      if (typeof containerManager.cleanupOrphanedJobs === 'function') {
        try {
          const cleanup = await containerManager.cleanupOrphanedJobs({
            ownerPluginId: PLUGIN_OWNER_ID
          });
          // Labels we set on runJob calls have the form
          // `<stage>-<chartNumber>`, where <stage> is one of a fixed
          // set of strings (gdal-export, tippecanoe, gdal-translate,
          // gdaladdo, tar-extract, gdal-rasterize). The naïve
          // `replace(/^[a-z-]+-/, '')` was greedy — it would strip
          // every hyphenated prefix and corrupt chartNumbers that
          // themselves contain hyphens (e.g. `tippecanoe-abc-def`
          // would yield `def` instead of `abc-def`). Match the
          // longest known prefix and take everything after.
          const STAGES = [
            'gdal-export',
            'gdal-translate',
            'gdal-rasterize',
            'tar-extract',
            'tippecanoe',
            'gdaladdo'
          ];
          const extractChartNumber = (label: string | undefined): string | null => {
            if (!label) {
              return null;
            }
            for (const stage of STAGES) {
              const prefix = `${stage}-`;
              if (label.startsWith(prefix)) {
                return label.slice(prefix.length) || null;
              }
            }
            return null;
          };

          for (const orphan of cleanup.reaped) {
            const chartNumber = extractChartNumber(orphan.label);
            app.debug(
              `Reaped orphan job ${orphan.name} (${orphan.label ?? 'no label'}); ` +
                `rolling back chart ${chartNumber ?? '<unknown>'}`
            );
            if (chartNumber) {
              setConvertingState(chartNumber, false);
              // A restart/crash can land here mid-update. rollbackInstall
              // restores the prior on-disk version (UPDATE) or drops the
              // pending record (FRESH), reading the snapshot trackInstall
              // persisted in the record — so a still-pending update keeps
              // surfacing in checkForUpdates(). For a committed record (no
              // snapshot marker) it's a no-op, so a spurious reap of an
              // already-installed chart doesn't delete it.
              rollbackInstall(chartNumber);
            }
          }
          if (cleanup.reaped.length > 0) {
            console.log(
              `[charts-provider] Reaped ${cleanup.reaped.length} orphan job(s) ` +
                `from a previous Signal K lifecycle`
            );
          }
        } catch (err) {
          app.debug(`Orphan cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    startCatalogUpdateChecker();

    downloadManager.removeAllListeners('job-completed');
    downloadManager.on('job-completed', (job: DownloadJob) => {
      app.debug(
        `Download job completed: ${job.id}, extracted files: ${job.extractedFiles.join(', ')}`
      );

      for (const fileName of job.extractedFiles) {
        const relativePath = path.relative(chartPath, path.join(job.targetDir, fileName));
        setChartEnabled(relativePath, true);
        app.debug(`Enabled downloaded chart: ${relativePath}`);
      }

      void refreshChartProviders().then(() => {
        for (const fileName of job.extractedFiles) {
          const chartId = fileName.replace(/\.mbtiles$/, '');

          if (chartProviders[chartId]) {
            const chartData = sanitizeProvider(chartProviders[chartId], 2);
            emitChartDelta(chartId, chartData);
            app.debug(`Delta emitted for downloaded chart: ${chartId}`);
          }
        }
      });
    });

    // Filesystem housekeeping (removing invalid .mbtiles and orphaned
    // journal/WAL files) runs independently of the display path so it can
    // never delay chart listing. It rescans the chart directory itself
    // rather than reusing the startup snapshot — charts may have been
    // uploaded/downloaded/converted during the container-manager wait, and
    // a stale snapshot would delete them as "invalid".
    void cleanupChartDirectory(chartPath);
  };

  // Load enabled charts into `chartProviders` and prune stale install
  // records. Display-critical: must run (and resolve) before the resource
  // provider is registered so `listResources` has charts to return. Returns
  // true on success, false if the chart directory could not be read.
  const loadChartProviders = async (chartPath: string): Promise<boolean> => {
    try {
      const charts = await findCharts(chartPath);
      const enabledCharts = Object.fromEntries(
        Object.entries(charts).filter(([, chart]) => {
          const relativePath = path.relative(chartPath, chart._filePath || '');
          return isChartEnabled(relativePath);
        })
      );

      app.debug(
        `Chart provider: Found ${Object.keys(charts).length} charts (${Object.keys(enabledCharts).length} enabled) from ${chartPath}.`
      );
      chartProviders = enabledCharts;

      pruneStaleInstalls(Object.keys(charts));
      return true;
    } catch (e: unknown) {
      console.error(`Error loading chart providers`, e instanceof Error ? e.message : String(e));
      chartProviders = {};
      app.setPluginError(`Error loading chart providers`);
      return false;
    }
  };

  const cleanupChartDirectory = async (chartPath: string): Promise<void> => {
    try {
      const charts = await findCharts(chartPath);
      const allFiles = await scanChartsRecursively(chartPath);
      const validPaths = new Set(
        Object.values(charts)
          .map((c) => c._filePath)
          .filter(Boolean)
      );
      // Repairable charts (valid tiles, missing metadata.bounds) are
      // deliberately excluded from findCharts(), so they'd otherwise be
      // unlinked here as "invalid" — destroying the very files the repair
      // flow exists to fix. Treat them as valid so the sweep skips them.
      const repairable = await findRepairableCharts(chartPath);
      for (const rc of repairable) {
        validPaths.add(rc.filePath);
      }
      for (const file of allFiles) {
        if (file.name.endsWith('.mbtiles') && !validPaths.has(file.path)) {
          console.log(`[charts-provider] Removing invalid .mbtiles file: ${file.name}`);
          try {
            fs.unlinkSync(file.path);
          } catch (e) {
            app.debug(
              `Failed to remove ${file.path}: ${e instanceof Error ? e.message : String(e)}`
            );
          }
        }
      }

      const cleanOrphans = (dir: string): void => {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            if (!entry.name.startsWith('.') && entry.name !== 'node_modules') {
              cleanOrphans(fullPath);
            }
          } else if (
            entry.name.endsWith('.mbtiles-journal') ||
            entry.name.endsWith('.mbtiles-wal') ||
            entry.name.endsWith('.partial_tiles.db')
          ) {
            console.log(`[charts-provider] Removing orphaned file: ${entry.name}`);
            try {
              fs.unlinkSync(fullPath);
            } catch (e) {
              app.debug(
                `Failed to remove orphan ${fullPath}: ${e instanceof Error ? e.message : String(e)}`
              );
            }
          }
        }
      };
      cleanOrphans(chartPath);
    } catch (e) {
      app.debug(`Error cleaning chart directory: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const finalizeUploadedFiles = async (
    uploadedFiles: string[],
    targetFolder: string,
    basePath: string
  ): Promise<void> => {
    for (const filename of uploadedFiles) {
      const uploadDir =
        targetFolder && targetFolder !== '/' ? path.join(basePath, targetFolder) : basePath;
      const relativePath = path.relative(basePath, path.join(uploadDir, filename));
      setChartEnabled(relativePath, true);
      app.debug(`Enabled uploaded chart: ${relativePath}`);
    }

    await refreshChartProviders();

    for (const filename of uploadedFiles) {
      const chartId = filename.replace(/\.mbtiles$/, '');

      if (chartProviders[chartId]) {
        const chartData = sanitizeProvider(chartProviders[chartId], 2);
        emitChartDelta(chartId, chartData);
      }
    }
  };

  // Tippecanoe accepts zooms 0–22 in practice (anything beyond produces
  // 4×4 pixel tiles per source feature; nothing useful comes out and the
  // job runs much longer). Bound the inputs to that envelope so a typo
  // (`minzoom: 100`) is rejected at the boundary instead of silently
  // turning into a multi-hour conversion that produces unusable output.
  const ZoomLevel = Type.Integer({ minimum: 0, maximum: 22 });

  const CatalogDownloadBody = Type.Object({
    // `^https?://` is the floor: rejecting `file://`, `gopher://`, and the
    // bare-string SSRF case (e.g. supplying `169.254.169.254/...` as a
    // path-relative URL). Per-host allowlisting is a bigger conversation
    // — catalog charts come from many community-run hosts.
    url: Type.String({ minLength: 1, pattern: '^https?://' }),
    chartNumber: Type.String({ minLength: 1 }),
    catalogFile: Type.String({ minLength: 1 }),
    zipfileDatetime: Type.Optional(Type.String()),
    targetFolder: Type.Optional(Type.String()),
    minzoom: Type.Optional(ZoomLevel),
    maxzoom: Type.Optional(ZoomLevel)
  });

  const FolderCreateBody = Type.Object({
    folderPath: Type.String({ minLength: 1 })
  });

  const ChartToggleBody = Type.Object({
    enabled: Type.Boolean()
  });

  const MoveChartBody = Type.Object({
    chartPath: Type.String({ minLength: 1 }),
    targetFolder: Type.String({ minLength: 1 })
  });

  // The schema enforces the .mbtiles suffix; the post-parse guard then
  // rejects path-injection sequences (`..`, `/`, `\`) inside the stem.
  // TypeBox regex can't express that as cleanly as a plain check, and
  // mixing two patterns in one regex is the kind of subtle thing that
  // gets misread later.
  const RenameChartBody = Type.Object({
    chartPath: Type.String({ minLength: 1 }),
    newName: Type.String({ minLength: 1, pattern: '\\.mbtiles$' })
  });

  const ChartMetadataBody = Type.Object({
    name: Type.String({ minLength: 1 })
  });

  const RepairChartBody = Type.Object({
    // Case-insensitive: discovery matches `.mbtiles` case-insensitively, so
    // a hand-copied FOO.MBTILES can appear in the repair list and must pass
    // here too.
    chartPath: Type.String({ minLength: 1, pattern: '\\.[mM][bB][tT][iI][lL][eE][sS]$' })
  });

  // Multipart/header field schemas. Same domain rules as the JSON-body
  // counterparts: zoom bounds, https?:// URL floor, non-empty chart
  // names. parseShape (via Value.Convert) handles the busboy-string-only
  // wire format so `'9'` validates as the integer 9.
  const DownloadChartLockerFields = Type.Object({
    url: Type.String({ minLength: 1, pattern: '^https?://' }),
    targetFolder: Type.String({ minLength: 1 }),
    chartName: Type.String({ minLength: 1 })
  });

  const UploadFields = Type.Object({
    targetFolder: Type.Optional(Type.String())
  });

  const UploadChunkHeaders = Type.Object({
    'x-upload-filename': Type.String({ minLength: 1, pattern: '\\.mbtiles$' }),
    'x-chunk-index': Type.Integer({ minimum: 0 }),
    'x-total-chunks': Type.Integer({ minimum: 1 }),
    'x-target-folder': Type.Optional(Type.String())
  });

  const ConvertUploadFields = Type.Object({
    type: Type.Union([Type.Literal('s57'), Type.Literal('rnc')]),
    minzoom: Type.Optional(ZoomLevel),
    maxzoom: Type.Optional(ZoomLevel)
  });

  const registerRoutes = (router: IRouter): void => {
    app.debug('** Registering API paths via registerWithRouter **');

    router.post('/download-chart-locker', (req: Request, res: Response) => {
      const bb = Busboy({ headers: req.headers });

      const fields: Record<string, string> = {};
      bb.on('field', (name: string, value: string) => {
        fields[name] = value;
      });

      bb.on('finish', () => {
        const parsed = parseShape(DownloadChartLockerFields, fields, res);
        if (!parsed) {
          return;
        }
        const { url: downloadUrl, targetFolder, chartName } = parsed;

        // chartName becomes the on-disk filename in download-manager; a
        // value like `../../foo` would write outside the quarantine dir.
        const chartNameCheck = validateChartName(chartName);
        if (!chartNameCheck.valid) {
          res
            .status(400)
            .json({ success: false, error: `Invalid chart name: ${chartNameCheck.reason}` });
          return;
        }

        try {
          console.log(`Creating download job for: ${downloadUrl}`);
          console.log(`Target folder: ${targetFolder}`);

          const basePath = props.chartPath || defaultChartsPath;
          const targetDir = targetFolder === '/' ? basePath : path.join(basePath, targetFolder);

          if (!isWithinBase(targetDir, basePath)) {
            res.status(403).json({ success: false, error: 'Access denied: Invalid target folder' });
            return;
          }

          if (!fs.existsSync(targetDir)) {
            fs.mkdirSync(targetDir, { recursive: true });
          }

          // Stage the download in the quarantine dir; promote on
          // job-completed so a crash mid-fetch never leaves a partial
          // .mbtiles in the live chart library.
          const quarantineDir = makeQuarantineDir(app.getDataDirPath(), chartName);
          const jobId = downloadManager.createJob(downloadUrl, quarantineDir, chartName);

          const promoteListener = (job: DownloadJob): void => {
            if (job.id !== jobId) {
              return;
            }
            void (async () => {
              try {
                if (
                  job.status === 'completed' &&
                  job.extractedFiles &&
                  job.extractedFiles.length > 0
                ) {
                  try {
                    await promoteQuarantine(quarantineDir, job.extractedFiles, targetDir);
                  } catch (promoteErr) {
                    app.error(
                      `Promotion failed for ${chartName}: ${
                        promoteErr instanceof Error ? promoteErr.message : String(promoteErr)
                      }`
                    );
                    return;
                  }
                  // The global job-completed handler runs against
                  // job.targetDir (the quarantine), so the chart it
                  // tried to enable is at a path that no longer
                  // exists. Re-do enable + refresh against the live
                  // target so the chart actually shows up.
                  const basePath = props.chartPath || defaultChartsPath;
                  const targetFolderRel = path.relative(basePath, targetDir);
                  for (const fileName of job.extractedFiles) {
                    const relativePath = targetFolderRel
                      ? path.join(targetFolderRel, fileName)
                      : fileName;
                    setChartEnabled(relativePath, true);
                  }
                  await refreshChartProviders();
                  for (const fileName of job.extractedFiles) {
                    const chartId = fileName.replace(/\.mbtiles$/, '');
                    if (chartProviders[chartId]) {
                      const chartData = sanitizeProvider(chartProviders[chartId], 2);
                      emitChartDelta(chartId, chartData);
                    }
                  }
                }
              } finally {
                cleanupQuarantineDir(quarantineDir);
                downloadManager.removeListener('job-completed', promoteListener);
                downloadManager.removeListener('job-failed', promoteListener);
              }
            })();
          };
          downloadManager.on('job-completed', promoteListener);
          downloadManager.on('job-failed', promoteListener);

          res.json({
            success: true,
            jobId: jobId,
            message: 'Download job created'
          });
        } catch (error) {
          console.error('Error creating download job:', error);
          res.status(500).json({
            success: false,
            error:
              (error instanceof Error ? error.message : String(error)) ||
              'Failed to create download job'
          });
        }
      });

      req.pipe(bb);
    });

    router.get('/download-job/:jobId', (req: Request, res: Response) => {
      const jobId = (req.params as Record<string, string>).jobId;
      const job = downloadManager.getJob(jobId);

      if (!job) {
        res.status(404).json({ error: 'Job not found' });
        return;
      }

      res.json(job);
    });

    router.get('/download-jobs', (_req: Request, res: Response) => {
      const jobs = downloadManager.getAllJobs();
      res.json(jobs);
    });

    router.post('/cancel-download/:jobId', (req: Request, res: Response) => {
      const { jobId } = req.params as Record<string, string>;

      if (!jobId) {
        res.status(400).json({ success: false, error: 'jobId is required' });
        return;
      }

      app.debug(`Cancelling download job: ${jobId}`);
      const result = downloadManager.cancelJob(jobId);

      if (result.success) {
        res.json({ success: true, message: 'Download cancelled successfully' });
      } else {
        res.status(400).json(result);
      }
    });

    router.get('/download', (req: Request, res: Response) => {
      const url = req.query.url as string | undefined;
      if (!url) {
        res.status(400).send('url parameter is required');
        return;
      }

      https
        .get(url, (response) => {
          if (
            response.statusCode &&
            response.statusCode >= 300 &&
            response.statusCode < 400 &&
            response.headers.location
          ) {
            res.redirect(response.headers.location);
            return;
          }
          if (response.statusCode !== 200) {
            res.status(response.statusCode ?? 500).send(`Failed to download file from ${url}`);
            return;
          }
          const disposition = response.headers['content-disposition'];
          let filename = 'download.zip';
          if (disposition && disposition.indexOf('attachment') !== -1) {
            const filenameRegex = /filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/;
            const matches = filenameRegex.exec(disposition);
            if (matches?.[1]) {
              filename = matches[1].replace(/['"]/g, '');
            }
          }
          res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
          res.setHeader(
            'Content-Type',
            response.headers['content-type'] ?? 'application/octet-stream'
          );
          response.pipe(res);
        })
        .on('error', (err) => {
          console.error(`Error downloading file from ${url}`, err);
          res.status(500).send('Error downloading file');
        });
    });

    router.get('/local-charts', async (_req: Request, res: Response) => {
      try {
        const chartPath = props.chartPath || defaultChartsPath;
        const charts = await scanChartsRecursively(chartPath);

        const allFolders = await scanAllFolders(chartPath);

        const foldersSet = new Set<string>();
        foldersSet.add('/');

        charts.forEach((chart) => {
          foldersSet.add(chart.folder);
        });

        allFolders.forEach((folder) => foldersSet.add(folder));

        const folders = Array.from(foldersSet).sort((a, b) => {
          if (a === '/') {
            return -1;
          }
          if (b === '/') {
            return 1;
          }
          return a.localeCompare(b);
        });

        const activeJobs = downloadManager.getActiveJobs();
        const downloadingFiles = new Set<string>();

        activeJobs.forEach((job) => {
          if (job.status === 'downloading' || job.status === 'extracting') {
            if (job.targetFiles && job.targetFiles.length > 0) {
              job.targetFiles.forEach((file) => downloadingFiles.add(file));
            }
          }
        });

        const convertingCharts = getConvertingCharts();
        const convertingFolders = new Set<string>();
        for (const chartNum of Object.keys(convertingCharts)) {
          convertingFolders.add(chartNum);
        }

        const chartsWithState = charts.map((chart) => {
          let converting = false;
          for (const num of convertingFolders) {
            if (chart.folder && chart.folder.includes(num)) {
              converting = true;
              break;
            }
          }
          return {
            ...chart,
            enabled: isChartEnabled(chart.relativePath),
            downloading: downloadingFiles.has(chart.name),
            converting
          };
        });

        res.json({
          charts: chartsWithState,
          folders: folders,
          basePath: chartPath
        });
      } catch (error) {
        console.error('Error listing local charts:', error);
        res.status(500).send('Error listing local charts');
      }
    });

    router.delete('/local-charts/:chartPath', async (req: Request, res: Response) => {
      const chartPathParam = decodeURIComponent((req.params as Record<string, string>).chartPath);
      try {
        const basePath = props.chartPath || defaultChartsPath;
        const fullPath = path.join(basePath, chartPathParam);

        if (!isWithinBase(fullPath, basePath)) {
          res.status(403).send('Access denied: Invalid path');
          return;
        }

        const fileName = path.basename(fullPath);

        const activeJobs = downloadManager.findJobsByTargetFile(fileName);
        activeJobs.forEach((job) => {
          app.debug(`Cancelling download job ${job.id} for file: ${fileName}`);
          downloadManager.cancelJob(job.id);
        });

        if (fs.existsSync(fullPath)) {
          const stat = await fs.promises.stat(fullPath);
          if (stat.isDirectory()) {
            await fs.promises.rm(fullPath, { recursive: true, force: true });
            cleanupEmptyParents(fullPath, basePath);
          } else {
            await fs.promises.unlink(fullPath);
          }

          await refreshChartProviders();
          const chartId = path.basename(chartPathParam).replace(/\.mbtiles$/, '');
          emitChartDelta(chartId, null);

          // Primary path: reverse-lookup by the on-disk filename. The
          // converter records this in the install record after a
          // successful conversion, so a chart whose filename was
          // rewritten by catalog title (chartNumber=2 →
          // Port_of_Rotterdam_…mbtiles) still gets its catalog
          // "Installed" badge cleared.
          if (!removeInstallByFilename(chartPathParam)) {
            // Fall back to the legacy chartId/chartNumber heuristics
            // for charts installed before setInstallFilename existed.
            removeInstall(chartId);
            const chartNumberPart = chartId.replace(/^[A-Z]+-/, '');
            if (chartNumberPart !== chartId) {
              removeInstall(chartNumberPart);
            }
          }

          res.status(200).send('Chart deleted successfully');
        } else {
          await refreshChartProviders();
          const chartId = path.basename(chartPathParam).replace(/\.mbtiles$/, '');
          emitChartDelta(chartId, null);

          // Primary path: reverse-lookup by the on-disk filename. The
          // converter records this in the install record after a
          // successful conversion, so a chart whose filename was
          // rewritten by catalog title (chartNumber=2 →
          // Port_of_Rotterdam_…mbtiles) still gets its catalog
          // "Installed" badge cleared.
          if (!removeInstallByFilename(chartPathParam)) {
            // Fall back to the legacy chartId/chartNumber heuristics
            // for charts installed before setInstallFilename existed.
            removeInstall(chartId);
            const chartNumberPart = chartId.replace(/^[A-Z]+-/, '');
            if (chartNumberPart !== chartId) {
              removeInstall(chartNumberPart);
            }
          }

          res.status(200).send('Chart deletion processed');
        }
      } catch (error) {
        console.error(`Error deleting chart:`, error);
        res.status(500).send('Error deleting chart');
      }
    });

    router.post('/folders', async (req: Request, res: Response) => {
      const body = parseBody(FolderCreateBody, req, res);
      if (!body) {
        return;
      }
      const { folderPath } = body;

      app.debug(`Create folder request - folderPath: ${folderPath}`);

      try {
        const basePath = props.chartPath || defaultChartsPath;
        const fullPath = path.join(basePath, folderPath);

        app.debug(`Create folder - basePath: ${basePath}, fullPath: ${fullPath}`);

        if (!isWithinBase(fullPath, basePath)) {
          app.debug('Create folder failed: path traversal attempt');
          res.status(403).send('Access denied: Invalid path');
          return;
        }

        await fs.promises.mkdir(fullPath, { recursive: true });
        app.debug(`Folder created successfully: ${fullPath}`);
        res.status(200).json({ success: true, message: 'Folder created successfully' });
      } catch (error) {
        app.error(
          'Error creating folder: ' + (error instanceof Error ? error.message : String(error))
        );
        res
          .status(500)
          .send(
            'Error creating folder: ' + (error instanceof Error ? error.message : String(error))
          );
      }
    });

    router.delete('/folders/:folderPath', async (req: Request, res: Response) => {
      const folderPathParam = decodeURIComponent((req.params as Record<string, string>).folderPath);

      try {
        const basePath = props.chartPath || defaultChartsPath;
        const fullPath = path.join(basePath, folderPathParam);

        if (!isWithinBase(fullPath, basePath)) {
          res.status(403).send('Access denied: Invalid path');
          return;
        }

        if (path.normalize(fullPath) === path.normalize(basePath)) {
          res.status(403).send('Cannot delete the root chart directory');
          return;
        }

        if (!fs.existsSync(fullPath)) {
          res.status(404).send('Folder not found');
          return;
        }

        const contents = await fs.promises.readdir(fullPath);
        if (contents.length > 0) {
          res.status(400).send('Folder is not empty');
          return;
        }

        await fs.promises.rmdir(fullPath);
        res.status(200).json({ success: true, message: 'Folder deleted successfully' });
      } catch (error) {
        console.error('Error deleting folder:', error);
        res.status(500).send('Error deleting folder');
      }
    });

    router.post('/charts/:chartPath/toggle', async (req: Request, res: Response) => {
      const chartPathParam = decodeURIComponent((req.params as Record<string, string>).chartPath);
      const body = parseBody(ChartToggleBody, req, res);
      if (!body) {
        return;
      }
      const { enabled } = body;

      try {
        setChartEnabled(chartPathParam, enabled);

        app.debug(`Chart ${chartPathParam} set to ${enabled ? 'enabled' : 'disabled'}`);

        await refreshChartProviders();

        const chartId = path.basename(chartPathParam).replace(/\.mbtiles$/, '');

        if (enabled) {
          if (chartProviders[chartId]) {
            const chart = chartProviders[chartId];
            const chartData = sanitizeProvider(chart, 2);
            emitChartDelta(chartId, chartData);
            app.debug(`Delta emitted for enabled chart: ${chartId}`);
          } else {
            app.debug(`Chart ${chartId} not found in providers after enabling`);
          }
        } else {
          emitChartDelta(chartId, null);
          app.debug(`Delta emitted for disabled chart: ${chartId}`);
        }

        res
          .status(200)
          .json({ success: true, message: `Chart ${enabled ? 'enabled' : 'disabled'}` });
      } catch (error) {
        console.error('Error toggling chart state:', error);
        res.status(500).send('Error toggling chart state');
      }
    });

    router.post('/move-chart', async (req: Request, res: Response) => {
      const body = parseBody(MoveChartBody, req, res);
      if (!body) {
        return;
      }
      const { chartPath: chartPathBody, targetFolder } = body;

      app.debug(`Move chart request: chartPath=${chartPathBody}, targetFolder=${targetFolder}`);

      try {
        const basePath = props.chartPath || defaultChartsPath;
        const sourcePath = path.join(basePath, chartPathBody);
        app.debug(`Source path: ${sourcePath}`);

        const filename = path.basename(chartPathBody);

        let targetPath: string;
        if (targetFolder === '/') {
          targetPath = path.join(basePath, filename);
        } else {
          targetPath = path.join(basePath, targetFolder, filename);
        }
        app.debug(`Target path: ${targetPath}`);

        if (!arePairWithinBase(sourcePath, targetPath, basePath)) {
          res.status(403).send('Access denied: Invalid path');
          return;
        }

        if (!fs.existsSync(sourcePath)) {
          app.error(`Chart not found at: ${sourcePath}`);
          res.status(404).send('Chart not found');
          return;
        }

        const targetDir = path.dirname(targetPath);
        if (!fs.existsSync(targetDir)) {
          app.debug(`Creating target directory: ${targetDir}`);
          await fs.promises.mkdir(targetDir, { recursive: true });
        }

        await fs.promises.rename(sourcePath, targetPath);
        app.debug(`Moved chart from ${sourcePath} to ${targetPath}`);

        // Update any catalog-install record that points at the old
        // path so a later delete still clears the catalog "Installed"
        // badge by reverse-lookup.
        const newRelative = path.relative(basePath, targetPath);
        renameInstallFilename(chartPathBody, newRelative);

        await refreshChartProviders();

        const chartId = path.basename(chartPathBody).replace(/\.mbtiles$/, '');

        if (chartProviders[chartId]) {
          const chartData = sanitizeProvider(chartProviders[chartId], 2);
          emitChartDelta(chartId, chartData);
        }

        res.status(200).json({ success: true, message: 'Chart moved successfully' });
      } catch (error) {
        app.error(
          'Error moving chart: ' + (error instanceof Error ? error.message : String(error))
        );
        res
          .status(500)
          .send('Error moving chart: ' + (error instanceof Error ? error.message : String(error)));
      }
    });

    router.post('/rename-chart', async (req: Request, res: Response) => {
      const body = parseBody(RenameChartBody, req, res);
      if (!body) {
        return;
      }
      const { chartPath: chartPathBody, newName } = body;

      app.debug(`Rename chart request: chartPath=${chartPathBody}, newName=${newName}`);

      // Schema enforced the .mbtiles suffix; this guard rejects path
      // injection inside the stem (`../foo.mbtiles`, `a/b.mbtiles`, …).
      const nameWithoutExt = newName.replace(/\.mbtiles$/, '');
      if (
        nameWithoutExt.includes('..') ||
        nameWithoutExt.includes('/') ||
        nameWithoutExt.includes('\\')
      ) {
        res.status(400).send('Invalid chart name');
        return;
      }

      try {
        const basePath = props.chartPath || defaultChartsPath;
        const sourcePath = path.join(basePath, chartPathBody);
        app.debug(`Source path: ${sourcePath}`);

        const folder = path.dirname(chartPathBody);
        const targetPath = path.join(basePath, folder, newName);
        app.debug(`Target path: ${targetPath}`);

        if (!arePairWithinBase(sourcePath, targetPath, basePath)) {
          res.status(403).send('Access denied: Invalid path');
          return;
        }

        if (!fs.existsSync(sourcePath)) {
          app.error(`Chart not found at: ${sourcePath}`);
          res.status(404).send('Chart not found');
          return;
        }

        if (fs.existsSync(targetPath)) {
          res.status(400).send('A chart with this name already exists in the same folder');
          return;
        }

        await fs.promises.rename(sourcePath, targetPath);
        app.debug(`Renamed chart from ${sourcePath} to ${targetPath}`);

        // Patch the MBTiles `metadata.name` row to match the new label
        // so consumers (Freeboard-SK, OpenCPN-Web) display the renamed
        // chart by its new name and not the stale value tippecanoe (or
        // an earlier rename) wrote. Best-effort — a failure here doesn't
        // abort the rename, the file move already succeeded.
        try {
          const dnResult = await setMbtilesDisplayName(targetPath, nameWithoutExt, undefined, {
            onMessage: (m) => app.debug(`rename-chart: ${m}`)
          });
          if (!dnResult.ok) {
            console.warn(
              `[charts-provider] WARNING: ${dnResult.message} (${path.basename(targetPath)})`
            );
          }
        } catch (mdErr) {
          app.debug(
            `rename-chart metadata patch threw: ${mdErr instanceof Error ? mdErr.message : String(mdErr)}`
          );
        }

        // Update any catalog-install record that points at the old
        // path so a later delete still clears the catalog "Installed"
        // badge by reverse-lookup.
        const newRelative = path.relative(basePath, targetPath);
        renameInstallFilename(chartPathBody, newRelative);

        await refreshChartProviders();

        const oldChartId = path.basename(chartPathBody).replace(/\.mbtiles$/, '');
        const newChartId = path.basename(targetPath).replace(/\.mbtiles$/, '');

        emitChartDelta(oldChartId, null);

        if (chartProviders[newChartId]) {
          const chartData = sanitizeProvider(chartProviders[newChartId], 2);
          emitChartDelta(newChartId, chartData);
        }

        res.status(200).json({ success: true, message: 'Chart renamed successfully' });
      } catch (error) {
        app.error(
          'Error renaming chart: ' + (error instanceof Error ? error.message : String(error))
        );
        res
          .status(500)
          .send(
            'Error renaming chart: ' + (error instanceof Error ? error.message : String(error))
          );
      }
    });

    // List MBTiles that the loader dropped for missing `metadata.bounds`
    // but that have a valid tile pyramid — the Manage UI surfaces these
    // with a Repair action. Mirrors /local-charts' base-path resolution and
    // error shape.
    router.get('/repairable-charts', async (_req: Request, res: Response) => {
      try {
        const basePath = props.chartPath || defaultChartsPath;
        const repairable = await findRepairableCharts(basePath);
        res.json({ repairable, basePath });
      } catch (error) {
        console.error('Error listing repairable charts:', error);
        res.status(500).send('Error listing repairable charts');
      }
    });

    // Derive the missing metadata from the tile pyramid and write it into
    // the file so the chart loads. Mirrors /rename-chart: path-safety guard,
    // existence check, metadata write, refresh + delta. The read-only reader
    // used to derive values is closed before the writer opens.
    router.post('/repair-chart', async (req: Request, res: Response) => {
      const body = parseBody(RepairChartBody, req, res);
      if (!body) {
        return;
      }
      const { chartPath: chartPathBody } = body;
      app.debug(`Repair chart request: chartPath=${chartPathBody}`);

      try {
        const basePath = props.chartPath || defaultChartsPath;
        const sourcePath = path.join(basePath, chartPathBody);

        if (!isWithinBase(sourcePath, basePath)) {
          res.status(403).send('Access denied: Invalid path');
          return;
        }

        if (!fs.existsSync(sourcePath)) {
          app.error(`Chart not found at: ${sourcePath}`);
          res.status(404).send('Chart not found');
          return;
        }

        // Re-derive from a fresh read-only reader, then close it before the
        // writer opens — two handles on one sqlite file race on the lock.
        const reader = await openMbtilesReader(sourcePath);
        let derived;
        try {
          if (!reader.hasTiles()) {
            res.status(422).json({ error: 'Chart has no tiles — cannot derive metadata' });
            return;
          }
          const bounds = reader.deriveBoundsFromTiles();
          const zoom = reader.getZoomRangeFromTiles();
          if (!bounds || !zoom) {
            res.status(422).json({ error: 'Could not derive bounds from tiles' });
            return;
          }
          const format = reader.sniffFormatFromTiles() ?? reader.getInfo().format ?? 'png';
          const tileSize = format === 'pbf' ? undefined : reader.getTilePixelSize();
          derived = {
            bounds,
            minzoom: zoom.minzoom,
            maxzoom: zoom.maxzoom,
            format,
            ...(tileSize !== undefined && tileSize !== 256 ? { tileSize } : {})
          };
        } finally {
          reader.close();
        }

        const result = await repairMbtilesMetadata(sourcePath, derived, {
          onMessage: (m) => app.debug(`repair-chart: ${m}`)
        });
        if (!result.ok) {
          console.warn(
            `[charts-provider] WARNING: ${result.message} (${path.basename(sourcePath)})`
          );
          res.status(500).json({ error: result.message });
          return;
        }

        if (derived.tileSize !== undefined && derived.tileSize !== 256) {
          console.warn(
            `[charts-provider] ${path.basename(sourcePath)} uses ${derived.tileSize}px tiles; ` +
              `Freeboard-SK renders charts at 256px and needs its own tileSize support to ` +
              `display this correctly.`
          );
        }

        await refreshChartProviders();

        // Case-insensitive strip so a repaired FOO.MBTILES still matches the
        // chartProviders key the loader derives (also case-insensitive).
        const chartId = path.basename(chartPathBody).replace(/\.mbtiles$/i, '');
        if (chartProviders[chartId]) {
          const chartData = sanitizeProvider(chartProviders[chartId], 2);
          emitChartDelta(chartId, chartData);
        }

        res.status(200).json({
          success: true,
          chartId,
          written: result.written,
          skipped: result.skipped
        });
      } catch (error) {
        app.error(
          'Error repairing chart: ' + (error instanceof Error ? error.message : String(error))
        );
        res
          .status(500)
          .send(
            'Error repairing chart: ' + (error instanceof Error ? error.message : String(error))
          );
      }
    });

    router.put('/chart-metadata/:chartPath', async (req: Request, res: Response) => {
      const chartPathParam = decodeURIComponent((req.params as Record<string, string>).chartPath);
      const body = parseBody(ChartMetadataBody, req, res);
      if (!body) {
        return;
      }
      const { name } = body;

      try {
        const basePath = props.chartPath || defaultChartsPath;
        const fullPath = path.join(basePath, chartPathParam);

        if (!isWithinBase(fullPath, basePath)) {
          res.status(403).send('Access denied: Invalid path');
          return;
        }

        if (!fs.existsSync(fullPath)) {
          res.status(404).send('Chart not found');
          return;
        }

        if (!fullPath.endsWith('.mbtiles')) {
          res.status(400).send('Metadata editing only available for MBTiles charts');
          return;
        }

        const db = new DatabaseSync(fullPath);

        try {
          const description = 'USER MODIFIED - DO NOT DISTRIBUTE - PERSONAL USE ONLY';

          db.prepare('UPDATE metadata SET value = ? WHERE name = ?').run(name, 'name');
          db.prepare('UPDATE metadata SET value = ? WHERE name = ?').run(
            description,
            'description'
          );

          app.debug(`Chart metadata updated: ${chartPathParam} - New name: ${name}`);
        } finally {
          db.close();
        }

        await refreshChartProviders();

        const chartId = path.basename(chartPathParam).replace(/\.mbtiles$/, '');
        if (chartProviders[chartId]) {
          const chartData = sanitizeProvider(chartProviders[chartId], 2);
          emitChartDelta(chartId, chartData);
          app.debug(`Delta emitted for metadata update: ${chartId}`);
        }

        res.json({ success: true, message: 'Chart metadata updated successfully' });
      } catch (error) {
        console.error('Error updating chart metadata:', error);
        res.status(500).send('Error updating chart metadata');
      }
    });

    router.get('/chart-metadata/:chartPath', (req: Request, res: Response) => {
      const chartPathParam = decodeURIComponent((req.params as Record<string, string>).chartPath);

      try {
        const basePath = props.chartPath || defaultChartsPath;
        const fullPath = path.join(basePath, chartPathParam);

        if (!isWithinBase(fullPath, basePath)) {
          res.status(403).send('Access denied: Invalid path');
          return;
        }

        if (!fs.existsSync(fullPath)) {
          res.status(404).send('Chart not found');
          return;
        }

        if (!fullPath.endsWith('.mbtiles')) {
          res.status(400).send('Metadata only available for MBTiles charts');
          return;
        }

        const db = new DatabaseSync(fullPath, { readOnly: true });

        try {
          const rows = db.prepare('SELECT name, value FROM metadata').all() as Array<{
            name: string;
            value: string;
          }>;

          const metadata: Record<string, unknown> = {};
          rows.forEach((row) => {
            metadata[row.name] = row.value;
          });

          try {
            const countRow = db.prepare('SELECT COUNT(*) as count FROM map').get() as
              { count: number } | undefined;
            if (countRow) {
              metadata.tileCount = countRow.count;
            }
          } catch {
            try {
              const countRow = db.prepare('SELECT COUNT(*) as count FROM tiles').get() as
                { count: number } | undefined;
              if (countRow) {
                metadata.tileCount = countRow.count;
              }
            } catch {
              // If both fail, silently omit tile count
            }
          }

          res.json(metadata);
        } finally {
          db.close();
        }
      } catch (error) {
        console.error('Error fetching chart metadata:', error);
        res.status(500).send('Error fetching chart metadata');
      }
    });

    router.post('/upload', (req: Request, res: Response) => {
      try {
        const bb = Busboy({ headers: req.headers });
        const basePath = props.chartPath || defaultChartsPath;
        // Per-request quarantine dir: every uploaded `.mbtiles` is
        // streamed here first, then atomically promoted on `finish`.
        // A crashed/aborted request leaves the partial files in the
        // quarantine for the startup sweep to wipe, never in basePath.
        const quarantineDir = makeQuarantineDir(
          app.getDataDirPath(),
          `upload-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        );
        const uploadedFiles: string[] = [];
        const writePromises: Promise<void>[] = [];
        const fields: Record<string, string> = {};
        let traversalRejected = false;

        bb.on('field', (fieldname: string, value: string) => {
          fields[fieldname] = value;
        });

        bb.on(
          'file',
          (_fieldname: string, file: NodeJS.ReadableStream, info: { filename: string }) => {
            const { filename } = info;

            if (!filename.endsWith('.mbtiles')) {
              (file as NodeJS.ReadableStream & { resume(): void }).resume();
              return;
            }

            const targetFolder = fields.targetFolder ?? '';
            let uploadPath = basePath;
            if (targetFolder && targetFolder !== '/') {
              uploadPath = path.join(basePath, targetFolder);
            }

            // Reject path-traversal in either the targetFolder or the
            // upload's own filename (`filename: '../etc/passwd'`).
            // Resolve against basePath even though we stage in the
            // quarantine — the *intended* destination is what matters
            // for the access-control check.
            if (
              !isWithinBase(path.join(uploadPath, filename), basePath) ||
              path.basename(filename) !== filename
            ) {
              traversalRejected = true;
              (file as NodeJS.ReadableStream & { resume(): void }).resume();
              return;
            }

            const stagedPath = path.join(quarantineDir, filename);
            app.debug(`Staging upload: ${filename} -> ${stagedPath}`);

            const writeStream = fs.createWriteStream(stagedPath);
            file.pipe(writeStream);

            const writePromise = new Promise<void>((resolve, reject) => {
              writeStream.on('finish', () => {
                uploadedFiles.push(filename);
                app.debug(`Upload staged successfully: ${filename}`);
                resolve();
              });

              writeStream.on('error', (err: Error) => {
                app.error(`Error staging file ${filename}: ${err.message}`);
                reject(err);
              });
            });

            writePromises.push(writePromise);
          }
        );

        bb.on('finish', () => {
          void (async () => {
            // Validate fields here (after busboy has handed every one to
            // us). The 'file' handler already used `fields.targetFolder`
            // to decide upload paths; doing the schema check on `finish`
            // also lets us include 'targetFolder' rules in the validator.
            const parsed = parseShape(UploadFields, fields, res);
            if (!parsed) {
              cleanupQuarantineDir(quarantineDir);
              return;
            }
            const { targetFolder = '' } = parsed;

            if (traversalRejected) {
              cleanupQuarantineDir(quarantineDir);
              res.status(403).json({ success: false, error: 'Access denied: Invalid upload path' });
              return;
            }

            try {
              await Promise.all(writePromises);

              if (uploadedFiles.length > 0) {
                const promoteTarget =
                  targetFolder && targetFolder !== '/'
                    ? path.join(basePath, targetFolder)
                    : basePath;
                // The earlier per-file `isWithinBase` check ran against
                // each filename joined with the *raw* `fields.targetFolder`,
                // before busboy had handed us every field. The actual
                // promotion target is computed here from the *parsed*
                // value, so re-check containment before we move staged
                // files anywhere — a malformed targetFolder mustn't be
                // able to slip through and direct the promotion outside
                // basePath.
                if (!isWithinBase(promoteTarget, basePath)) {
                  cleanupQuarantineDir(quarantineDir);
                  res
                    .status(403)
                    .json({ success: false, error: 'Access denied: Invalid upload path' });
                  return;
                }
                await promoteQuarantine(quarantineDir, uploadedFiles, promoteTarget);

                await finalizeUploadedFiles(uploadedFiles, targetFolder, basePath);

                res.status(200).json({
                  success: true,
                  message: `${uploadedFiles.length} file(s) uploaded successfully`,
                  files: uploadedFiles
                });
              } else {
                res.status(400).send('No valid .mbtiles files uploaded');
              }
            } catch (error) {
              app.error(
                'Error completing file uploads: ' +
                  (error instanceof Error ? error.message : String(error))
              );
              res.status(500).send('Error completing file uploads');
            } finally {
              cleanupQuarantineDir(quarantineDir);
            }
          })();
        });

        req.pipe(bb);
      } catch (error) {
        app.error(
          'Error uploading charts: ' + (error instanceof Error ? error.message : String(error))
        );
        res.status(500).send('Error uploading charts');
      }
    });

    // Chunked upload for large files — each chunk is a short-lived request that
    // stays well within Node's server.requestTimeout (default 300s in Node 18+).
    router.put('/upload-chunk', (req: Request, res: Response) => {
      try {
        // Headers are pulled from req.headers as a plain object; node
        // already lowercases the names, so picking the four we care
        // about by-name is safe. parseShape coerces the numeric ones
        // (`x-chunk-index`, `x-total-chunks`) from string to integer.
        const headerFields = {
          'x-upload-filename': req.headers['x-upload-filename'],
          'x-chunk-index': req.headers['x-chunk-index'],
          'x-total-chunks': req.headers['x-total-chunks'],
          'x-target-folder': req.headers['x-target-folder']
        };
        const parsed = parseShape(UploadChunkHeaders, headerFields, res);
        if (!parsed) {
          return;
        }
        const filename = parsed['x-upload-filename'];
        const chunkIndex = parsed['x-chunk-index'];
        const totalChunks = parsed['x-total-chunks'];
        const targetFolder = parsed['x-target-folder'] ?? '/';

        const basePath = props.chartPath || defaultChartsPath;
        let uploadPath = basePath;
        if (targetFolder && targetFolder !== '/') {
          uploadPath = path.join(basePath, targetFolder);
        }

        const finalPath = path.join(uploadPath, filename);

        // Reject path-traversal via either header. Catches `'../foo.mbtiles'`
        // as a filename and `'../etc'` as a target-folder, both of which
        // would otherwise resolve outside the chart root. Re-check
        // basename to catch any traversal in the filename header itself
        // even though arePairWithinBase already handled the resolved
        // path — defense in depth before we use it as a path segment
        // inside the quarantine dir.
        if (
          !arePairWithinBase(finalPath, finalPath, basePath) ||
          path.basename(filename) !== filename
        ) {
          res.status(403).json({ error: 'Access denied: Invalid upload path' });
          return;
        }

        // Stage chunked uploads in a per-filename quarantine dir.  All
        // chunks append to a single staged file there; only the final
        // chunk promotes it to the live `uploadPath`. A crash mid-upload
        // therefore can never leave a half-built `.mbtiles` in the
        // chart library — the startup sweep wipes the quarantine.
        const quarantineDir = makeQuarantineDir(app.getDataDirPath(), `chunk-${filename}`);
        const stagedPath = path.join(quarantineDir, filename);

        const writeStream = fs.createWriteStream(stagedPath, {
          flags: chunkIndex === 0 ? 'w' : 'a'
        });

        req.pipe(writeStream);

        writeStream.on('finish', () => {
          void (async () => {
            try {
              if (chunkIndex + 1 < totalChunks) {
                app.debug(`Chunk ${chunkIndex + 1}/${totalChunks} for ${filename}`);
                res.json({ received: chunkIndex, total: totalChunks });
                return;
              }

              // Final chunk — promote the staged file out of quarantine.
              app.debug(`Final chunk ${totalChunks}/${totalChunks} for ${filename}, assembling`);
              try {
                await promoteQuarantine(quarantineDir, [filename], uploadPath);
                await finalizeUploadedFiles([filename], targetFolder, basePath);
                res.json({
                  success: true,
                  message: `${filename} uploaded successfully`,
                  files: [filename]
                });
              } finally {
                cleanupQuarantineDir(quarantineDir);
              }
            } catch (error) {
              app.error(
                `Error finalizing chunked upload: ${error instanceof Error ? error.message : String(error)}`
              );
              res.status(500).json({ error: 'Error finalizing upload' });
            }
          })();
        });

        writeStream.on('error', (err: Error) => {
          app.error(`Error writing chunk for ${filename}: ${err.message}`);
          res.status(500).json({ error: 'Error writing chunk' });
        });
      } catch (error) {
        app.error(
          'Error in chunked upload: ' + (error instanceof Error ? error.message : String(error))
        );
        res.status(500).json({ error: 'Error in chunked upload' });
      }
    });

    // ---- Chart Catalog API routes ----

    router.get('/catalog-registry', (_req: Request, res: Response) => {
      try {
        const registry = getCatalogRegistry();
        const installed = getInstalledCatalogCharts();
        const convertingCharts = getConvertingCharts();
        res.json({
          registry,
          installed,
          converting: convertingCharts,
          registryStatus: getRegistryStatus()
        });
      } catch (error) {
        console.error('Error fetching catalog registry:', error);
        res.status(500).json({ error: 'Failed to fetch catalog registry' });
      }
    });

    // Force a re-fetch of the catalog index from GitHub (the Refresh button).
    // Awaits the fetch so the response reflects the just-attempted result, but
    // swallows the rejection — registryStatus carries the reason (rate-limited
    // / offline / error) so the UI can message accurately.
    router.post('/catalog-registry/refresh', (_req: Request, res: Response) => {
      void (async () => {
        try {
          await fetchCatalogRegistry().catch((err: unknown) => {
            app.debug(
              `Catalog registry refresh failed: ${err instanceof Error ? err.message : String(err)}`
            );
          });
          res.json({
            registry: getCatalogRegistry(),
            installed: getInstalledCatalogCharts(),
            converting: getConvertingCharts(),
            registryStatus: getRegistryStatus()
          });
        } catch (error) {
          // The refresh itself is awaited+swallowed above; this only fires if
          // building the response throws.
          console.error('Error building catalog refresh response:', error);
          res.status(500).json({ error: 'Failed to build catalog refresh response' });
        }
      })();
    });

    router.get('/catalog-s57-status', (_req: Request, res: Response) => {
      // Runtime info is owned by signalk-container in 2.0+; we report
      // whatever its manager exposes.  Available = manager present AND
      // its runtime detection has succeeded.  socketPath is no longer a
      // first-class concept (signalk-container shells out to the
      // podman/docker CLI rather than the daemon socket), so we emit
      // null for that field — the UI uses it for display only.
      const containerManager = getContainerManager();
      const rt = containerManager?.getRuntime() ?? null;
      const available = rt !== null;
      const version = rt ? `${rt.runtime} version ${rt.version}` : null;
      const engine = rt?.runtime ?? null;
      res.json({
        containerRuntimeAvailable: available,
        containerRuntimeVersion: version,
        containerRuntimeEngine: engine,
        containerRuntimeSocketPath: null,
        // legacy aliases (kept until next breaking release)
        podmanAvailable: available,
        podmanVersion: version,
        conversions: { ...getAllS57Progress(), ...getAllRncProgress() }
      });
    });

    router.get('/catalog-s57-log/:chartNumber', (req: Request, res: Response) => {
      const progress =
        getS57Progress((req.params as Record<string, string>).chartNumber) ||
        getRncProgress((req.params as Record<string, string>).chartNumber);
      if (!progress) {
        res.json({ log: [], status: null });
        return;
      }
      const tail = parseInt(req.query.tail as string) || 100;
      const log = progress.log || [];
      res.json({
        log: log.slice(-tail),
        status: progress.status,
        message: progress.message
      });
    });

    router.get('/catalog-updates', (_req: Request, res: Response) => {
      try {
        const updates = checkForUpdates();
        res.json(updates);
      } catch (error) {
        console.error('Error checking catalog updates:', error);
        res.status(500).json({ error: 'Failed to check for updates' });
      }
    });

    router.get('/catalog/:catalogFile', async (req: Request, res: Response) => {
      try {
        const catalogFile = (req.params as Record<string, string>).catalogFile;
        const data = await fetchCatalog(catalogFile);
        if (!data) {
          res.status(404).json({ error: 'Catalog not found or unavailable' });
          return;
        }

        const installed = getInstalledCatalogCharts();
        const registryEntry = getCatalogRegistry().find((r) => r.file === catalogFile);
        const catalogCategory = registryEntry ? registryEntry.category : '';
        const augmentedCharts = data.charts.map((chart) => ({
          ...chart,
          urlClassification: classifyUrl(chart.zipfile_location, catalogCategory),
          installed:
            !!installed[chart.number] &&
            installed[chart.number].zipfile_location === chart.zipfile_location,
          installedDate:
            installed[chart.number] &&
            installed[chart.number].zipfile_location === chart.zipfile_location
              ? installed[chart.number].zipfile_datetime_iso8601
              : null
        }));

        res.json({
          ...data,
          charts: augmentedCharts
        });
      } catch (error) {
        const cached = getCachedCatalog((req.params as Record<string, string>).catalogFile);
        if (cached) {
          res.json(cached);
          return;
        }
        console.error('Error fetching catalog:', error);
        res.status(500).json({ error: 'Failed to fetch catalog' });
      }
    });

    router.post('/convert-upload', (req: Request, res: Response) => {
      const bb = Busboy({ headers: req.headers, limits: { fileSize: 500 * 1024 * 1024 } });
      const chartPath = props.chartPath || defaultChartsPath;

      const tmpDir = path.join(app.getDataDirPath(), `convert-upload-${Date.now()}`);
      fs.mkdirSync(tmpDir, { recursive: true });

      let uploadedFile: string | null = null;
      let uploadedFileName = '';
      const fields: Record<string, string> = {};

      bb.on('field', (name: string, value: string) => {
        fields[name] = value;
      });

      bb.on(
        'file',
        (_fieldname: string, file: NodeJS.ReadableStream, info: { filename: string }) => {
          const { filename } = info;
          if (!filename.endsWith('.zip')) {
            (file as NodeJS.ReadableStream & { resume(): void }).resume();
            return;
          }
          uploadedFileName = filename;
          uploadedFile = path.join(tmpDir, filename);
          const ws = fs.createWriteStream(uploadedFile);
          file.pipe(ws);
        }
      );

      bb.on('finish', () => {
        if (!uploadedFile || !fs.existsSync(uploadedFile)) {
          cleanupDir(tmpDir);
          res.status(400).json({ success: false, error: 'No ZIP file uploaded' });
          return;
        }

        const parsed = parseShape(ConvertUploadFields, fields, res);
        if (!parsed) {
          cleanupDir(tmpDir);
          return;
        }
        const convType = parsed.type;
        const minzoom = parsed.minzoom ?? 9;
        const maxzoom = parsed.maxzoom ?? 16;

        if (minzoom > maxzoom) {
          cleanupDir(tmpDir);
          res.status(400).json({ success: false, error: 'minzoom must be ≤ maxzoom' });
          return;
        }

        const validatedFile = uploadedFile;
        void (async () => {
          const cm = getContainerManager();
          if (!cm?.getRuntime()) {
            cleanupDir(tmpDir);
            res.status(503).json({
              success: false,
              error:
                'signalk-container plugin not available. Install it from the App Store and restart Signal K.'
            });
            return;
          }

          const budgetMax = getCpuBudget().maxConcurrentConversions;
          if (getConvertingCount() >= budgetMax) {
            cleanupDir(tmpDir);
            res.status(429).json({
              success: false,
              error: `Too many conversions running (max ${budgetMax}). Please wait for a conversion to finish.`
            });
            return;
          }

          const chartNumber = path
            .basename(uploadedFileName, '.zip')
            .replace(/[^a-zA-Z0-9_-]/g, '_');

          // Order matters: defer the success response until
          // makeQuarantineDir has actually returned. A permission /
          // disk error there used to surface AFTER the client had
          // already been told the conversion was running, leaving
          // the UI stuck waiting for status it would never get.
          let quarantineDir: string;
          try {
            quarantineDir = makeQuarantineDir(app.getDataDirPath(), chartNumber);
          } catch (err) {
            res.status(500).json({
              success: false,
              error: `Failed to prepare conversion workspace: ${
                err instanceof Error ? err.message : String(err)
              }`
            });
            return;
          }
          setConvertingState(chartNumber, true);
          res.json({ success: true, chartNumber, message: 'Conversion started' });

          try {
            if (convType === 's57') {
              const result = await processS57Zip(
                validatedFile,
                quarantineDir,
                chartNumber,
                (status, message) => {
                  app.debug(`Convert [${chartNumber}] ${status}: ${message}`);
                },
                { minzoom, maxzoom }
              );

              await promoteQuarantine(quarantineDir, [result.mbtilesFile], chartPath);

              const relativePath = path.relative(
                chartPath,
                path.join(chartPath, result.mbtilesFile)
              );
              setChartEnabled(relativePath, true);
              await refreshChartProviders();
              const chartId = result.mbtilesFile.replace(/\.mbtiles$/, '');
              if (chartProviders[chartId]) {
                const chartData = sanitizeProvider(chartProviders[chartId], 2);
                emitChartDelta(chartId, chartData);
              }
              app.debug(`Convert complete: ${chartNumber} → ${result.mbtilesFile}`);
            } else if (convType === 'rnc') {
              const result = await processRncZip(
                validatedFile,
                quarantineDir,
                chartNumber,
                (status, message) => {
                  app.debug(`Convert [${chartNumber}] ${status}: ${message}`);
                }
              );

              await promoteQuarantine(quarantineDir, result.mbtilesFiles, chartPath);

              for (const mbtilesFile of result.mbtilesFiles) {
                const relativePath = path.relative(chartPath, path.join(chartPath, mbtilesFile));
                setChartEnabled(relativePath, true);
              }
              await refreshChartProviders();
              for (const mbtilesFile of result.mbtilesFiles) {
                const chartId = mbtilesFile.replace(/\.mbtiles$/, '');
                if (chartProviders[chartId]) {
                  const chartData = sanitizeProvider(chartProviders[chartId], 2);
                  emitChartDelta(chartId, chartData);
                }
              }
              app.debug(`Convert complete: ${chartNumber} → ${result.mbtilesFiles.join(', ')}`);
            }
          } catch (error) {
            app.error(
              `Convert failed for ${chartNumber}: ${error instanceof Error ? error.message : String(error)}`
            );
          } finally {
            setConvertingState(chartNumber, false);
            cleanupQuarantineDir(quarantineDir);
            cleanupDir(tmpDir);
          }
        })();
      });

      req.pipe(bb);
    });

    router.post('/catalog/download', (req: Request, res: Response) => {
      const body = parseBody(CatalogDownloadBody, req, res);
      if (!body) {
        return;
      }
      // TypeBox bounds each field independently; cross-field invariants
      // (`minzoom <= maxzoom`) need a plain post-parse guard. A typo
      // here would silently produce empty tile sets after a long run.
      if (body.minzoom !== undefined && body.maxzoom !== undefined && body.minzoom > body.maxzoom) {
        res.status(400).json({ success: false, error: 'minzoom must be ≤ maxzoom' });
        return;
      }
      const { url, chartNumber, catalogFile, zipfileDatetime, targetFolder, minzoom, maxzoom } =
        body;

      // chartNumber reaches download-manager as the on-disk filename for
      // the direct-.mbtiles branch; guard it the same way as the locker
      // route so a crafted catalog entry can't escape the quarantine dir.
      const chartNumberCheck = validateChartName(chartNumber);
      if (!chartNumberCheck.valid) {
        res
          .status(400)
          .json({ success: false, error: `Invalid chart number: ${chartNumberCheck.reason}` });
        return;
      }

      const registryEntry = getCatalogRegistry().find((r) => r.file === catalogFile);
      const catalogCategory = registryEntry ? registryEntry.category : '';
      const classification = classifyUrl(url, catalogCategory);
      if (!classification.supported) {
        res.status(400).json({
          success: false,
          error: `Unsupported format: ${classification.label}`
        });
        return;
      }

      try {
        const chartPath = props.chartPath || defaultChartsPath;
        const targetDir =
          !targetFolder || targetFolder === '/' ? chartPath : path.join(chartPath, targetFolder);

        // Reject `targetFolder: '../etc'` etc. before mkdir/mkdirSync. The
        // schema's String pattern can't catch every traversal vector
        // (e.g. `valid/../escape`); the helper does the normalize-and-
        // startsWith check used by every other mutating route.
        if (!isWithinBase(targetDir, chartPath)) {
          res.status(403).json({ success: false, error: 'Access denied: Invalid target folder' });
          return;
        }

        if (!fs.existsSync(targetDir)) {
          fs.mkdirSync(targetDir, { recursive: true });
        }

        const needsRuntime = ['s57-zip', 'rnc-zip', 'gshhg', 'pilot-tar', 'shp-basemap'].includes(
          classification.format
        );

        if (needsRuntime) {
          const cm = getContainerManager();
          if (!cm?.getRuntime()) {
            res.status(503).json({
              success: false,
              error:
                'signalk-container plugin not available. Install it from the App Store and restart Signal K.'
            });
            return;
          }
        }

        const budgetMax = getCpuBudget().maxConcurrentConversions;
        if (needsRuntime && getConvertingCount() >= budgetMax) {
          res.status(429).json({
            success: false,
            error: `Too many conversions running (max ${budgetMax}). Please wait for a conversion to finish.`
          });
          return;
        }

        // Look up the chart's catalog title so the converter can write
        // the cleaned label into MBTiles metadata.name (and the full
        // original title into metadata.description). Manual uploads
        // don't go through this path so they keep the existing
        // 'S-57 <chartNumber>' default.
        const cachedCatalog = getCachedCatalog(catalogFile);
        const chartTitle = cachedCatalog?.charts.find((c) => c.number === chartNumber)?.title;

        if (classification.format === 's57-zip') {
          handleS57Download(
            res,
            app,
            url,
            chartNumber,
            catalogFile,
            zipfileDatetime,
            targetDir,
            chartPath,
            minzoom,
            maxzoom,
            chartTitle
          );
        } else if (classification.format === 'rnc-zip') {
          handleRncDownload(
            res,
            app,
            url,
            chartNumber,
            catalogFile,
            zipfileDatetime,
            targetDir,
            chartPath
          );
        } else if (classification.format === 'pilot-tar') {
          handlePilotDownload(
            res,
            app,
            url,
            chartNumber,
            catalogFile,
            zipfileDatetime,
            targetDir,
            chartPath
          );
        } else if (classification.format === 'shp-basemap') {
          handleShpBasemapDownload(
            res,
            app,
            url,
            chartNumber,
            catalogFile,
            zipfileDatetime,
            targetDir,
            chartPath
          );
        } else if (classification.format === 'gshhg') {
          handleGshhgDownload(
            res,
            app,
            chartNumber,
            catalogFile,
            zipfileDatetime,
            url,
            targetDir,
            chartPath
          );
        } else {
          // Direct .mbtiles download (or ZIP-of-.mbtiles): stage into the
          // quarantine dir so a crash mid-download/extract never leaves a
          // half-built file in the live chart library. Promotion runs on
          // job-completed; failure / no-files paths drop the quarantine.
          const quarantineDir = makeQuarantineDir(app.getDataDirPath(), chartNumber);
          const jobId = downloadManager.createJob(url, quarantineDir, chartNumber);

          trackInstall(chartNumber, catalogFile, zipfileDatetime ?? '', url);

          const cleanupListener = (job: DownloadJob): void => {
            if (job.id !== jobId) {
              return;
            }
            void (async () => {
              try {
                if (!job.extractedFiles || job.extractedFiles.length === 0) {
                  rollbackInstall(chartNumber);
                  app.debug(`Removed catalog tracking for ${chartNumber}: no .mbtiles extracted`);
                  return;
                }
                if (job.status !== 'completed') {
                  // Failed downloads leak nothing into the live target;
                  // the quarantine wipe in `finally` handles cleanup.
                  rollbackInstall(chartNumber);
                  return;
                }
                try {
                  await promoteQuarantine(quarantineDir, job.extractedFiles, targetDir);
                } catch (promoteErr) {
                  app.error(
                    `Promotion failed for ${chartNumber}: ${
                      promoteErr instanceof Error ? promoteErr.message : String(promoteErr)
                    }`
                  );
                  rollbackInstall(chartNumber);
                  return;
                }
                // The global `job-completed` handler enables charts and
                // refreshes providers against `job.targetDir`, but with
                // quarantine that's the staging dir under
                // `<dataDir>/in-progress/`, not the live target. So
                // run the same enable + refresh + delta-emit cycle
                // ourselves now that the files are actually in place.
                const targetFolderRel = path.relative(chartPath, targetDir);
                for (const fileName of job.extractedFiles) {
                  const relativePath = targetFolderRel
                    ? path.join(targetFolderRel, fileName)
                    : fileName;
                  setChartEnabled(relativePath, true);
                  app.debug(`Enabled promoted chart: ${relativePath}`);
                }
                await refreshChartProviders();
                for (const fileName of job.extractedFiles) {
                  const chartId = fileName.replace(/\.mbtiles$/, '');
                  if (chartProviders[chartId]) {
                    const chartData = sanitizeProvider(chartProviders[chartId], 2);
                    emitChartDelta(chartId, chartData);
                    app.debug(`Delta emitted for promoted chart: ${chartId}`);
                  }
                }
                // Record the produced filename so the delete flow can
                // clear this install record by reverse-lookup. Same
                // pattern as the S-57 / RNC conversion completion paths.
                const firstFile = job.extractedFiles[0];
                if (firstFile) {
                  const relativePath = targetFolderRel
                    ? path.join(targetFolderRel, firstFile)
                    : firstFile;
                  setInstallFilename(chartNumber, relativePath);
                }
              } finally {
                cleanupQuarantineDir(quarantineDir);
                downloadManager.removeListener('job-failed', cleanupListener);
                downloadManager.removeListener('job-completed', cleanupListener);
              }
            })();
          };
          downloadManager.on('job-failed', cleanupListener);
          downloadManager.on('job-completed', cleanupListener);

          app.debug(`Catalog download started: ${chartNumber} from ${catalogFile}, job: ${jobId}`);

          res.json({
            success: true,
            jobId,
            message: 'Download job created from catalog'
          });
        }
      } catch (error) {
        console.error('Error creating catalog download job:', error);
        res.status(500).json({
          success: false,
          error:
            (error instanceof Error ? error.message : String(error)) ||
            'Failed to create download job'
        });
      }
    });

    // ---- Custom NOAA ENC catalogs ----
    // Build a named bundle of NOAA band-4 coverage areas selected on a map,
    // then download all selected band-4 ENCs plus overlapping band-3/5 ENCs
    // and convert them once into a single MBTiles named after the catalog.

    const CustomCatalogCreateBody = Type.Object({
      name: Type.String({ minLength: 1, maxLength: 120 })
    });
    const CustomCatalogUpdateBody = Type.Object({
      name: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
      selectedBand4ChartIds: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 32 })))
    });

    // Map data: all NOAA band-4 footprints as selectable bbox areas. This is
    // the one endpoint that fetches the (large) NOAA enc.geojson; every other
    // endpoint reads the in-memory index via peekFootprintIndex(). Registered
    // BEFORE '/custom-catalogs/:id' so the literal path wins over the param.
    router.get('/custom-catalogs/noaa-enc-footprints', (req: Request, res: Response) => {
      const forceRefresh = req.query.refresh === '1' || req.query.refresh === 'true';
      void (async () => {
        try {
          const index = await getFootprintIndex({ forceRefresh });
          res.json({
            band4: band4MapEntries(index.all),
            fetchedAt: index.fetchedAt,
            stale: index.stale
          });
        } catch (error) {
          res.status(502).json({
            error: error instanceof Error ? error.message : 'Failed to load NOAA ENC footprints'
          });
        }
      })();
    });

    router.get('/custom-catalogs', (_req: Request, res: Response) => {
      res.json(listCustomCatalogs().map((c) => decorateCatalog(c)));
    });

    router.post('/custom-catalogs', (req: Request, res: Response) => {
      const body = parseBody(CustomCatalogCreateBody, req, res);
      if (!body) {
        return;
      }
      try {
        const catalog = createCustomCatalog(body.name);
        res.status(201).json(decorateCatalog(catalog));
      } catch (error) {
        res.status(400).json({
          success: false,
          error: error instanceof Error ? error.message : 'Failed to create catalog'
        });
      }
    });

    router.get('/custom-catalogs/:id', (req: Request, res: Response) => {
      const catalog = getCustomCatalog((req.params as Record<string, string>).id);
      if (!catalog) {
        res.status(404).json({ error: 'Custom catalog not found' });
        return;
      }
      res.json(decorateCatalog(catalog));
    });

    router.put('/custom-catalogs/:id', (req: Request, res: Response) => {
      const id = (req.params as Record<string, string>).id;
      const catalog = getCustomCatalog(id);
      if (!catalog) {
        res.status(404).json({ error: 'Custom catalog not found' });
        return;
      }
      if (isCatalogBusy(id)) {
        res
          .status(409)
          .json({ error: 'Catalog is downloading/converting; try again when it finishes' });
        return;
      }
      const body = parseBody(CustomCatalogUpdateBody, req, res);
      if (!body) {
        return;
      }
      if (body.name !== undefined && body.name.trim() !== '') {
        catalog.name = body.name.trim();
      }
      if (body.selectedBand4ChartIds !== undefined) {
        catalog.selectedBand4ChartIds = Array.from(new Set(body.selectedBand4ChartIds));
        // Recompute coverage from the cached footprint index when available so
        // the UI shows an included-chart count immediately. The snapshot in
        // `chartVersions` is only refreshed at download time.
        const index = peekFootprintIndex();
        if (index) {
          catalog.includedChartIds = computeInclusion(
            index.all,
            catalog.selectedBand4ChartIds
          ).includedChartIds;
        }
        // Any selection change requires a rebuild of the single combined chart.
        catalog.status = catalog.selectedBand4ChartIds.length === 0 ? 'empty' : 'out_of_date';
      }
      saveCustomCatalog(catalog);
      res.json(decorateCatalog(catalog));
    });

    router.delete('/custom-catalogs/:id', (req: Request, res: Response) => {
      const id = (req.params as Record<string, string>).id;
      if (isCatalogBusy(id)) {
        res.status(409).json({ error: 'Catalog is downloading/converting; cannot delete now' });
        return;
      }
      if (!deleteCustomCatalog(id)) {
        res.status(404).json({ error: 'Custom catalog not found' });
        return;
      }
      // The produced .mbtiles (if any) is intentionally left in the chart
      // library — deleting the catalog definition is non-destructive. The user
      // can remove the chart itself from the Manage Charts tab.
      res.json({ success: true });
    });

    router.post('/custom-catalogs/:id/download-convert', (req: Request, res: Response) => {
      const id = (req.params as Record<string, string>).id;
      const catalog = getCustomCatalog(id);
      if (!catalog) {
        res.status(404).json({ error: 'Custom catalog not found' });
        return;
      }
      if (catalog.selectedBand4ChartIds.length === 0) {
        res.status(400).json({ success: false, error: 'Select at least one coverage area first' });
        return;
      }
      if (isCatalogBusy(id)) {
        res.status(409).json({ success: false, error: 'Already downloading/converting' });
        return;
      }
      const cm = getContainerManager();
      if (!cm?.getRuntime()) {
        res.status(503).json({
          success: false,
          error:
            'signalk-container plugin not available. Install it from the App Store and restart Signal K.'
        });
        return;
      }
      const budgetMax = getCpuBudget().maxConcurrentConversions;
      if (getConvertingCount() >= budgetMax) {
        res.status(429).json({
          success: false,
          error: `Too many conversions running (max ${budgetMax}). Please wait for one to finish.`
        });
        return;
      }

      handleCustomCatalogDownloadConvert(catalog);
      res.json({ success: true, message: 'Download and conversion started' });
    });

    router.get('/custom-catalogs/:id/status', (req: Request, res: Response) => {
      const id = (req.params as Record<string, string>).id;
      const catalog = getCustomCatalog(id);
      if (!catalog) {
        res.status(404).json({ error: 'Custom catalog not found' });
        return;
      }
      res.json({
        ...decorateCatalog(catalog),
        busy: isCatalogBusy(id),
        progress: getCatalogProgress(id),
        detail: getCatalogDetail(id)
      });
    });

    router.post('/custom-catalogs/:id/cancel', (req: Request, res: Response) => {
      const id = (req.params as Record<string, string>).id;
      if (!isValidCatalogId(id)) {
        res.status(400).json({ success: false, error: 'Invalid catalog id' });
        return;
      }
      if (!isCatalogBusy(id)) {
        res.json({ success: true, message: 'Nothing running' });
        return;
      }
      requestCatalogCancel(id);
      setCatalogProgress(id, 'cancelling', 'Cancelling…');
      // Reflect it in the structured detail immediately so the next /status
      // poll shows "Cancelling…" rather than the last conversion frame.
      setCatalogDetail(id, {
        phase: 'cancelling',
        sectionLabel: 'Cancelling…',
        sectionPercent: -1
      });
      // Aborts the in-flight container job on signalk-container >= 1.16.0;
      // downloads stop between charts; older containers stop at a band boundary.
      res.json({ success: true, message: 'Cancellation requested' });
    });

    router.get('/custom-catalogs/:id/log', (req: Request, res: Response) => {
      const id = (req.params as Record<string, string>).id;
      if (!isValidCatalogId(id)) {
        res.status(400).json({ log: [], status: null });
        return;
      }
      const tail = parseInt(req.query.tail as string) || 200;
      const managerProgress = getCatalogProgress(id);
      const s57 = getS57Progress(id);
      // Manager progress carries the download phase; the S-57 converter carries
      // the detailed per-band conversion log. Concatenate for the full picture.
      const log = [...(managerProgress?.log ?? []), ...(s57?.log ?? [])];
      res.json({
        log: log.slice(-tail),
        status: managerProgress?.status ?? s57?.status ?? null,
        message: managerProgress?.message ?? s57?.message ?? ''
      });
    });
  };

  // Helper functions for catalog download routes (extracted to reduce nesting)

  function handleS57Download(
    res: Response,
    app: ExtendedServerAPI,
    url: string,
    chartNumber: string,
    catalogFile: string,
    zipfileDatetime: string | undefined,
    targetDir: string,
    chartPath: string,
    minzoom: number | undefined,
    maxzoom: number | undefined,
    chartTitle: string | undefined
  ): void {
    const tmpDownloadDir = path.join(app.getDataDirPath(), `s57-download-${Date.now()}`);
    fs.mkdirSync(tmpDownloadDir, { recursive: true });

    const jobId = downloadManager.createJob(url, tmpDownloadDir, chartNumber, { saveRaw: true });

    trackInstall(chartNumber, catalogFile, zipfileDatetime ?? '', url);
    // Don't flag converting yet — the download still has to finish.
    // Setting it here made the catalog UI report "Converting…" all
    // through the (slow!) download phase. Flip it to true inside the
    // listener once the ZIP is on disk and processS57Zip is about to run.

    const s57Listener = async (job: DownloadJob): Promise<void> => {
      if (job.id !== jobId) {
        return;
      }
      downloadManager.removeListener('job-completed', s57Listener);
      downloadManager.removeListener('job-failed', s57FailListener);

      const zipFileName = job.extractedFiles?.[0] ?? job.targetFiles?.[0];
      const zipPath = zipFileName ? path.join(tmpDownloadDir, zipFileName) : null;

      if (!zipPath || !fs.existsSync(zipPath)) {
        app.debug(`S-57: no ZIP file found after download for ${chartNumber}`);
        rollbackInstall(chartNumber);
        cleanupDir(tmpDownloadDir);
        return;
      }

      setConvertingState(chartNumber, true);

      // Convert into a quarantine dir under getDataDirPath() so a
      // mid-conversion crash leaves a stale .mbtiles there, NOT in
      // the user's live chart library. Promote to targetDir only
      // after a successful conversion. The mkdir is inside the
      // guarded try so a sync throw (perms, disk full) goes through
      // the same cleanup as a conversion failure.
      let quarantineDir: string | null = null;

      try {
        quarantineDir = makeQuarantineDir(app.getDataDirPath(), chartNumber);
        const displayName = chartTitle ? cleanCatalogTitle(chartTitle) : undefined;
        const result = await processS57Zip(
          zipPath,
          quarantineDir,
          chartNumber,
          (status, message) => {
            app.debug(`S-57 [${chartNumber}] ${status}: ${message}`);
          },
          {
            minzoom,
            maxzoom,
            displayName: displayName || undefined,
            displayDescription: chartTitle || undefined
          }
        );

        // Atomic move into the live chart library. If this throws
        // the catch below clears state — the install record gets
        // dropped and the user sees the catalog row return to
        // "Download & Convert".
        await promoteQuarantine(quarantineDir, [result.mbtilesFile], targetDir);

        setConvertingState(chartNumber, false);
        cleanupQuarantineDir(quarantineDir);
        cleanupDir(tmpDownloadDir);

        const relativePath = path.relative(chartPath, path.join(targetDir, result.mbtilesFile));
        setChartEnabled(relativePath, true);
        // Record the produced filename so the delete flow can find this
        // install record even when the converter renamed the file by
        // catalog title (e.g. chartNumber=2 → Port_of_Rotterdam_….mbtiles).
        setInstallFilename(chartNumber, relativePath);
        await refreshChartProviders();

        const chartId = result.mbtilesFile.replace(/\.mbtiles$/, '');
        if (chartProviders[chartId]) {
          const chartData = sanitizeProvider(chartProviders[chartId], 2);
          emitChartDelta(chartId, chartData);
        }
        app.debug(`S-57 conversion complete: ${result.mbtilesFile}`);
      } catch (convError) {
        app.error(
          `S-57 conversion failed for ${chartNumber}: ${convError instanceof Error ? convError.message : String(convError)}`
        );
        rollbackInstall(chartNumber);
        setConvertingState(chartNumber, false);
        if (quarantineDir !== null) {
          cleanupQuarantineDir(quarantineDir);
        }
        cleanupDir(tmpDownloadDir);
      }
    };

    const s57FailListener = (job: DownloadJob): void => {
      if (job.id !== jobId) {
        return;
      }
      downloadManager.removeListener('job-completed', s57Listener);
      downloadManager.removeListener('job-failed', s57FailListener);
      rollbackInstall(chartNumber);
      setConvertingState(chartNumber, false);
      setS57Failed(chartNumber, job.error ?? 'Download failed');
      cleanupDir(tmpDownloadDir);
    };

    downloadManager.on('job-completed', s57Listener);
    downloadManager.on('job-failed', s57FailListener);

    app.debug(`S-57 catalog download started: ${chartNumber} from ${catalogFile}, job: ${jobId}`);
    res.json({ success: true, jobId, message: 'S-57 download and conversion job created' });
  }

  function handleRncDownload(
    res: Response,
    app: ExtendedServerAPI,
    url: string,
    chartNumber: string,
    catalogFile: string,
    zipfileDatetime: string | undefined,
    targetDir: string,
    chartPath: string
  ): void {
    const tmpDownloadDir = path.join(app.getDataDirPath(), `rnc-download-${Date.now()}`);
    fs.mkdirSync(tmpDownloadDir, { recursive: true });

    const jobId = downloadManager.createJob(url, tmpDownloadDir, chartNumber, { saveRaw: true });

    trackInstall(chartNumber, catalogFile, zipfileDatetime ?? '', url);
    // Set converting state inside the listener once the download has
    // finished — see the comment on the s57 path; same fix.

    const rncListener = async (job: DownloadJob): Promise<void> => {
      if (job.id !== jobId) {
        return;
      }
      downloadManager.removeListener('job-completed', rncListener);
      downloadManager.removeListener('job-failed', rncFailListener);

      const zipFileName = job.extractedFiles?.[0] ?? job.targetFiles?.[0];
      const zipPath = zipFileName ? path.join(tmpDownloadDir, zipFileName) : null;

      if (!zipPath || !fs.existsSync(zipPath)) {
        app.debug(`RNC: no file found after download for ${chartNumber}`);
        rollbackInstall(chartNumber);
        cleanupDir(tmpDownloadDir);
        return;
      }

      setConvertingState(chartNumber, true);

      app.debug(`Starting RNC conversion for ${chartNumber}: ${zipPath}`);

      let quarantineDir: string | null = null;

      try {
        quarantineDir = makeQuarantineDir(app.getDataDirPath(), chartNumber);
        const result = await processRncZip(
          zipPath,
          quarantineDir,
          chartNumber,
          (status, message) => {
            app.debug(`RNC [${chartNumber}] ${status}: ${message}`);
          }
        );

        await promoteQuarantine(quarantineDir, result.mbtilesFiles, targetDir);

        setConvertingState(chartNumber, false);
        cleanupQuarantineDir(quarantineDir);
        cleanupDir(tmpDownloadDir);

        const firstRelative = result.mbtilesFiles[0]
          ? path.relative(chartPath, path.join(targetDir, result.mbtilesFiles[0]))
          : null;
        for (const mbtilesFile of result.mbtilesFiles) {
          const relativePath = path.relative(chartPath, path.join(targetDir, mbtilesFile));
          setChartEnabled(relativePath, true);
        }
        // Record the produced filename so the delete flow can clear
        // this install record by matching the filename. RNC catalogs
        // can produce multiple files per chart number; we track the
        // first — deleting any one of them clears the catalog badge.
        if (firstRelative) {
          setInstallFilename(chartNumber, firstRelative);
        }
        await refreshChartProviders();
        for (const mbtilesFile of result.mbtilesFiles) {
          const chartId = mbtilesFile.replace(/\.mbtiles$/, '');
          if (chartProviders[chartId]) {
            const chartData = sanitizeProvider(chartProviders[chartId], 2);
            emitChartDelta(chartId, chartData);
          }
        }
        app.debug(`RNC conversion complete for ${chartNumber}: ${result.mbtilesFiles.join(', ')}`);
      } catch (convError) {
        app.error(
          `RNC conversion failed for ${chartNumber}: ${convError instanceof Error ? convError.message : String(convError)}`
        );
        rollbackInstall(chartNumber);
        setConvertingState(chartNumber, false);
        if (quarantineDir !== null) {
          cleanupQuarantineDir(quarantineDir);
        }
        cleanupDir(tmpDownloadDir);
      }
    };

    const rncFailListener = (job: DownloadJob): void => {
      if (job.id !== jobId) {
        return;
      }
      downloadManager.removeListener('job-completed', rncListener);
      downloadManager.removeListener('job-failed', rncFailListener);
      rollbackInstall(chartNumber);
      setConvertingState(chartNumber, false);
      setRncFailed(chartNumber, job.error ?? 'Download failed');
      cleanupDir(tmpDownloadDir);
    };

    downloadManager.on('job-completed', rncListener);
    downloadManager.on('job-failed', rncFailListener);

    app.debug(`RNC catalog download started: ${chartNumber} from ${catalogFile}, job: ${jobId}`);
    res.json({ success: true, jobId, message: 'RNC download and conversion job created' });
  }

  function handlePilotDownload(
    res: Response,
    app: ExtendedServerAPI,
    url: string,
    chartNumber: string,
    catalogFile: string,
    zipfileDatetime: string | undefined,
    targetDir: string,
    chartPath: string
  ): void {
    const tmpDownloadDir = path.join(app.getDataDirPath(), `pilot-download-${Date.now()}`);
    fs.mkdirSync(tmpDownloadDir, { recursive: true });

    const jobId = downloadManager.createJob(url, tmpDownloadDir, chartNumber, { saveRaw: true });

    trackInstall(chartNumber, catalogFile, zipfileDatetime ?? '', url);
    // Set converting state inside the listener once the download has
    // finished — see the comment on the s57 path; same fix.

    const pilotListener = async (job: DownloadJob): Promise<void> => {
      if (job.id !== jobId) {
        return;
      }
      downloadManager.removeListener('job-completed', pilotListener);
      downloadManager.removeListener('job-failed', pilotFailListener);

      const dlFileName = job.extractedFiles?.[0] ?? job.targetFiles?.[0];
      const dlPath = dlFileName ? path.join(tmpDownloadDir, dlFileName) : null;

      if (!dlPath || !fs.existsSync(dlPath)) {
        rollbackInstall(chartNumber);
        cleanupDir(tmpDownloadDir);
        return;
      }

      setConvertingState(chartNumber, true);

      let quarantineDir: string | null = null;

      try {
        quarantineDir = makeQuarantineDir(app.getDataDirPath(), chartNumber);
        const result = await processPilotTar(
          dlPath,
          quarantineDir,
          chartNumber,
          (status, message) => {
            app.debug(`Pilot [${chartNumber}] ${status}: ${message}`);
          }
        );

        await promoteQuarantine(quarantineDir, result.mbtilesFiles, targetDir);

        setConvertingState(chartNumber, false);
        cleanupQuarantineDir(quarantineDir);
        cleanupDir(tmpDownloadDir);

        for (const mbtilesFile of result.mbtilesFiles) {
          const relativePath = path.relative(chartPath, path.join(targetDir, mbtilesFile));
          setChartEnabled(relativePath, true);
        }
        await refreshChartProviders();
        for (const mbtilesFile of result.mbtilesFiles) {
          const chartId = mbtilesFile.replace(/\.mbtiles$/, '');
          if (chartProviders[chartId]) {
            const chartData = sanitizeProvider(chartProviders[chartId], 2);
            emitChartDelta(chartId, chartData);
          }
        }
        app.debug(`Pilot conversion complete: ${result.mbtilesFiles.join(', ')}`);
      } catch (convError) {
        app.error(
          `Pilot conversion failed: ${convError instanceof Error ? convError.message : String(convError)}`
        );
        rollbackInstall(chartNumber);
        setConvertingState(chartNumber, false);
        if (quarantineDir !== null) {
          cleanupQuarantineDir(quarantineDir);
        }
        cleanupDir(tmpDownloadDir);
      }
    };

    const pilotFailListener = (job: DownloadJob): void => {
      if (job.id !== jobId) {
        return;
      }
      downloadManager.removeListener('job-completed', pilotListener);
      downloadManager.removeListener('job-failed', pilotFailListener);
      rollbackInstall(chartNumber);
      setConvertingState(chartNumber, false);
      setRncFailed(chartNumber, job.error ?? 'Download failed');
      cleanupDir(tmpDownloadDir);
    };

    downloadManager.on('job-completed', pilotListener);
    downloadManager.on('job-failed', pilotFailListener);

    app.debug(`Pilot download started: ${chartNumber}, job: ${jobId}`);
    res.json({ success: true, jobId, message: 'Pilot chart download and conversion started' });
  }

  function handleShpBasemapDownload(
    res: Response,
    app: ExtendedServerAPI,
    url: string,
    chartNumber: string,
    catalogFile: string,
    zipfileDatetime: string | undefined,
    targetDir: string,
    chartPath: string
  ): void {
    const tmpDownloadDir = path.join(app.getDataDirPath(), `shp-download-${Date.now()}`);
    fs.mkdirSync(tmpDownloadDir, { recursive: true });

    const jobId = downloadManager.createJob(url, tmpDownloadDir, chartNumber, { saveRaw: true });

    trackInstall(chartNumber, catalogFile, zipfileDatetime ?? '', url);
    // Set converting state inside the listener once the download has
    // finished — see the comment on the s57 path; same fix.

    const shpListener = async (job: DownloadJob): Promise<void> => {
      if (job.id !== jobId) {
        return;
      }
      downloadManager.removeListener('job-completed', shpListener);
      downloadManager.removeListener('job-failed', shpFailListener);

      const dlFileName = job.extractedFiles?.[0] ?? job.targetFiles?.[0];
      const dlPath = dlFileName ? path.join(tmpDownloadDir, dlFileName) : null;

      if (!dlPath || !fs.existsSync(dlPath)) {
        rollbackInstall(chartNumber);
        cleanupDir(tmpDownloadDir);
        return;
      }

      setConvertingState(chartNumber, true);

      let quarantineDir: string | null = null;

      try {
        quarantineDir = makeQuarantineDir(app.getDataDirPath(), chartNumber);
        const result = await processShpBasemap(
          dlPath,
          quarantineDir,
          chartNumber,
          (status, message) => {
            app.debug(`ShpBasemap [${chartNumber}] ${status}: ${message}`);
          }
        );

        await promoteQuarantine(quarantineDir, [result.mbtilesFile], targetDir);

        setConvertingState(chartNumber, false);
        cleanupQuarantineDir(quarantineDir);
        cleanupDir(tmpDownloadDir);

        const relativePath = path.relative(chartPath, path.join(targetDir, result.mbtilesFile));
        setChartEnabled(relativePath, true);
        await refreshChartProviders();

        const chartId = result.mbtilesFile.replace(/\.mbtiles$/, '');
        if (chartProviders[chartId]) {
          const chartData = sanitizeProvider(chartProviders[chartId], 2);
          emitChartDelta(chartId, chartData);
        }
        app.debug(`ShpBasemap installed: ${result.mbtilesFile}`);
      } catch (convError) {
        app.error(
          `ShpBasemap conversion failed: ${convError instanceof Error ? convError.message : String(convError)}`
        );
        rollbackInstall(chartNumber);
        setConvertingState(chartNumber, false);
        if (quarantineDir !== null) {
          cleanupQuarantineDir(quarantineDir);
        }
        cleanupDir(tmpDownloadDir);
      }
    };

    const shpFailListener = (job: DownloadJob): void => {
      if (job.id !== jobId) {
        return;
      }
      downloadManager.removeListener('job-completed', shpListener);
      downloadManager.removeListener('job-failed', shpFailListener);
      rollbackInstall(chartNumber);
      setConvertingState(chartNumber, false);
      cleanupDir(tmpDownloadDir);
    };

    downloadManager.on('job-completed', shpListener);
    downloadManager.on('job-failed', shpFailListener);

    res.json({ success: true, jobId, message: 'Basemap download and conversion started' });
  }

  function handleGshhgDownload(
    res: Response,
    app: ExtendedServerAPI,
    chartNumber: string,
    catalogFile: string,
    zipfileDatetime: string | undefined,
    url: string,
    targetDir: string,
    _chartPath: string
  ): void {
    const resolution = chartNumber.replace('poly-', '');

    trackInstall(chartNumber, catalogFile, zipfileDatetime ?? '', url);
    setConvertingState(chartNumber, true);

    const tmpDir = path.join(app.getDataDirPath(), `gshhg-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    void (async () => {
      let quarantineDir: string | null = null;
      try {
        quarantineDir = makeQuarantineDir(app.getDataDirPath(), chartNumber);
        const result = await processGshhg(
          tmpDir,
          quarantineDir,
          resolution,
          chartNumber,
          (status, message) => {
            app.debug(`GSHHG [${chartNumber}] ${status}: ${message}`);
          }
        );

        await promoteQuarantine(quarantineDir, [result.mbtilesFile], targetDir);

        setConvertingState(chartNumber, false);
        cleanupQuarantineDir(quarantineDir);
        await refreshChartProviders();

        const chartId = `gshhg-basemap-${resolution}`;
        if (chartProviders[chartId]) {
          const chartData = sanitizeProvider(chartProviders[chartId], 2);
          emitChartDelta(chartId, chartData);
        }
        app.debug(`GSHHG basemap installed: ${resolution}`);
      } catch (error) {
        app.error(
          `GSHHG conversion failed: ${error instanceof Error ? error.message : String(error)}`
        );
        rollbackInstall(chartNumber);
        setConvertingState(chartNumber, false);
        if (quarantineDir !== null) {
          cleanupQuarantineDir(quarantineDir);
        }
      } finally {
        cleanupDir(tmpDir);
      }
    })();

    res.json({
      success: true,
      jobId: `gshhg-${chartNumber}`,
      message: 'GSHHG basemap conversion started'
    });
  }

  // Augment a persisted catalog with derived, non-persisted fields the UI
  // needs: the freshness-aware effective status, the live included-chart
  // count, and any reasons it's out of date. Freshness is only computed when
  // the NOAA footprint index is already in memory (the map endpoint loads it);
  // otherwise we fall back to the stored status so this never blocks on the
  // network.
  function decorateCatalog(catalog: CustomCatalog): CustomCatalog & {
    effectiveStatus: string;
    includedCount: number;
    updateReasons: string[];
    boxStates: Record<string, string>;
  } {
    const chartPath = props.chartPath || defaultChartsPath;
    const index = peekFootprintIndex();
    if (!index) {
      return {
        ...catalog,
        effectiveStatus: catalog.selectedBand4ChartIds.length === 0 ? 'empty' : catalog.status,
        includedCount: catalog.includedChartIds.length,
        updateReasons: [],
        boxStates: {}
      };
    }
    const mbtilesPresent =
      catalog.convertedChartPath !== null &&
      fs.existsSync(path.join(chartPath, catalog.convertedChartPath));
    const freshness = evaluateFreshness(catalog, index, (rel) =>
      fs.existsSync(path.join(chartPath, rel))
    );
    return {
      ...catalog,
      effectiveStatus: freshness.effectiveStatus,
      includedCount: freshness.recomputed.includedChartIds.length,
      updateReasons: freshness.reasons,
      // Per-box freshness by NOAA edition. A box is green only when the set is
      // cleanly converted and its MBTiles exists — a cancelled/failed build or
      // a deleted output shows red, matching the catalog-level status.
      boxStates: boxStatesForCatalog(catalog, index, mbtilesPresent)
    };
  }

  // Async download-and-convert flow for a custom catalog. Fetches the current
  // NOAA footprint index, resolves the band-3/4/5 ENC set, downloads every ZIP
  // into one combined tree, converts it once via processS57Directory, and
  // promotes the single MBTiles into the live chart library. The client polls
  // /custom-catalogs/:id/status and /log for progress.
  function handleCustomCatalogDownloadConvert(catalog: CustomCatalog): void {
    const id = catalog.id;
    const chartPath = props.chartPath || defaultChartsPath;
    setCatalogBusy(id, true);
    clearCatalogProgress(id);
    setCatalogProgress(id, 'preparing', 'Resolving coverage…');
    setCatalogDetail(id, {
      phase: 'preparing',
      overallPercent: 0,
      sectionLabel: 'Resolving coverage…',
      sectionPercent: -1,
      downloadedChartIds: []
    });
    const stagedSoFar: string[] = [];

    // Abort controller for mid-job cancel: requestCatalogCancel(id) aborts it,
    // which kills the in-flight container job on signalk-container >= 1.16.0.
    const abortController = new AbortController();
    registerCatalogAbort(id, abortController);

    const stagingRoot = path.join(app.getDataDirPath(), `custom-catalog-${Date.now()}`);
    const encDir = path.join(stagingRoot, 'enc');
    const zipsDir = path.join(stagingRoot, 'zips');

    void (async () => {
      let quarantineDir: string | null = null;
      let convertingFlagged = false;
      try {
        // Refresh the footprint index so we download the current editions.
        const index = await getFootprintIndex();
        const inclusion = computeInclusion(index.all, catalog.selectedBand4ChartIds);
        if (inclusion.includedChartIds.length === 0) {
          throw new Error('No NOAA charts match the selected coverage areas');
        }
        appendCatalogLog(
          id,
          `Resolved ${inclusion.includedChartIds.length} ENC(s) from ` +
            `${catalog.selectedBand4ChartIds.length} selected area(s)`
        );
        if (inclusion.missingSelected.length > 0) {
          appendCatalogLog(
            id,
            `Note: no longer published: ${inclusion.missingSelected.join(', ')}`
          );
        }

        // Per-box coverage so the map can fill each band-4 box by its own
        // band-4 + nested-band-5 download fraction.
        setCatalogDetail(id, {
          coverageByBox: coverageByBox(index.all, catalog.selectedBand4ChartIds)
        });

        // 1. Download + extract every ENC ZIP into one combined input tree.
        const result = await downloadAndExtractEncs(inclusion.includedChartIds, encDir, zipsDir, {
          onProgress: (done, total, chartId) => {
            setCatalogProgress(id, 'downloading', `Downloading ${done}/${total}: ${chartId}`);
            setCatalogDetail(id, {
              phase: 'downloading',
              overallPercent: 0,
              sectionLabel: `Downloading ${done}/${total}`,
              sectionPercent: total > 0 ? Math.round((done / total) * 100) : -1
            });
          },
          // Flip the map area as each ENC lands, rather than all at once.
          onStaged: (chartId) => {
            stagedSoFar.push(chartId);
            setCatalogDetail(id, { downloadedChartIds: [...stagedSoFar] });
          },
          onLog: (line) => appendCatalogLog(id, line),
          isAborted: () => isCatalogCancelRequested(id)
        });
        // Cancel during download → stop before converting.
        if (isCatalogCancelRequested(id)) {
          throw new Error('Cancelled by user');
        }
        if (result.staged.length === 0) {
          throw new Error('All ENC downloads failed — check network connectivity');
        }
        appendCatalogLog(
          id,
          `Downloaded ${result.staged.length}/${inclusion.includedChartIds.length} ENC(s)` +
            (result.failed.length > 0 ? `, ${result.failed.length} failed` : '')
        );
        // A partial download yields an MBTiles that omits the failed cells, so
        // it must not be marked up-to-date (see the status decision after
        // conversion below).
        const partialDownload = result.failed.length > 0;
        if (partialDownload) {
          appendCatalogLog(
            id,
            `WARNING: ${result.failed.length} cell(s) failed to download: ` +
              `${result.failed.map((f) => f.chartId).join(', ')} — the built chart will be ` +
              `incomplete and stay flagged for rebuild.`
          );
        }

        // Persist the snapshot of what actually baked into the MBTiles — the
        // STAGED charts and their editions, not the full requested set. On a
        // partial download this records only the cells that made it in, so
        // freshness (recomputed full vs stored staged) flags the missing cells
        // and per-box edition state shows the affected boxes as needing a
        // refresh. On a complete download staged == the full set, so nothing
        // changes for the common case.
        const staged = new Set(result.staged);
        catalog.includedChartIds = inclusion.includedChartIds.filter((cid) => staged.has(cid));
        catalog.chartVersions = Object.fromEntries(
          Object.entries(inclusion.chartVersions).filter(([cid]) => staged.has(cid))
        );
        catalog.downloadedChartIds = result.staged;
        catalog.lastDownloadedAt = new Date().toISOString();
        catalog.status = 'downloaded';
        saveCustomCatalog(catalog);

        // 2. Convert the combined tree once → one MBTiles in the quarantine.
        //    Flag converting so the global CPU-budget gate accounts for it.
        setCatalogProgress(id, 'converting', 'Converting combined ENC set…');
        setCatalogDetail(id, {
          phase: 'converting',
          overallPercent: 0,
          sectionLabel: 'Starting conversion…',
          sectionPercent: -1
        });
        // Re-check the conversion budget right before claiming a slot. The
        // admission check at request time ran before the (long) download, so
        // several catalogs could have passed it and now be ready to convert
        // together. This synchronous check + setConvertingState pair is atomic
        // in the event loop, so it can't over-subscribe maxConcurrentConversions.
        const convertBudgetMax = getCpuBudget().maxConcurrentConversions;
        if (getConvertingCount() >= convertBudgetMax) {
          throw new Error(
            `Too many conversions running (max ${convertBudgetMax}). Please retry when one finishes.`
          );
        }
        setConvertingState(id, true);
        convertingFlagged = true;
        quarantineDir = makeQuarantineDir(app.getDataDirPath(), id);
        const conv = await processS57Directory(
          encDir,
          quarantineDir,
          id,
          (status, message) => setCatalogProgress(id, status, message),
          {
            displayName: catalog.name,
            displayDescription: `Custom catalog: ${catalog.name}`,
            isAborted: () => isCatalogCancelRequested(id),
            // Overall (convert-only) bar treats the per-band tippecanoe passes
            // plus the final combine as equal slices, so it rises monotonically
            // through the whole conversion. The combine now reports its own %
            // (derived from tile-join's tile-coordinate output), so its section
            // bar is determinate too.
            onProgress: (p) => {
              // Once cancel is requested, the in-flight job is being killed but
              // may emit a few more progress lines before it dies. Don't let
              // those overwrite the "Cancelling…" state — otherwise the UI
              // flips back to "running" until the job actually unwinds.
              if (isCatalogCancelRequested(id)) {
                setCatalogDetail(id, {
                  phase: 'cancelling',
                  sectionLabel: 'Cancelling…',
                  sectionPercent: -1
                });
                return;
              }
              const hasJoin = p.bucketCount >= 2;
              const denom = p.bucketCount + (hasJoin ? 1 : 0);
              const pct = p.bucketPercent >= 0 ? p.bucketPercent : 0;
              let overall: number;
              let sectionLabel: string;
              let sectionPercent: number;
              if (p.stage === 'join') {
                // Clamp: with a single bucket (no dedicated join slot) the
                // join collapses to a file move and emits 100%, which would
                // otherwise compute >100 here.
                overall =
                  denom > 0
                    ? Math.min(100, Math.round(((p.bucketCount + pct / 100) / denom) * 100))
                    : 99;
                sectionLabel = `Combining ${p.bucketCount} tile sets`;
                sectionPercent = p.bucketPercent;
              } else if (p.stage === 'export') {
                overall = denom > 0 ? Math.round(((p.bucketIndex - 1) / denom) * 100) : 0;
                sectionLabel = `${p.bucketLabel} — reading charts (${p.bucketIndex} of ${p.bucketCount})`;
                sectionPercent = -1;
              } else {
                overall =
                  denom > 0 ? Math.round(((p.bucketIndex - 1 + pct / 100) / denom) * 100) : 0;
                sectionLabel = `${p.bucketLabel} — generating tiles (${p.bucketIndex} of ${p.bucketCount})`;
                sectionPercent = Math.round(pct);
              }
              setCatalogDetail(id, {
                phase: p.stage === 'join' ? 'joining' : 'converting',
                overallPercent: overall,
                sectionLabel,
                sectionPercent
              });
            },
            signal: abortController.signal
          },
          stagingRoot
        );

        // 3. Promote the single output into the live chart library (root).
        await promoteQuarantine(quarantineDir, [conv.mbtilesFile], chartPath);
        setChartEnabled(conv.mbtilesFile, true);

        catalog.convertedChartPath = conv.mbtilesFile;
        catalog.lastConvertedAt = new Date().toISOString();
        // Only a complete bundle counts as up-to-date. A partial download
        // produced a chart that omits some cells, so leave it out_of_date and
        // the UI flags it for a rebuild (which retries the failed cells).
        catalog.status = partialDownload ? 'out_of_date' : 'converted';
        saveCustomCatalog(catalog);

        await refreshChartProviders();
        const chartId = conv.mbtilesFile.replace(/\.mbtiles$/, '');
        if (chartProviders[chartId]) {
          emitChartDelta(chartId, sanitizeProvider(chartProviders[chartId], 2));
        }

        setCatalogProgress(id, 'completed', `Created ${conv.mbtilesFile}`);
        setCatalogDetail(id, {
          phase: 'completed',
          overallPercent: 100,
          sectionLabel: `Created ${conv.mbtilesFile}`,
          sectionPercent: 100
        });
        appendCatalogLog(id, `Done: ${conv.mbtilesFile}`);
        // Let the completed state linger briefly, then clear so the UI settles
        // onto the persisted 'converted' status.
        setTimeout(() => clearCatalogProgress(id), 8000);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (isCatalogCancelRequested(id)) {
          appendCatalogLog(id, 'Cancelled by user.');
          setCatalogProgress(id, 'cancelled', 'Cancelled');
          setCatalogDetail(id, {
            phase: 'cancelled',
            sectionLabel: 'Cancelled',
            sectionPercent: -1
          });
          // Drop the cancelled state after a short linger.
          setTimeout(() => clearCatalogProgress(id), 6000);
        } else {
          app.error(`Custom catalog ${id} download/convert failed: ${msg}`);
          setCatalogFailed(id, msg);
          setCatalogDetail(id, { phase: 'failed', sectionLabel: msg, sectionPercent: -1 });
        }
        // Mark out_of_date (unless it had a prior good conversion) so the UI
        // shows the coverage needs a (re)build.
        const latest = getCustomCatalog(id);
        if (latest && latest.selectedBand4ChartIds.length > 0 && latest.status !== 'converted') {
          latest.status = 'out_of_date';
          saveCustomCatalog(latest);
        }
      } finally {
        if (convertingFlagged) {
          setConvertingState(id, false);
        }
        if (quarantineDir !== null) {
          cleanupQuarantineDir(quarantineDir);
        }
        cleanupDir(stagingRoot);
        clearCatalogCancel(id);
        setCatalogBusy(id, false);
      }
    })();
  }

  const registerAsProvider = (): void => {
    app.debug('** Registering as Resource Provider for `charts` **');
    try {
      app.registerResourceProvider({
        type: 'charts',
        methods: {
          listResources: (params) => {
            app.debug(`** listResources() ${JSON.stringify(params)}`);
            return Promise.resolve(
              Object.fromEntries(
                Object.entries(chartProviders).map(([k, provider]) => [
                  k,
                  sanitizeProvider(provider, 2)
                ])
              )
            );
          },
          getResource: (id) => {
            app.debug(`** getResource() ${id}`);
            const provider = chartProviders[id];
            if (provider) {
              return Promise.resolve(sanitizeProvider(provider, 2));
            } else {
              throw new Error('Chart not found!');
            }
          },
          setResource: (id, value) => {
            throw new Error(`Not implemented!\n Cannot set ${id} to ${JSON.stringify(value)}`);
          },
          deleteResource: (id) => {
            throw new Error(`Not implemented!\n Cannot delete ${id}`);
          }
        }
      });
    } catch {
      app.debug('Failed Provider Registration!');
    }
  };

  const refreshChartProviders = async (): Promise<void> => {
    try {
      const chartPath = props.chartPath || defaultChartsPath;
      const charts = await findCharts(chartPath);

      chartProviders = Object.fromEntries(
        Object.entries(charts).filter(([, chart]) => {
          const relativePath = path.relative(chartPath, chart._filePath || '');
          return isChartEnabled(relativePath);
        })
      );

      app.debug(`Chart providers refreshed: ${Object.keys(chartProviders).length} enabled charts`);
    } catch (error) {
      app.error(
        `Failed to refresh chart providers: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  };

  const startCatalogUpdateChecker = (): void => {
    const doCheck = async (): Promise<void> => {
      try {
        const catalogsToCheck = getCatalogsWithInstalledCharts();
        if (catalogsToCheck.length === 0) {
          return;
        }

        app.debug(`Checking ${catalogsToCheck.length} catalog(s) for chart updates`);

        for (const catalogFile of catalogsToCheck) {
          await fetchCatalog(catalogFile);
        }

        const updates = checkForUpdates();
        if (updates.length > 0) {
          app.debug(`Found ${updates.length} chart update(s) available from catalog`);
          if (props.disableUpdateNotifications) {
            app.debug('Chart update notifications are disabled; skipping notification emit');
          } else {
            emitCatalogUpdateNotification(updates);
          }
        }
      } catch (error) {
        app.debug(
          `Catalog update check failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    };

    setTimeout(() => void doCheck(), 10000);
    catalogUpdateInterval = setInterval(() => void doCheck(), 24 * 60 * 60 * 1000);
  };

  const emitCatalogUpdateNotification = (
    updates: { title?: string; chartNumber?: string }[]
  ): void => {
    try {
      const chartNames = updates.map((u) => u.title ?? u.chartNumber ?? '').join(', ');
      app.handleMessage(PLUGIN_ID, {
        updates: [
          {
            values: [
              {
                path: `notifications.plugins.${PLUGIN_ID}.chartCatalogUpdate` as Path,
                value: {
                  state: 'warn',
                  method: ['visual'],
                  message: `${updates.length} chart update${updates.length !== 1 ? 's' : ''} available from Chart Catalog: ${chartNames}`
                }
              }
            ]
          }
        ]
      });
      app.debug(`Catalog update notification emitted for ${updates.length} chart(s)`);
    } catch (error) {
      app.error(
        `Failed to emit catalog update notification: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  };

  const emitChartDelta = (chartId: string, chartValue: SanitizedChart | null): void => {
    try {
      app.handleMessage(
        PLUGIN_ID,
        {
          updates: [
            {
              values: [
                {
                  path: `resources.charts.${chartId}` as Path,
                  value: chartValue
                }
              ]
            }
          ]
        },
        SKVersion.v2
      );
      app.debug(`Delta emitted for chart: ${chartId}, value: ${chartValue ? 'data' : 'null'}`);
    } catch (error) {
      app.error(
        `Failed to emit delta for chart ${chartId}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  };

  return plugin;
};

const responseHttpOptions = {
  headers: {
    'Cache-Control': 'public, max-age=7776000'
  }
};

const sanitizeProvider = (provider: ChartProvider, version: 1 | 2 = 1): SanitizedChart => {
  let v: Record<string, unknown>;
  if (version === 1) {
    v = { ...provider.v1 };
    (v as { tilemapUrl: string }).tilemapUrl = (v.tilemapUrl as string).replace(
      '~tilePath~',
      chartTilesPath
    );
  } else {
    v = { ...provider.v2 };
    (v as { url: string }).url = (v.url as string | undefined)
      ? (v.url as string).replace('~tilePath~', chartTilesPath)
      : '';
  }

  const { _filePath, _fileFormat, _mbtilesHandle, _flipY, v1: _v1, v2: _v2, ...rest } = provider;
  return { ...rest, ...v };
};

const ensureDirectoryExists = (dirPath: string): boolean => {
  try {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
    return true;
  } catch {
    return false;
  }
};

// Probe whether an EXISTING directory is usable as a chart root, without
// creating it. Used for the injected host charts mount: we must NOT mkdir a
// missing mount (that silently shadows it with an ephemeral in-container dir),
// so we check existence + usability separately instead of create-on-demand.
// Requires an actual directory (W_OK alone would accept a writable regular
// file) with both write AND execute/search permission (X_OK — needed to
// traverse into it to read/write chart files).
const isDirWritable = (dirPath: string): boolean => {
  try {
    if (!fs.statSync(dirPath).isDirectory()) {
      return false;
    }
    fs.accessSync(dirPath, fs.constants.W_OK | fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const cleanupEmptyParents = (deletedPath: string, stopAt: string): void => {
  try {
    let parent = path.dirname(deletedPath);
    const normalizedStop = path.normalize(stopAt);
    while (path.normalize(parent) !== normalizedStop) {
      const contents = fs.readdirSync(parent);
      if (contents.length === 0) {
        fs.rmdirSync(parent);
        parent = path.dirname(parent);
      } else {
        break;
      }
    }
  } catch {
    // ignore
  }
};

const cleanupDir = (dirPath: string): void => {
  try {
    if (fs.existsSync(dirPath)) {
      fs.rmSync(dirPath, { recursive: true, force: true });
    }
  } catch {
    // ignore cleanup errors
  }
};

const serveTileFromFilesystem = (
  res: Response,
  provider: ChartProvider,
  z: number,
  x: number,
  y: number
): void => {
  const { format, _flipY, _filePath } = provider;
  const flippedY = Math.pow(2, z) - 1 - y;
  const file = _filePath
    ? path.resolve(_filePath, `${z}/${x}/${_flipY ? flippedY : y}.${format}`)
    : '';
  res.sendFile(file, responseHttpOptions, (err?: Error) => {
    if (err && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      res.sendStatus(404);
    } else if (err) {
      throw err;
    }
  });
};

// Exported for tests (the Express route registration is not separately
// constructible without a full server).
export const serveTileFromMbtiles = (
  res: Response,
  provider: ChartProvider,
  z: number,
  x: number,
  y: number
): void => {
  try {
    const result = provider._mbtilesHandle?.getTile(z, x, y) ?? null;

    if (!result) {
      // Combined NOAA chart sets have spatially varying max zoom (per-band
      // bounds + zoom ranges merged by tile-join), so clients legitimately
      // request tiles in coverage holes the advertised zoom range implies
      // should exist. Re-slice the nearest ancestor instead of 404ing black.
      if (provider.format === 'pbf' && provider._mbtilesHandle) {
        const synthesized = getOverzoomedTile(provider._mbtilesHandle, z, x, y);
        if (synthesized) {
          res.writeHead(200, {
            'Content-Type': 'application/x-protobuf',
            'Content-Encoding': 'gzip',
            'Cache-Control': responseHttpOptions.headers['Cache-Control']
          });
          res.end(synthesized);
          return;
        }
      }
      res.sendStatus(404);
    } else {
      // A stored cell-edge tile whose features all sit outside its visible
      // extent renders blank and would mask lower-band content; serve a
      // synthesized replacement instead.
      if (provider.format === 'pbf' && provider._mbtilesHandle) {
        const replacement = getBlankTileReplacement(provider._mbtilesHandle, z, x, y, result.data);
        if (replacement) {
          res.writeHead(200, {
            'Content-Type': 'application/x-protobuf',
            'Content-Encoding': 'gzip',
            'Cache-Control': responseHttpOptions.headers['Cache-Control']
          });
          res.end(replacement);
          return;
        }
      }
      const headers = {
        ...result.headers,
        'Cache-Control': responseHttpOptions.headers['Cache-Control']
      };
      res.writeHead(200, headers);
      res.end(result.data);
    }
  } catch (err) {
    console.error(`Error fetching tile ${provider.identifier}/${z}/${x}/${y}:`, err);
    res.sendStatus(500);
  }
};

export default pluginConstructor;
