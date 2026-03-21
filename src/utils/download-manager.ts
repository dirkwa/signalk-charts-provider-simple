import https from 'https';
import http from 'http';
import fs from 'fs';
import path from 'path';
import unzipper from 'unzipper';
import { EventEmitter } from 'events';
import type { DownloadJob, DownloadJobOptions, DownloadJobStatus } from '../types';

interface DownloadManagerEvents {
  'job-created': [job: DownloadJob];
  'job-updated': [job: DownloadJob];
  'job-completed': [job: DownloadJob];
  'job-failed': [job: DownloadJob];
  'job-cancelled': [job: DownloadJob];
}

class DownloadManager extends EventEmitter {
  private jobs: Map<string, DownloadJob>;
  private activeDownloads: number;
  private maxConcurrent: number;

  constructor() {
    super();
    this.jobs = new Map();
    this.activeDownloads = 0;
    this.maxConcurrent = 3;
  }

  override emit<K extends keyof DownloadManagerEvents>(
    event: K,
    ...args: DownloadManagerEvents[K]
  ): boolean {
    return super.emit(event, ...args);
  }

  override on<K extends keyof DownloadManagerEvents>(
    event: K,
    listener: (...args: DownloadManagerEvents[K]) => void
  ): this {
    return super.on(event, listener);
  }

  override removeListener<K extends keyof DownloadManagerEvents>(
    event: K,
    listener: (...args: DownloadManagerEvents[K]) => void
  ): this {
    return super.removeListener(event, listener);
  }

