import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import os from 'node:os';

import type { Plugin } from '@signalk/server-api';
import type { ExtendedServerAPI } from '../dist/types.js';
import pluginFactoryDefault from '../dist/index.js';
import { downloadManager } from '../dist/utils/download-manager.js';
import { accessRouter } from '../dist/utils/route-access.js';
import { progressWithoutLogs, withoutLog } from '../dist/utils/conversion-progress.js';

const pluginFactory = pluginFactoryDefault as unknown as (app: ExtendedServerAPI) => Plugin;

after(() => {
  downloadManager.removeAllListeners();
});

type PluginRouter = Parameters<NonNullable<Plugin['registerWithRouter']>>[0];
type Level = 'admin' | 'readonly' | 'readwrite';
const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

function recordingRouter(withAccess: boolean): {
  router: PluginRouter;
  levels: Map<string, Level>;
} {
  const levels = new Map<string, Level>();
  const registrar = (level: Level) => {
    const r: Record<string, unknown> = {};
    for (const method of METHODS) {
      r[method] = (path: string) => {
        levels.set(`${method.toUpperCase()} ${path}`, level);
        return r;
      };
    }
    return r;
  };
  const router = registrar('admin') as Record<string, unknown>;
  if (withAccess) {
    router['access'] = (level: 'readonly' | 'readwrite') => registrar(level);
  }
  return { router: router as unknown as PluginRouter, levels };
}

function registeredRoutes(): Map<string, Level> {
  const app = {
    config: { configPath: os.tmpdir(), ssl: false, version: '2.0.0', getExternalPort: () => 3000 },
    debug: () => {},
    error: () => {}
  } as unknown as ExtendedServerAPI;
  const { router, levels } = recordingRouter(true);
  pluginFactory(app).registerWithRouter?.(router);
  return levels;
}

describe('route access levels', () => {
  const levels = registeredRoutes();

  it('lets read-only users read the chart library, catalogs, chart sets and job status', () => {
    for (const route of [
      'GET /local-charts',
      'GET /chart-metadata/:chartPath',
      'GET /catalog-registry',
      'GET /catalog/:catalogFile',
      'GET /catalog-s57-status',
      'GET /download-jobs',
      'GET /land-index',
      'GET /custom-catalogs',
      'GET /custom-catalogs/:id/status',
      'GET /enc-store/:collection/:cell/:file'
    ]) {
      assert.strictEqual(levels.get(route), 'readonly', route);
    }
  });

  it('never opens a change to read-only users', () => {
    for (const [route, level] of levels) {
      if (!route.startsWith('GET ')) {
        assert.notStrictEqual(level, 'readonly', route);
      }
    }
  });

  it('lets readwrite users add and convert charts and read the conversion logs', () => {
    for (const route of [
      'POST /convert-upload',
      'POST /convert-local',
      'POST /catalog/download',
      'POST /online-charts',
      'POST /custom-catalogs/:id/download-convert',
      'GET /catalog-s57-log/:chartNumber',
      'GET /custom-catalogs/:id/log'
    ]) {
      assert.strictEqual(levels.get(route), 'readwrite', route);
    }
  });

  it('keeps removing and reorganising charts, and the URL fetcher, for admins', () => {
    for (const route of [
      'DELETE /local-charts/:chartPath',
      'DELETE /folders/:folderPath',
      'POST /charts/:chartPath/toggle',
      'POST /rename-chart',
      'POST /move-chart',
      'POST /online-charts/masked-version',
      'DELETE /custom-catalogs/:id',
      'GET /download'
    ]) {
      assert.strictEqual(levels.get(route), 'admin', route);
    }
  });
});

describe('accessRouter', () => {
  it('registers on the router itself, admin-only, when the server has no access()', () => {
    const { router, levels } = recordingRouter(false);
    accessRouter(router, 'readonly')
      .get('/a', () => {})
      .post('/b', () => {});
    assert.deepStrictEqual(
      [...levels],
      [
        ['GET /a', 'admin'],
        ['POST /b', 'admin']
      ]
    );
  });
});

describe('conversion status for read-only users', () => {
  it('leaves the log out and keeps the status and message', () => {
    const entry = { status: 'converting', message: 'Tiling', log: ['/data/charts/x.000'] };
    assert.deepStrictEqual(withoutLog(entry), { status: 'converting', message: 'Tiling' });
    assert.strictEqual(withoutLog(null), null);
    assert.deepStrictEqual(progressWithoutLogs({ US5: entry }), {
      US5: { status: 'converting', message: 'Tiling' }
    });
  });
});
