const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const unzipper = require('unzipper');
const { EventEmitter } = require('events');

class DownloadManager extends EventEmitter {
  constructor() {
    super();
    this.jobs = new Map();
    this.activeDownloads = 0;
    this.maxConcurrent = 3;
  }

  createJob(url, targetDir, chartName) {
    const id = `dl_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    const job = {
      id,
      url,
      targetDir,
      chartName,
      status: 'queued',
      progress: 0,
      downloadedBytes: 0,
      totalBytes: 0,
      extractedFiles: [],
      targetFiles: [], // Files being written (added as soon as write starts)
      createdAt: Date.now()
    };

    this.jobs.set(id, job);
    this.emit('job-created', job);

    // Start processing if under concurrent limit
    this.processQueue();

    return id;
  }

  getJob(id) {
    return this.jobs.get(id);
  }

  getAllJobs() {
    return Array.from(this.jobs.values()).sort((a, b) => b.createdAt - a.createdAt);
  }

  getActiveJobs() {
    return this.getAllJobs().filter(job =>
      job.status === 'queued' || job.status === 'downloading' || job.status === 'extracting'
    );
  }

  async processQueue() {
    if (this.activeDownloads >= this.maxConcurrent) {
      return;
    }

    // Find next queued job
    const queuedJob = Array.from(this.jobs.values()).find(job => job.status === 'queued');
    if (!queuedJob) {
      return;
    }

    this.activeDownloads++;
    await this.processJob(queuedJob);
    this.activeDownloads--;

    // Process next job
    this.processQueue();
  }

  async processJob(job) {
    try {
      job.status = 'downloading';
      job.startedAt = Date.now();
      this.emit('job-updated', job);

      await this.downloadAndExtract(job);

      job.status = 'completed';
      job.progress = 100;
      job.completedAt = Date.now();
      this.emit('job-completed', job);
    } catch (error) {
      job.status = 'failed';
      job.error = error.message || 'Download failed';
      job.completedAt = Date.now();
      this.emit('job-failed', job);
      console.error(`Download job ${job.id} failed:`, error);
    }
  }

  async downloadAndExtract(job) {
    return new Promise((resolve, reject) => {
      const protocol = job.url.startsWith('https') ? https : http;

      console.log(`[${job.id}] Starting download from: ${job.url}`);

      protocol.get(job.url, (response) => {
        // Follow redirects
        if (response.statusCode === 301 || response.statusCode === 302) {
          const redirectUrl = response.headers.location;
          if (redirectUrl) {
            console.log(`[${job.id}] Following redirect to: ${redirectUrl}`);
            job.url = redirectUrl;
            this.downloadAndExtract(job).then(resolve).catch(reject);
            return;
          }
        }

        if (response.statusCode !== 200) {
          reject(new Error(`HTTP ${response.statusCode}`));
          return;
        }

        const contentLength = parseInt(response.headers['content-length'] || '0');
        job.totalBytes = contentLength;

        const contentType = response.headers['content-type'] || '';
        console.log(`[${job.id}] Content-Type: ${contentType}, Size: ${contentLength} bytes`);

        let downloadedBytes = 0;

        // Track download progress
        response.on('data', (chunk) => {
          downloadedBytes += chunk.length;
          job.downloadedBytes = downloadedBytes;

          if (contentLength > 0) {
            job.progress = Math.min(90, Math.floor((downloadedBytes / contentLength) * 90)); // Reserve 90-100 for extraction
          }

          this.emit('job-updated', job);
        });

        // Check if it's a zip file
        if (contentType.includes('zip') || job.url.endsWith('.zip')) {
          console.log(`[${job.id}] Processing as ZIP file...`);
          job.status = 'extracting';
          this.emit('job-updated', job);

          const extractionPromises = [];

          response.pipe(unzipper.Parse())
            .on('entry', (entry) => {
              const fileName = entry.path;
              const type = entry.type;

              if (type === 'File' && fileName.endsWith('.mbtiles')) {
                const targetPath = path.join(job.targetDir, path.basename(fileName));
                const targetFileName = path.basename(fileName);
                console.log(`[${job.id}] Extracting: ${fileName} to ${targetPath}`);

                // Add to targetFiles immediately (before extraction completes)
                job.targetFiles.push(targetFileName);
                this.emit('job-updated', job);

                // Create a promise for this extraction
                const extractPromise = new Promise((resolveExtract, rejectExtract) => {
                  const writeStream = fs.createWriteStream(targetPath);

                  writeStream
                    .on('close', () => {
                      console.log(`[${job.id}] Extracted: ${fileName}`);
                      job.extractedFiles.push(path.basename(fileName));
                      resolveExtract();
                    })
                    .on('error', (err) => {
                      console.error(`[${job.id}] Error writing ${fileName}:`, err);
                      rejectExtract(err);
                    });

                  entry.pipe(writeStream);
                });

                extractionPromises.push(extractPromise);
              } else {
                entry.autodrain();
              }
            })
            .on('finish', async () => {
              // Wait for all file writes to complete
              try {
                await Promise.all(extractionPromises);
                console.log(`[${job.id}] Extraction complete. Files: ${job.extractedFiles.join(', ')}`);

                if (job.extractedFiles.length === 0) {
                  reject(new Error('No .mbtiles files found in archive'));
                } else {
                  job.progress = 100;
                  resolve();
                }
              } catch (error) {
                console.error(`[${job.id}] Error during extraction:`, error);
                reject(error);
              }
            })
            .on('error', (error) => {
              console.error(`[${job.id}] Extraction error:`, error);
              reject(error);
            });
        } else {
          // Direct .mbtiles file
          console.log(`[${job.id}] Processing as direct .mbtiles file...`);

          // Use custom chart name if provided, otherwise use filename from URL
          let fileName;
          if (job.chartName && job.chartName.trim()) {
            fileName = job.chartName.trim();
            // Ensure .mbtiles extension
            if (!fileName.endsWith('.mbtiles')) {
              fileName += '.mbtiles';
            }
          } else {
            fileName = path.basename(job.url).split('?')[0];
            if (!fileName.endsWith('.mbtiles')) {
              fileName += '.mbtiles';
            }
          }

          const targetPath = path.join(job.targetDir, fileName);

          // Add to targetFiles immediately (before download completes)
          job.targetFiles.push(fileName);
          this.emit('job-updated', job);

          const fileStream = fs.createWriteStream(targetPath);
          response.pipe(fileStream);

          fileStream.on('finish', () => {
            fileStream.close();
            console.log(`[${job.id}] Downloaded: ${fileName}`);
            job.extractedFiles.push(path.basename(targetPath));
            job.progress = 100;
            resolve();
          });

          fileStream.on('error', (error) => {
            fs.unlink(targetPath, () => {});
            reject(error);
          });
        }
      }).on('error', (error) => {
        console.error(`[${job.id}] Download error:`, error);
        reject(error);
      });
    });
  }

  // Find jobs downloading a specific file
  findJobsByTargetFile(fileName) {
    const jobs = [];
    for (const job of this.jobs.values()) {
      if (job.status === 'downloading' || job.status === 'extracting' || job.status === 'queued') {
        if (job.targetFiles && job.targetFiles.includes(fileName)) {
          jobs.push(job);
        }
      }
    }
    return jobs;
  }

  // Cancel a job and clean up any partial files
  cancelJob(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) {
      return { success: false, error: 'Job not found' };
    }

    if (job.status === 'completed') {
      return { success: false, error: 'Job already completed' };
    }

    // Mark job as failed/cancelled
    job.status = 'failed';
    job.error = 'Cancelled by user';
    job.completedAt = Date.now();

    // Clean up any target files that were being written
    if (job.targetFiles && job.targetFiles.length > 0) {
      job.targetFiles.forEach(fileName => {
        const filePath = path.join(job.targetDir, fileName);
        fs.unlink(filePath, (err) => {
          if (err && err.code !== 'ENOENT') {
            console.error(`Error deleting cancelled file ${filePath}:`, err);
          } else {
            console.log(`[${job.id}] Deleted cancelled file: ${fileName}`);
          }
        });
      });
    }

    this.emit('job-cancelled', job);
    console.log(`[${job.id}] Job cancelled by user`);

    return { success: true };
  }

  // Clean up old completed/failed jobs (older than 1 hour)
  cleanup() {
    const oneHourAgo = Date.now() - (60 * 60 * 1000);

    for (const [id, job] of this.jobs.entries()) {
      if ((job.status === 'completed' || job.status === 'failed') &&
          job.completedAt && job.completedAt < oneHourAgo) {
        this.jobs.delete(id);
        console.log(`Cleaned up old download job: ${id}`);
      }
    }
  }
}

// Singleton instance
const downloadManager = new DownloadManager();

// Clean up old jobs every 10 minutes
setInterval(() => {
  downloadManager.cleanup();
}, 10 * 60 * 1000);

module.exports = {
  downloadManager
};
