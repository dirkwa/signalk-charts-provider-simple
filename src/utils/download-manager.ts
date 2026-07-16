import https from 'https';
import http from 'http';
import fs from 'fs';
import path from 'path';
import unzipper from 'unzipper';
import { EventEmitter } from 'events';
import { pipeline } from 'stream/promises';
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

// Bounded retry for transient download failures. Three consecutive attempts
// WITHOUT forward progress with a short linear backoff handles a flaky
// upstream without stalling on a genuinely-gone file; an attempt that did
// advance the .part file rearms the budget, so a throttled multi-GB source
// (mediafire stalls mid-transfer, NOAA rate-caps) can be resumed through
// any number of interruptions as long as bytes keep arriving.
const MAX_DOWNLOAD_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = 2000;

// Redirect ceiling per attempt — guards against a redirect loop from a
// misbehaving chart source.
const MAX_REDIRECTS = 10;

// "bytes 100-999/3657588990" or "bytes */3657588990" → 3657588990.
function parseContentRangeTotal(header: string | undefined): number | null {
  if (!header) {
    return null;
  }
  const m = /\/(\d+)\s*$/.exec(header);
  return m ? parseInt(m[1], 10) : null;
}

// "bytes 100-999/3657588990" → 100. Null for "bytes */N" and malformed.
function parseContentRangeStart(header: string | undefined): number | null {
  if (!header) {
    return null;
  }
  const m = /^bytes (\d+)-/.exec(header);
  return m ? parseInt(m[1], 10) : null;
}

// Does the URL's *path* end in .zip? Query strings (chart.zip?token=...)
// and unparseable strings are handled; used only as a claim about what
// the source intended to serve — the magic-byte check on the body is the
// authority for how to process it.
function urlPathLooksLikeZip(url: string | undefined): boolean {
  if (!url) {
    return false;
  }
  try {
    return new URL(url).pathname.toLowerCase().endsWith('.zip');
  } catch {
    return (url.split('?')[0] ?? '').toLowerCase().endsWith('.zip');
  }
}

// ZIP magic: local file header PK\x03\x04 (or the empty-archive marker
// PK\x05\x06). Extension and Content-Type lie often enough (tokenized
// download URLs, mislabeled servers) that the file itself is the authority.
function isZipMagic(filePath: string): boolean {
  let fd: number;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch {
    return false;
  }
  try {
    const buf = Buffer.alloc(4);
    const n = fs.readSync(fd, buf, 0, 4, 0);
    return n === 4 && buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 0x03 || buf[2] === 0x05);
  } finally {
    fs.closeSync(fd);
  }
}

// Per-download state shared across resume attempts: the Content-Type of
// the response the .part file was written from (finalizeDownload's
// zip-claim check) and the source's ETag/Last-Modified for If-Range.
interface DownloadState {
  contentType: string;
  validator: string;
}

