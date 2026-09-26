import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { findCharts } from '../dist/charts-loader.js';
import { scanChartsRecursively } from '../dist/utils/file-scanner.js';
import {
  chartIdFromFilename,
  findOnlineChartFiles,
  onlineChartProvider,
  readOnlineChartFile,
  renameOnlineChartFile,
  writeOnlineChartFile,
  type OnlineChartResolver
} from '../dist/utils/online-charts.js';
import type { MergedOnlineChart } from '../dist/catalog/merged-catalog-schema.js';

function entry(overrides: Partial<MergedOnlineChart> = {}): MergedOnlineChart {
  return {
    id: 'nws-radar-conus',
    name: 'NWS Radar – Continental US',
    description: 'Rain radar for the lower 48 states.',
    category: 'weather',
    regions: ['us-conus'],
    bbox: [-130, 20, -60, 55],
    provider: 'NOAA / National Weather Service',
    attribution: 'NOAA / National Weather Service',
    license: 'Public domain',
    licenseUrl: 'https://www.weather.gov/disclaimer',
    chart: {
      type: 'WMS',
      url: 'https://opengeo.ncep.noaa.gov/geoserver/conus/conus_bref_qcd/ows',
      layers: ['conus_bref_qcd'],
      defaultOpacity: 0.7
    },
    use: 'stream',
    format: 'wms',
    ...overrides
  };
}

const catalog = new Map<string, MergedOnlineChart>([
  ['nws-radar-conus', entry()],
  [
    'nws-warnings',
    entry({
      id: 'nws-warnings',
      bbox: [140, 9, -60, 72],
      chart: { type: 'WMS', url: 'https://x.test/ows', layers: ['warnings'] }
    })
  ]
]);
const resolve: OnlineChartResolver = (id) => catalog.get(id);

