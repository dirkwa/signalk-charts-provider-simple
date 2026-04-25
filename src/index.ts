import path from 'path';
import fs from 'fs';
import https from 'https';
import type { Plugin, Path } from '@signalk/server-api';
import { findCharts } from './charts-loader';
import { scanChartsRecursively, scanAllFolders } from './utils/file-scanner';
import { initChartState, isChartEnabled, setChartEnabled } from './utils/chart-state';
import { downloadManager } from './utils/download-manager';
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
} from './utils/catalog-manager';
import {
  initS57Converter,
  processS57Zip,
  getAllConversionProgress as getAllS57Progress,
  getConversionProgress as getS57Progress,
  setConversionFailed as setS57Failed
} from './utils/s57-converter';
import { checkContainerRuntime } from './utils/container-runtime';
import {
  initRncConverter,
  processRncZip,
  processPilotTar,
  getAllConversionProgress as getAllRncProgress,
  getConversionProgress as getRncProgress,
  setConversionFailed as setRncFailed
} from './utils/rnc-converter';
import { processGshhg, processShpBasemap } from './utils/s57-converter';
import { MAX_CONCURRENT_CONVERSIONS } from './utils/concurrency';
import type {
  ExtendedServerAPI,
  PluginConfig,
  ChartProvider,
  SanitizedChart,
  IRouter,
  Request,
  Response,
  DownloadJob
} from './types';

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
        }
      }
    }),
    uiSchema: () => ({}),
    start: (settings) => {
      doStartup(settings as PluginConfig);
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

  const doStartup = (config: PluginConfig): void => {
    app.debug(`** loaded config: ${JSON.stringify(config)}`);
    props = { ...config };

    getDefaultChartsPath(); // ensure lazy init
    ensureDirectoryExists(defaultChartsPath);
    const chartPath = props.chartPath || defaultChartsPath;
    if (!ensureDirectoryExists(chartPath)) {
      app.setPluginError(`Chart directory is not writable: ${chartPath}`);
      app.setPluginStatus('Started (no chart directory)');
      return;
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

    app.setPluginStatus('Started');

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
      const Busboy = require('busboy') as typeof import('busboy');
      const bb = Busboy({ headers: req.headers });

      let downloadUrl = '';
      let targetFolder = '';
      let chartName = '';

      bb.on('field', (name: string, value: string) => {
        if (name === 'url') {
          downloadUrl = value;
        }
        if (name === 'targetFolder') {
          targetFolder = value;
        }
        if (name === 'chartName') {
          chartName = value;
        }
      });

      bb.on('finish', () => {
        try {
          console.log(`Creating download job for: ${downloadUrl}`);
          console.log(`Target folder: ${targetFolder}`);

          const targetDir =
            targetFolder === '/' ? props.chartPath : path.join(props.chartPath, targetFolder);

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

        const normalizedFullPath = path.normalize(fullPath);
        const normalizedBasePath = path.normalize(basePath);
        if (!normalizedFullPath.startsWith(normalizedBasePath)) {
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
      const { folderPath } = req.body as { folderPath?: string };

      app.debug(`Create folder request - folderPath: ${folderPath}`);

      if (!folderPath || typeof folderPath !== 'string') {
        app.debug('Create folder failed: folder path is required');
        res.status(400).send('Folder path is required');
        return;
      }

      try {
        const basePath = props.chartPath || defaultChartsPath;
        const fullPath = path.join(basePath, folderPath);

        app.debug(`Create folder - basePath: ${basePath}, fullPath: ${fullPath}`);

        const normalizedFullPath = path.normalize(fullPath);
        const normalizedBasePath = path.normalize(basePath);
        if (!normalizedFullPath.startsWith(normalizedBasePath)) {
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

        const normalizedFullPath = path.normalize(fullPath);
        const normalizedBasePath = path.normalize(basePath);
        if (!normalizedFullPath.startsWith(normalizedBasePath)) {
          res.status(403).send('Access denied: Invalid path');
          return;
        }

        if (normalizedFullPath === normalizedBasePath) {
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
      const { enabled } = req.body as { enabled?: boolean };

      if (typeof enabled !== 'boolean') {
        res.status(400).send('enabled parameter must be a boolean');
        return;
      }

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
      const { chartPath: chartPathBody, targetFolder } = req.body as {
        chartPath?: string;
        targetFolder?: string;
      };

      app.debug(`Move chart request: chartPath=${chartPathBody}, targetFolder=${targetFolder}`);

      if (!chartPathBody || !targetFolder) {
        res.status(400).send('chartPath and targetFolder are required');
        return;
      }

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

        const normalizedSource = path.normalize(sourcePath);
        const normalizedTarget = path.normalize(targetPath);
        const normalizedBase = path.normalize(basePath);

        if (
          !normalizedSource.startsWith(normalizedBase) ||
          !normalizedTarget.startsWith(normalizedBase)
        ) {
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
      const { chartPath: chartPathBody, newName } = req.body as {
        chartPath?: string;
        newName?: string;
      };

      app.debug(`Rename chart request: chartPath=${chartPathBody}, newName=${newName}`);

      if (!chartPathBody || !newName) {
        res.status(400).send('chartPath and newName are required');
        return;
      }

      if (!newName.endsWith('.mbtiles')) {
        res.status(400).send('Chart name must end with .mbtiles');
        return;
      }

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

        const normalizedSource = path.normalize(sourcePath);
        const normalizedTarget = path.normalize(targetPath);
        const normalizedBase = path.normalize(basePath);

        if (
          !normalizedSource.startsWith(normalizedBase) ||
          !normalizedTarget.startsWith(normalizedBase)
        ) {
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
      const { name } = req.body as { name?: string };

      if (!name || typeof name !== 'string') {
        res.status(400).send('Chart name is required');
        return;
      }

      try {
        const basePath = props.chartPath || defaultChartsPath;
        const fullPath = path.join(basePath, chartPathParam);

        const normalizedFullPath = path.normalize(fullPath);
        const normalizedBasePath = path.normalize(basePath);
        if (!normalizedFullPath.startsWith(normalizedBasePath)) {
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

        const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
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

        const normalizedFullPath = path.normalize(fullPath);
        const normalizedBasePath = path.normalize(basePath);
        if (!normalizedFullPath.startsWith(normalizedBasePath)) {
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

        const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
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
        const Busboy = require('busboy') as typeof import('busboy');
        const bb = Busboy({ headers: req.headers });
        const basePath = props.chartPath || defaultChartsPath;
        const uploadedFiles: string[] = [];
        const writePromises: Promise<void>[] = [];
        let targetFolder = '';

        bb.on('field', (fieldname: string, value: string) => {
          if (fieldname === 'targetFolder') {
            targetFolder = value;
          }
        });

        bb.on(
          'file',
          (_fieldname: string, file: NodeJS.ReadableStream, info: { filename: string }) => {
            const { filename } = info;

            if (!filename.endsWith('.mbtiles')) {
              (file as NodeJS.ReadableStream & { resume(): void }).resume();
              return;
            }

            let uploadPath = basePath;
            if (targetFolder && targetFolder !== '/') {
              uploadPath = path.join(basePath, targetFolder);
            }

            const filepath = path.join(uploadPath, filename);
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
        const filename = req.headers['x-upload-filename'] as string;
        const chunkIndex = parseInt(req.headers['x-chunk-index'] as string, 10);
        const totalChunks = parseInt(req.headers['x-total-chunks'] as string, 10);
        const targetFolder = (req.headers['x-target-folder'] as string) || '/';

        if (
          !filename ||
          !filename.endsWith('.mbtiles') ||
          isNaN(chunkIndex) ||
          isNaN(totalChunks)
        ) {
          res.status(400).json({ error: 'Missing or invalid chunk upload headers' });
          return;
        }

        const basePath = props.chartPath || defaultChartsPath;
        let uploadPath = basePath;
        if (targetFolder && targetFolder !== '/') {
          uploadPath = path.join(basePath, targetFolder);
        }

        const partialPath = path.join(uploadPath, filename + '.partial');
        const finalPath = path.join(uploadPath, filename);

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

    router.get('/catalog-s57-status', async (_req: Request, res: Response) => {
      try {
        const runtime = await checkContainerRuntime();
        res.json({
          containerRuntimeAvailable: runtime.available,
          containerRuntimeVersion: runtime.version,
          containerRuntimeEngine: runtime.engine,
          containerRuntimeSocketPath: runtime.socketPath,
          // legacy aliases (kept until next breaking release)
          podmanAvailable: runtime.available,
          podmanVersion: runtime.version,
          conversions: { ...getAllS57Progress(), ...getAllRncProgress() }
        });
      } catch {
        res.json({
          containerRuntimeAvailable: false,
          containerRuntimeVersion: null,
          containerRuntimeEngine: null,
          containerRuntimeSocketPath: null,
          podmanAvailable: false,
          podmanVersion: null,
          conversions: {}
        });
      }
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
      const Busboy = require('busboy') as typeof import('busboy');
      const bb = Busboy({ headers: req.headers, limits: { fileSize: 500 * 1024 * 1024 } });
      const chartPath = props.chartPath || defaultChartsPath;
      let convType = '';
      let minzoom = 9;
      let maxzoom = 16;

      const tmpDir = path.join(app.getDataDirPath(), `convert-upload-${Date.now()}`);
      fs.mkdirSync(tmpDir, { recursive: true });

      let uploadedFile: string | null = null;
      let uploadedFileName = '';

      bb.on('field', (name: string, value: string) => {
        if (name === 'type') {
          convType = value;
        }
        if (name === 'minzoom') {
          minzoom = parseInt(value) || 9;
        }
        if (name === 'maxzoom') {
          maxzoom = parseInt(value) || 16;
        }
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

        if (!convType || !['s57', 'rnc'].includes(convType)) {
          cleanupDir(tmpDir);
          res.status(400).json({ success: false, error: 'Invalid conversion type' });
          return;
        }

        const validatedFile = uploadedFile;
        void (async () => {
          const runtimeStatus = await checkContainerRuntime();
          if (!runtimeStatus.available) {
            cleanupDir(tmpDir);
            res.status(503).json({
              success: false,
              error:
                'No Docker- or Podman-compatible socket reachable. See docs/running-in-docker.md.'
            });
            return;
          }

          if (getConvertingCount() >= MAX_CONCURRENT_CONVERSIONS) {
            cleanupDir(tmpDir);
            res.status(429).json({
              success: false,
              error: `Too many conversions running (max ${MAX_CONCURRENT_CONVERSIONS}). Please wait for a conversion to finish.`
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

    router.post('/catalog/download', async (req: Request, res: Response) => {
      const { url, chartNumber, catalogFile, zipfileDatetime, targetFolder, minzoom, maxzoom } =
        req.body as {
          url?: string;
          chartNumber?: string;
          catalogFile?: string;
          zipfileDatetime?: string;
          targetFolder?: string;
          minzoom?: number;
          maxzoom?: number;
        };

      if (!url || !chartNumber || !catalogFile) {
        res.status(400).json({
          success: false,
          error: 'url, chartNumber, and catalogFile are required'
        });
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

        if (!fs.existsSync(targetDir)) {
          fs.mkdirSync(targetDir, { recursive: true });
        }

        const needsRuntime = ['s57-zip', 'rnc-zip', 'gshhg', 'pilot-tar', 'shp-basemap'].includes(
          classification.format
        );

        if (needsRuntime) {
          const runtimeStatus = await checkContainerRuntime();
          if (!runtimeStatus.available) {
            res.status(503).json({
              success: false,
              error:
                'No Docker- or Podman-compatible socket reachable. See docs/running-in-docker.md.'
            });
            return;
          }
        }

        if (needsRuntime && getConvertingCount() >= MAX_CONCURRENT_CONVERSIONS) {
          res.status(429).json({
            success: false,
            error: `Too many conversions running (max ${MAX_CONCURRENT_CONVERSIONS}). Please wait for a conversion to finish.`
          });
          return;
        }

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
            maxzoom
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
    maxzoom: number | undefined
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
        const result = await processS57Zip(
          zipPath,
          targetDir,
          chartNumber,
          (status, message) => {
            app.debug(`S-57 [${chartNumber}] ${status}: ${message}`);
          },
          { minzoom, maxzoom }
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

export = pluginConstructor;
