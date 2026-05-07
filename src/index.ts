import path from 'path';
import fs from 'fs';
import https from 'https';
import type { Plugin, Path } from '@signalk/server-api';
import { findCharts } from './charts-loader.js';
import { scanChartsRecursively, scanAllFolders } from './utils/file-scanner.js';
import { initChartState, isChartEnabled, setChartEnabled } from './utils/chart-state.js';
import { downloadManager } from './utils/download-manager.js';
import {
  initCatalogManager,
  getCatalogRegistry,
  fetchCatalog,
  getCachedCatalog,
  classifyUrl,
  trackInstall,
  removeInstall,
  getInstalledCatalogCharts,
  pruneStaleInstalls,
  setConvertingState,
  getConvertingCharts,
  getConvertingCount,
  checkForUpdates,
  getCatalogsWithInstalledCharts
} from './utils/catalog-manager.js';
import {
  initS57Converter,
  processS57Zip,
  getAllConversionProgress as getAllS57Progress,
  getConversionProgress as getS57Progress,
  setConversionFailed as setS57Failed
} from './utils/s57-converter.js';
import { getContainerManager, waitForContainerManager } from './utils/container-manager.js';
import { cleanCatalogTitle } from './utils/catalog-title.js';
import { setMbtilesDisplayName } from './utils/mbtiles-metadata.js';
import {
  initRncConverter,
  processRncZip,
  processPilotTar,
  getAllConversionProgress as getAllRncProgress,
  getConversionProgress as getRncProgress,
  setConversionFailed as setRncFailed
} from './utils/rnc-converter.js';
import { processGshhg, processShpBasemap } from './utils/s57-converter.js';
import { getCpuBudget, setCpuBudget } from './utils/concurrency.js';
import { writeChartPathMarker } from './utils/path-marker.js';
import { parsePluginConfig } from './utils/plugin-config-schema.js';
import { Type } from '@sinclair/typebox';
import { parseBody, parseShape } from './utils/rest-validation.js';
import { isWithinBase, arePairWithinBase } from './utils/path-safety.js';
import Busboy from 'busboy';
import { DatabaseSync } from 'node:sqlite';

// JSON import with type attribute (NodeNext ESM). package.json's `version`
// is what the marker file records so users can confirm the running build.
import packageJson from '../package.json' with { type: 'json' };
const pluginVersion: string = (packageJson as { version: string }).version;
import type {
  ExtendedServerAPI,
  PluginConfig,
  ChartProvider,
  SanitizedChart,
  IRouter,
  Request,
  Response,
  DownloadJob
} from './types.js';

const PLUGIN_ID = 'signalk-charts-provider-simple';
const chartTilesPath = `/plugins/${PLUGIN_ID}`;

