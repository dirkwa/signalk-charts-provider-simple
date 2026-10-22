/**
 * Tests for the plugin's copy of the ENC index (`enc-index-manager.ts`):
 * reading it under the published compatibility policy, and downloading it
 * from a local server with ETag revalidation and an offline cache.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import {
  getEncIndex,
  getEncIndexStatus,
  getEncMapPayload,
  initEncIndexManager,
  interpretEncIndex,
  refreshEncIndex
} from '../dist/utils/enc-index-manager.js';

function sampleIndex(extraUnits: unknown[] = []) {
  return {
    schemaVersion: 1,
    generatedAt: '2026-10-22T20:26:10.703Z',
    contentHash: 'abc',
    sources: [{ id: 'EURIS_IENC_Catalog', label: 'EuRIS', kind: 'chartcatalogs' }],
    archives: [
      {
        url: 'https://www.eurisportal.eu/a',
        source: 'EURIS_IENC_Catalog',
        version: '2026-07-17T06:35:31Z',
        kind: 'zip'
      }
    ],
    units: [
      {
        source: 'EURIS_IENC_Catalog',
        id: '1H7D1430',
        title: 'Dunav - Mohács',
        scale: 4000,
        bbox: [18.74, 45.89, 18.83, 45.95],
        outline: {
          type: 'Polygon',
          coordinates: [
            [
              [18.74, 45.89],
              [18.83, 45.89],
              [18.83, 45.95],
              [18.74, 45.89]
            ]
          ]
        },
        cells: [
          {
            name: '1H7D1430',
            archive: 'https://www.eurisportal.eu/a',
            path: '1H7D1430.000',
            version: '1H7D1430_ED011_UP000'
          }
        ],
        statusCells: ['1H7D1430'],
        aFieldFromTheFuture: true
      },
      ...extraUnits
    ]
  };
}

describe('interpretEncIndex', () => {
  it('skips a unit it cannot read and keeps the rest', () => {
    const result = interpretEncIndex(sampleIndex([{ source: 'x', id: 'broken' }]));
    assert.ok(result.ok);
    assert.strictEqual(result.skipped, 1);
    assert.deepStrictEqual(
      result.index.units.map((u) => u.id),
      ['1H7D1430']
    );
    assert.ok(result.index.otherUnits.has('1H7D1430'));
  });

  it('refuses a newer format, and a file that is not an index', () => {
    const newer = interpretEncIndex({ ...sampleIndex(), schemaVersion: 2 });
    assert.ok(!newer.ok && newer.reason === 'incompatible');
    const junk = interpretEncIndex({ hello: 'world' });
    assert.ok(!junk.ok && junk.reason === 'invalid');
  });
});

describe('downloading the index', () => {
  let server: http.Server;
  let dataDir = '';
  let requests: { etag: string | undefined }[] = [];
  let answer: 'index' | '404' = 'index';
  const body = JSON.stringify(sampleIndex());

  before(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enc-index-mgr-'));
    server = http.createServer((req, res) => {
      const etag = req.headers['if-none-match'];
      requests.push({ etag: typeof etag === 'string' ? etag : undefined });
      if (answer === '404') {
        res.writeHead(404).end();
      } else if (etag === '"v1"') {
        res.writeHead(304, { ETag: '"v1"' }).end();
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json', ETag: '"v1"' }).end(body);
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    process.env.ENC_INDEX_URL = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/enc-index.json`;
  });

  after(() => {
    delete process.env.ENC_INDEX_URL;
    server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('says plainly when the index has not been published', async () => {
    answer = '404';
    initEncIndexManager(dataDir, () => {});
    await refreshEncIndex();
    assert.strictEqual(getEncIndex(), null);
    assert.strictEqual(getEncIndexStatus().status, 'error');
    assert.match(getEncIndexStatus().message ?? '', /not been published yet/);
    answer = 'index';
  });

  it('downloads it, then revalidates by ETag', async () => {
    requests = [];
    initEncIndexManager(dataDir, () => {});
    await refreshEncIndex();
    assert.strictEqual(getEncIndex()?.units.length, 1);
    assert.strictEqual(getEncIndexStatus().status, 'ok');
    await refreshEncIndex();
    assert.deepStrictEqual(requests, [{ etag: undefined }, { etag: '"v1"' }]);
    assert.strictEqual(getEncIndex()?.units.length, 1);
  });

  it('keeps working from the saved copy when the server is unreachable', async () => {
    const url = process.env.ENC_INDEX_URL;
    process.env.ENC_INDEX_URL = 'http://127.0.0.1:1/enc-index.json';
    try {
      initEncIndexManager(dataDir, () => {});
      assert.strictEqual(getEncIndex()?.units.length, 1, 'loaded from the cache at start');
      await refreshEncIndex();
      assert.strictEqual(getEncIndexStatus().status, 'error');
      assert.strictEqual(getEncIndex()?.units.length, 1, 'a failed refresh keeps the copy');
    } finally {
      process.env.ENC_INDEX_URL = url;
    }
  });

  it('serves the map without the cell lists', () => {
    const payload = JSON.parse(getEncMapPayload() ?? 'null') as {
      sources: { id: string; units: number }[];
      units: Record<string, unknown>[];
    };
    assert.deepStrictEqual(payload.sources, [
      { id: 'EURIS_IENC_Catalog', label: 'EuRIS', units: 1 }
    ]);
    assert.deepStrictEqual(Object.keys(payload.units[0]).sort(), [
      'bbox',
      'id',
      'outline',
      'scale',
      'source',
      'title'
    ]);
  });

  it('removes the NOAA footprint cache the old tab left behind', () => {
    const old = path.join(dataDir, 'noaa-enc-cache');
    fs.mkdirSync(old, { recursive: true });
    fs.writeFileSync(path.join(old, 'enc.geojson'), '{}');
    initEncIndexManager(dataDir, () => {});
    assert.ok(!fs.existsSync(old));
  });
});
