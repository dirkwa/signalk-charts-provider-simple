/**
 * The local WFS proxy's lifecycle in the plugin (`wfs-proxy.ts`, `docs/wfs-proxy.md`):
 * its store under the data dir, the in-process API peer plugins use, and the
 * handover across the restart a config save makes: a stopped proxy goes on
 * serving for a while, and the next start takes it over with its new settings,
 * so a peer's read in progress keeps its pages and its way.
 */

import path from 'path';
import type { ChartsProviderWfsApi } from '../types.js';
import { WfsCache } from './wfs-cache.js';
import type { WfsSourceConfig } from './wfs-sources.js';
import { normalizeUpstream, WfsProxy, type WfsProxySettings, type WfsSource } from './wfs-proxy.js';

export const WFS_PROXY_API_VERSION = 1;
/** The PropertyValue that offers the proxy to peer plugins (`wfsOffer`). */
export const WFS_PROPERTY = 'chartsProviderWfs';
export const DEFAULT_WFS_MAX_AGE_DAYS = 30;

/** How long a stopped proxy serves on for the next start to take it over, ms. */
export const HANDOVER_MS = 30_000;

const DAY_MS = 86_400_000;

/** The port the proxy last listened on, so a peer's URLs survive this plugin's restart. */
let lastPort = 0;

/** A stopped proxy still serving, until a start takes it over or its time is up. */
let parked: { running: WfsProxyRunning; timer: NodeJS.Timeout } | null = null;
/** The close of a proxy whose time was up, which a new one waits for to keep its port. */
let closing: Promise<void> = Promise.resolve();

export interface WfsProxyRunning {
  proxy: WfsProxy;
  cache: WfsCache;
  /** The settings of the start running it. */
  settings: WfsServiceSettings;
}

export interface WfsServiceSettings {
  dataDir: string;
  maxAgeDays: () => number;
  /** The store's size limit, bytes; 0 for none. */
  maxBytes: () => number;
  /** The WFS servers proxied, as the WFS Data tab lists them. */
  sources: () => readonly WfsSourceConfig[];
  /** False while their list cannot be read: what is kept is left as it is. */
  sourcesKnown?: () => boolean;
  mayRefresh: () => boolean;
  log: (message: string) => void;
  /** What went wrong that the user should hear of. */
  warn: (message: string) => void;
}

export function wfsCacheFile(dataDir: string): string {
  return path.join(dataDir, 'wfs-cache', 'wfs.sqlite');
}

/** The configured sources with an http or https URL, the first of each URL. */
export function wfsSources(configs: readonly WfsSourceConfig[]): WfsSource[] {
  const out = new Map<string, WfsSource>();
  for (const c of configs) {
    const url = normalizeUpstream(c.url);
    if (url === undefined || out.has(url)) {
      continue;
    }
    const idProperty = c.idProperty?.trim();
    out.set(url, {
      url,
      ...(c.answersByBox === true ? { byBox: { margin: c.answerMargin ?? 0 } } : {}),
      ...(idProperty ? { idProperty } : {})
    });
  }
  return [...out.values()];
}

function proxySettings(settings: WfsServiceSettings): WfsProxySettings {
  return {
    sources: () => wfsSources(settings.sources()),
    sourcesKnown: settings.sourcesKnown ?? (() => true),
    maxAgeMs: () => settings.maxAgeDays() * DAY_MS,
    maxBytes: settings.maxBytes,
    mayRefresh: settings.mayRefresh,
    handingOver: false,
    log: settings.log
  };
}

export async function startWfsProxy(settings: WfsServiceSettings): Promise<WfsProxyRunning> {
  if (parked) {
    const { running, timer } = parked;
    // Taken over only once configured: until then its timer still closes it.
    running.proxy.configure(proxySettings(settings));
    clearTimeout(timer);
    parked = null;
    running.settings = settings;
    return running;
  }
  await closing;
  const cache = new WfsCache(wfsCacheFile(settings.dataDir));
  let proxy: WfsProxy;
  try {
    proxy = new WfsProxy({ cache, ...proxySettings(settings) });
    lastPort = await proxy.listen(lastPort);
  } catch (err) {
    cache.close();
    throw err;
  }
  return { proxy, cache, settings };
}

/**
 * The proxy for peer plugins, over the one `running` gives at each call: none while the
 * plugin is stopped or the proxy is off. One object for the server process, as a
 * PropertyValue is kept for good while every config save restarts the plugin.
 */
export const wfsOffer = (running: () => WfsProxyRunning | null): ChartsProviderWfsApi => ({
  apiVersion: WFS_PROXY_API_VERSION,
  proxyUrl: (upstream) => running()?.proxy.proxyUrl(upstream),
  upstreams: () => [...(running()?.proxy.upstreams() ?? [])],
  stats: () => running()?.cache.stats()
});

/** Takes up a change of the sources listed: what a source no longer proxied kept is dropped. */
export function refreshWfsSources(running: WfsProxyRunning): void {
  running.proxy.configure({ sources: proxySettings(running.settings).sources });
}

export async function stopWfsProxy(running: WfsProxyRunning): Promise<void> {
  try {
    await running.proxy.close();
  } finally {
    // A stage left behind is cleared when the store is next opened.
    running.cache.close();
  }
}

/** Closes `running` after any close before it, reporting a failure rather than dropping it. */
function closeLater(running: WfsProxyRunning): void {
  closing = closing
    .then(() => stopWfsProxy(running))
    .catch((err: unknown) => {
      running.settings.warn(`Local WFS proxy did not close cleanly: ${String(err)}`);
    });
}

/**
 * Stops `running` once `HANDOVER_MS` has passed without a start taking it over.
 * Meanwhile it answers from the store and carries on the reads going upstream,
 * but begins no new read upstream and refreshes no stale area.
 */
export function releaseWfsProxy(running: WfsProxyRunning): void {
  if (parked && parked.running !== running) {
    clearTimeout(parked.timer);
    closeLater(parked.running);
  }
  running.proxy.configure({ mayRefresh: () => false, handingOver: true });
  const timer = setTimeout(() => {
    if (parked?.running === running) {
      parked = null;
      closeLater(running);
    }
  }, HANDOVER_MS);
  timer.unref();
  parked = { running, timer };
}
