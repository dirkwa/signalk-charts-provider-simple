/**
 * Pre-downloading an area of a chart kept offline, so it works with no
 * internet before a plotter has ever shown it: pick the area, pick the zoom
 * levels, and every tile in between is fetched and kept.
 */

import { randomUUID } from 'crypto';
import type { EnsureOutcome, OnlineTileProxy, OnlineTileSource } from './online-tile-cache.js';

/** [west, south, east, north] in degrees; west > east crosses the antimeridian. */
export type AreaBbox = [number, number, number, number];

/** The most tiles one download may ask for: a few gigabytes of chart at most. */
export const MAX_AREA_TILES = 100_000;
const CONCURRENCY = 4;
/** Consecutive failures after which the provider is taken to be unreachable. */
const GIVE_UP_AFTER = 25;
const KEEP_FINISHED = 20;
const MAX_LAT = 85.0511287798066;

function lonToX(lon: number, z: number): number {
  const n = 2 ** z;
  return Math.min(n - 1, Math.max(0, Math.floor(((lon + 180) / 360) * n)));
}

function latToY(lat: number, z: number): number {
  const n = 2 ** z;
  const clamped = (Math.max(-MAX_LAT, Math.min(MAX_LAT, lat)) * Math.PI) / 180;
  const y = Math.floor(
    ((1 - Math.log(Math.tan(clamped) + 1 / Math.cos(clamped)) / Math.PI) / 2) * n
  );
  return Math.min(n - 1, Math.max(0, y));
}

/** Tile column ranges for an area, split in two where it crosses the antimeridian. */
function columnRanges([west, , east]: AreaBbox, z: number): [number, number][] {
  if (west <= east) {
    return [[lonToX(west, z), lonToX(east, z)]];
  }
  const from = lonToX(west, z);
  const to = lonToX(east, z);
  // At low zoom both halves can land in the same columns.
  if (to >= from) {
    return [[0, 2 ** z - 1]];
  }
  return [
    [from, 2 ** z - 1],
    [0, to]
  ];
}

function rowRange([, south, , north]: AreaBbox, z: number): [number, number] {
  return [latToY(north, z), latToY(south, z)];
}

/** How many tiles an area spans over a zoom range. */
export function countAreaTiles(bbox: AreaBbox, minzoom: number, maxzoom: number): number {
  let total = 0;
  for (let z = minzoom; z <= maxzoom; z++) {
    const [top, bottom] = rowRange(bbox, z);
    for (const [from, to] of columnRanges(bbox, z)) {
      total += (to - from + 1) * (bottom - top + 1);
    }
  }
  return total;
}

/** Every tile of an area, lowest zoom first, so a cut-short download still covers the overview. */
export function* areaTiles(
  bbox: AreaBbox,
  minzoom: number,
  maxzoom: number
): Generator<[number, number, number]> {
  for (let z = minzoom; z <= maxzoom; z++) {
    const [top, bottom] = rowRange(bbox, z);
    for (const [from, to] of columnRanges(bbox, z)) {
      for (let x = from; x <= to; x++) {
        for (let y = top; y <= bottom; y++) {
          yield [z, x, y];
        }
      }
    }
  }
}

export type AreaDownloadStatus = 'running' | 'completed' | 'cancelled' | 'failed';

export interface AreaDownloadJob {
  id: string;
  chartId: string;
  catalogId: string;
  bbox: AreaBbox;
  minzoom: number;
  maxzoom: number;
  status: AreaDownloadStatus;
  total: number;
  /** Tiles dealt with so far: fetched, already kept, failed or not offered. */
  done: number;
  fetched: number;
  failed: number;
  startedAt: string;
  finishedAt?: string;
  error?: string;
}

export interface AreaDownloadRequest {
  chartId: string;
  catalogId: string;
  source: OnlineTileSource;
  bbox: AreaBbox;
  minzoom: number;
  maxzoom: number;
}

export class AreaDownloadError extends Error {}

/** Runs area downloads, one at a time per chart, a few tiles at a time. */
export class AreaDownloader {
  private readonly jobs = new Map<string, AreaDownloadJob>();
  private readonly cancelled = new Set<string>();
  private readonly runs = new Map<string, Promise<void>>();

