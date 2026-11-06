/**
 * Serves the charts Multihelm changed with one refresh of the chart list
 * for a whole burst of changes, not one per chart, and retries a refresh
 * that failed until one succeeds, so a chart taken over during a peer's
 * catch-up is not left unserved, or a deleted one left advertised.
 */

import path from 'node:path';
import { performance } from 'node:perf_hooks';

import type { ChartProvider } from '../../types.js';

/** A burst of changes ends this long after its last one. */
export const REFRESH_DELAY_MS = 2_000;
/** A failed refresh is tried again after this long. */
export const RETRY_DELAY_MS = 30_000;
/**
 * Refreshes start at least this far apart, so a catch-up whose charts arrive
 * a few seconds apart still rescans the folder only now and then.
 */
export const MIN_INTERVAL_MS = 15_000;

export interface ChartRefreshHost {
  /** Rescan the chart folder; false when the scan failed and nothing changed. */
  refresh: () => Promise<boolean>;
  /** Tell clients what is served now under these `/`-separated chart paths. */
  announce: (relPaths: readonly string[]) => void;
  /** Stop serving the chart at this path at once, without a rescan. */
  drop: (relPath: string) => void;
}

/** Debounces, spaces and retries the chart list refreshes Multihelm's changes need. */
export class ChartRefreshQueue {
  private readonly pending = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private stopped = false;
  private lastStart = Number.NEGATIVE_INFINITY;

  /** `now` is a monotonic clock, so a clock set back cannot stall refreshes. */
  constructor(
    private readonly host: ChartRefreshHost,
    private readonly now: () => number = () => performance.now()
  ) {}

  /** Charts were added, replaced, enabled or disabled. */
  changed(relPaths: readonly string[]): void {
    this.add(relPaths, REFRESH_DELAY_MS);
  }

  /** A chart was deleted: it is no longer served from now on, and the list follows. */
  deleted(relPath: string): void {
    if (this.stopped) {
      return;
    }
    this.host.drop(relPath);
    this.add([relPath], REFRESH_DELAY_MS);
  }

  /** Cancels what is pending; a stopped queue ignores later changes. */
  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pending.clear();
  }

  private add(relPaths: readonly string[], delay: number): void {
    if (this.stopped) {
      return;
    }
    for (const relPath of relPaths) {
      this.pending.add(relPath);
    }
    this.schedule(delay);
  }

  private schedule(delay: number): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    const wait = Math.max(delay, this.lastStart + MIN_INTERVAL_MS - this.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.run();
    }, wait);
  }

  private async run(): Promise<void> {
    if (this.stopped || this.pending.size === 0) {
      return;
    }
    if (this.running) {
      // The refresh under way may have missed these: one more follows it.
      this.schedule(REFRESH_DELAY_MS);
      return;
    }
    const relPaths = [...this.pending];
    this.pending.clear();
    this.running = true;
    this.lastStart = this.now();
    let ok: boolean;
    try {
      ok = await this.host.refresh();
    } finally {
      this.running = false;
    }
    if (this.stopped) {
      return;
    }
    if (!ok) {
      for (const relPath of relPaths) {
        this.pending.add(relPath);
      }
      // A change that arrived meanwhile keeps its shorter wait.
      if (!this.timer) {
        this.schedule(RETRY_DELAY_MS);
      }
      return;
    }
    this.host.announce(relPaths);
  }
}

/**
 * Keeps charts deleted while a scan of the chart folder ran out of that
 * scan's result, so a scan that loaded a chart before it was deleted cannot
 * serve it again. A scan calls `begin()` before it reads the folder and
 * `finish()` on its result right before installing it, with no await in
 * between; `release()` ends a scan whose result is not installed.
 */
export class DeletedCharts {
  private generation = 0;
  /** Resolved file path → the generation of its deletion. */
  private readonly deleted = new Map<string, number>();
  /** The generation each scan under way began at. */
  private readonly scans = new Map<symbol, number>();

  /** A chart file was deleted. */
  mark(filePath: string): void {
    this.generation++;
    this.deleted.set(path.resolve(filePath), this.generation);
  }

  /** A scan is about to read the chart folder; pass the token to `finish` or `release`. */
  begin(): symbol {
    const scan = Symbol('scan');
    this.scans.set(scan, this.generation);
    return scan;
  }

  /**
   * Removes from `charts` those deleted since `scan` began and returns them,
   * for the caller to close their handles.
   */
  finish(scan: symbol, charts: Record<string, ChartProvider>): ChartProvider[] {
    const since = this.scans.get(scan) ?? this.generation;
    const removed: ChartProvider[] = [];
    for (const [chartId, provider] of Object.entries(charts)) {
      if (provider._filePath === '') {
        continue;
      }
      const deletedAt = this.deleted.get(path.resolve(provider._filePath));
      if (deletedAt !== undefined && deletedAt > since) {
        Reflect.deleteProperty(charts, chartId);
        removed.push(provider);
      }
    }
    this.release(scan);
    return removed;
  }

  /** Ends a scan without installing its result, and forgets deletions no scan needs. */
  release(scan: symbol): void {
    this.scans.delete(scan);
    // A deletion only matters to scans that began before it.
    const oldest = Math.min(...this.scans.values());
    for (const [filePath, deletedAt] of this.deleted) {
      if (deletedAt <= oldest) {
        this.deleted.delete(filePath);
      }
    }
  }
}
