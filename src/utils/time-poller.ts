/**
 * Keeps the `time` block of time-varying online charts current by reading
 * each service's capabilities document at the catalog entry's refresh
 * interval.
 *
 * Polling follows demand: a chart plotter showing a time-varying chart
 * re-reads it every `refreshInterval`, and each read counts as demand (see
 * `touch`). An entry nobody has read for two intervals is left idle, so a
 * chart that is added but not displayed costs no bandwidth — which matters
 * on a boat, where some documents are megabytes (NASA GIBS: 2.5 MB). One
 * download serves every entry that shares a capabilities URL.
 */

import {
  buildTimeBlock,
  findLayerTimeDimension,
  parseTimeExtent,
  type ChartTimeBlock,
  type TimeWindow
} from './time-dimension.js';

export interface PollTarget {
  catalogId: string;
  capabilitiesUrl: string;
  layer: string;
  window: TimeWindow;
  refreshInterval: number;
}

type FetchText = (url: string) => Promise<string>;

const FETCH_TIMEOUT_MS = 30000;
// A catalog typo must never turn into hammering a service (Node clamps an
// over-long timer to 1 ms) or into a timeline that never refreshes.
const MIN_INTERVAL_MS = 60000;
const MAX_INTERVAL_MS = 24 * 60 * 60 * 1000;
// Entries sharing a capabilities URL poll at about the same moment; reuse
// a download this recent instead of fetching the same document again.
const SHARED_FETCH_MS = 60000;
// How soon a read may retry an entry that has no timeline yet (its
// download failed, or the document has none for the layer), so client
// reads can't turn into a fetch or a multi-megabyte scan each.
const RETRY_GAP_MS = 60000;

async function defaultFetchText(url: string): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) {
    throw new Error(`HTTP ${String(response.status)}`);
  }
  return response.text();
}

function sameTarget(a: PollTarget, b: PollTarget): boolean {
  return (
    a.capabilitiesUrl === b.capabilitiesUrl &&
    a.layer === b.layer &&
    a.refreshInterval === b.refreshInterval &&
    a.window.kind === b.window.kind &&
    a.window.window === b.window.window
  );
}

interface Poll {
  target: PollTarget;
  interval: number;
  timer: NodeJS.Timeout;
  lastDemand: number;
  lastPoll: number;
}

export class TimeDimensionPoller {
  private readonly polls = new Map<string, Poll>();
  private readonly latest = new Map<string, ChartTimeBlock>();
  private readonly downloads = new Map<string, { at: number; text: Promise<string> }>();

  constructor(
    /** Called when an entry's time block changes, or is withdrawn (undefined). */
    private readonly onChange: (catalogId: string, time: ChartTimeBlock | undefined) => void,
    private readonly debug: (msg: string) => void = () => {},
    private readonly fetchText: FetchText = defaultFetchText,
    private readonly now: () => number = Date.now
  ) {}

  /** The last time block read for an entry, if any. */
  get(catalogId: string): ChartTimeBlock | undefined {
    return this.latest.get(catalogId);
  }

  /**
   * Record that a client read this entry's chart. Polls when its last poll
   * is a full interval old, or, while it has no timeline, a retry gap old
   * (so the first read polls at once).
   */
  touch(catalogId: string): void {
    const poll = this.polls.get(catalogId);
    if (!poll) {
      return;
    }
    const now = this.now();
    poll.lastDemand = now;
    const gap = this.latest.has(catalogId) ? poll.interval : RETRY_GAP_MS;
    if (poll.lastPoll === 0 || now - poll.lastPoll >= gap) {
      void this.poll(poll.target);
    }
  }

  /** Track exactly these targets: add new ones, stop dropped ones. */
  sync(targets: PollTarget[]): void {
    const wanted = new Map(targets.map((t) => [t.catalogId, t]));
    for (const [id, poll] of this.polls) {
      const next = wanted.get(id);
      if (!next || !sameTarget(poll.target, next)) {
        clearInterval(poll.timer);
        this.polls.delete(id);
        if (!next) {
          this.latest.delete(id);
        }
      }
    }
    for (const [id, target] of wanted) {
      if (this.polls.has(id)) {
        continue;
      }
      const interval = Math.min(Math.max(target.refreshInterval, MIN_INTERVAL_MS), MAX_INTERVAL_MS);
      const timer = setInterval(() => {
        const poll = this.polls.get(id);
        // Idle once no client has read the chart for two intervals.
        if (poll && this.now() - poll.lastDemand <= 2 * interval) {
          void this.poll(target);
        }
      }, interval);
      // Never keep the process alive just to poll weather layers.
      timer.unref();
      this.polls.set(id, { target, interval, timer, lastDemand: 0, lastPoll: 0 });
    }
  }

  stop(): void {
    for (const poll of this.polls.values()) {
      clearInterval(poll.timer);
    }
    this.polls.clear();
    this.latest.clear();
    this.downloads.clear();
  }

  private download(url: string): Promise<string> {
    const now = this.now();
    const recent = this.downloads.get(url);
    if (recent && now - recent.at < SHARED_FETCH_MS) {
      return recent.text;
    }
    const text = this.fetchText(url);
    this.downloads.set(url, { at: now, text });
    // A failed download must not be shared; the next poll retries.
    text.catch(() => {
      if (this.downloads.get(url)?.text === text) {
        this.downloads.delete(url);
      }
    });
    return text;
  }

  /**
   * Read one entry's timeline. A failed download keeps the last good block,
   * so a brief outage doesn't take the time slider away; a document that no
   * longer offers the layer's timeline withdraws it.
   */
  async poll(target: PollTarget): Promise<void> {
    const started = this.polls.get(target.catalogId);
    if (started?.target !== target) {
      return;
    }
    started.lastPoll = this.now();
    let xml: string;
    try {
      xml = await this.download(target.capabilitiesUrl);
    } catch (error) {
      this.debug(
        `time: ${target.catalogId}: ${error instanceof Error ? error.message : String(error)}`
      );
      return;
    }
    if (this.polls.get(target.catalogId)?.target !== target) {
      return; // stopped or replaced while the request was out
    }
    const text = findLayerTimeDimension(xml, target.layer);
    const now = this.now();
    const extent = text !== null ? parseTimeExtent(text, now) : null;
    const block = extent ? buildTimeBlock(extent, target.window, now) : null;
    if (!block) {
      this.debug(`time: ${target.catalogId}: no timeline for layer ${target.layer} in the window`);
      if (this.latest.delete(target.catalogId)) {
        this.onChange(target.catalogId, undefined);
      }
      return;
    }
    if (JSON.stringify(block) !== JSON.stringify(this.latest.get(target.catalogId))) {
      this.latest.set(target.catalogId, block);
      this.onChange(target.catalogId, block);
    }
  }
}