  constructor(
    private readonly proxy: OnlineTileProxy,
    private readonly concurrency = CONCURRENCY
  ) {}

  start(req: AreaDownloadRequest): AreaDownloadJob {
    if (req.minzoom > req.maxzoom) {
      throw new AreaDownloadError('The lowest zoom level is above the highest');
    }
    const total = countAreaTiles(req.bbox, req.minzoom, req.maxzoom);
    if (total > MAX_AREA_TILES) {
      throw new AreaDownloadError(
        `That is ${total.toLocaleString('en-US')} tiles; choose a smaller area or a lower zoom level (at most ${MAX_AREA_TILES.toLocaleString('en-US')}).`
      );
    }
    if (this.list().some((j) => j.chartId === req.chartId && j.status === 'running')) {
      throw new AreaDownloadError('An area of this chart is already downloading');
    }
    const job: AreaDownloadJob = {
      id: randomUUID(),
      chartId: req.chartId,
      catalogId: req.catalogId,
      bbox: req.bbox,
      minzoom: req.minzoom,
      maxzoom: req.maxzoom,
      status: 'running',
      total,
      done: 0,
      fetched: 0,
      failed: 0,
      startedAt: new Date().toISOString()
    };
    this.jobs.set(job.id, job);
    this.prune();
    const run = this.run(job, req.source).finally(() => this.runs.delete(job.id));
    this.runs.set(job.id, run);
    return job;
  }

  cancel(id: string): boolean {
    const job = this.jobs.get(id);
    if (job?.status !== 'running') {
      return false;
    }
    this.cancelled.add(id);
    return true;
  }

  cancelAll(): void {
    for (const job of this.jobs.values()) {
      this.cancel(job.id);
    }
  }

  /** Cancel a chart's running downloads and wait until their last tile is written. */
  async stop(catalogId: string): Promise<void> {
    const running = this.list().filter((j) => j.catalogId === catalogId && j.status === 'running');
    for (const job of running) {
      this.cancel(job.id);
    }
    await Promise.all(
      running.flatMap((j) => {
        const run = this.runs.get(j.id);
        return run ? [run] : [];
      })
    );
  }

  get(id: string): AreaDownloadJob | undefined {
    return this.jobs.get(id);
  }

  list(): AreaDownloadJob[] {
    return [...this.jobs.values()];
  }

  private async run(job: AreaDownloadJob, source: OnlineTileSource): Promise<void> {
    const tiles = areaTiles(job.bbox, job.minzoom, job.maxzoom);
    let consecutiveFailures = 0;
    // The job stays 'running' until every worker has returned, so nothing
    // (deleting the kept tiles, say) treats it as over while tiles are still
    // being written.
    let gaveUp = false;
    const worker = async (): Promise<void> => {
      for (;;) {
        if (this.cancelled.has(job.id) || gaveUp) {
          return;
        }
        const next = tiles.next();
        if (next.done) {
          return;
        }
        const [z, x, y] = next.value;
        let outcome: EnsureOutcome;
        try {
          outcome = await this.proxy.ensureTile(job.catalogId, source, z, x, y);
        } catch {
          outcome = 'failed';
        }
        job.done++;
        if (outcome === 'failed') {
          job.failed++;
          consecutiveFailures++;
          if (consecutiveFailures >= GIVE_UP_AFTER) {
            gaveUp = true;
          }
        } else {
          consecutiveFailures = 0;
          if (outcome === 'fetched') {
            job.fetched++;
          }
        }
      }
    };
    await Promise.all(Array.from({ length: this.concurrency }, () => worker()));
    if (gaveUp) {
      job.status = 'failed';
      job.error =
        'The chart provider stopped answering: check the internet connection, or pick a lower highest zoom if the chart has no tiles that close';
    } else {
      job.status = this.cancelled.has(job.id) ? 'cancelled' : 'completed';
    }
    this.cancelled.delete(job.id);
    job.finishedAt = new Date().toISOString();
  }

  private prune(): void {
    const finished = this.list().filter((j) => j.status !== 'running');
    for (const job of finished.slice(0, Math.max(0, finished.length - KEEP_FINISHED))) {
      this.jobs.delete(job.id);
    }
  }
}