const pluginConstructor = (app: ExtendedServerAPI): Plugin => {
  let chartProviders: Record<string, ChartProvider> = {};
  let props: PluginConfig = {
    chartPath: ''
  };

  let catalogUpdateInterval: ReturnType<typeof setInterval> | null = null;
  let pluginDataDir = '';
  let defaultChartsPath = '';
  let serverMajorVersion = 1;

  function getDefaultChartsPath(): string {
    if (!defaultChartsPath) {
      pluginDataDir = app.getDataDirPath();
      const configBasePath = path.dirname(path.dirname(pluginDataDir));
      defaultChartsPath = path.join(configBasePath, 'charts-simple');
      serverMajorVersion = app.config?.version ? parseInt(app.config.version.split('.')[0], 10) : 1;
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
          description: `Main directory for chart files. Defaults to "${getDefaultChartsPath()}". Subfolders will be scanned recursively.`,
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
    ensureDirectoryExists(defaultChartsPath);
    const chartPath = props.chartPath || defaultChartsPath;
    if (!ensureDirectoryExists(chartPath)) {
      app.setPluginError(`Chart directory is not writable: ${chartPath}`);
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

    const tempDirPattern =
      /^(s57-download-|rnc-download-|pilot-download-|shp-download-|gshhg-)\d+$/;
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

    // Discover the signalk-container plugin's manager API.  Chart conversion
    // (S-57, BSB raster, Pilot, basemaps) goes through it from 2.0 onward;
    // the App Store's `signalk.requires` declaration in our package.json
    // ensures users are prompted to install signalk-container, but plugin
    // load order is not deterministic, so we wait up to 30 s before giving
    // up.  A missing manager surfaces as setPluginError but does NOT abort
    // startup — chart *display* (serving tiles for already-converted
    // .mbtiles) doesn't need the runtime layer and remains functional.
    const containerManager = await waitForContainerManager({
      onWaitingStatus: () => app.setPluginStatus('Waiting for signalk-container...')
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

    app.debug(`Start chart provider. Chart path: ${chartPath}`);

    if (serverMajorVersion === 2) {
      app.debug('** Registering v2 API paths **');
      registerAsProvider();
    }

    // Don't overwrite a pluginError that the manager-discovery block may
    // have set — that message must stay visible so the user knows chart
    // conversion will not work until they install signalk-container.
    if (containerManager) {
      app.setPluginStatus('Started');
    }

    findCharts(chartPath)
      .then((charts) => {
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

        return scanChartsRecursively(chartPath).then((allFiles) => {
          const validPaths = new Set(
            Object.values(charts)
              .map((c) => c._filePath)
              .filter(Boolean)
          );
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

          try {
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
                  fs.unlinkSync(fullPath);
                }
              }
            };
            cleanOrphans(chartPath);
          } catch (e) {
            app.debug(
              `Error cleaning orphaned files: ${e instanceof Error ? e.message : String(e)}`
            );
          }
        });
      })
      .catch((e: unknown) => {
        console.error(`Error loading chart providers`, e instanceof Error ? e.message : String(e));
        chartProviders = {};
        app.setPluginError(`Error loading chart providers`);
      });
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

    router.get('/:identifier/:z([0-9]*)/:x([0-9]*)/:y([0-9]*)', (req: Request, res: Response) => {
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
    });

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

          const jobId = downloadManager.createJob(downloadUrl, targetDir, chartName);

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

          removeInstall(chartId);
          const chartNumberPart = chartId.replace(/^[A-Z]+-/, '');
          if (chartNumberPart !== chartId) {
            removeInstall(chartNumberPart);
          }

          res.status(200).send('Chart deleted successfully');
        } else {
          await refreshChartProviders();
          const chartId = path.basename(chartPathParam).replace(/\.mbtiles$/, '');
          emitChartDelta(chartId, null);

          removeInstall(chartId);
          const chartNumberPart = chartId.replace(/^[A-Z]+-/, '');
          if (chartNumberPart !== chartId) {
            removeInstall(chartNumberPart);
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
              | { count: number }
              | undefined;
            if (countRow) {
              metadata.tileCount = countRow.count;
            }
          } catch {
            try {
              const countRow = db.prepare('SELECT COUNT(*) as count FROM tiles').get() as
                | { count: number }
                | undefined;
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

            const filepath = path.join(uploadPath, filename);

            // Reject path-traversal in either the targetFolder or the
            // upload's own filename (`filename: '../etc/passwd'`).
            if (!isWithinBase(filepath, basePath)) {
              traversalRejected = true;
              (file as NodeJS.ReadableStream & { resume(): void }).resume();
              return;
            }

            app.debug(`Uploading chart file: ${filename} to ${filepath}`);

            const writeStream = fs.createWriteStream(filepath);
            file.pipe(writeStream);

            const writePromise = new Promise<void>((resolve, reject) => {
              writeStream.on('finish', () => {
                uploadedFiles.push(filename);
                app.debug(`Chart file uploaded successfully: ${filename}`);
                resolve();
              });

              writeStream.on('error', (err: Error) => {
                app.error(`Error writing file ${filename}: ${err.message}`);
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
              return;
            }
            const { targetFolder = '' } = parsed;

            if (traversalRejected) {
              res.status(403).json({ success: false, error: 'Access denied: Invalid upload path' });
              return;
            }

            try {
              await Promise.all(writePromises);

              if (uploadedFiles.length > 0) {
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

        const partialPath = path.join(uploadPath, filename + '.partial');
        const finalPath = path.join(uploadPath, filename);

        // Reject path-traversal via either header. Catches `'../foo.mbtiles'`
        // as a filename and `'../etc'` as a target-folder, both of which
        // would otherwise resolve outside the chart root.
        if (!arePairWithinBase(partialPath, finalPath, basePath)) {
          res.status(403).json({ error: 'Access denied: Invalid upload path' });
          return;
        }

        const writeStream = fs.createWriteStream(partialPath, {
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

              // Final chunk — rename partial to final
              app.debug(`Final chunk ${totalChunks}/${totalChunks} for ${filename}, assembling`);
              fs.renameSync(partialPath, finalPath);

              await finalizeUploadedFiles([filename], targetFolder, basePath);

              res.json({
                success: true,
                message: `${filename} uploaded successfully`,
                files: [filename]
              });
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
        res.json({ registry, installed, converting: convertingCharts });
      } catch (error) {
        console.error('Error fetching catalog registry:', error);
        res.status(500).json({ error: 'Failed to fetch catalog registry' });
      }
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

          res.json({ success: true, chartNumber, message: 'Conversion started' });

          setConvertingState(chartNumber, true);

          try {
            if (convType === 's57') {
              const result = await processS57Zip(
                validatedFile,
                chartPath,
                chartNumber,
                (status, message) => {
                  app.debug(`Convert [${chartNumber}] ${status}: ${message}`);
                },
                { minzoom, maxzoom }
              );

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
                chartPath,
                chartNumber,
                (status, message) => {
                  app.debug(`Convert [${chartNumber}] ${status}: ${message}`);
                }
              );

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
          const jobId = downloadManager.createJob(url, targetDir, chartNumber);

          trackInstall(chartNumber, catalogFile, zipfileDatetime ?? '', url);

          const cleanupListener = (job: DownloadJob): void => {
            if (job.id === jobId) {
              if (!job.extractedFiles || job.extractedFiles.length === 0) {
                removeInstall(chartNumber);
                app.debug(`Removed catalog tracking for ${chartNumber}: no .mbtiles extracted`);
              }
              downloadManager.removeListener('job-failed', cleanupListener);
              downloadManager.removeListener('job-completed', cleanupListener);
            }
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
    setConvertingState(chartNumber, true);

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
        removeInstall(chartNumber);
        setConvertingState(chartNumber, false);
        cleanupDir(tmpDownloadDir);
        return;
      }

      try {
        const displayName = chartTitle ? cleanCatalogTitle(chartTitle) : undefined;
        const result = await processS57Zip(
          zipPath,
          targetDir,
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

        setConvertingState(chartNumber, false);
        cleanupDir(tmpDownloadDir);

        const relativePath = path.relative(chartPath, path.join(targetDir, result.mbtilesFile));
        setChartEnabled(relativePath, true);
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
        removeInstall(chartNumber);
        setConvertingState(chartNumber, false);
        cleanupDir(tmpDownloadDir);
      }
    };

    const s57FailListener = (job: DownloadJob): void => {
      if (job.id !== jobId) {
        return;
      }
      downloadManager.removeListener('job-completed', s57Listener);
      downloadManager.removeListener('job-failed', s57FailListener);
      removeInstall(chartNumber);
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
    setConvertingState(chartNumber, true);

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
        removeInstall(chartNumber);
        setConvertingState(chartNumber, false);
        cleanupDir(tmpDownloadDir);
        return;
      }

      app.debug(`Starting RNC conversion for ${chartNumber}: ${zipPath}`);

      try {
        const result = await processRncZip(zipPath, targetDir, chartNumber, (status, message) => {
          app.debug(`RNC [${chartNumber}] ${status}: ${message}`);
        });

        setConvertingState(chartNumber, false);
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
        app.debug(`RNC conversion complete for ${chartNumber}: ${result.mbtilesFiles.join(', ')}`);
      } catch (convError) {
        app.error(
          `RNC conversion failed for ${chartNumber}: ${convError instanceof Error ? convError.message : String(convError)}`
        );
        removeInstall(chartNumber);
        setConvertingState(chartNumber, false);
        cleanupDir(tmpDownloadDir);
      }
    };

    const rncFailListener = (job: DownloadJob): void => {
      if (job.id !== jobId) {
        return;
      }
      downloadManager.removeListener('job-completed', rncListener);
      downloadManager.removeListener('job-failed', rncFailListener);
      removeInstall(chartNumber);
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
    setConvertingState(chartNumber, true);

    const pilotListener = async (job: DownloadJob): Promise<void> => {
      if (job.id !== jobId) {
        return;
      }
      downloadManager.removeListener('job-completed', pilotListener);
      downloadManager.removeListener('job-failed', pilotFailListener);

      const dlFileName = job.extractedFiles?.[0] ?? job.targetFiles?.[0];
      const dlPath = dlFileName ? path.join(tmpDownloadDir, dlFileName) : null;

      if (!dlPath || !fs.existsSync(dlPath)) {
        removeInstall(chartNumber);
        setConvertingState(chartNumber, false);
        cleanupDir(tmpDownloadDir);
        return;
      }

      try {
        const result = await processPilotTar(dlPath, targetDir, chartNumber, (status, message) => {
          app.debug(`Pilot [${chartNumber}] ${status}: ${message}`);
        });

        setConvertingState(chartNumber, false);
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
        removeInstall(chartNumber);
        setConvertingState(chartNumber, false);
        cleanupDir(tmpDownloadDir);
      }
    };

    const pilotFailListener = (job: DownloadJob): void => {
      if (job.id !== jobId) {
        return;
      }
      downloadManager.removeListener('job-completed', pilotListener);
      downloadManager.removeListener('job-failed', pilotFailListener);
      removeInstall(chartNumber);
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
    setConvertingState(chartNumber, true);

    const shpListener = async (job: DownloadJob): Promise<void> => {
      if (job.id !== jobId) {
        return;
      }
      downloadManager.removeListener('job-completed', shpListener);
      downloadManager.removeListener('job-failed', shpFailListener);

      const dlFileName = job.extractedFiles?.[0] ?? job.targetFiles?.[0];
      const dlPath = dlFileName ? path.join(tmpDownloadDir, dlFileName) : null;

      if (!dlPath || !fs.existsSync(dlPath)) {
        removeInstall(chartNumber);
        setConvertingState(chartNumber, false);
        cleanupDir(tmpDownloadDir);
        return;
      }

      try {
        const result = await processShpBasemap(
          dlPath,
          targetDir,
          chartNumber,
          (status, message) => {
            app.debug(`ShpBasemap [${chartNumber}] ${status}: ${message}`);
          }
        );

        setConvertingState(chartNumber, false);
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
        removeInstall(chartNumber);
        setConvertingState(chartNumber, false);
        cleanupDir(tmpDownloadDir);
      }
    };

    const shpFailListener = (job: DownloadJob): void => {
      if (job.id !== jobId) {
        return;
      }
      downloadManager.removeListener('job-completed', shpListener);
      downloadManager.removeListener('job-failed', shpFailListener);
      removeInstall(chartNumber);
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
      try {
        await processGshhg(tmpDir, targetDir, resolution, chartNumber, (status, message) => {
          app.debug(`GSHHG [${chartNumber}] ${status}: ${message}`);
        });

        setConvertingState(chartNumber, false);
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
        removeInstall(chartNumber);
        setConvertingState(chartNumber, false);
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
          emitCatalogUpdateNotification(updates);
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
      app.handleMessage('signalk-charts-provider-simple', {
        updates: [
          {
            values: [
              {
                path: 'notifications.plugins.signalk-charts-provider-simple.chartCatalogUpdate' as Path,
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
        'signalk-charts-provider-simple',
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
        2 as unknown as import('@signalk/server-api').SKVersion
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

const serveTileFromMbtiles = (
  res: Response,
  provider: ChartProvider,
  z: number,
  x: number,
  y: number
): void => {
  try {
    const result = provider._mbtilesHandle?.getTile(z, x, y) ?? null;

    if (!result) {
      res.sendStatus(404);
    } else {
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
