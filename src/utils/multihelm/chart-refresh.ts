/**
 * Serves the charts Multihelm changed with one refresh of the chart list
 * for a whole burst of changes, not one per chart, and retries a refresh
 * that failed until one succeeds, so a chart taken over during a peer's
 * catch-up is not left unserved, or a deleted one left advertised.
 */

/** A burst of changes ends this long after its last one. */
export const REFRESH_DELAY_MS = 2_000;
/** A failed refresh is tried again after this long. */
export const RETRY_DELAY_MS = 30_000;

export interface ChartRefreshHost {
  /** Rescan the chart folder; false when the scan failed and nothing changed. */
  refresh: () => Promise<boolean>;
  /** Tell clients what is served now under these `/`-separated chart paths. */
  announce: (relPaths: readonly string[]) => void;
  /** Stop serving the chart at this path at once, without a rescan. */
  drop: (relPath: string) => void;
}

export class ChartRefreshQueue {
  private readonly pending = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private stopped = false;

  constructor(private readonly host: ChartRefreshHost) {}

  /** Charts were added, replaced, enabled or disabled. */
  changed(relPaths: readonly string[]): void {
    this.add(relPaths, REFRESH_DELAY_MS);
  }

  /** A chart was deleted: it is no longer served from now on, and the list follows. */
  deleted(relPath: string): void {
    this.host.drop(relPath);
    this.add([relPath], REFRESH_DELAY_MS);
  }

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
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.run();
    }, delay);
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
      this.add(relPaths, RETRY_DELAY_MS);
      return;
    }
    this.host.announce(relPaths);
  }
}
