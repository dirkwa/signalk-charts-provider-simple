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
import { normalizeUpstream, WfsProxy, type WfsProxySettings } from './wfs-proxy.js';

/** Traficom's WFS services: depth areas and soundings (restricted) and the open one. */
export const DEFAULT_WFS_UPSTREAMS = [
  'https://julkinen.traficom.fi/inspirepalvelu/rajoitettu/wfs',
  'https://julkinen.traficom.fi/inspirepalvelu/avoin/wfs'
] as const;

export const WFS_PROXY_API_VERSION = 1;
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
  api: ChartsProviderWfsApi;
}

export interface WfsServiceSettings {
  dataDir: string;
  maxAgeDays: () => number;
  /** Upstreams proxied besides Traficom's. */
  extraUpstreams: () => readonly string[];
  mayRefresh: () => boolean;
  log: (message: string) => void;
  /** What the user should correct in the settings. */
  warn: (message: string) => void;
}

export function wfsCacheFile(dataDir: string): string {
  return path.join(dataDir, 'wfs-cache', 'wfs.sqlite');
}

const TRAFICOM = new Set<string>(DEFAULT_WFS_UPSTREAMS);

function proxySettings(settings: WfsServiceSettings): WfsProxySettings {
  return {
    upstreams: () =>
      [...DEFAULT_WFS_UPSTREAMS, ...settings.extraUpstreams()]
        .map(normalizeUpstream)
        .filter((u): u is string => u !== undefined),
    answersByBox: (upstream) => TRAFICOM.has(upstream),
    maxAgeMs: () => settings.maxAgeDays() * DAY_MS,
    mayRefresh: settings.mayRefresh,
    log: settings.log
  };
}

/** Names the extra upstreams that are no http or https URL, by place only: a URL may hold a key. */
function warnInvalidUpstreams(settings: WfsServiceSettings): void {
  settings.extraUpstreams().forEach((u, i) => {
    if (normalizeUpstream(u) === undefined) {
      settings.warn(
        `Other WFS servers to keep: entry ${String(i + 1)} is not an http or https URL, so it is not proxied`
      );
    }
  });
}

export async function startWfsProxy(settings: WfsServiceSettings): Promise<WfsProxyRunning> {
  warnInvalidUpstreams(settings);
  if (parked) {
    clearTimeout(parked.timer);
    const { running } = parked;
    parked = null;
    running.proxy.configure(proxySettings(settings));
    return running;
  }
  await closing;
  const cache = new WfsCache(wfsCacheFile(settings.dataDir));
  const proxy = new WfsProxy({ cache, ...proxySettings(settings) });
  try {
    lastPort = await proxy.listen(lastPort);
  } catch (err) {
    cache.close();
    throw err;
  }
  const api: ChartsProviderWfsApi = {
    apiVersion: WFS_PROXY_API_VERSION,
    proxyUrl: (upstream) => proxy.proxyUrl(upstream),
    upstreams: () => [...proxy.upstreams()],
    stats: () => cache.stats()
  };
  return { proxy, cache, api };
}

export async function stopWfsProxy(running: WfsProxyRunning): Promise<void> {
  await running.proxy.close();
  running.cache.close();
}

/**
 * Stops `running` once `HANDOVER_MS` has passed without a start taking it over.
 * Meanwhile it serves the reads going on, and goes online on its own for none.
 */
export function releaseWfsProxy(running: WfsProxyRunning): void {
  if (parked && parked.running !== running) {
    clearTimeout(parked.timer);
    const other = parked.running;
    closing = closing.then(() => stopWfsProxy(other)).catch(() => undefined);
  }
  running.proxy.configure({ mayRefresh: () => false });
  const timer = setTimeout(() => {
    if (parked?.running === running) {
      parked = null;
      closing = closing.then(() => stopWfsProxy(running)).catch(() => undefined);
    }
  }, HANDOVER_MS);
  timer.unref();
  parked = { running, timer };
}
