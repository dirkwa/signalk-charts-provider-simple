/**
 * The local WFS proxy's lifecycle in the plugin (`wfs-proxy.ts`, `docs/wfs-proxy.md`):
 * its store under the data dir, the port it keeps across the restarts a
 * config save makes, and the in-process API peer plugins use.
 */

import path from 'path';
import type { ChartsProviderWfsApi } from '../types.js';
import { WfsCache } from './wfs-cache.js';
import { normalizeUpstream, WfsProxy } from './wfs-proxy.js';

/** Traficom's WFS services: depth areas and soundings (restricted) and the open one. */
export const DEFAULT_WFS_UPSTREAMS = [
  'https://julkinen.traficom.fi/inspirepalvelu/rajoitettu/wfs',
  'https://julkinen.traficom.fi/inspirepalvelu/avoin/wfs'
] as const;

export const WFS_PROXY_API_VERSION = 1;
export const DEFAULT_WFS_MAX_AGE_DAYS = 30;

const DAY_MS = 86_400_000;

/** The port the proxy last listened on, so a peer's URLs survive this plugin's restart. */
let lastPort = 0;

export interface WfsProxyRunning {
  proxy: WfsProxy;
  cache: WfsCache;
  api: ChartsProviderWfsApi;
}

export interface WfsProxySettings {
  dataDir: string;
  maxAgeDays: () => number;
  /** Upstreams proxied besides Traficom's. */
  extraUpstreams: () => readonly string[];
  mayRefresh: () => boolean;
  log: (message: string) => void;
}

export function wfsCacheFile(dataDir: string): string {
  return path.join(dataDir, 'wfs-cache', 'wfs.sqlite');
}

export async function startWfsProxy(settings: WfsProxySettings): Promise<WfsProxyRunning> {
  const cache = new WfsCache(wfsCacheFile(settings.dataDir));
  const upstreams = (): string[] =>
    [...DEFAULT_WFS_UPSTREAMS, ...settings.extraUpstreams()]
      .map(normalizeUpstream)
      .filter((u): u is string => u !== undefined);
  const proxy = new WfsProxy({
    cache,
    upstreams,
    maxAgeMs: () => settings.maxAgeDays() * DAY_MS,
    mayRefresh: settings.mayRefresh,
    log: settings.log
  });
  try {
    lastPort = await proxy.listen(lastPort);
  } catch (err) {
    cache.close();
    throw err;
  }
  const api: ChartsProviderWfsApi = {
    apiVersion: WFS_PROXY_API_VERSION,
    proxyUrl: (upstream) => proxy.proxyUrl(upstream),
    upstreams,
    stats: () => cache.stats()
  };
  return { proxy, cache, api };
}

export async function stopWfsProxy(running: WfsProxyRunning): Promise<void> {
  await running.proxy.close();
  running.cache.close();
}
