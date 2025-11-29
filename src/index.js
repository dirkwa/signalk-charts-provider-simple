const path = require('path');
const fs = require('fs');
const _ = require('lodash');
const { findCharts } = require('./charts-loader');
const { scanChartsRecursively, scanAllFolders } = require('./utils/file-scanner');
const { initChartState, isChartEnabled, setChartEnabled } = require('./utils/chart-state');
const { downloadManager } = require('./utils/download-manager');

const chartTilesPath = '/signalk/chart-tiles';
const apiRoutePrefix = {
  1: '/signalk/v1/api/resources',
  2: '/signalk/v2/api/resources'
};

module.exports = (app) => {
  let chartProviders = {};
  let pluginStarted = false;
  let props = {
    chartPath: ''
  };

  let urlBase = '';
  const configBasePath = app.config.configPath;
  const defaultChartsPath = path.join(configBasePath, '/charts-simple');
  const serverMajorVersion = app.config.version
    ? parseInt(app.config.version.split('.')[0])
    : '1';
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
    id: 'signalk-charts-provider-simple',
    name: 'Charts Provider Simple',
    schema: () => CONFIG_SCHEMA,
    uiSchema: () => CONFIG_UISCHEMA,
    start: (settings) => {
      return doStartup(settings); // return required for tests
    },
    stop: () => {
      app.setPluginStatus('stopped');
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

    // Listen for download completion events and emit delta notifications
    downloadManager.removeAllListeners('job-completed'); // Remove old listeners on restart
    downloadManager.on('job-completed', async (job) => {
      app.debug(`Download job completed: ${job.id}, extracted files: ${job.extractedFiles.join(', ')}`);

      // Reload chart providers to include downloaded charts
      await refreshChartProviders();

      // Emit delta for each extracted chart
      for (const fileName of job.extractedFiles) {
        const chartId = fileName.replace(/\.mbtiles$/, '');

        // If chart is enabled and in chartProviders, emit its data
        if (chartProviders[chartId]) {
          const chartData = sanitizeProvider(chartProviders[chartId], serverMajorVersion);
          emitChartDelta(chartId, chartData);
          app.debug(`Delta emitted for downloaded chart: ${chartId}`);
        }
      }
    });

    app.debug(`Start chart provider. Chart path: ${chartPath}`);

    // Do not register routes if plugin has been started once already
    pluginStarted === false && registerRoutes();
    pluginStarted = true;

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

  const registerRoutes = () => {
    app.debug('** Registering API paths **');

    app.get(
      `${chartTilesPath}/:identifier/:z([0-9]*)/:x([0-9]*)/:y([0-9]*)`,
      async (req, res) => {
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
            console.log(
              `Unknown chart provider fileformat ${provider._fileFormat}`
            );
            res.status(500).send();
        }
      }
    );


    // Download from URL - create download job
    app.post(`${chartTilesPath}/download-chart-locker`, async (req, res) => {
      const busboy = require('busboy');
      const bb = busboy({ headers: req.headers });

      let downloadUrl = '';
      let targetFolder = '';
      let chartName = '';

      bb.on('field', (name, value) => {
        if (name === 'url') downloadUrl = value;
        if (name === 'targetFolder') targetFolder = value;
        if (name === 'chartName') chartName = value;
      });

      bb.on('finish', async () => {
        try {
          console.log(`Creating download job for: ${downloadUrl}`);
          console.log(`Target folder: ${targetFolder}`);

          // Determine target directory
          const targetDir = targetFolder === '/'
            ? props.chartPath
            : path.join(props.chartPath, targetFolder);

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
    app.get(`${chartTilesPath}/download-job/:jobId`, (req, res) => {
      const jobId = req.params.jobId;
      const job = downloadManager.getJob(jobId);

      if (!job) {
        return res.status(404).json({ error: 'Job not found' });
      }

      res.json(job);
    });

    // Get all download jobs
    app.get(`${chartTilesPath}/download-jobs`, (req, res) => {
      const jobs = downloadManager.getAllJobs();
      res.json(jobs);
    });

    // Cancel a download job
    app.post(`${chartTilesPath}/cancel-download/:jobId`, (req, res) => {
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

    app.get(`${chartTilesPath}/download`, (req, res) => {
      const url = req.query.url;
      if (!url) {
        return res.status(400).send('url parameter is required');
      }

      const https = require('https');
      https.get(url, (response) => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
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
            if (matches != null && matches[1]) {
                filename = matches[1].replace(/['"]/g, '');
            }
        }
        res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
        res.setHeader('Content-Type', response.headers['content-type']);
        response.pipe(res);
      }).on('error', (err) => {
        console.error(`Error downloading file from ${url}`, err);
        res.status(500).send('Error downloading file');
      });
    });

    app.get(`${chartTilesPath}/local-charts`, async (req, res) => {
      try {
        const chartPath = props.chartPath || defaultChartsPath;
        const charts = await scanChartsRecursively(chartPath);

        // Scan all folders (including empty ones)
        const allFolders = await scanAllFolders(chartPath);

        const foldersSet = new Set();

        // Always include root folder
        foldersSet.add('/');

        // Add folders from charts
        charts.forEach(chart => {
          foldersSet.add(chart.folder);
        });

        // Add all scanned folders (these are actual subdirectories)
        allFolders.forEach(folder => foldersSet.add(folder));

        // Convert to array and sort (root first, then alphabetically)
        const folders = Array.from(foldersSet).sort((a, b) => {
          if (a === '/') return -1;
          if (b === '/') return 1;
          return a.localeCompare(b);
        });

        // Get active download jobs to mark charts being downloaded
        const activeJobs = downloadManager.getActiveJobs();
        const downloadingFiles = new Set();

        activeJobs.forEach(job => {
          if (job.status === 'downloading' || job.status === 'extracting') {
            // Add all target files (these are added as soon as writing starts)
            if (job.targetFiles && job.targetFiles.length > 0) {
              job.targetFiles.forEach(file => downloadingFiles.add(file));
            }
          }
        });

        // Apply enabled state and downloading status from chart-state and download manager
        const chartsWithState = charts.map(chart => ({
          ...chart,
          enabled: isChartEnabled(chart.relativePath),
          downloading: downloadingFiles.has(chart.name)
        }));

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

    app.delete(`${chartTilesPath}/local-charts/:chartPath`, async (req, res) => {
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
        activeJobs.forEach(job => {
          app.debug(`Cancelling download job ${job.id} for file: ${fileName}`);
          downloadManager.cancelJob(job.id);
        });

        if (fs.existsSync(fullPath)) {
          await fs.promises.unlink(fullPath);

          // Reload chart providers and emit delta
          await refreshChartProviders();
          const chartId = path.basename(chartPathParam).replace(/\.mbtiles$/, '');
          emitChartDelta(chartId, null);

          res.status(200).send('Chart deleted successfully');
        } else {
          // File might not exist yet if it was being downloaded
          // Still emit delta in case it was previously registered
          await refreshChartProviders();
          const chartId = path.basename(chartPathParam).replace(/\.mbtiles$/, '');
          emitChartDelta(chartId, null);

          res.status(200).send('Chart deletion processed');
        }
      } catch (error) {
        console.error(`Error deleting chart:`, error);
        res.status(500).send('Error deleting chart');
      }
    });

    // Create folder endpoint
    app.post(`${chartTilesPath}/folders`, async (req, res) => {
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
    app.delete(`${chartTilesPath}/folders/:folderPath`, async (req, res) => {
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
    app.post(`${chartTilesPath}/charts/:chartPath/toggle`, async (req, res) => {
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

        // Emit delta notification for toggle operation
        if (enabled) {
          // Chart was enabled - emit full chart data
          if (chartProviders[chartPathParam.replace(/\.mbtiles$/, '')]) {
            const chart = chartProviders[chartPathParam.replace(/\.mbtiles$/, '')];
            const chartData = sanitizeProvider(chart, serverMajorVersion);
            emitChartDelta(chart.identifier, chartData);
          }
        } else {
          // Chart was disabled - emit null to remove from stream
          // Use the filename (without extension) as identifier
          const chartId = path.basename(chartPathParam).replace(/\.mbtiles$/, '');
          emitChartDelta(chartId, null);
        }

        res.status(200).json({ success: true, message: `Chart ${enabled ? 'enabled' : 'disabled'}` });
      } catch (error) {
        console.error('Error toggling chart state:', error);
        res.status(500).send('Error toggling chart state');
      }
    });

    // Move chart to different folder
    app.post(`${chartTilesPath}/move-chart`, async (req, res) => {
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

        if (!normalizedSource.startsWith(normalizedBase) || !normalizedTarget.startsWith(normalizedBase)) {
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
          const chartData = sanitizeProvider(chartProviders[chartId], serverMajorVersion);
          emitChartDelta(chartId, chartData);
        }

        res.status(200).json({ success: true, message: 'Chart moved successfully' });
      } catch (error) {
        app.error('Error moving chart: ' + error.message);
        res.status(500).send('Error moving chart: ' + error.message);
      }
    });

    // Rename chart
    app.post(`${chartTilesPath}/rename-chart`, async (req, res) => {
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
      if (nameWithoutExt.includes('..') || nameWithoutExt.includes('/') || nameWithoutExt.includes('\\')) {
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

        if (!normalizedSource.startsWith(normalizedBase) || !normalizedTarget.startsWith(normalizedBase)) {
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
          const chartData = sanitizeProvider(chartProviders[newChartId], serverMajorVersion);
          emitChartDelta(newChartId, chartData);
        }

        res.status(200).json({ success: true, message: 'Chart renamed successfully' });
      } catch (error) {
        app.error('Error renaming chart: ' + error.message);
        res.status(500).send('Error renaming chart: ' + error.message);
      }
    });

    // Get chart metadata (MBTiles only)
    app.get(`${chartTilesPath}/chart-metadata/:chartPath`, async (req, res) => {
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
        const sqlite3 = require('sqlite3').verbose();
        const db = new sqlite3.Database(fullPath, sqlite3.OPEN_READONLY, (err) => {
          if (err) {
            console.error('Error opening database:', err);
            return res.status(500).send('Error reading chart metadata');
          }
        });

        db.all('SELECT name, value FROM metadata', [], (err, rows) => {
          if (err) {
            db.close();
            console.error('Error querying metadata:', err);
            return res.status(500).send('Error reading chart metadata');
          }

          // Convert rows to object
          const metadata = {};
          rows.forEach(row => {
            metadata[row.name] = row.value;
          });

          // Try to get tile count - different MBTiles files use different table names
          // Try 'map' first (standard), then 'tiles' (alternative)
          db.get('SELECT COUNT(*) as count FROM map', [], (err, countRow) => {
            if (err) {
              // Try alternative table name
              db.get('SELECT COUNT(*) as count FROM tiles', [], (err2, countRow2) => {
                db.close();

                if (!err2 && countRow2) {
                  metadata.tileCount = countRow2.count;
                }
                // If both fail, silently omit tile count - some MBTiles formats don't have this
                return res.json(metadata);
              });
            } else {
              db.close();
              metadata.tileCount = countRow.count;
              res.json(metadata);
            }
          });
        });

      } catch (error) {
        console.error('Error fetching chart metadata:', error);
        res.status(500).send('Error fetching chart metadata');
      }
    });

    // Upload chart file
    app.post(`${chartTilesPath}/upload`, async (req, res) => {
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
              // Reload chart providers to include new uploads
              await refreshChartProviders();

              // Emit delta notifications for uploaded charts
              for (const filename of uploadedFiles) {
                const chartId = filename.replace(/\.mbtiles$/, '');

                // If chart is enabled and in chartProviders, emit its data
                if (chartProviders[chartId]) {
                  const chartData = sanitizeProvider(chartProviders[chartId], serverMajorVersion);
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

    app.debug('** Registering v1 API paths **');

    app.get(
      apiRoutePrefix[1] + '/charts/:identifier',
      (req, res) => {
        const { identifier } = req.params;
        const provider = chartProviders[identifier];
        if (provider) {
          return res.json(sanitizeProvider(provider));
        } else {
          return res.status(404).send('Not found');
        }
      }
    );

    app.get(apiRoutePrefix[1] + '/charts', (req, res) => {
      const sanitized = _.mapValues(chartProviders, (provider) =>
        sanitizeProvider(provider)
      );
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
              _.mapValues(chartProviders, (provider) =>
                sanitizeProvider(provider, 2)
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
            throw new Error(`Not implemented!\n Cannot set ${id} to ${value}`);
          },
          deleteResource: (id) => {
            throw new Error(`Not implemented!\n Cannot delete ${id}`);
          }
        }
      });
    } catch (error) {
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
          updates: [{
            values: [{
              path: `resources.charts.${chartId}`,
              value: chartValue
            }]
          }]
        },
        serverMajorVersion
      );
      app.debug(`Delta emitted for chart: ${chartId}`);
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


const sanitizeProvider = (provider, version = 1) => {
  let v;
  if (version === 1) {
    v = _.merge({}, provider.v1);
    v.tilemapUrl = v.tilemapUrl.replace('~tilePath~', chartTilesPath);
  } else if (version === 2) {
    v = _.merge({}, provider.v2);
    v.url = v.url ? v.url.replace('~tilePath~', chartTilesPath) : '';
  }
  provider = _.omit(provider, [
    '_filePath',
    '_fileFormat',
    '_mbtilesHandle',
    '_flipY',
    'v1',
    'v2'
  ]);
  return _.merge(provider, v);
};

const ensureDirectoryExists = (path) => {
  if (!fs.existsSync(path)) {
    fs.mkdirSync(path);
  }
};

const serveTileFromFilesystem = (
  res,
  provider,
  z,
  x,
  y
) => {
  const { format, _flipY, _filePath } = provider;
  const flippedY = Math.pow(2, z) - 1 - y;
  const file = _filePath
    ? path.resolve(_filePath, `${z}/${x}/${_flipY ? flippedY : y}.${format}`)
    : '';
  res.sendFile(file, responseHttpOptions, (err) => {
    if (err && err.code === 'ENOENT') {
      res.sendStatus(404);
    } else if (err) {
      throw err;
    }
  });
};

const serveTileFromMbtiles = (
  res,
  provider,
  z,
  x,
  y
) => {
  provider._mbtilesHandle.getTile(
    z,
    x,
    y,
    (err, tile, headers) => {
      if (err && err.message && err.message === 'Tile does not exist') {
        res.sendStatus(404);
      } else if (err) {
        console.error(
          `Error fetching tile ${provider.identifier}/${z}/${x}/${y}:`,
          err
        );
        res.sendStatus(500);
      } else {
        headers['Cache-Control'] = responseHttpOptions.headers['Cache-Control'];
        res.writeHead(200, headers);
        res.end(tile);
      }
    }
  );
};
