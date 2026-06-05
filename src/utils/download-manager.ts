import https from 'https';
import http from 'http';
import fs from 'fs';
import path from 'path';
import unzipper from 'unzipper';
import { EventEmitter } from 'events';
import type { DownloadJob, DownloadJobOptions } from '../types.js';

// A download failure worth retrying: a network error, a timeout, or a 5xx
// server response. A 4xx (e.g. 404 for a moved/expired catalog link) is NOT
// transient — retrying just delays a legitimate error — so it stays a plain
// Error and fails fast.
export class TransientDownloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransientDownloadError';
  }
}

// Bounded retry for transient download failures. Three attempts total with a
// short linear backoff handles a flaky upstream (the chart sources are
// third-party government servers) without stalling on a genuinely-gone file.
const MAX_DOWNLOAD_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = 2000;

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

      await this.downloadWithRetry(job);

      job.status = 'completed';
      job.progress = 100;
      job.completedAt = Date.now();
      this.emit('job-completed', job);
    } catch (error) {
      job.status = 'failed';
      job.error = (error instanceof Error ? error.message : String(error)) || 'Download failed';
      job.completedAt = Date.now();

      this.cleanupPartialFiles(job);

      this.emit('job-failed', job);
      console.error(`Download job ${job.id} failed:`, error);
    }
  }

  private cleanupPartialFiles(job: DownloadJob): void {
    for (const fileName of job.targetFiles) {
      const filePath = path.join(job.targetDir, fileName);
      try {
        fs.unlinkSync(filePath);
        console.log(`[${job.id}] Cleaned up partial file: ${fileName}`);
      } catch {
        // file may not exist yet
      }
    }
  }

  // Run downloadAndExtract with bounded retries on TRANSIENT failures only
  // (network error, timeout, 5xx). A 4xx (e.g. 404 for an expired catalog
  // link) throws immediately. Between attempts, partial files are removed and
  // the URL is reset to the original (downloadAndExtract mutates job.url while
  // following redirects).
  private async downloadWithRetry(job: DownloadJob): Promise<void> {
    const originalUrl = job.originalUrl ?? job.url;
    for (let attempt = 1; attempt <= MAX_DOWNLOAD_ATTEMPTS; attempt++) {
      try {
        await this.downloadAndExtract(job);
        return;
      } catch (error) {
        const transient = error instanceof TransientDownloadError;
        if (!transient || attempt === MAX_DOWNLOAD_ATTEMPTS) {
          throw error;
        }
        const msg = error instanceof Error ? error.message : String(error);
        console.warn(
          `[${job.id}] Transient download failure (attempt ${attempt}/${MAX_DOWNLOAD_ATTEMPTS}): ${msg}; retrying...`
        );
        this.cleanupPartialFiles(job);
        job.url = originalUrl;
        job.downloadedBytes = 0;
        job.progress = 0;
        // downloadAndExtract pushes onto these as files/zip-entries arrive, so
        // clear them (after cleanupPartialFiles has used targetFiles) — else a
        // retry of a partially-streamed download accumulates duplicate names.
        job.targetFiles = [];
        job.extractedFiles = [];
        await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS * attempt));
      }
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
            const status = response.statusCode ?? 0;
            response.resume(); // drain so the socket can be reused/freed
            // 5xx = server-side hiccup, worth a retry; 4xx (incl. 404 for a
            // moved/expired catalog link) is permanent — fail fast.
            const msg = `HTTP ${status}`;
            reject(status >= 500 ? new TransientDownloadError(msg) : new Error(msg));
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
                  job.status = 'extracting';
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

            // Strip any directory component before joining, the same way
            // the ZIP branch above does. The route handlers already reject
            // unsafe chartName/chartNumber with a 400, so this only fires
            // for any future non-route caller — but it keeps the write
            // inside targetDir regardless. Reuse the basenamed value for
            // targetFiles so the cancel/cleanup unlink paths reference the
            // file that was actually written.
            const safeFileName = path.basename(fileName);
            const targetPath = path.join(job.targetDir, safeFileName);

            job.targetFiles.push(safeFileName);
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

            response.on('error', () => {
              fileStream.destroy();
            });

            response.on('aborted', () => {
              fileStream.destroy();
            });
          }
        })
        .on('error', (error: Error) => {
          console.error(`[${job.id}] Download error:`, error);
          // Connection reset / DNS / socket errors are transient — retry.
          reject(new TransientDownloadError(error.message));
        });

      req.on('timeout', () => {
        req.destroy();
        reject(new TransientDownloadError('Server not responding (no data received for 60s)'));
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
