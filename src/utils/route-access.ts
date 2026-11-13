import type { AccessScopedRouter, PluginRouter, RouteAccessLevel } from '@signalk/server-api';
import type { RequestHandler } from 'express';

// Servers older than PluginRouter.access() keep every plugin route
// admin-only, so on those the routes go straight on the router.
export function accessRouter(router: PluginRouter, level: RouteAccessLevel): AccessScopedRouter {
  if (typeof (router as Partial<PluginRouter>).access === 'function') {
    return router.access(level);
  }
  const registrar: AccessScopedRouter = {
    get: (path: string, ...handlers: RequestHandler[]) => {
      router.get(path, ...handlers);
      return registrar;
    },
    post: (path: string, ...handlers: RequestHandler[]) => {
      router.post(path, ...handlers);
      return registrar;
    },
    put: (path: string, ...handlers: RequestHandler[]) => {
      router.put(path, ...handlers);
      return registrar;
    },
    patch: (path: string, ...handlers: RequestHandler[]) => {
      router.patch(path, ...handlers);
      return registrar;
    },
    delete: (path: string, ...handlers: RequestHandler[]) => {
      router.delete(path, ...handlers);
      return registrar;
    }
  };
  return registrar;
}
