import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { findCharts } from '../dist/charts-loader.js';
import { scanChartsRecursively } from '../dist/utils/file-scanner.js';
import {
  chartFileNameBeside,
  chartFileNamesBeside,
  collectChartIds,
  chartIdFromFilename,
  customCatalogEntry,
  customChartId,
  customOnlineChartProblem,
  onlineChartEntry,
  findOnlineChartFiles,
  onlineChartProvider,
  readOnlineChartFile,
  updateOnlineChartFile,
  isMaskable,
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

    it('never names a chart added by URL after a device name Windows reserves', () => {
      const custom = { type: 'WMS' as const, url: 'https://w.example/ows', layers: ['a'] };
      const file = writeOnlineChartFile(dir, 'custom-x', 'CON', new Set(), custom);
      assert.strictEqual(file, 'con-chart.onlinechart.json');
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

    it("names a masked version after its chart's catalog id and the mask", () => {
      const name = writeOnlineChartFile(
        dir,
        'kept-depths',
        'Depths (Water only)',
        new Set(),
        undefined,
        'water-only'
      );
      assert.strictEqual(name, 'kept-depths-water-only.onlinechart.json');
      assert.deepStrictEqual(readOnlineChartFile(path.join(dir, name)), {
        catalogId: 'kept-depths',
        name: 'Depths (Water only)',
        mask: 'water-only'
      });
    });

    it('creates the target folder', () => {
      const sub = path.join(dir, 'Online Charts');
      writeOnlineChartFile(sub, 'nws-radar-conus', 'x');
      assert.ok(fs.existsSync(path.join(sub, 'nws-radar-conus.onlinechart.json')));
    });
  });

  describe('readOnlineChartFile / updateOnlineChartFile', () => {
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
      assert.ok(updateOnlineChartFile(file, { name: 'New' }));
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf-8')), {
        catalogId: 'nws-radar-conus',
        name: 'New',
        extra: 1
      });
    });

    it('sets and clears the opacity, keeping the name', () => {
      const file = path.join(dir, 'x.onlinechart.json');
      fs.writeFileSync(file, JSON.stringify({ catalogId: 'nws-radar-conus', name: 'Radar' }));
      assert.ok(updateOnlineChartFile(file, { defaultOpacity: 0.25 }));
      assert.deepStrictEqual(readOnlineChartFile(file), {
        catalogId: 'nws-radar-conus',
        name: 'Radar',
        defaultOpacity: 0.25
      });
      assert.ok(updateOnlineChartFile(file, { defaultOpacity: null }));
      assert.deepStrictEqual(readOnlineChartFile(file), {
        catalogId: 'nws-radar-conus',
        name: 'Radar'
      });
    });

    it('ignores an opacity out of range instead of dropping the chart', () => {
      const file = path.join(dir, 'x.onlinechart.json');
      for (const defaultOpacity of [2, -1, 'half', null]) {
        fs.writeFileSync(
          file,
          JSON.stringify({ catalogId: 'nws-radar-conus', name: 'Radar', defaultOpacity })
        );
        assert.deepStrictEqual(
          readOnlineChartFile(file),
          { catalogId: 'nws-radar-conus', name: 'Radar' },
          String(defaultOpacity)
        );
      }
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

    it("starts at the file's opacity when it sets one, else the catalog's", () => {
      const file = path.join(dir, 'nws-radar-conus.onlinechart.json');
      const own = onlineChartProvider(
        file,
        { catalogId: 'nws-radar-conus', name: 'Radar', defaultOpacity: 0 },
        resolve
      );
      assert.strictEqual(own?.defaultOpacity, 0);
      const fallback = onlineChartProvider(
        file,
        { catalogId: 'nws-radar-conus', name: 'Radar' },
        resolve
      );
      assert.strictEqual(fallback?.defaultOpacity, 0.7);
      const none = onlineChartProvider(
        path.join(dir, 'w.onlinechart.json'),
        { catalogId: 'nws-warnings', name: 'Warnings' },
        resolve
      );
      assert.strictEqual(none?.defaultOpacity, undefined);
    });

    it('publishes an antimeridian-crossing box as west > east', () => {
      const provider = onlineChartProvider(
        path.join(dir, 'w.onlinechart.json'),
        { catalogId: 'nws-warnings', name: 'Warnings' },
        resolve
      );
      assert.deepStrictEqual(provider?.bounds, [140, 9, -60, 72]);
    });

    it('serves a masked version only once the land index is built, and only of a kept chart', () => {
      const kept = entry({
        id: 'kept-depths',
        chart: { type: 'tilelayer', url: 'https://x.test/{z}/{x}/{y}.png', tileSize: 512 },
        offline: {}
      });
      const lookup: OnlineChartResolver = (id) => (id === 'kept-depths' ? kept : catalog.get(id));
      const file = path.join(dir, 'kept-depths-water-only.onlinechart.json');
      const masked = {
        catalogId: 'kept-depths',
        name: 'Depths (Water only)',
        mask: 'water-only' as const
      };
      assert.strictEqual(onlineChartProvider(file, masked, lookup, false), null);
      const provider = onlineChartProvider(file, masked, lookup, true);
      assert.ok(provider);
      assert.strictEqual(provider.identifier, 'kept-depths-water-only');
      assert.strictEqual(provider._mask, 'water-only');
      assert.strictEqual(provider.format, 'png');
      assert.strictEqual(provider.tileSize, 512);
      assert.strictEqual(provider._keepTiles, true);
      assert.match(provider.description, /OpenStreetMap contributors \(ODbL\)/);
      assert.strictEqual(provider.v2.url, '~tilePath~/kept-depths-water-only/{z}/{x}/{y}');
      assert.strictEqual(
        onlineChartProvider(file, { ...masked, defaultOpacity: 0.3 }, lookup, true)?.defaultOpacity,
        0.3,
        "a masked version starts at its own file's opacity"
      );

      const landOnly = onlineChartProvider(
        path.join(dir, 'kept-depths-land-only.onlinechart.json'),
        { catalogId: 'kept-depths', name: 'Depths (Land only)', mask: 'land-only' },
        lookup,
        true
      );
      assert.strictEqual(landOnly?.defaultOpacity, 0.7, 'starts at 0.7 whatever its chart');
      assert.strictEqual(
        onlineChartProvider(
          path.join(dir, 'kept-depths-land-only.onlinechart.json'),
          {
            catalogId: 'kept-depths',
            name: 'Depths (Land only)',
            mask: 'land-only',
            defaultOpacity: 0.5
          },
          lookup,
          true
        )?.defaultOpacity,
        0.5,
        "the file's own opacity overrides it"
      );
      assert.match(landOnly?.description ?? '', /Not for navigation/);

      const streamed = { catalogId: 'nws-radar-conus', name: 'Radar', mask: 'water-only' as const };
      assert.strictEqual(onlineChartProvider(file, streamed, lookup, true), null);
      assert.ok(isMaskable({ catalogId: 'kept-depths', name: 'Depths' }, kept));
      assert.ok(!isMaskable(masked, kept), 'a masked version is not masked again');
      assert.ok(!isMaskable({ catalogId: 'nws-radar-conus', name: 'Radar' }, entry()));
    });

    it('serves a kept 512 px tile layer through the plugin at its own tile size', () => {
      const wmts = entry({
        id: 'bluetopo-relief',
        chart: {
          type: 'tilelayer',
          url: 'https://x.test/wmts?TILEMATRIX=EPSG:3857:{z}&TILEROW={y}&TILECOL={x}',
          tileSize: 512,
          defaultOpacity: 0.5
        },
        offline: {}
      });
      const provider = onlineChartProvider(
        path.join(dir, 'bluetopo-relief.onlinechart.json'),
        { catalogId: 'bluetopo-relief', name: 'BlueTopo Relief' },
        () => wmts
      );
      assert.ok(provider);
      assert.strictEqual(provider.tileSize, 512);
      assert.strictEqual(provider._keepTiles, true);
      assert.deepStrictEqual(provider.v2, {
        url: '~tilePath~/bluetopo-relief/{z}/{x}/{y}',
        layers: [],
        tileSize: 512
      });
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

    it('findOnlineChartFiles fails on a folder it cannot read only when asked to', async () => {
      const missing = path.join(dir, 'unmounted');
      assert.deepStrictEqual(await findOnlineChartFiles(missing), []);
      await assert.rejects(findOnlineChartFiles(missing, missing, { strict: true }));
      const broken = path.join(dir, 'broken');
      fs.mkdirSync(broken);
      fs.writeFileSync(path.join(broken, 'x.onlinechart.json'), 'not json');
      assert.deepStrictEqual(await findOnlineChartFiles(broken), []);
      await assert.rejects(findOnlineChartFiles(broken, broken, { strict: true }));
    });

    it('findOnlineChartFiles skips lost+found but no other folder it may not enter', async (t) => {
      const base = path.join(dir, 'card');
      const lost = path.join(base, 'lost+found');
      const locked = path.join(base, 'Locked');
      fs.mkdirSync(lost, { recursive: true });
      fs.writeFileSync(
        path.join(base, 'radar.onlinechart.json'),
        '{"catalogId":"radar","name":"Radar"}'
      );
      const readdir = fs.promises.readdir.bind(fs.promises);
      // Root ignores directory permissions, so the denial is simulated.
      const denied = new Set([lost, locked]);
      t.mock.method(fs.promises, 'readdir', (p: fs.PathLike, ...rest: unknown[]) => {
        if (denied.has(String(p))) {
          return Promise.reject(Object.assign(new Error('denied'), { code: 'EACCES' }));
        }
        return (readdir as (...a: unknown[]) => Promise<unknown>)(p, ...rest);
      });
      const refs = await findOnlineChartFiles(base, base, { strict: true });
      assert.deepStrictEqual(
        refs.map((r) => r.catalogId),
        ['radar']
      );
      fs.mkdirSync(locked);
      await assert.rejects(findOnlineChartFiles(base, base, { strict: true }));
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

describe('online charts added by URL', () => {
  const custom = { type: 'WMS' as const, url: 'https://w.example/ows', layers: ['a'] };

  it('keeps tiles under an id that follows the service', () => {
    const id = customChartId(custom);
    assert.match(id, /^custom-[0-9a-f]{12}$/);
    assert.strictEqual(customChartId({ ...custom, keepOffline: true }), id);
    assert.notStrictEqual(customChartId({ ...custom, layers: ['b'] }), id);
  });

  it('is kept offline only when the user allows it', () => {
    assert.strictEqual(customCatalogEntry(custom).offline, undefined);
    assert.deepStrictEqual(customCatalogEntry({ ...custom, keepOffline: true }).offline, {});
  });

  it('refuses placeholders the server cannot fill in, where it fills them in', () => {
    const url = 'https://{s}.tiles.example/{z}/{x}/{y}.png';
    assert.strictEqual(customOnlineChartProblem({ type: 'tilelayer', url }), null);
    assert.match(
      customOnlineChartProblem({ type: 'tilelayer', url, keepOffline: true }) ?? '',
      /\{s\}/
    );
  });

  it('skips a hand-edited chart that cannot be served', () => {
    const file = { catalogId: 'custom-x', custom: { type: 'tilelayer' as const, url: 'http://[' } };
    assert.strictEqual(
      onlineChartEntry(file, () => undefined),
      undefined
    );
  });

  it('refuses placeholders in a WMS address, where the server makes the requests', () => {
    assert.match(
      customOnlineChartProblem({ ...custom, url: 'https://w.example/ows?BBOX={bbox}' }) ?? '',
      /without placeholders/
    );
  });

  it('accepts TMS and shifted tile templates', () => {
    for (const url of ['https://t/{z}/{x}/{-y}.png', 'https://t/{z-2}/{y}/{x}']) {
      assert.strictEqual(customOnlineChartProblem({ type: 'tilelayer', url }), null, url);
    }
  });

  it('refuses a zoom offset that leaves no level the plugin serves', () => {
    assert.match(
      customOnlineChartProblem({ type: 'tilelayer', url: 'https://t/{z-30}/{x}/{y}.png' }) ?? '',
      /more than 24/
    );
  });
});

describe('chartFileNameBeside', () => {
  it('keeps a name whose chart id is free, or that replaces the same file', () => {
    assert.strictEqual(chartFileNameBeside('fiji.pmtiles', ['tonga.mbtiles']), 'fiji.pmtiles');
    assert.strictEqual(
      chartFileNameBeside('fiji.pmtiles', ['fiji.pmtiles', 'fiji.mbtiles']),
      'fiji.pmtiles'
    );
  });

  it('numbers a file that would share its chart id with another entry', () => {
    assert.strictEqual(chartFileNameBeside('fiji.pmtiles', ['fiji.mbtiles']), 'fiji-2.pmtiles');
    assert.strictEqual(
      chartFileNameBeside('fiji.mbtiles', ['fiji.pmtiles', 'fiji-2.onlinechart.json']),
      'fiji-3.mbtiles'
    );
    assert.strictEqual(chartFileNameBeside('Fiji.PMTILES', ['Fiji']), 'Fiji-2.PMTILES');
  });
});

describe('collectChartIds', () => {
  it('can leave out the charts directly in one folder, but not its subfolders', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chart-ids-'));
    try {
      fs.mkdirSync(path.join(root, 'a', 'b'), { recursive: true });
      fs.writeFileSync(path.join(root, 'top.mbtiles'), '');
      fs.writeFileSync(path.join(root, 'a', 'here.pmtiles'), '');
      fs.writeFileSync(path.join(root, 'a', 'b', 'deeper.mbtiles'), '');
      const ids = await collectChartIds(root, root, path.join(root, 'a'));
      assert.deepStrictEqual([...ids].sort(), ['deeper', 'top']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('chart ids taken elsewhere', () => {
  it('treats them as ids, not file names', () => {
    // `foo.mbtiles.pmtiles` elsewhere has the id `foo.mbtiles`.
    assert.strictEqual(
      chartFileNameBeside('foo.mbtiles.mbtiles', [], ['foo.mbtiles']),
      'foo.mbtiles-2.mbtiles'
    );
    assert.strictEqual(chartFileNameBeside('foo.mbtiles', [], ['foo.mbtiles']), 'foo.mbtiles');
    assert.deepStrictEqual(chartFileNamesBeside(['foo.pmtiles'], [], ['foo']), ['foo-2.pmtiles']);
  });
});

describe('chartFileNamesBeside', () => {
  it('never renames a staged file onto another staged file', () => {
    assert.deepStrictEqual(
      chartFileNamesBeside(['foo.mbtiles', 'foo-2.mbtiles'], ['foo.pmtiles']),
      ['foo-3.mbtiles', 'foo-2.mbtiles']
    );
  });

  it('renames the later of two staged files that share an id, not both', () => {
    assert.deepStrictEqual(chartFileNamesBeside(['foo.mbtiles', 'foo.pmtiles'], []), [
      'foo.mbtiles',
      'foo-2.pmtiles'
    ]);
  });

  it('keeps names that collide with nothing, and replaces the same file', () => {
    assert.deepStrictEqual(
      chartFileNamesBeside(['fiji.mbtiles', 'tonga.mbtiles'], ['fiji.mbtiles']),
      ['fiji.mbtiles', 'tonga.mbtiles']
    );
  });
});