// cancelJob() marks a job failed with this exact error and emits job-cancelled.
const CANCELLED_ERROR = 'Cancelled by user';
function isCancelled(job: DownloadJob): boolean {
  return job.status === 'failed' && job.error === CANCELLED_ERROR;
}

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
    // Cancelled while still queued — don't resurrect it into 'downloading'.
    if (isCancelled(job)) {
      return;
    }
    try {
      job.status = 'downloading';
      job.startedAt = Date.now();
      this.emit('job-updated', job);

      await this.downloadWithRetry(job);

      // A cancel that raced the last await must win over 'completed'.
      // In-flight work has settled here, so sweep anything created after
      // cancelJob()'s own (racy) unlink pass — extraction targets and the
      // recreated .part file included.
      if (isCancelled(job)) {
        this.cleanupPartialFiles(job);
        return;
      }
      job.status = 'completed';
      job.progress = 100;
      job.completedAt = Date.now();
      this.emit('job-completed', job);
    } catch (error) {
      // A cancelled job is already in its terminal state (cancelJob set it and
      // emitted job-cancelled); don't overwrite or re-emit job-failed. Do run
      // a final cleanup: the attempt that just ended may have written files
      // after cancelJob()'s unlink pass.
      if (isCancelled(job)) {
        this.cleanupPartialFiles(job);
        return;
      }
      job.status = 'failed';
      job.error = (error instanceof Error ? error.message : String(error)) || 'Download failed';
      job.completedAt = Date.now();

      this.cleanupPartialFiles(job);

      this.emit('job-failed', job);
      console.error(`Download job ${job.id} failed:`, error);
    }
  }

  private cleanupPartialFiles(job: DownloadJob): void {
    // Only called on a job's FINAL failure (or cancel) — never between
    // transient retries, where the .part file is the resume state.
    const names = job.partFile ? [...job.targetFiles, job.partFile] : job.targetFiles;
    for (const fileName of names) {
      const filePath = path.join(job.targetDir, fileName);
      try {
        fs.unlinkSync(filePath);
        console.log(`[${job.id}] Cleaned up partial file: ${fileName}`);
      } catch {
        // file may not exist yet
      }
    }
    job.partFile = undefined;
  }

  private partFilePath(job: DownloadJob): string {
    // job.id is `dl_<ts>_<rand>` — already filesystem-safe, and per-job
    // unique so concurrent jobs in the same targetDir can't collide.
    return path.join(job.targetDir, `${job.id}.part`);
  }

  private partFileSize(partPath: string): number {
    try {
      return fs.statSync(partPath).size;
    } catch {
      return 0;
    }
  }

  // Download to a .part file with bounded retries on TRANSIENT failures
  // only (network error, timeout, 5xx). The .part file survives retries:
  // a resumed attempt continues from its current size via an HTTP Range
  // request instead of starting over. Only consecutive attempts with NO
  // forward progress count against the budget. A 4xx (e.g. 404 for a
  // moved/expired catalog link) throws immediately. Between attempts the
  // URL is reset to the original (downloadToFile mutates job.url while
  // following redirects) so a tokenized direct link gets re-resolved from
  // its source. Once the body is complete, finalizeDownload turns the
  // .part file into the final chart file(s).
  private async downloadWithRetry(job: DownloadJob): Promise<void> {
    const originalUrl = job.originalUrl ?? job.url;
    if (!job.originalUrl) {
      job.originalUrl = originalUrl;
    }
    const partPath = this.partFilePath(job);
    job.partFile = path.basename(partPath);
    // Shared across attempts: the Content-Type of the response the part
    // file was written from, and the source's ETag/Last-Modified validator
    // for If-Range resumes.
    const state: DownloadState = { contentType: '', validator: '' };
    let attemptsWithoutProgress = 0;
    for (;;) {
      // cancelJob() marks the job failed/'Cancelled by user' but can't abort an
      // in-flight attempt or the backoff timer. Bail before (re)starting so a
      // cancel during a download or backoff isn't overwritten by a later
      // success in processJob.
      if (isCancelled(job)) {
        throw new Error('Cancelled by user');
      }
      const bytesBefore = this.partFileSize(partPath);
      try {
        await this.downloadToFile(job, partPath, state);
        break;
      } catch (error) {
        if (isCancelled(job)) {
          throw new Error('Cancelled by user');
        }
        if (!(error instanceof TransientDownloadError)) {
          throw error;
        }
        // Forward progress fully rearms the budget: an attempt that moved
        // bytes was not "without progress", so the next failure gets the
        // whole MAX_DOWNLOAD_ATTEMPTS streak again.
        const bytesNow = this.partFileSize(partPath);
        attemptsWithoutProgress = bytesNow > bytesBefore ? 0 : attemptsWithoutProgress + 1;
        if (attemptsWithoutProgress >= MAX_DOWNLOAD_ATTEMPTS) {
          throw error;
        }
        console.warn(
          `[${job.id}] Transient download failure (${attemptsWithoutProgress}/${MAX_DOWNLOAD_ATTEMPTS} without progress): ${error.message}; resuming from ${bytesNow} bytes...`
        );
        job.url = originalUrl;
        job.status = 'downloading';
        // Extraction only runs after the download completes, so these are
        // always safe to reset on a retry.
        job.targetFiles = [];
        job.extractedFiles = [];
        await new Promise((r) =>
          setTimeout(r, RETRY_BACKOFF_MS * Math.max(1, attemptsWithoutProgress))
        );
      }
    }
    // A cancel that landed during the final (successful) attempt must not
    // be overwritten by finalization/completion.
    if (isCancelled(job)) {
      throw new Error('Cancelled by user');
    }
    await this.finalizeDownload(job, partPath, state.contentType);
  }

  // One HTTP attempt: stream the response body onto the end of `partPath`.
  // Sends a Range request when the part file already has bytes — with
  // If-Range when the source gave us an ETag/Last-Modified, so a source
  // that changed between attempts answers 200 (full body) and we rewrite
  // instead of appending version-B bytes onto version-A data. Handles
  // servers that ignore Range (200 → rewrite the file from scratch) and
  // 416 (part already complete, or stale → drop it and let the retry
  // start over). A premature connection close is a TransientDownloadError
  // so the caller resumes; fs errors stay plain Errors and fail fast.
  // Mutates `state` with the Content-Type and validator of the response
  // the part file was written from.
  private downloadToFile(
    job: DownloadJob,
    partPath: string,
    state: DownloadState,
    redirects = 0
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const startByte = this.partFileSize(partPath);
      const protocol = job.url.startsWith('https') ? https : http;
      const headers: Record<string, string> = {};
      if (startByte > 0) {
        headers.Range = `bytes=${String(startByte)}-`;
        if (state.validator) {
          headers['If-Range'] = state.validator;
        }
      }

      console.log(`[${job.id}] Starting download from: ${job.url} (offset ${String(startByte)})`);

      const req = protocol
        .get(job.url, { timeout: 60000, headers }, (response) => {
          const status = response.statusCode ?? 0;

          if (
            status === 301 ||
            status === 302 ||
            status === 303 ||
            status === 307 ||
            status === 308
          ) {
            const redirectUrl = response.headers.location;
            response.resume(); // drain so the socket can be reused/freed
            if (redirectUrl) {
              if (redirects >= MAX_REDIRECTS) {
                reject(new Error('Too many redirects'));
                return;
              }
              // Location may be relative — resolve against the URL that
              // produced the redirect.
              let resolvedUrl: string;
              try {
                resolvedUrl = new URL(redirectUrl, job.url).toString();
              } catch {
                reject(new Error(`Invalid redirect location: ${redirectUrl}`));
                return;
              }
              console.log(`[${job.id}] Following redirect to: ${resolvedUrl}`);
              job.url = resolvedUrl;
              this.downloadToFile(job, partPath, state, redirects + 1)
                .then(resolve)
                .catch(reject);
              return;
            }
          }

          if (status === 416) {
            // Range not satisfiable: either the part file already holds the
            // complete body (offset === total) or it's stale relative to
            // the source. "bytes */<total>" disambiguates; stale parts are
            // dropped so the retry starts from zero.
            response.resume();
            const total = parseContentRangeTotal(response.headers['content-range']);
            if (total !== null && total === startByte) {
              // state.contentType deliberately keeps the value from the
              // response the bytes were actually written from — a 416's
              // own Content-Type describes the error body, not the chart.
              job.downloadedBytes = startByte;
              job.totalBytes = total;
              resolve();
              return;
            }
            try {
              fs.unlinkSync(partPath);
            } catch {
              // already gone
            }
            reject(
              new TransientDownloadError(`HTTP 416 at offset ${String(startByte)}; restarting`)
            );
            return;
          }

          const resumed = status === 206 && startByte > 0;
          if (resumed) {
            // Trust but verify: appending a 206 body that doesn't start
            // exactly at our offset would silently corrupt the file.
            const rangeStart = parseContentRangeStart(response.headers['content-range']);
            if (rangeStart !== startByte) {
              response.resume();
              try {
                fs.unlinkSync(partPath);
              } catch {
                // already gone
              }
              reject(
                new TransientDownloadError(
                  `Server resumed at ${String(rangeStart ?? 'unknown')} instead of ${String(startByte)}; restarting`
                )
              );
              return;
            }
          }
          if (status !== 200 && !resumed) {
            response.resume(); // drain so the socket can be reused/freed
            // 5xx = server-side hiccup, worth a retry; 4xx (incl. 404 for a
            // moved/expired catalog link) is permanent — fail fast.
            const msg = `HTTP ${String(status)}`;
            reject(status >= 500 ? new TransientDownloadError(msg) : new Error(msg));
            return;
          }

          // A 200 answer to a Range request means the server ignored the
          // header — write the file from scratch rather than appending a
          // second copy of the body onto the partial one.
          const appendFrom = resumed ? startByte : 0;
          const totalBytes = resumed
            ? (parseContentRangeTotal(response.headers['content-range']) ?? 0)
            : parseInt(response.headers['content-length'] ?? '0') || 0;
          job.totalBytes = totalBytes;
          job.downloadedBytes = appendFrom;

          const contentType = response.headers['content-type'] ?? '';
          state.contentType = contentType;
          // Remember the source's validator so the next resume can send
          // If-Range: a changed source then answers 200 (full body) and
          // the rewrite path below keeps the file consistent.
          state.validator = response.headers.etag ?? response.headers['last-modified'] ?? '';
          console.log(
            `[${job.id}] ${resumed ? `Resuming at byte ${String(startByte)}` : 'Downloading'}; Content-Type: ${contentType}, total: ${totalBytes > 0 ? String(totalBytes) : 'unknown'} bytes`
          );

          // Archives cap at 90% — finalizeDownload owns 90-100 for the
          // extraction phase; raw saves and direct files run to 100.
          const looksLikeZip =
            !job.saveRaw &&
            (contentType.includes('zip') ||
              urlPathLooksLikeZip(job.originalUrl) ||
              urlPathLooksLikeZip(job.url));
          const cap = looksLikeZip ? 90 : 100;

          let receivedThisAttempt = 0;
          response.on('data', (chunk: Buffer) => {
            receivedThisAttempt += chunk.length;
            job.downloadedBytes = appendFrom + receivedThisAttempt;
            if (job.totalBytes > 0) {
              job.progress = Math.min(
                cap,
                Math.floor((job.downloadedBytes / job.totalBytes) * cap)
              );
            }
            this.emit('job-updated', job);
          });

          const fileStream = fs.createWriteStream(partPath, { flags: resumed ? 'a' : 'w' });
          let settled = false;
          const fail = (err: Error): void => {
            if (settled) {
              return;
            }
            settled = true;
            // Whatever was flushed stays in the part file — the next
            // attempt resumes from its on-disk size.
            fileStream.destroy();
            response.destroy();
            reject(err);
          };

          fileStream.on('error', (err: Error) => {
            // fs-level failure (ENOENT/ENOSPC/perms): not transient.
            fail(err);
          });
          response.on('aborted', () => {
            fail(new TransientDownloadError('Connection closed mid-transfer'));
          });
          response.on('error', (err: Error) => {
            fail(new TransientDownloadError(err.message));
          });

          fileStream.on('finish', () => {
            if (settled) {
              return;
            }
            settled = true;
            // Truncation guard: a keep-alive server can end the body short
            // without an 'aborted'/'error' event.
            const received = appendFrom + receivedThisAttempt;
            if (job.totalBytes > 0 && received < job.totalBytes) {
              reject(
                new TransientDownloadError(
                  `Connection closed early (${String(received)} of ${String(job.totalBytes)} bytes)`
                )
              );
              return;
            }
            resolve();
          });

          response.pipe(fileStream);
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

  // The body is fully on disk — turn the .part file into the final chart
  // file(s). Archives are detected by magic bytes (tokenized URLs and
  // mislabeled servers make extension/Content-Type unreliable) and
  // extracted via the zip central directory: random access on a complete
  // file, no streaming parser to stall, and sequential entry writes so
  // duplicate basenames can't clobber each other from concurrent streams.
  private async finalizeDownload(
    job: DownloadJob,
    partPath: string,
    contentType: string
  ): Promise<void> {
    const looksLikeZip =
      contentType.includes('zip') ||
      urlPathLooksLikeZip(job.originalUrl) ||
      urlPathLooksLikeZip(job.url);

    if (!job.saveRaw && isZipMagic(partPath)) {
      job.status = 'extracting';
      job.progress = Math.max(job.progress, 90);
      this.emit('job-updated', job);

      const directory = await unzipper.Open.file(partPath);
      const entries = directory.files.filter(
        (f) => f.type === 'File' && f.path.endsWith('.mbtiles')
      );
      if (entries.length === 0) {
        fs.unlinkSync(partPath);
        job.partFile = undefined;
        throw new Error('No .mbtiles files found in archive');
      }

      let done = 0;
      // Entry paths are flattened to basenames, so region-a/chart.mbtiles
      // and region-b/chart.mbtiles would land on the same target — keep
      // every chart by uniquifying collisions (chart.mbtiles, chart-2...).
      const usedNames = new Set<string>();
      for (const entry of entries) {
        let targetFileName = path.basename(entry.path);
        if (usedNames.has(targetFileName)) {
          const ext = path.extname(targetFileName);
          const stem = ext ? targetFileName.slice(0, -ext.length) : targetFileName;
          let suffix = 2;
          while (usedNames.has(`${stem}-${String(suffix)}${ext}`)) {
            suffix += 1;
          }
          targetFileName = `${stem}-${String(suffix)}${ext}`;
          console.log(
            `[${job.id}] Duplicate basename in archive; extracting ${entry.path} as ${targetFileName}`
          );
        }
        usedNames.add(targetFileName);
        const targetPath = path.join(job.targetDir, targetFileName);
        console.log(`[${job.id}] Extracting: ${entry.path} to ${targetPath}`);
        job.targetFiles.push(targetFileName);
        this.emit('job-updated', job);

        await pipeline(entry.stream(), fs.createWriteStream(targetPath));

        job.extractedFiles.push(targetFileName);
        done += 1;
        job.progress = 90 + Math.floor((done / entries.length) * 10);
        this.emit('job-updated', job);
      }
      console.log(`[${job.id}] Extraction complete. Files: ${job.extractedFiles.join(', ')}`);
      fs.unlinkSync(partPath);
      job.partFile = undefined;
      return;
    }

    if (!job.saveRaw && looksLikeZip) {
      // The source claimed a zip but the bytes aren't one (typically an
      // HTML error page from an expired share link). Failing beats
      // renaming junk to .mbtiles and calling the job completed.
      fs.unlinkSync(partPath);
      job.partFile = undefined;
      throw new Error('Downloaded file is not a valid ZIP archive');
    }

    console.log(`[${job.id}] Processing as direct file (saveRaw: ${String(job.saveRaw)})...`);

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

    // Strip any directory component before joining. The route handlers
    // already reject unsafe chartName/chartNumber with a 400, so this only
    // fires for any future non-route caller — but it keeps the write
    // inside targetDir regardless. Reuse the basenamed value for
    // targetFiles so the cancel/cleanup unlink paths reference the file
    // that was actually written.
    const safeFileName = path.basename(fileName);
    const targetPath = path.join(job.targetDir, safeFileName);

    job.targetFiles.push(safeFileName);
    this.emit('job-updated', job);

    fs.renameSync(partPath, targetPath);
    job.partFile = undefined;
    console.log(`[${job.id}] Downloaded: ${safeFileName}`);
    job.extractedFiles.push(safeFileName);
    job.progress = 100;
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

    const cancelNames = job.partFile ? [...job.targetFiles, job.partFile] : job.targetFiles;
    if (cancelNames.length > 0) {
      cancelNames.forEach((fn) => {
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
