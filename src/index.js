const path = require('path');
const fs = require('fs');
const _ = require('lodash');
const { findCharts } = require('./charts-loader');
const { scanChartsRecursively, scanAllFolders } = require('./utils/file-scanner');
const { initChartState, isChartEnabled, setChartEnabled } = require('./utils/chart-state');
const { downloadManager } = require('./utils/download-manager');
const {
  initCatalogManager,
  getCatalogRegistry,
  fetchCatalog,
  getCachedCatalog,
  classifyUrl,
  trackInstall,
  removeInstall,
  getInstalledCatalogCharts,
  setConvertingState,
  getConvertingCharts,
  getConvertingCount,
  checkForUpdates,
  getCatalogsWithInstalledCharts
} = require('./utils/catalog-manager');
const {
  initS57Converter,
  checkPodman,
  processS57Zip,
  getAllConversionProgress: getAllS57Progress,
  getConversionProgress: getS57Progress
} = require('./utils/s57-converter');
const {
  initRncConverter,
  processRncZip,
  getAllConversionProgress: getAllRncProgress,
  getConversionProgress: getRncProgress
} = require('./utils/rnc-converter');

// Routes are now scoped under /plugins/signalk-charts-provider-simple/ via registerWithRouter
const PLUGIN_ID = 'signalk-charts-provider-simple';
const chartTilesPath = `/plugins/${PLUGIN_ID}`;
const apiRoutePrefix = {
  1: '/signalk/v1/api/resources',
  2: '/signalk/v2/api/resources'
};