  createJob(
    url: string,
    targetDir: string,
    chartName: string,
    options: DownloadJobOptions = {}
  ): string {
    const id = `dl_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;

    const job: DownloadJob = {
      id,
      url,
      targetDir,
      chartName,
      saveRaw: options.saveRaw ?? false,
      status: 'queued',
      progress: 0,
      downloadedBytes: 0,
      totalBytes: 0,
      extractedFiles: [],
      targetFiles: [],
      createdAt: Date.now()
    };

    this.jobs.set(id, job);
    this.emit('job-created', job);

    void this.processQueue();

    return id;
  }

  getJob(id: string): DownloadJob | undefined {
    return this.jobs.get(id);
  }

  getAllJobs(): DownloadJob[] {
    return Array.from(this.jobs.values()).sort((a, b) => b.createdAt - a.createdAt);
  }

  getActiveJobs(): DownloadJob[] {
    return this.getAllJobs().filter(
      (job) =>
        job.status === 'queued' || job.status === 'downloading' || job.status === 'extracting'
    );
  }

  private async processQueue(): Promise<void> {
    if (this.activeDownloads >= this.maxConcurrent) {
      return;
    }

    const queuedJob = Array.from(this.jobs.values()).find((job) => job.status === 'queued');
    if (!queuedJob) {
      return;
    }

    this.activeDownloads++;
    await this.processJob(queuedJob);
    this.activeDownloads--;

    void this.processQueue();
  }

  private async processJob(job: DownloadJob): Promise<void> {
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
      job.error = (error instanceof Error ? error.message : String(error)) || 'Download failed';
      job.completedAt = Date.now();
      this.emit('job-failed', job);
      console.error(`Download job ${job.id} failed:`, error);
    }
  }

  private async downloadAndExtract(job: DownloadJob): Promise<void> {
    if (!job.originalUrl) {
      job.originalUrl = job.url;
    }

    return new Promise<void>((resolve, reject) => {
      const protocol = job.url.startsWith('https') ? https : http;

      console.log(`[${job.id}] Starting download from: ${job.url}`);

      const req = protocol
        .get(job.url, { timeout: 60000 }, (response) => {
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

          const contentLength = parseInt(response.headers['content-length'] ?? '0');
          job.totalBytes = contentLength;

          const contentType = response.headers['content-type'] ?? '';
          console.log(`[${job.id}] Content-Type: ${contentType}, Size: ${contentLength} bytes`);

          let downloadedBytes = 0;

          const isZip =
            !job.saveRaw &&
            (contentType.includes('zip') || (job.originalUrl ?? job.url).endsWith('.zip'));

          response.on('data', (chunk: Buffer) => {
            downloadedBytes += chunk.length;
            job.downloadedBytes = downloadedBytes;

            if (contentLength > 0) {
              if (isZip) {
                job.progress = Math.min(90, Math.floor((downloadedBytes / contentLength) * 90));
                if (job.progress >= 90 && job.status === 'downloading') {
                  job.status = 'extracting' as DownloadJobStatus;
                }
              } else {
                job.progress = Math.floor((downloadedBytes / contentLength) * 100);
              }
            }

            this.emit('job-updated', job);
          });

          if (isZip) {
            console.log(`[${job.id}] Processing as ZIP file...`);

            const extractionPromises: Promise<void>[] = [];

            response
              .pipe(unzipper.Parse())
              .on('entry', (entry: unzipper.Entry) => {
                const fileName = entry.path;
                const type = entry.type;

                if (type === 'File' && fileName.endsWith('.mbtiles')) {
                  const targetPath = path.join(job.targetDir, path.basename(fileName));
                  const targetFileName = path.basename(fileName);
                  console.log(`[${job.id}] Extracting: ${fileName} to ${targetPath}`);

                  job.targetFiles.push(targetFileName);
                  this.emit('job-updated', job);

                  const extractPromise = new Promise<void>((resolveExtract, rejectExtract) => {
                    const writeStream = fs.createWriteStream(targetPath);

                    writeStream
                      .on('close', () => {
                        console.log(`[${job.id}] Extracted: ${fileName}`);
                        job.extractedFiles.push(path.basename(fileName));
                        resolveExtract();
                      })
                      .on('error', (err: Error) => {
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
              .on('finish', () => {
                void (async () => {
                  try {
                    await Promise.all(extractionPromises);
                    console.log(
                      `[${job.id}] Extraction complete. Files: ${job.extractedFiles.join(', ')}`
                    );

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
                })();
              })
              .on('error', (error: Error) => {
                console.error(`[${job.id}] Extraction error:`, error);
                reject(error);
              });
          } else {
            console.log(
              `[${job.id}] Processing as direct file (saveRaw: ${String(job.saveRaw)})...`
            );

            let fileName: string;
            if (job.saveRaw) {
              fileName = path.basename(job.originalUrl ?? job.url).split('?')[0];
              if (job.chartName && job.chartName.trim()) {
                const ext = path.extname(fileName) || '.zip';
                fileName = job.chartName.trim() + ext;
              }
            } else if (job.chartName && job.chartName.trim()) {
              fileName = job.chartName.trim();
              if (!fileName.endsWith('.mbtiles')) {
                fileName += '.mbtiles';
              }
            } else {
              fileName = path.basename(job.originalUrl ?? job.url).split('?')[0];
              if (!fileName.endsWith('.mbtiles')) {
                fileName += '.mbtiles';
              }
            }

            const targetPath = path.join(job.targetDir, fileName);

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

            fileStream.on('error', (error: Error) => {
              fs.unlink(targetPath, () => {});
              reject(error);
            });
          }
        })
        .on('error', (error: Error) => {
          console.error(`[${job.id}] Download error:`, error);
          reject(error);
        });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Server not responding (no data received for 60s)'));
      });
    });
  }

  findJobsByTargetFile(fileName: string): DownloadJob[] {
    const result: DownloadJob[] = [];
    for (const job of this.jobs.values()) {
      if (job.status === 'downloading' || job.status === 'extracting' || job.status === 'queued') {
        if (job.targetFiles && job.targetFiles.includes(fileName)) {
          result.push(job);
        }
      }
    }
    return result;
  }

  cancelJob(jobId: string): { success: boolean; error?: string } {
    const job = this.jobs.get(jobId);
    if (!job) {
      return { success: false, error: 'Job not found' };
    }

    if (job.status === 'completed') {
      return { success: false, error: 'Job already completed' };
    }

    job.status = 'failed';
    job.error = 'Cancelled by user';
    job.completedAt = Date.now();

    if (job.targetFiles && job.targetFiles.length > 0) {
      job.targetFiles.forEach((fn) => {
        const filePath = path.join(job.targetDir, fn);
        fs.unlink(filePath, (err) => {
          if (err && err.code !== 'ENOENT') {
            console.error(`Error deleting cancelled file ${filePath}:`, err);
          } else {
            console.log(`[${job.id}] Deleted cancelled file: ${fn}`);
          }
        });
      });
    }

    this.emit('job-cancelled', job);
    console.log(`[${job.id}] Job cancelled by user`);

    return { success: true };
  }

  cleanup(): void {
    const oneHourAgo = Date.now() - 60 * 60 * 1000;

    for (const [id, job] of this.jobs.entries()) {
      if (
        (job.status === 'completed' || job.status === 'failed') &&
        job.completedAt &&
        job.completedAt < oneHourAgo
      ) {
        this.jobs.delete(id);
        console.log(`Cleaned up old download job: ${id}`);
      }
    }
  }
}

export const downloadManager = new DownloadManager();

setInterval(
  () => {
    downloadManager.cleanup();
  },
  10 * 60 * 1000
);
