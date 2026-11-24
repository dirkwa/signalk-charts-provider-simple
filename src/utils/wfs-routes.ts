/**
 * The WFS Data tab's routes: what the local WFS proxy keeps from each source,
 * the sources it proxies, and deleting what it keeps. Anyone who may read the
 * server sees them; only an administrator changes them.
 */

import type { Request, Response } from 'express';
import type { RouteRegistrar } from './open-data/service.js';
import { parseBody } from './rest-validation.js';
import { normalizeUpstream } from './wfs-proxy.js';
import type { WfsProxyRunning } from './wfs-proxy-service.js';
import {
  WfsSourceConfigSchema,
  WfsSourceError,
  type WfsSourceConfig,
  type WfsSourceList
} from './wfs-sources.js';
import type { WfsSourceStats } from './wfs-cache.js';

const DAY_MS = 86_400_000;

export interface WfsRouteContext {
  sources: () => WfsSourceList | null;
  /** The running proxy; null while it is off or not started yet. */
  proxy: () => WfsProxyRunning | null;
  enabled: () => boolean;
  maxAgeDays: () => number;
  maxBytes: () => number;
  /** Called after the list of sources changed. */
  sourcesChanged: () => void;
}

export interface WfsSourceView extends WfsSourceConfig {
  stats: Omit<WfsSourceStats, 'upstream'> | null;
}

export interface WfsOverview {
  enabled: boolean;
  running: boolean;
  maxAgeDays: number;
  limitBytes: number;
  /** The store's file with its write-ahead log, and the part of it in use; null while not running. */
  store: { fileBytes: number; usedBytes: number } | null;
  sources: WfsSourceView[];
}

const urlOf = (req: Request): string | undefined => {
  const url = req.query.url;
  return typeof url === 'string' ? normalizeUpstream(url) : undefined;
};

export function registerWfsRoutes(
  ctx: WfsRouteContext,
  readonly: RouteRegistrar,
  admin: RouteRegistrar
): void {
  const fail = (res: Response, error: unknown): void => {
    const status = error instanceof WfsSourceError ? error.status : 500;
    res.status(status).json({
      success: false,
      error: error instanceof Error ? error.message : String(error)
    });
  };
  const withList =
    (handler: (list: WfsSourceList, req: Request, res: Response) => void) =>
    (req: Request, res: Response): void => {
      const list = ctx.sources();
      if (!list) {
        res.status(503).json({ success: false, error: 'The plugin is not running' });
        return;
      }
      try {
        handler(list, req, res);
      } catch (error) {
        fail(res, error);
      }
    };
  const withProxy =
    (handler: (running: WfsProxyRunning, req: Request, res: Response) => void) =>
    (req: Request, res: Response): void => {
      const running = ctx.proxy();
      if (!running) {
        res.status(409).json({
          success: false,
          error:
            'The WFS proxy is off: turn on "Keep the WFS data other plugins read" in the plugin settings'
        });
        return;
      }
      try {
        handler(running, req, res);
      } catch (error) {
        fail(res, error);
      }
    };

  readonly.get(
    '/wfs',
    withList((list, _req, res) => {
      const running = ctx.proxy();
      const maxAgeDays = ctx.maxAgeDays();
      const stats = new Map(
        (running?.cache.sourceStats(Date.now() - maxAgeDays * DAY_MS) ?? []).map(
          ({ upstream, ...s }) => [upstream, s]
        )
      );
      const overview: WfsOverview = {
        enabled: ctx.enabled(),
        running: running !== null,
        maxAgeDays,
        limitBytes: ctx.maxBytes(),
        store: running
          ? { fileBytes: running.cache.stats().bytes, usedBytes: running.cache.usedBytes() }
          : null,
        sources: list.list().map((s) => ({ ...s, stats: stats.get(s.url) ?? null }))
      };
      res.json(overview);
    })
  );

  const saveSource = (replace: boolean) =>
    withList((list, req, res) => {
      const body = parseBody(WfsSourceConfigSchema, req, res);
      if (!body) {
        return;
      }
      const source = list.save(body, replace);
      ctx.sourcesChanged();
      res.json({ success: true, source });
    });
  admin.post('/wfs/sources', saveSource(false));
  admin.put('/wfs/sources', saveSource(true));

  admin.delete(
    '/wfs/sources',
    withList((list, req, res) => {
      const url = urlOf(req);
      if (url === undefined || !list.remove(url)) {
        res.status(404).json({ success: false, error: 'No WFS server of that URL is kept' });
        return;
      }
      ctx.sourcesChanged();
      res.json({ success: true });
    })
  );

  // Without a URL, everything kept goes.
  admin.delete(
    '/wfs/data',
    withProxy((running, req, res) => {
      if (req.query.url === undefined) {
        running.cache.clear();
        res.json({ success: true });
        return;
      }
      const url = urlOf(req);
      if (url === undefined) {
        res.status(400).json({ success: false, error: 'Invalid URL' });
        return;
      }
      running.cache.forgetUpstream(url);
      res.json({ success: true });
    })
  );
}