module.exports = (app) => {
  let chartProviders = {};
  let props = {
    chartPath: ''
  };

  let urlBase = '';
  let catalogUpdateInterval = null;
  const configBasePath = app.config.configPath;
  const defaultChartsPath = path.join(configBasePath, '/charts-simple');
  const serverMajorVersion = app.config.version ? parseInt(app.config.version.split('.')[0]) : '1';
  ensureDirectoryExists(defaultChartsPath);

  const CONFIG_SCHEMA = {
    title: 'Charts Provider Simple',
    type: 'object',
    properties: {
      chartPath: {
        type: 'string',
        title: 'Chart path',
        description: `Main directory for chart files. Defaults to "${defaultChartsPath}". Subfolders will be scanned recursively.`,
        default: defaultChartsPath
      }
    }
  };

  const CONFIG_UISCHEMA = {};

  const plugin = {
    id: PLUGIN_ID,
    name: 'Charts Provider Simple',
    schema: () => CONFIG_SCHEMA,
    uiSchema: () => CONFIG_UISCHEMA,
    start: (settings) => {
      return doStartup(settings); // return required for tests
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
    }
  };

  const doStartup = (config) => {
    app.debug(`** loaded config: ${config}`);
    props = { ...config };

    urlBase = `${app.config.ssl ? 'https' : 'http'}://localhost:${
      'getExternalPort' in app.config ? app.config.getExternalPort() : 3000
    }`;
    app.debug(`**urlBase** ${urlBase}`);

    const chartPath = props.chartPath || defaultChartsPath;
    ensureDirectoryExists(chartPath);

    // Initialize chart state management
    const configPath = app.config.configPath;
    initChartState(configPath);

    // Initialize catalog manager for chart catalog browsing and update checking
    const dataDir = app.getDataDirPath();
    initCatalogManager(dataDir, app.debug);

    // Initialize converters (Podman-based)
    initS57Converter(app.debug);
    initRncConverter(app.debug);

    // Start periodic catalog update checking (non-blocking)
    startCatalogUpdateChecker();

    // Listen for download completion events and emit delta notifications
    downloadManager.removeAllListeners('job-completed'); // Remove old listeners on restart
    downloadManager.on('job-completed', async (job) => {
      app.debug(
        `Download job completed: ${job.id}, extracted files: ${job.extractedFiles.join(', ')}`
      );

      // Enable newly downloaded charts (in case they were previously disabled)
      for (const fileName of job.extractedFiles) {
        // Calculate relative path from chart base path
        const relativePath = path.relative(chartPath, path.join(job.targetDir, fileName));
        setChartEnabled(relativePath, true);
        app.debug(`Enabled downloaded chart: ${relativePath}`);
      }

      // Reload chart providers to include downloaded charts
      await refreshChartProviders();

      // Emit delta for each extracted chart
      for (const fileName of job.extractedFiles) {
        const chartId = fileName.replace(/\.mbtiles$/, '');

        // If chart is enabled and in chartProviders, emit its data
        if (chartProviders[chartId]) {
          // Always use version 2 format for deltas
          const chartData = sanitizeProvider(chartProviders[chartId], 2);
          emitChartDelta(chartId, chartData);
          app.debug(`Delta emitted for downloaded chart: ${chartId}`);
        }
      }
    });

    app.debug(`Start chart provider. Chart path: ${chartPath}`);

    // v2 routes - register as Resource Provider, this needs to be always on startup
    if (serverMajorVersion === 2) {
      app.debug('** Registering v2 API paths **');
      registerAsProvider();
    }

    app.setPluginStatus('Started');

    // Load charts from the single chart path (including subfolders)
    return findCharts(chartPath)
      .then((charts) => {
        // Filter out disabled charts
        const enabledCharts = _.pickBy(charts, (chart) => {
          // Extract relative path from the full path
          const relativePath = path.relative(chartPath, chart._filePath || '');
          return isChartEnabled(relativePath);
        });

        app.debug(
          `Chart provider: Found ${
            _.keys(charts).length
          } charts (${_.keys(enabledCharts).length} enabled) from ${chartPath}.`
        );
        chartProviders = enabledCharts;
      })
      .catch((e) => {
        console.error(`Error loading chart providers`, e.message);
        chartProviders = {};
        app.setPluginError(`Error loading chart providers`);
      });
  };

  const registerRoutes = (router) => {
    app.debug('** Registering API paths via registerWithRouter **');

    // Tile serving route - path is relative to /plugins/signalk-charts-provider-simple/
    router.get('/:identifier/:z([0-9]*)/:x([0-9]*)/:y([0-9]*)', async (req, res) => {
      const { identifier, z, x, y } = req.params;
      const ix = parseInt(x);
      const iy = parseInt(y);
      const iz = parseInt(z);
      const provider = chartProviders[identifier];
      if (!provider) {
        return res.sendStatus(404);
      }
      switch (provider._fileFormat) {
        case 'directory':
          return serveTileFromFilesystem(res, provider, iz, ix, iy);
        case 'mbtiles':
          return serveTileFromMbtiles(res, provider, iz, ix, iy);
        default:
          console.log(`Unknown chart provider fileformat ${provider._fileFormat}`);
          res.status(500).send();
      }
    });

    // Download from URL - create download job
    router.post('/download-chart-locker', async (req, res) => {
      const busboy = require('busboy');
      const bb = busboy({ headers: req.headers });

      let downloadUrl = '';
      let targetFolder = '';
      let chartName = '';

      bb.on('field', (name, value) => {
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

      bb.on('finish', async () => {
        try {
          console.log(`Creating download job for: ${downloadUrl}`);
          console.log(`Target folder: ${targetFolder}`);

          // Determine target directory
          const targetDir =
            targetFolder === '/' ? props.chartPath : path.join(props.chartPath, targetFolder);

          // Ensure target directory exists
          if (!fs.existsSync(targetDir)) {
            fs.mkdirSync(targetDir, { recursive: true });
          }

          // Create download job
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
            error: error.message || 'Failed to create download job'
          });
        }
      });

      req.pipe(bb);
    });

    // Get download job status
    router.get('/download-job/:jobId', (req, res) => {
      const jobId = req.params.jobId;
      const job = downloadManager.getJob(jobId);

      if (!job) {
        return res.status(404).json({ error: 'Job not found' });
      }

      res.json(job);
    });

    // Get all download jobs
    router.get('/download-jobs', (req, res) => {
      const jobs = downloadManager.getAllJobs();
      res.json(jobs);
    });

    // Cancel a download job
    router.post('/cancel-download/:jobId', (req, res) => {
      const { jobId } = req.params;

      if (!jobId) {
        return res.status(400).json({ success: false, error: 'jobId is required' });
      }

      app.debug(`Cancelling download job: ${jobId}`);
      const result = downloadManager.cancelJob(jobId);

      if (result.success) {
        res.json({ success: true, message: 'Download cancelled successfully' });
      } else {
        res.status(400).json(result);
      }
    });

    router.get('/download', (req, res) => {
      const url = req.query.url;
      if (!url) {
        return res.status(400).send('url parameter is required');
      }

      const https = require('https');
      https
        .get(url, (response) => {
          if (
            response.statusCode >= 300 &&
            response.statusCode < 400 &&
            response.headers.location
          ) {
            return res.redirect(response.headers.location);
          }
          if (response.statusCode !== 200) {
            return res.status(response.statusCode).send(`Failed to download file from ${url}`);
          }
          const disposition = response.headers['content-disposition'];
          let filename = 'download.zip';
          if (disposition && disposition.indexOf('attachment') !== -1) {
            const filenameRegex = /filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/;
            const matches = filenameRegex.exec(disposition);
            if (matches !== null && matches[1]) {
              filename = matches[1].replace(/['"]/g, '');
            }
          }
          res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
          res.setHeader('Content-Type', response.headers['content-type']);
          response.pipe(res);
        })
        .on('error', (err) => {
          console.error(`Error downloading file from ${url}`, err);
          res.status(500).send('Error downloading file');
        });
    });

    router.get('/local-charts', async (req, res) => {
      try {
        const chartPath = props.chartPath || defaultChartsPath;
        const charts = await scanChartsRecursively(chartPath);

        // Scan all folders (including empty ones)
        const allFolders = await scanAllFolders(chartPath);

        const foldersSet = new Set();

        // Always include root folder
        foldersSet.add('/');

        // Add folders from charts
        charts.forEach((chart) => {
          foldersSet.add(chart.folder);
        });

        // Add all scanned folders (these are actual subdirectories)
        allFolders.forEach((folder) => foldersSet.add(folder));

        // Convert to array and sort (root first, then alphabetically)
        const folders = Array.from(foldersSet).sort((a, b) => {
          if (a === '/') {
            return -1;
          }
          if (b === '/') {
            return 1;
          }
          return a.localeCompare(b);
        });

        // Get active download jobs to mark charts being downloaded
        const activeJobs = downloadManager.getActiveJobs();
        const downloadingFiles = new Set();

        activeJobs.forEach((job) => {
          if (job.status === 'downloading' || job.status === 'extracting') {
            // Add all target files (these are added as soon as writing starts)
            if (job.targetFiles && job.targetFiles.length > 0) {
              job.targetFiles.forEach((file) => downloadingFiles.add(file));
            }
          }
        });

        // Check for active conversions (S-57/RNC)
        const convertingCharts = getConvertingCharts();
        const convertingFolders = new Set();
        for (const chartNum of Object.keys(convertingCharts)) {
          // S-57 charts land in S-57/{code}-{number}/ folders
          // Mark any chart whose folder contains a converting chart number
          convertingFolders.add(chartNum);
        }

        // Apply enabled state, downloading and converting status
        const chartsWithState = charts.map((chart) => {
          // Check if this chart is in a folder being converted
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

    router.delete('/local-charts/:chartPath', async (req, res) => {
      const chartPathParam = decodeURIComponent(req.params.chartPath);
      try {
        const basePath = props.chartPath || defaultChartsPath;
        const fullPath = path.join(basePath, chartPathParam);

        // Security check: ensure the path is within the base chart directory
        const normalizedFullPath = path.normalize(fullPath);
        const normalizedBasePath = path.normalize(basePath);
        if (!normalizedFullPath.startsWith(normalizedBasePath)) {
          return res.status(403).send('Access denied: Invalid path');
        }

        // Extract just the filename for download job lookup
        const fileName = path.basename(fullPath);

        // Cancel any active downloads for this file
        const activeJobs = downloadManager.findJobsByTargetFile(fileName);
        activeJobs.forEach((job) => {
          app.debug(`Cancelling download job ${job.id} for file: ${fileName}`);
          downloadManager.cancelJob(job.id);
        });

        if (fs.existsSync(fullPath)) {
          const stat = await fs.promises.stat(fullPath);
          if (stat.isDirectory()) {
            await fs.promises.rm(fullPath, { recursive: true, force: true });
            // Clean up empty parent directories (e.g., S-57/ after deleting S-57/AT-269/)
            cleanupEmptyParents(fullPath, basePath);
          } else {
            await fs.promises.unlink(fullPath);
          }

          // Reload chart providers and emit delta
          await refreshChartProviders();
          const chartId = path.basename(chartPathParam).replace(/\.mbtiles$/, '');
          emitChartDelta(chartId, null);

          // Remove catalog install tracking — try both the full ID (AT-269)
          // and the chart number portion (269) since catalogs track by number
          removeInstall(chartId);
          const chartNumberPart = chartId.replace(/^[A-Z]+-/, '');
          if (chartNumberPart !== chartId) {
            removeInstall(chartNumberPart);
          }

          res.status(200).send('Chart deleted successfully');
        } else {
          // File might not exist yet if it was being downloaded
          // Still emit delta in case it was previously registered
          await refreshChartProviders();
          const chartId = path.basename(chartPathParam).replace(/\.mbtiles$/, '');
          emitChartDelta(chartId, null);

          // Remove catalog install tracking
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

    // Create folder endpoint
    router.post('/folders', async (req, res) => {
      const { folderPath } = req.body;

      app.debug(`Create folder request - folderPath: ${folderPath}`);

      if (!folderPath || typeof folderPath !== 'string') {
        app.debug('Create folder failed: folder path is required');
        return res.status(400).send('Folder path is required');
      }

      try {
        const basePath = props.chartPath || defaultChartsPath;
        const fullPath = path.join(basePath, folderPath);

        app.debug(`Create folder - basePath: ${basePath}, fullPath: ${fullPath}`);

        // Security check: ensure the path is within the base chart directory
        const normalizedFullPath = path.normalize(fullPath);
        const normalizedBasePath = path.normalize(basePath);
        if (!normalizedFullPath.startsWith(normalizedBasePath)) {
          app.debug('Create folder failed: path traversal attempt');
          return res.status(403).send('Access denied: Invalid path');
        }

        // Create the folder
        await fs.promises.mkdir(fullPath, { recursive: true });
        app.debug(`Folder created successfully: ${fullPath}`);
        res.status(200).json({ success: true, message: 'Folder created successfully' });
      } catch (error) {
        app.error('Error creating folder: ' + error.message);
        res.status(500).send('Error creating folder: ' + error.message);
      }
    });

    // Delete folder endpoint
    router.delete('/folders/:folderPath', async (req, res) => {
      const folderPathParam = decodeURIComponent(req.params.folderPath);

      try {
        const basePath = props.chartPath || defaultChartsPath;
        const fullPath = path.join(basePath, folderPathParam);

        // Security check: ensure the path is within the base chart directory
        const normalizedFullPath = path.normalize(fullPath);
        const normalizedBasePath = path.normalize(basePath);
        if (!normalizedFullPath.startsWith(normalizedBasePath)) {
          return res.status(403).send('Access denied: Invalid path');
        }

        // Prevent deleting the root chart directory
        if (normalizedFullPath === normalizedBasePath) {
          return res.status(403).send('Cannot delete the root chart directory');
        }

        if (!fs.existsSync(fullPath)) {
          return res.status(404).send('Folder not found');
        }

        // Check if folder is empty
        const contents = await fs.promises.readdir(fullPath);
        if (contents.length > 0) {
          return res.status(400).send('Folder is not empty');
        }

        // Delete the folder
        await fs.promises.rmdir(fullPath);
        res.status(200).json({ success: true, message: 'Folder deleted successfully' });
      } catch (error) {
        console.error('Error deleting folder:', error);
        res.status(500).send('Error deleting folder');
      }
    });

    // Toggle chart enabled state
    router.post('/charts/:chartPath/toggle', async (req, res) => {
      const chartPathParam = decodeURIComponent(req.params.chartPath);
      const { enabled } = req.body;

      if (typeof enabled !== 'boolean') {
        return res.status(400).send('enabled parameter must be a boolean');
      }

      try {
        setChartEnabled(chartPathParam, enabled);

        app.debug(`Chart ${chartPathParam} set to ${enabled ? 'enabled' : 'disabled'}`);

        // Reload chart providers to update v1/v2 API
        await refreshChartProviders();

        // Chart identifier is just the filename without extension (not the full relative path)
        const chartId = path.basename(chartPathParam).replace(/\.mbtiles$/, '');

        // Emit delta notification for toggle operation
        if (enabled) {
          // Chart was enabled - emit full chart data
          if (chartProviders[chartId]) {
            const chart = chartProviders[chartId];
            // Always use version 2 format for deltas (v2 clients expect v2 data structure)
            const chartData = sanitizeProvider(chart, 2);
            emitChartDelta(chartId, chartData);
            app.debug(`Delta emitted for enabled chart: ${chartId}`);
          } else {
            app.debug(`Chart ${chartId} not found in providers after enabling`);
          }
        } else {
          // Chart was disabled - emit null to remove from stream
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

    // Move chart to different folder
    router.post('/move-chart', async (req, res) => {
      const { chartPath, targetFolder } = req.body;

      app.debug(`Move chart request: chartPath=${chartPath}, targetFolder=${targetFolder}`);

      if (!chartPath || !targetFolder) {
        return res.status(400).send('chartPath and targetFolder are required');
      }

      try {
        const basePath = props.chartPath || defaultChartsPath;
        const sourcePath = path.join(basePath, chartPath);
        app.debug(`Source path: ${sourcePath}`);

        // Get just the filename
        const filename = path.basename(chartPath);

        // Build target path
        let targetPath;
        if (targetFolder === '/') {
          targetPath = path.join(basePath, filename);
        } else {
          targetPath = path.join(basePath, targetFolder, filename);
        }
        app.debug(`Target path: ${targetPath}`);

        // Security check
        const normalizedSource = path.normalize(sourcePath);
        const normalizedTarget = path.normalize(targetPath);
        const normalizedBase = path.normalize(basePath);

        if (
          !normalizedSource.startsWith(normalizedBase) ||
          !normalizedTarget.startsWith(normalizedBase)
        ) {
          return res.status(403).send('Access denied: Invalid path');
        }

        // Check if source exists
        if (!fs.existsSync(sourcePath)) {
          app.error(`Chart not found at: ${sourcePath}`);
          return res.status(404).send('Chart not found');
        }

        // Ensure target folder exists
        const targetDir = path.dirname(targetPath);
        if (!fs.existsSync(targetDir)) {
          app.debug(`Creating target directory: ${targetDir}`);
          await fs.promises.mkdir(targetDir, { recursive: true });
        }

        // Move the file
        await fs.promises.rename(sourcePath, targetPath);
        app.debug(`Moved chart from ${sourcePath} to ${targetPath}`);

        // Reload chart providers and emit deltas for move operation
        await refreshChartProviders();

        // Emit delta notifications
        // Note: Move doesn't change the chart identifier (just the filename), but we still
        // need to notify that the old resource is gone and new one exists
        const chartId = path.basename(chartPath).replace(/\.mbtiles$/, '');

        // If chart is in chartProviders (enabled), emit its data
        if (chartProviders[chartId]) {
          // Always use version 2 format for deltas
          const chartData = sanitizeProvider(chartProviders[chartId], 2);
          emitChartDelta(chartId, chartData);
        }

        res.status(200).json({ success: true, message: 'Chart moved successfully' });
      } catch (error) {
        app.error('Error moving chart: ' + error.message);
        res.status(500).send('Error moving chart: ' + error.message);
      }
    });

    // Rename chart
    router.post('/rename-chart', async (req, res) => {
      const { chartPath, newName } = req.body;

      app.debug(`Rename chart request: chartPath=${chartPath}, newName=${newName}`);

      if (!chartPath || !newName) {
        return res.status(400).send('chartPath and newName are required');
      }

      // Validate new name
      if (!newName.endsWith('.mbtiles')) {
        return res.status(400).send('Chart name must end with .mbtiles');
      }

      // Check for invalid characters
      const nameWithoutExt = newName.replace(/\.mbtiles$/, '');
      if (
        nameWithoutExt.includes('..') ||
        nameWithoutExt.includes('/') ||
        nameWithoutExt.includes('\\')
      ) {
        return res.status(400).send('Invalid chart name');
      }

      try {
        const basePath = props.chartPath || defaultChartsPath;
        const sourcePath = path.join(basePath, chartPath);
        app.debug(`Source path: ${sourcePath}`);

        // Build target path (same folder, different name)
        const folder = path.dirname(chartPath);
        const targetPath = path.join(basePath, folder, newName);
        app.debug(`Target path: ${targetPath}`);

        // Security check
        const normalizedSource = path.normalize(sourcePath);
        const normalizedTarget = path.normalize(targetPath);
        const normalizedBase = path.normalize(basePath);

        if (
          !normalizedSource.startsWith(normalizedBase) ||
          !normalizedTarget.startsWith(normalizedBase)
        ) {
          return res.status(403).send('Access denied: Invalid path');
        }

        // Check if source exists
        if (!fs.existsSync(sourcePath)) {
          app.error(`Chart not found at: ${sourcePath}`);
          return res.status(404).send('Chart not found');
        }

        // Check if target already exists
        if (fs.existsSync(targetPath)) {
          return res.status(400).send('A chart with this name already exists in the same folder');
        }

        // Rename the file
        await fs.promises.rename(sourcePath, targetPath);
        app.debug(`Renamed chart from ${sourcePath} to ${targetPath}`);

        // Reload chart providers and emit delta notifications for rename operation
        await refreshChartProviders();

        // Emit deltas: delete old name, add new name
        const oldChartId = path.basename(chartPath).replace(/\.mbtiles$/, '');
        const newChartId = path.basename(targetPath).replace(/\.mbtiles$/, '');

        emitChartDelta(oldChartId, null);

        if (chartProviders[newChartId]) {
          // Always use version 2 format for deltas
          const chartData = sanitizeProvider(chartProviders[newChartId], 2);
          emitChartDelta(newChartId, chartData);
        }

        res.status(200).json({ success: true, message: 'Chart renamed successfully' });
      } catch (error) {
        app.error('Error renaming chart: ' + error.message);
        res.status(500).send('Error renaming chart: ' + error.message);
      }
    });

    // Update chart metadata (MBTiles only)
    router.put('/chart-metadata/:chartPath', async (req, res) => {
      const chartPathParam = decodeURIComponent(req.params.chartPath);
      const { name } = req.body;

      if (!name || typeof name !== 'string') {
        return res.status(400).send('Chart name is required');
      }

      try {
        const basePath = props.chartPath || defaultChartsPath;
        const fullPath = path.join(basePath, chartPathParam);

        // Security check
        const normalizedFullPath = path.normalize(fullPath);
        const normalizedBasePath = path.normalize(basePath);
        if (!normalizedFullPath.startsWith(normalizedBasePath)) {
          return res.status(403).send('Access denied: Invalid path');
        }

        // Check if file exists
        if (!fs.existsSync(fullPath)) {
          return res.status(404).send('Chart not found');
        }

        // Only support .mbtiles files
        if (!fullPath.endsWith('.mbtiles')) {
          return res.status(400).send('Metadata editing only available for MBTiles charts');
        }

        // Update metadata in SQLite database
        const { DatabaseSync } = require('node:sqlite');
        const db = new DatabaseSync(fullPath);

        try {
          // Update name and description
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

        // Reload chart providers and emit delta notification
        await refreshChartProviders();

        const chartId = path.basename(chartPathParam).replace(/\.mbtiles$/, '');
        if (chartProviders[chartId]) {
          // Always use version 2 format for deltas
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

    // Get chart metadata (MBTiles only)
    router.get('/chart-metadata/:chartPath', (req, res) => {
      const chartPathParam = decodeURIComponent(req.params.chartPath);

      try {
        const basePath = props.chartPath || defaultChartsPath;
        const fullPath = path.join(basePath, chartPathParam);

        // Security check: ensure the path is within the base chart directory
        const normalizedFullPath = path.normalize(fullPath);
        const normalizedBasePath = path.normalize(basePath);
        if (!normalizedFullPath.startsWith(normalizedBasePath)) {
          return res.status(403).send('Access denied: Invalid path');
        }

        // Check if file exists
        if (!fs.existsSync(fullPath)) {
          return res.status(404).send('Chart not found');
        }

        // Only support .mbtiles files
        if (!fullPath.endsWith('.mbtiles')) {
          return res.status(400).send('Metadata only available for MBTiles charts');
        }

        // Read metadata from SQLite database
        const { DatabaseSync } = require('node:sqlite');
        const db = new DatabaseSync(fullPath, { readOnly: true });

        try {
          // Get all metadata
          const rows = db.prepare('SELECT name, value FROM metadata').all();

          // Convert rows to object
          const metadata = {};
          rows.forEach((row) => {
            metadata[row.name] = row.value;
          });

          // Try to get tile count - different MBTiles files use different table names
          // Try 'map' first (standard), then 'tiles' (alternative)
          try {
            const countRow = db.prepare('SELECT COUNT(*) as count FROM map').get();
            metadata.tileCount = countRow.count;
          } catch (_err) {
            // Try alternative table name
            try {
              const countRow = db.prepare('SELECT COUNT(*) as count FROM tiles').get();
              metadata.tileCount = countRow.count;
            } catch (_err2) {
              // If both fail, silently omit tile count - some MBTiles formats don't have this
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

    // Upload chart file
    router.post('/upload', async (req, res) => {
      try {
        const busboy = require('busboy');
        const bb = busboy({ headers: req.headers });
        const basePath = props.chartPath || defaultChartsPath;
        const uploadedFiles = [];
        const writePromises = [];
        let targetFolder = '';

        bb.on('field', (fieldname, value) => {
          if (fieldname === 'targetFolder') {
            targetFolder = value;
          }
        });

        bb.on('file', (fieldname, file, info) => {
          const { filename } = info;

          // Only accept .mbtiles files
          if (!filename.endsWith('.mbtiles')) {
            file.resume(); // Drain the stream
            return;
          }

          // Determine upload path
          let uploadPath = basePath;
          if (targetFolder && targetFolder !== '/') {
            uploadPath = path.join(basePath, targetFolder);
          }

          const filepath = path.join(uploadPath, filename);
          app.debug(`Uploading chart file: ${filename} to ${filepath}`);

          const writeStream = fs.createWriteStream(filepath);
          file.pipe(writeStream);

          // Create a promise that resolves when the write stream finishes
          const writePromise = new Promise((resolve, reject) => {
            writeStream.on('finish', () => {
              uploadedFiles.push(filename);
              app.debug(`Chart file uploaded successfully: ${filename}`);
              resolve();
            });

            writeStream.on('error', (err) => {
              app.error(`Error writing file ${filename}: ${err.message}`);
              reject(err);
            });
          });

          writePromises.push(writePromise);
        });

        bb.on('finish', async () => {
          try {
            // Wait for all file writes to complete
            await Promise.all(writePromises);

            if (uploadedFiles.length > 0) {
              // Enable uploaded charts (in case they were previously disabled)
              for (const filename of uploadedFiles) {
                // Calculate relative path from chart base path
                const uploadDir =
                  targetFolder && targetFolder !== '/'
                    ? path.join(basePath, targetFolder)
                    : basePath;
                const relativePath = path.relative(basePath, path.join(uploadDir, filename));
                setChartEnabled(relativePath, true);
                app.debug(`Enabled uploaded chart: ${relativePath}`);
              }

              // Reload chart providers to include new uploads
              await refreshChartProviders();

              // Emit delta notifications for uploaded charts
              for (const filename of uploadedFiles) {
                const chartId = filename.replace(/\.mbtiles$/, '');

                // If chart is enabled and in chartProviders, emit its data
                if (chartProviders[chartId]) {
                  // Always use version 2 format for deltas
                  const chartData = sanitizeProvider(chartProviders[chartId], 2);
                  emitChartDelta(chartId, chartData);
                }
              }

              res.status(200).json({
                success: true,
                message: `${uploadedFiles.length} file(s) uploaded successfully`,
                files: uploadedFiles
              });
            } else {
              res.status(400).send('No valid .mbtiles files uploaded');
            }
          } catch (error) {
            app.error('Error completing file uploads: ' + error.message);
            res.status(500).send('Error completing file uploads');
          }
        });

        req.pipe(bb);
      } catch (error) {
        app.error('Error uploading charts: ' + error.message);
        res.status(500).send('Error uploading charts');
      }
    });

    // ---- Chart Catalog API routes ----

    // Return the 27-catalog registry with cached metadata
    router.get('/catalog-registry', (req, res) => {
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

    // Check Podman availability and all conversion progress (S-57 + RNC)
    router.get('/catalog-s57-status', async (req, res) => {
      try {
        const podman = await checkPodman();
        res.json({
          podmanAvailable: podman.available,
          podmanVersion: podman.version,
          conversions: { ...getAllS57Progress(), ...getAllRncProgress() }
        });
      } catch (_error) {
        res.json({ podmanAvailable: false, podmanVersion: null, conversions: {} });
      }
    });

    // Get conversion log for a specific chart (S-57 or RNC)
    router.get('/catalog-s57-log/:chartNumber', (req, res) => {
      const progress =
        getS57Progress(req.params.chartNumber) || getRncProgress(req.params.chartNumber);
      if (!progress) {
        return res.json({ log: [], status: null });
      }
      res.json({ log: progress.log || [], status: progress.status, message: progress.message });
    });

    // Return charts with available updates
    router.get('/catalog-updates', (req, res) => {
      try {
        const updates = checkForUpdates();
        res.json(updates);
      } catch (error) {
        console.error('Error checking catalog updates:', error);
        res.status(500).json({ error: 'Failed to check for updates' });
      }
    });

    // Fetch and return a specific catalog's charts
    router.get('/catalog/:catalogFile', async (req, res) => {
      try {
        const catalogFile = req.params.catalogFile;
        const data = await fetchCatalog(catalogFile);
        if (!data) {
          return res.status(404).json({ error: 'Catalog not found or unavailable' });
        }

        // Augment each chart with URL classification and install status
        const installed = getInstalledCatalogCharts();
        const registryEntry = getCatalogRegistry().find((r) => r.file === catalogFile);
        const catalogCategory = registryEntry ? registryEntry.category : '';
        const augmentedCharts = data.charts.map((chart) => ({
          ...chart,
          urlClassification: classifyUrl(chart.zipfile_location, catalogCategory),
          installed: !!installed[chart.number],
          installedDate: installed[chart.number]
            ? installed[chart.number].zipfile_datetime_iso8601
            : null
        }));

        res.json({
          ...data,
          charts: augmentedCharts
        });
      } catch (error) {
        // Fall back to cache
        const cached = getCachedCatalog(req.params.catalogFile);
        if (cached) {
          return res.json(cached);
        }
        console.error('Error fetching catalog:', error);
        res.status(500).json({ error: 'Failed to fetch catalog' });
      }
    });

    // Initiate download of a catalog chart
    router.post('/catalog/download', (req, res) => {
      const { url, chartNumber, catalogFile, zipfileDatetime, targetFolder, minzoom, maxzoom } =
        req.body;

      if (!url || !chartNumber || !catalogFile) {
        return res.status(400).json({
          success: false,
          error: 'url, chartNumber, and catalogFile are required'
        });
      }

      // Validate URL is supported (pass catalog category for ZIP classification)
      const registryEntry = getCatalogRegistry().find((r) => r.file === catalogFile);
      const catalogCategory = registryEntry ? registryEntry.category : '';
      const classification = classifyUrl(url, catalogCategory);
      if (!classification.supported) {
        return res.status(400).json({
          success: false,
          error: `Unsupported format: ${classification.label}`
        });
      }

      try {
        const chartPath = props.chartPath || defaultChartsPath;
        const targetDir =
          !targetFolder || targetFolder === '/' ? chartPath : path.join(chartPath, targetFolder);

        // Ensure target directory exists
        if (!fs.existsSync(targetDir)) {
          fs.mkdirSync(targetDir, { recursive: true });
        }

        // Limit concurrent conversions to avoid overloading the host
        const MAX_CONCURRENT_CONVERSIONS = 2;
        if (
          (classification.format === 's57-zip' || classification.format === 'rnc-zip') &&
          getConvertingCount() >= MAX_CONCURRENT_CONVERSIONS
        ) {
          return res.status(429).json({
            success: false,
            error: `Too many conversions running (max ${MAX_CONCURRENT_CONVERSIONS}). Please wait for a conversion to finish.`
          });
        }

        if (classification.format === 's57-zip') {
          // S-57 ENC pipeline: download ZIP → convert via Podman s57-tiler
          // Output goes to S-57/{catalogCode}-{chartNumber}/ subfolder
          const catalogCode = catalogFile.replace(/_.*$/, ''); // AT_IENC_Catalog.xml → AT
          const s57SubDir = path.join(chartPath, 'S-57', `${catalogCode}-${chartNumber}`);
          fs.mkdirSync(s57SubDir, { recursive: true });

          // Download ZIP to a temp location (not the charts dir)
          const tmpDownloadDir = path.join(app.getDataDirPath(), `s57-download-${Date.now()}`);
          fs.mkdirSync(tmpDownloadDir, { recursive: true });

          const jobId = downloadManager.createJob(url, tmpDownloadDir, chartNumber, {
            saveRaw: true
          });

          // Track as "converting" — not yet installed
          trackInstall(chartNumber, catalogFile, zipfileDatetime || '', url);
          setConvertingState(chartNumber, true);

          // When ZIP download completes, run S-57 conversion
          const s57Listener = async (job) => {
            if (job.id !== jobId) {
              return;
            }
            downloadManager.removeListener('job-completed', s57Listener);
            downloadManager.removeListener('job-failed', s57FailListener);

            // Find the downloaded ZIP file
            const zipFileName =
              (job.extractedFiles && job.extractedFiles[0]) ||
              (job.targetFiles && job.targetFiles[0]);
            const zipPath = zipFileName ? path.join(tmpDownloadDir, zipFileName) : null;

            if (!zipPath || !fs.existsSync(zipPath)) {
              app.debug(`S-57: no ZIP file found after download for ${chartNumber}`);
              removeInstall(chartNumber);
              setConvertingState(chartNumber, false);
              cleanupDir(tmpDownloadDir);
              return;
            }

            app.debug(`Starting S-57 conversion for ${chartNumber}: ${zipPath} → ${s57SubDir}`);

            try {
              const result = await processS57Zip(
                zipPath,
                s57SubDir,
                chartNumber,
                (status, message) => {
                  app.debug(`S-57 [${chartNumber}] ${status}: ${message}`);
                },
                { minzoom, maxzoom }
              );

              // Conversion done — mark as no longer converting
              setConvertingState(chartNumber, false);

              // Clean up temp download dir
              cleanupDir(tmpDownloadDir);

              // Reload chart providers to pick up the new vector tile charts
              await refreshChartProviders();

              // Emit deltas for each new chart directory
              for (const chartDir of result.chartDirs) {
                if (chartProviders[chartDir]) {
                  const chartData = sanitizeProvider(chartProviders[chartDir], 2);
                  emitChartDelta(chartDir, chartData);
                }
              }

              app.debug(
                `S-57 conversion complete for ${chartNumber}: ${result.chartDirs.length} chart(s) in S-57/${catalogCode}-${chartNumber}/`
              );
            } catch (convError) {
              app.error(`S-57 conversion failed for ${chartNumber}: ${convError.message}`);
              removeInstall(chartNumber);
              setConvertingState(chartNumber, false);
              cleanupDir(tmpDownloadDir);
            }
          };

          const s57FailListener = (job) => {
            if (job.id !== jobId) {
              return;
            }
            downloadManager.removeListener('job-completed', s57Listener);
            downloadManager.removeListener('job-failed', s57FailListener);
            removeInstall(chartNumber);
            setConvertingState(chartNumber, false);
            cleanupDir(tmpDownloadDir);
          };

          downloadManager.on('job-completed', s57Listener);
          downloadManager.on('job-failed', s57FailListener);

          app.debug(
            `S-57 catalog download started: ${chartNumber} from ${catalogFile}, job: ${jobId}`
          );

          res.json({
            success: true,
            jobId,
            message: 'S-57 download and conversion job created'
          });
        } else if (classification.format === 'rnc-zip') {
          // RNC (BSB raster) pipeline: download ZIP → convert via Podman GDAL → MBTiles
          const tmpDownloadDir = path.join(app.getDataDirPath(), `rnc-download-${Date.now()}`);
          fs.mkdirSync(tmpDownloadDir, { recursive: true });

          const jobId = downloadManager.createJob(url, tmpDownloadDir, chartNumber, {
            saveRaw: true
          });

          trackInstall(chartNumber, catalogFile, zipfileDatetime || '', url);
          setConvertingState(chartNumber, true);

          const rncListener = async (job) => {
            if (job.id !== jobId) {
              return;
            }
            downloadManager.removeListener('job-completed', rncListener);
            downloadManager.removeListener('job-failed', rncFailListener);

            const zipFileName =
              (job.extractedFiles && job.extractedFiles[0]) ||
              (job.targetFiles && job.targetFiles[0]);
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
              const result = await processRncZip(
                zipPath,
                targetDir,
                chartNumber,
                (status, message) => {
                  app.debug(`RNC [${chartNumber}] ${status}: ${message}`);
                }
              );

              setConvertingState(chartNumber, false);
              cleanupDir(tmpDownloadDir);

              // Reload chart providers and enable new charts
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

              app.debug(
                `RNC conversion complete for ${chartNumber}: ${result.mbtilesFiles.join(', ')}`
              );
            } catch (convError) {
              app.error(`RNC conversion failed for ${chartNumber}: ${convError.message}`);
              removeInstall(chartNumber);
              setConvertingState(chartNumber, false);
              cleanupDir(tmpDownloadDir);
            }
          };

          const rncFailListener = (job) => {
            if (job.id !== jobId) {
              return;
            }
            downloadManager.removeListener('job-completed', rncListener);
            downloadManager.removeListener('job-failed', rncFailListener);
            removeInstall(chartNumber);
            setConvertingState(chartNumber, false);
            cleanupDir(tmpDownloadDir);
          };

          downloadManager.on('job-completed', rncListener);
          downloadManager.on('job-failed', rncFailListener);

          app.debug(
            `RNC catalog download started: ${chartNumber} from ${catalogFile}, job: ${jobId}`
          );

          res.json({
            success: true,
            jobId,
            message: 'RNC download and conversion job created'
          });
        } else {
          // Standard MBTiles / ZIP-with-MBTiles download
          const jobId = downloadManager.createJob(url, targetDir, chartNumber);

          trackInstall(chartNumber, catalogFile, zipfileDatetime || '', url);

          // Remove tracking if the download fails or produces no .mbtiles
          const cleanupListener = (job) => {
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
          error: error.message || 'Failed to create download job'
        });
      }
    });

    app.debug('** Registering v1 API paths **');

    app.get(apiRoutePrefix[1] + '/charts/:identifier', (req, res) => {
      const { identifier } = req.params;
      const provider = chartProviders[identifier];
      if (provider) {
        return res.json(sanitizeProvider(provider));
      } else {
        return res.status(404).send('Not found');
      }
    });

    app.get(apiRoutePrefix[1] + '/charts', (req, res) => {
      const sanitized = _.mapValues(chartProviders, (provider) => sanitizeProvider(provider));
      res.json(sanitized);
    });
  };

  // Resources API provider registration
  const registerAsProvider = () => {
    app.debug('** Registering as Resource Provider for `charts` **');
    try {
      app.registerResourceProvider({
        type: 'charts',
        methods: {
          listResources: (params) => {
            app.debug(`** listResources() ${params}`);
            return Promise.resolve(
              _.mapValues(chartProviders, (provider) => sanitizeProvider(provider, 2))
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
            throw new Error(`Not implemented!\n Cannot set ${id} to ${value}`);
          },
          deleteResource: (id) => {
            throw new Error(`Not implemented!\n Cannot delete ${id}`);
          }
        }
      });
    } catch (_error) {
      app.debug('Failed Provider Registration!');
    }
  };

  /**
   * Reload chart providers to pick up changes from disk
   * This ensures v1/v2 API endpoints serve current data
   */
  const refreshChartProviders = async () => {
    try {
      const chartPath = props.chartPath || defaultChartsPath;
      const charts = await findCharts(chartPath);

      // Filter out disabled charts
      chartProviders = _.pickBy(charts, (chart) => {
        const relativePath = path.relative(chartPath, chart._filePath || '');
        return isChartEnabled(relativePath);
      });

      app.debug(`Chart providers refreshed: ${_.keys(chartProviders).length} enabled charts`);
    } catch (error) {
      app.error(`Failed to refresh chart providers: ${error.message}`);
    }
  };

  /**
   * Start periodic checking for catalog chart updates.
   * Runs an initial check after 10s delay, then every 24 hours.
   */
  const startCatalogUpdateChecker = () => {
    const doCheck = async () => {
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
        app.debug(`Catalog update check failed: ${error.message}`);
      }
    };

    // Initial check after 10 second delay (don't block startup)
    setTimeout(doCheck, 10000);

    // Then check every 24 hours
    catalogUpdateInterval = setInterval(doCheck, 24 * 60 * 60 * 1000);
  };

  /**
   * Emit a Signal K notification delta when catalog chart updates are available
   */
  const emitCatalogUpdateNotification = (updates) => {
    try {
      const chartNames = updates.map((u) => u.title || u.chartNumber).join(', ');
      app.handleMessage('signalk-charts-provider-simple', {
        updates: [
          {
            values: [
              {
                path: 'notifications.plugins.signalk-charts-provider-simple.chartCatalogUpdate',
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
      app.error(`Failed to emit catalog update notification: ${error.message}`);
    }
  };

  /**
   * Emit delta notification for chart resource changes
   * Following SignalK Server's built-in resource provider pattern
   * @param {string} chartId - Chart identifier (relative path without extension)
   * @param {object|null} chartValue - Chart data object, or null for deletions
   */
  const emitChartDelta = (chartId, chartValue) => {
    try {
      app.handleMessage(
        'signalk-charts-provider-simple',
        {
          updates: [
            {
              values: [
                {
                  path: `resources.charts.${chartId}`,
                  value: chartValue
                }
              ]
            }
          ]
        },
        2 // Always use v2 for resource deltas - resources should not be in full model cache
      );
      app.debug(`Delta emitted for chart: ${chartId}, value: ${chartValue ? 'data' : 'null'}`);
    } catch (error) {
      app.error(`Failed to emit delta for chart ${chartId}: ${error.message}`);
    }
  };

  return plugin;
};

const responseHttpOptions = {
  headers: {
    'Cache-Control': 'public, max-age=7776000' // 90 days
  }
};

const pbfResponseHttpOptions = {
  headers: {
    'Cache-Control': 'public, max-age=7776000',
    'Content-Type': 'application/x-protobuf'
  }
};

// Empty PBF tile — a valid zero-byte protobuf message.
// Returned instead of 404 for S-57 grouped charts so Freeboard-SK
// renders transparent instead of black for missing tile areas.
const EMPTY_PBF = Buffer.alloc(0);

const sanitizeProvider = (provider, version = 1) => {
  let v;
  if (version === 1) {
    v = _.merge({}, provider.v1);
    v.tilemapUrl = v.tilemapUrl.replace('~tilePath~', chartTilesPath);
  } else if (version === 2) {
    v = _.merge({}, provider.v2);
    v.url = v.url ? v.url.replace('~tilePath~', chartTilesPath) : '';
  }
  provider = _.omit(provider, ['_filePath', '_fileFormat', '_mbtilesHandle', '_flipY', 'v1', 'v2']);
  return _.merge(provider, v);
};

const ensureDirectoryExists = (path) => {
  if (!fs.existsSync(path)) {
    fs.mkdirSync(path);
  }
};

const cleanupEmptyParents = (deletedPath, stopAt) => {
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
  } catch (_e) {
    // ignore
  }
};

const cleanupDir = (dirPath) => {
  try {
    if (fs.existsSync(dirPath)) {
      fs.rmSync(dirPath, { recursive: true, force: true });
    }
  } catch (_e) {
    // ignore cleanup errors
  }
};

const serveTileFromFilesystem = (res, provider, z, x, y) => {
  const { format, _flipY, _filePath } = provider;
  const flippedY = Math.pow(2, z) - 1 - y;
  const tileY = _flipY ? flippedY : y;
  const tilePath = `${z}/${x}/${tileY}.${format}`;
  const file = _filePath ? path.resolve(_filePath, tilePath) : '';
  const httpOptions = format === 'pbf' ? pbfResponseHttpOptions : responseHttpOptions;

  res.sendFile(file, httpOptions, (err) => {
    if (err && err.code === 'ENOENT') {
      // For S-57 grouped charts: tiles are in cell subdirectories, not at the group level.
      // Only serve from overview cells (listed in metadata._s57OverviewCells) to avoid
      // black rectangles from depth-only detail cells that lack land polygons.
      // Falls back to any cell if no overview cell list exists.
      if (_filePath && format === 'pbf') {
        try {
          let overviewCells = null;
          try {
            const meta = JSON.parse(
              fs.readFileSync(path.join(_filePath, 'metadata.json'), 'utf-8')
            );
            overviewCells = meta._s57OverviewCells || null;
          } catch (_metaErr) {
            // no metadata or parse error
          }

          const entries = fs.readdirSync(_filePath, { withFileTypes: true });
          const dirs = entries.filter((e) => e.isDirectory());

          // First pass: try overview cells only
          if (overviewCells) {
            for (const entry of dirs) {
              if (!overviewCells.includes(entry.name)) {
                continue;
              }
              const cellTile = path.join(_filePath, entry.name, tilePath);
              if (fs.existsSync(cellTile)) {
                return res.sendFile(cellTile, httpOptions, (err2) => {
                  if (err2) {
                    res.sendStatus(404);
                  }
                });
              }
            }
          }

          // Fallback: try any cell (for non-grouped or legacy charts)
          if (!overviewCells) {
            for (const entry of dirs) {
              const cellTile = path.join(_filePath, entry.name, tilePath);
              if (fs.existsSync(cellTile)) {
                return res.sendFile(cellTile, httpOptions, (err2) => {
                  if (err2) {
                    res.sendStatus(404);
                  }
                });
              }
            }
          }
        } catch (_e) {
          // fall through
        }
        // For PBF grouped charts, return empty tile instead of 404
        // so Freeboard-SK renders transparent instead of black
        res.writeHead(200, pbfResponseHttpOptions.headers);
        res.end(EMPTY_PBF);
        return;
      }
      res.sendStatus(404);
    } else if (err) {
      throw err;
    }
  });
};

const serveTileFromMbtiles = (res, provider, z, x, y) => {
  try {
    const result = provider._mbtilesHandle.getTile(z, x, y);

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
