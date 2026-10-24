/**
 * The connection state the signalk-internet plugin publishes at
 * `vessels.self` `network.internet.state`: `online`, `metered` (the link
 * costs money per byte, such as satellite data billed per GB), `captive`
 * (a sign-in page catches the traffic) or `offline`.
 *
 * Without that plugin, or with no state published, everything runs as it
 * would without this module: no waits, no checks held back.
 */

export const INTERNET_STATE_PATH = 'network.internet.state';
export const SIGNALK_INTERNET_PLUGIN_ID = 'signalk-internet';

/**
 * How long the startup round waits for signalk-internet's first state, when
 * the plugin is enabled but has not published one yet. Its first probe
 * settles within seconds online; offline it gives up after its retries.
 */
export const FIRST_STATE_WAIT_MS = 60_000;
const FIRST_STATE_POLL_MS = 1_000;
/** How long the answer to "is signalk-internet enabled" is reused. */
export const PUBLISHER_CHECK_MS = 60_000;

const RESTRICTED_STATES: ReadonlySet<string> = new Set(['metered', 'offline', 'captive']);

/** One row of the server's `app.getPluginsList()`. */
export interface PluginListEntry {
  id: string;
  enabled: boolean;
}

export interface InternetGateOptions {
  /** `app.getSelfPath`: the leaf node (`{ value, $source, timestamp }`), or a bare value. */
  getSelfPath: (path: string) => unknown;
  /** `app.getPluginsList`; without it a published state is always believed. */
  getPluginsList?: () => Promise<PluginListEntry[]>;
  /** The user's choice to fetch online chart tiles on a metered link. */
  allowMeteredCharts: () => boolean;
  /**
   * Calls `onState` with each new value of the state; returns the
   * unsubscribe. Only used while work is held for a usable link.
   */
  subscribeState?: (onState: (value: unknown) => void) => () => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Answers, at the moment work would run, whether the plugin may go online.
 *
 * A state stays in the server's data model after signalk-internet is
 * disabled or removed, so a state is believed only while that plugin is
 * enabled (checked through `getPluginsList`, at most every
 * `PUBLISHER_CHECK_MS`).
 */
export class InternetGate {
  private publisherEnabled: boolean | undefined;
  private checkedAt = -Infinity;
  private checking: Promise<boolean | undefined> | null = null;
  private firstState: Promise<void> | null = null;
  private stopped = false;
  private held: (() => void)[] = [];
  private unsubscribe: (() => void) | null = null;
  private recheck: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: InternetGateOptions) {
    this.now = options.now ?? Date.now;
    this.sleep =
      options.sleep ??
      ((ms) =>
        new Promise((resolve) => {
          setTimeout(resolve, ms).unref();
        }));
  }

  /** The published state, or undefined without one or once its publisher is no longer enabled. */
  state(): string | undefined {
    this.recheckPublisher();
    return this.publisherEnabled === false ? undefined : this.readValue();
  }

  /**
   * Whether the plugin may download on its own: the startup and daily
   * catalog checks, the ENC index refresh, resuming a land index build.
   * What the user starts is not asked.
   */
  mayRunBackground(): boolean {
    const state = this.state();
    return state === undefined || !RESTRICTED_STATES.has(state);
  }

  /**
   * Whether online chart tiles and timelines may be fetched for a plotter.
   * On a metered link only when the user allowed it; offline or behind a
   * sign-in page never, so kept tiles are served without trying first.
   */
  mayFetchCharts(): boolean {
    const state = this.state();
    if (state === 'metered') {
      return this.options.allowMeteredCharts();
    }
    return state === undefined || !RESTRICTED_STATES.has(state);
  }

  /**
   * Resolves once the startup round can decide: at once when a state is
   * already there or signalk-internet is not enabled, otherwise when it
   * publishes its first state or `FIRST_STATE_WAIT_MS` has passed.
   */
  firstStateKnown(): Promise<void> {
    this.firstState ??= this.waitForFirstState();
    return this.firstState;
  }

  /**
   * Run `task` now when background work may run, otherwise once a new state
   * (or signalk-internet being disabled) allows it.
   */
  runWhenBackgroundAllowed(task: () => void): void {
    if (this.stopped) {
      return;
    }
    if (this.mayRunBackground()) {
      task();
      return;
    }
    this.held.push(task);
    this.unsubscribe ??=
      this.options.subscribeState?.((value) => {
        if (typeof value !== 'string' || !RESTRICTED_STATES.has(value)) {
          // The server announces a delta before writing it to the data
          // model, which the held work reads through getSelfPath.
          queueMicrotask(() => {
            this.runHeld();
          });
        }
      }) ?? null;
    // A disabled signalk-internet publishes nothing more, so its state left
    // behind would hold the work until something happened to ask again.
    if (!this.recheck && this.options.getPluginsList) {
      this.recheck = setInterval(() => {
        this.state();
      }, PUBLISHER_CHECK_MS);
      this.recheck.unref();
    }
  }

  /** Ends a wait for the first state and drops held work; the plugin stopped. */
  stop(): void {
    this.stopped = true;
    this.held = [];
    this.detach();
  }

  private detach(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.recheck) {
      clearInterval(this.recheck);
      this.recheck = null;
    }
  }

  private runHeld(): void {
    // A usable state may already have been replaced by a restricted one.
    if (this.stopped || this.held.length === 0 || !this.mayRunBackground()) {
      return;
    }
    const tasks = this.held;
    this.held = [];
    this.detach();
    for (const task of tasks) {
      task();
    }
  }

  private async waitForFirstState(): Promise<void> {
    // The publisher first: a left-over state must not count as published.
    if ((await this.checkPublisher()) !== true || this.readValue() !== undefined) {
      return;
    }
    const until = this.now() + FIRST_STATE_WAIT_MS;
    while (!this.stopped && this.readValue() === undefined && this.now() < until) {
      await this.sleep(FIRST_STATE_POLL_MS);
    }
  }

  private readValue(): string | undefined {
    let node: unknown;
    try {
      node = this.options.getSelfPath(INTERNET_STATE_PATH);
    } catch {
      return undefined;
    }
    const value: unknown =
      node !== null && typeof node === 'object' && 'value' in node ? node.value : node;
    return typeof value === 'string' ? value : undefined;
  }

  private recheckPublisher(): void {
    if (!this.checking && this.now() - this.checkedAt >= PUBLISHER_CHECK_MS) {
      void this.checkPublisher();
    }
  }

  /** True or false once the server said; undefined when it can't tell. */
  private checkPublisher(): Promise<boolean | undefined> {
    const list = this.options.getPluginsList;
    if (!list) {
      return Promise.resolve(undefined);
    }
    this.checking ??= Promise.resolve()
      .then(list)
      .then((plugins) => {
        const enabled = plugins.some((p) => p.id === SIGNALK_INTERNET_PLUGIN_ID && p.enabled);
        this.publisherEnabled = enabled;
        if (!enabled) {
          this.runHeld();
        }
        return enabled;
      })
      .catch(() => undefined)
      .finally(() => {
        this.checkedAt = this.now();
        this.checking = null;
      });
    return this.checking;
  }
}
