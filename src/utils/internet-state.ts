/**
 * The connection state the signalk-internet plugin publishes at
 * `vessels.self` `network.internet.state`: `online`, `metered` (the link
 * costs money per byte, such as satellite data billed per GB), `captive`
 * (a sign-in page catches the traffic) or `offline`.
 *
 * Without that plugin, or with no state published, everything runs as it
 * would without this module: no waits, no checks held back.
 */

import type { Context, Delta, Path, ServerAPI } from '@signalk/server-api';

export const INTERNET_STATE_PATH = 'network.internet.state';
export const SIGNALK_INTERNET_PLUGIN_ID = 'signalk-internet';

/**
 * How long the startup round waits for signalk-internet's state, when the
 * plugin is enabled but has not published one: after a start, and after the
 * `null` it publishes when it stops (a restart). Its first probe settles
 * within seconds online; offline it gives up after its retries.
 */
export const FIRST_STATE_WAIT_MS = 60_000;

const RESTRICTED_STATES: ReadonlySet<string> = new Set(['metered', 'offline', 'captive']);

/** One row of the server's `app.getPluginsList()`. */
export interface PluginListEntry {
  id: string;
  enabled: boolean;
}

/** Calls `onState` with each value of the state, the current one first; returns the unsubscribe. */
export type SubscribeState = (onState: (value: unknown) => void) => () => void;

/**
 * The state through the server's subscription manager, which sends the last
 * value when the subscription starts.
 */
export function subscribeInternetState(
  subscriptionmanager: ServerAPI['subscriptionmanager'],
  onError: (error: unknown) => void
): SubscribeState {
  return (onState) => {
    const unsubscribes: (() => void)[] = [];
    subscriptionmanager.subscribe(
      {
        context: 'vessels.self' as Context,
        subscribe: [{ path: INTERNET_STATE_PATH as Path, policy: 'instant' }]
      },
      unsubscribes,
      onError,
      (delta: Delta) => {
        for (const update of delta.updates) {
          if (!('values' in update)) {
            continue;
          }
          for (const pv of update.values) {
            if (pv.path === INTERNET_STATE_PATH) {
              onState(pv.value);
            }
          }
        }
      }
    );
    return () => {
      for (const unsubscribe of unsubscribes.splice(0)) {
        unsubscribe();
      }
    };
  };
}

export interface InternetGateOptions {
  /**
   * The state, followed from the gate's creation until `stop()`. Without it
   * there is never a state.
   */
  subscribeState?: SubscribeState;
  /**
   * `app.getPluginsList`; asked only while there is no state, to know whether
   * a first one is coming. Without it nothing is waited for.
   */
  getPluginsList?: () => Promise<PluginListEntry[]>;
  /** The user's choice to fetch online chart tiles on a metered link. */
  allowMeteredCharts: () => boolean;
}

/**
 * Answers, at the moment work would run, whether the plugin may go online.
 *
 * signalk-internet publishes `null` when it stops, so a disabled plugin
 * leaves no state behind; 0.7.1 and older do not, and their last state stays
 * until Signal K restarts.
 */
export class InternetGate {
  private value: unknown = undefined;
  private firstState: Promise<void> | null = null;
  /** From the start of a wait for a state until it ends, also while the plugin list is asked. */
  private waiting = false;
  /** Ends the wait in progress for a state, once it is on its timer. */
  private endWait: (() => void) | null = null;
  private stopped = false;
  private held: (() => void)[] = [];
  private readonly unsubscribe: (() => void) | null;

  constructor(private readonly options: InternetGateOptions) {
    this.unsubscribe =
      options.subscribeState?.((value) => {
        this.onState(value);
      }) ?? null;
  }

  /** The published state, or undefined without one. */
  state(): string | undefined {
    return typeof this.value === 'string' ? this.value : undefined;
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
   * Resolves once background work can decide: at once when a state is there
   * or signalk-internet is not enabled, otherwise when it publishes a state
   * or `FIRST_STATE_WAIT_MS` has passed. Waits again after signalk-internet
   * restarts.
   */
  firstStateKnown(): Promise<void> {
    this.firstState ??= this.waitForState();
    return this.firstState;
  }

  /**
   * Run `task` now when background work may run, otherwise once a new state
   * (or signalk-internet stopping) allows it.
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
  }

  /** Ends a wait for a state, drops held work and unsubscribes; the plugin stopped. */
  stop(): void {
    this.stopped = true;
    this.held = [];
    this.unsubscribe?.();
    this.endWait?.();
  }

  private onState(value: unknown): void {
    this.value = value;
    if (typeof value === 'string') {
      this.endWait?.();
      this.runHeld();
      return;
    }
    // signalk-internet stopped: disabled, or restarting with a probe to come.
    if (!this.waiting) {
      this.firstState = null;
    }
    void this.firstStateKnown().then(() => {
      this.runHeld();
    });
  }

  private runHeld(): void {
    // A usable state may already have been replaced by a restricted one.
    if (this.stopped || this.held.length === 0 || !this.mayRunBackground()) {
      return;
    }
    const tasks = this.held;
    this.held = [];
    for (const task of tasks) {
      task();
    }
  }

  private async waitForState(): Promise<void> {
    this.waiting = true;
    try {
      if (this.state() !== undefined || !(await this.publisherEnabled())) {
        return;
      }
      if (this.stopped || this.state() !== undefined) {
        return;
      }
      await new Promise<void>((resolve) => {
        const done = (): void => {
          clearTimeout(timer);
          this.endWait = null;
          resolve();
        };
        const timer = setTimeout(done, FIRST_STATE_WAIT_MS);
        timer.unref();
        this.endWait = done;
      });
    } finally {
      this.waiting = false;
    }
  }

  /** Asked at the time, not at start: the server adds a plugin to its list only after starting it. */
  private async publisherEnabled(): Promise<boolean> {
    const list = this.options.getPluginsList;
    if (!list) {
      return false;
    }
    try {
      const plugins = await list();
      return plugins.some((p) => p.id === SIGNALK_INTERNET_PLUGIN_ID && p.enabled);
    } catch {
      return false;
    }
  }
}