describe('online charts', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'online-charts-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe('chartIdFromFilename', () => {
    it('strips either chart-file extension', () => {
      assert.strictEqual(
        chartIdFromFilename('nws-radar-conus.onlinechart.json'),
        'nws-radar-conus'
      );
      assert.strictEqual(chartIdFromFilename('Miami.mbtiles'), 'Miami');
      assert.strictEqual(chartIdFromFilename('Miami.MBTILES'), 'Miami');
      assert.strictEqual(chartIdFromFilename('folder-chart'), 'folder-chart');
    });
  });

  describe('writeOnlineChartFile', () => {
    it('names the file after the catalog id, never the display name', () => {
      const file = writeOnlineChartFile(dir, 'nws-radar-conus', 'NWS Radar – Continental US');
      assert.strictEqual(file, 'nws-radar-conus.onlinechart.json');
      assert.deepStrictEqual(readOnlineChartFile(path.join(dir, file)), {
        catalogId: 'nws-radar-conus',
        name: 'NWS Radar – Continental US'
      });
    });

    it('picks a new name instead of overwriting', () => {
      writeOnlineChartFile(dir, 'nws-radar-conus', 'A');
      const second = writeOnlineChartFile(dir, 'nws-radar-conus', 'B');
      assert.strictEqual(second, 'nws-radar-conus-2.onlinechart.json');
      assert.strictEqual(
        readOnlineChartFile(path.join(dir, 'nws-radar-conus.onlinechart.json'))?.name,
        'A'
      );
    });

    it('never reuses a chart id taken anywhere in the library', () => {
      const file = writeOnlineChartFile(
        dir,
        'nws-radar-conus',
        'x',
        new Set(['nws-radar-conus', 'nws-radar-conus-2'])
      );
      assert.strictEqual(file, 'nws-radar-conus-3.onlinechart.json');
    });

    it('keeps path characters out of the file name', () => {
      const file = writeOnlineChartFile(dir, '../../etc/passwd', 'x');
      assert.ok(!file.includes('/') && !file.includes('..'), file);
      assert.ok(fs.existsSync(path.join(dir, file)));
    });

    it('creates the target folder', () => {
      const sub = path.join(dir, 'Online Charts');
      writeOnlineChartFile(sub, 'nws-radar-conus', 'x');
      assert.ok(fs.existsSync(path.join(sub, 'nws-radar-conus.onlinechart.json')));
    });
  });

  describe('readOnlineChartFile / renameOnlineChartFile', () => {
    it('rejects unreadable or incomplete files', () => {
      fs.writeFileSync(path.join(dir, 'bad.onlinechart.json'), '{not json');
      fs.writeFileSync(path.join(dir, 'empty.onlinechart.json'), '{"name": "x"}');
      assert.strictEqual(readOnlineChartFile(path.join(dir, 'bad.onlinechart.json')), null);
      assert.strictEqual(readOnlineChartFile(path.join(dir, 'empty.onlinechart.json')), null);
    });

    it('renames by rewriting the name and keeping other fields', () => {
      const file = path.join(dir, 'x.onlinechart.json');
      fs.writeFileSync(
        file,
        JSON.stringify({ catalogId: 'nws-radar-conus', name: 'Old', extra: 1 })
      );
      assert.ok(renameOnlineChartFile(file, 'New'));
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf-8')), {
        catalogId: 'nws-radar-conus',
        name: 'New',
        extra: 1
      });
    });
  });

  describe('onlineChartProvider', () => {
    it('serves the catalog entry under the file name and display name', () => {
      const file = path.join(dir, 'nws-radar-conus.onlinechart.json');
      const provider = onlineChartProvider(
        file,
        { catalogId: 'nws-radar-conus', name: 'My Radar' },
        resolve
      );
      assert.ok(provider);
      assert.strictEqual(provider.identifier, 'nws-radar-conus');
      assert.strictEqual(provider.name, 'My Radar');
      assert.strictEqual(provider.type, 'WMS');
      assert.strictEqual(provider._fileFormat, 'online');
      assert.strictEqual(provider.defaultOpacity, 0.7);
      assert.deepStrictEqual(provider.v2, {
        url: 'https://opengeo.ncep.noaa.gov/geoserver/conus/conus_bref_qcd/ows',
        layers: ['conus_bref_qcd']
      });
      assert.deepStrictEqual(provider.bounds, [-130, 20, -60, 55]);
    });

    it('widens an antimeridian-crossing box to all longitudes', () => {
      const provider = onlineChartProvider(
        path.join(dir, 'w.onlinechart.json'),
        { catalogId: 'nws-warnings', name: 'Warnings' },
        resolve
      );
      assert.deepStrictEqual(provider?.bounds, [-180, 9, 180, 72]);
    });

    it('serves nothing when the catalog lacks the entry', () => {
      const provider = onlineChartProvider(
        path.join(dir, 'x.onlinechart.json'),
        { catalogId: 'retired', name: 'x' },
        resolve
      );
      assert.strictEqual(provider, null);
    });
  });

  describe('chart folder integration', () => {
    beforeEach(() => {
      writeOnlineChartFile(path.join(dir, 'Online Charts'), 'nws-radar-conus', 'NWS Radar');
      writeOnlineChartFile(dir, 'retired', 'Retired');
      fs.writeFileSync(path.join(dir, 'broken.onlinechart.json'), 'nope');
    });

    it('findCharts serves resolvable online charts only', async () => {
      const charts = await findCharts(dir, resolve);
      assert.deepStrictEqual(Object.keys(charts), ['nws-radar-conus']);
      assert.strictEqual(charts['nws-radar-conus']?.name, 'NWS Radar');
    });

    it('findCharts serves no online charts without a resolver', async () => {
      assert.deepStrictEqual(await findCharts(dir), {});
    });

    it('the Manage Charts scan lists every online chart file, damaged ones flagged', async () => {
      const scanned = await scanChartsRecursively(dir);
      const online = scanned
        .filter((c) => c.online)
        .map((c) => [
          c.relativePath,
          c.chartName,
          c.online?.catalogId,
          c.online?.unreadable ?? false
        ])
        .sort();
      assert.deepStrictEqual(online, [
        [
          path.join('Online Charts', 'nws-radar-conus.onlinechart.json'),
          'NWS Radar',
          'nws-radar-conus',
          false
        ],
        ['broken.onlinechart.json', 'broken.onlinechart.json', '', true],
        ['retired.onlinechart.json', 'Retired', 'retired', false]
      ]);
    });

    it('findOnlineChartFiles does not walk into tile directories', async () => {
      const tiles = path.join(dir, 'some-chart');
      fs.mkdirSync(path.join(tiles, '1'), { recursive: true });
      fs.writeFileSync(path.join(tiles, 'tilemapresource.xml'), '<TileMap/>');
      fs.writeFileSync(
        path.join(tiles, '1', 'stray.onlinechart.json'),
        '{"catalogId":"x","name":"x"}'
      );
      const refs = await findOnlineChartFiles(dir);
      assert.ok(!refs.some((r) => r.relativePath.startsWith('some-chart')));
    });

    it('findOnlineChartFiles reports catalog ids and paths', async () => {
      const refs = (await findOnlineChartFiles(dir)).sort((a, b) =>
        a.catalogId < b.catalogId ? -1 : 1
      );
      assert.deepStrictEqual(refs, [
        {
          relativePath: path.join('Online Charts', 'nws-radar-conus.onlinechart.json'),
          catalogId: 'nws-radar-conus'
        },
        { relativePath: 'retired.onlinechart.json', catalogId: 'retired' }
      ]);
    });
  });
});
