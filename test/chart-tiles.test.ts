/**
 * The `chartTiles` PropertyValue: peer plugins (signalk-collision-alerts)
 * read chart tiles in-process, as the tile route serves them.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import type { Plugin } from '@signalk/server-api';
import type { ChartProvider, ChartTiles, ExtendedServerAPI } from '../dist/types.js';
import pluginFactoryDefault, {
  chartTilesOf,
  readLocalTile,
  serveTileFromMbtiles
} from '../dist/index.js';
import { MBTilesReader } from '../dist/utils/mbtiles-reader.js';
import { downloadManager } from '../dist/utils/download-manager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pluginFactory = pluginFactoryDefault as unknown as (app: ExtendedServerAPI) => Plugin;
const FIXTURES = path.join(__dirname, '..', 'test', 'fixtures');
const VECTOR_MBTILES = path.join(FIXTURES, 'test-vector-chart.mbtiles');
const RASTER_MBTILES = path.join(FIXTURES, 'test-chart.mbtiles');

after(() => {
  downloadManager.removeAllListeners();
});

const isGzip = (tile: unknown): boolean =>
  tile instanceof Uint8Array && tile[0] === 0x1f && tile[1] === 0x8b;

/** The body the tile route answers with, or null for a 404. */
function served(chart: ChartProvider, z: number, x: number, y: number): Promise<unknown> {
  return new Promise((resolve) => {
    const res = {
      writeHead: () => res,
      end: (data?: unknown) => {
        resolve(data);
      },
      sendStatus: (code: number) => {
        resolve(code === 404 ? null : code);
      }
    };
    serveTileFromMbtiles(
      res as unknown as Parameters<typeof serveTileFromMbtiles>[0],
      chart,
      z,
      x,
      y
    );
  });
}

/** Every tile of zooms `from` to `to`, as [z, x, y]. */
function tilesOf(from: number, to: number): [number, number, number][] {
  const tiles: [number, number, number][] = [];
  for (let z = from; z <= to; z++) {
    for (let x = 0; x < 2 ** z; x++) {
      for (let y = 0; y < 2 ** z; y++) {
        tiles.push([z, x, y]);
      }
    }
  }
  return tiles;
}

const mbtilesChart = (reader: MBTilesReader, format: string): ChartProvider =>
  ({
    identifier: 'test',
    format,
    _fileFormat: 'mbtiles',
    _mbtilesHandle: reader
  }) as unknown as ChartProvider;

describe('readLocalTile()', () => {
  let vector!: MBTilesReader;
  let raster!: MBTilesReader;

  before(() => {
    vector = new MBTilesReader(VECTOR_MBTILES);
    raster = new MBTilesReader(RASTER_MBTILES);
  });

  after(() => {
    vector.close();
    raster.close();
  });

  it('reads a vector chart as the tile route serves it', async () => {
    const chart = mbtilesChart(vector, 'pbf');
    for (const [z, x, y] of tilesOf(0, 5)) {
      assert.deepStrictEqual(await readLocalTile(chart, z, x, y), await served(chart, z, x, y));
    }
    // Among them a coverage hole and a stored tile that renders blank, both
    // synthesized, a stored tile, and none.
    assert.ok(isGzip(await readLocalTile(chart, 5, 1, 14)));
    assert.ok(isGzip(await readLocalTile(chart, 4, 0, 7)));
    assert.deepStrictEqual(await readLocalTile(chart, 2, 0, 1), vector.getTile(2, 0, 1)?.data);
    assert.strictEqual(await readLocalTile(chart, 3, 7, 7), null);
  });

  it('reads a raster chart as the tile route serves it, holes filled', async () => {
    const chart = mbtilesChart(raster, 'png');
    let filled = 0;
    for (const [z, x, y] of tilesOf(0, 3)) {
      const tile = await readLocalTile(chart, z, x, y);
      assert.deepStrictEqual(tile, await served(chart, z, x, y), `tile ${z}/${x}/${y}`);
      if (tile && !raster.getTile(z, x, y)) {
        filled++;
      }
    }
    assert.ok(filled > 0, 'some tiles should be synthesized for holes');
  });

  it('reads a tile directory, its rows flipped when it says so', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chart-tiles-'));
    try {
      fs.mkdirSync(path.join(dir, '3', '1'), { recursive: true });
      fs.writeFileSync(path.join(dir, '3', '1', '2.pbf'), Buffer.from([1, 2, 3]));
      const chart = (flipY: boolean) =>
        ({
          identifier: 'dir',
          format: 'pbf',
          _fileFormat: 'directory',
          _filePath: dir,
          _flipY: flipY
        }) as unknown as ChartProvider;
      assert.deepStrictEqual(await readLocalTile(chart(false), 3, 1, 2), Buffer.from([1, 2, 3]));
      assert.strictEqual(await readLocalTile(chart(false), 3, 1, 3), null);
      // Row 5 counted from the south is row 2 counted from the north at z3.
      assert.deepStrictEqual(await readLocalTile(chart(true), 3, 1, 5), Buffer.from([1, 2, 3]));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads no online chart and no tile off the grid', async () => {
    const online = {
      identifier: 'osm',
      format: 'png',
      _fileFormat: 'online'
    } as unknown as ChartProvider;
    assert.strictEqual(await readLocalTile(online, 2, 0, 1), null);
    const chart = mbtilesChart(vector, 'pbf');
    assert.strictEqual(await readLocalTile(chart, -1, 0, 0), null);
    assert.strictEqual(await readLocalTile(chart, 2, 0.5, 1), null);
  });
});

describe('chartTilesOf()', () => {
  it('reads the charts served at each read, and no online or unknown chart', async () => {
    const vector = new MBTilesReader(VECTOR_MBTILES);
    try {
      let charts: Record<string, ChartProvider> = {};
      const tiles = chartTilesOf(() => charts);
      assert.strictEqual(await tiles.getTile('enc', 2, 0, 1), undefined);
      charts = {
        enc: mbtilesChart(vector, 'pbf'),
        osm: { identifier: 'osm', format: 'png', _fileFormat: 'online' } as unknown as ChartProvider
      };
      assert.deepStrictEqual(await tiles.getTile('enc', 2, 0, 1), vector.getTile(2, 0, 1)?.data);
      assert.strictEqual(await tiles.getTile('enc', 3, 7, 7), null);
      assert.strictEqual(await tiles.getTile('osm', 2, 0, 1), undefined);
      assert.strictEqual(await tiles.getTile('toString', 2, 0, 1), undefined);
    } finally {
      vector.close();
    }
  });

  it('lists the charts it reads, an Open Data Charts set marked, no online chart', () => {
    const coverage = [{ minzoom: 9, tiles: ['9/248/178'] }];
    const odc = {
      identifier: 'brittany',
      name: 'Brittany',
      type: 'S-57',
      format: 'pbf',
      bounds: [-5.625, 47.5, -4.9, 48.0],
      minzoom: 9,
      maxzoom: 17,
      coverage,
      _fileFormat: 'mbtiles',
      _openDataSet: 'brittany'
    } as unknown as ChartProvider;
    const enc = {
      identifier: 'enc',
      name: 'ENC',
      type: 'S-57',
      format: 'pbf',
      bounds: undefined,
      minzoom: 0,
      maxzoom: 5,
      _fileFormat: 'pmtiles'
    } as unknown as ChartProvider;
    const osm = {
      identifier: 'osm',
      format: 'png',
      _fileFormat: 'online'
    } as unknown as ChartProvider;
    const tiles = chartTilesOf(() => ({ brittany: odc, enc, osm }));
    const listed = tiles.charts();
    assert.deepStrictEqual(listed, [
      {
        id: 'brittany',
        name: 'Brittany',
        type: 'S-57',
        format: 'pbf',
        bounds: [-5.625, 47.5, -4.9, 48.0],
        minzoom: 9,
        maxzoom: 17,
        coverage,
        openDataSet: 'brittany'
      },
      { id: 'enc', name: 'ENC', type: 'S-57', format: 'pbf', minzoom: 0, maxzoom: 5 }
    ]);
    // A copy: what a peer plugin does with the list leaves the chart as it is.
    listed[0]?.coverage?.[0]?.tiles.push('9/0/0');
    assert.deepStrictEqual(odc.coverage, [{ minzoom: 9, tiles: ['9/248/178'] }]);
  });
});

describe('chartTiles PropertyValue', () => {
  it('is offered once per server process and reads charts while the plugin runs', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chart-tiles-plugin-'));
    const chartPath = path.join(tempDir, 'charts');
    fs.mkdirSync(chartPath, { recursive: true });
    fs.copyFileSync(VECTOR_MBTILES, path.join(chartPath, 'enc.mbtiles'));
    fs.copyFileSync(VECTOR_MBTILES, path.join(chartPath, 'odc.mbtiles'));
    const odc = new DatabaseSync(path.join(chartPath, 'odc.mbtiles'));
    odc.prepare("INSERT INTO metadata (name, value) VALUES ('x-odc-set', 'brittany')").run();
    odc.close();
    const dataDir = path.join(tempDir, 'plugin-config-data', 'signalk-charts-provider-simple');
    fs.mkdirSync(dataDir, { recursive: true });

    const offered: { name: string; value: unknown }[] = [];
    let resources:
      { methods: { listResources: (q: object) => Promise<Record<string, object>> } } | undefined;
    const app = {
      config: { configPath: tempDir, ssl: false, version: '2.0.0', getExternalPort: () => 3000 },
      debug: () => {},
      error: () => {},
      setPluginStatus: () => {},
      setPluginError: () => {},
      getDataDirPath: () => dataDir,
      registerResourceProvider: (p: typeof resources) => {
        resources = p;
      },
      handleMessage: () => {},
      emitPropertyValue: (name: string, value: unknown) => {
        offered.push({ name, value });
      },
      subscriptionmanager: { subscribe: () => {}, unsubscribe: () => {} }
    } as unknown as ExtendedServerAPI;

    const plugin = pluginFactory(app);
    const until = async (done: () => Promise<boolean>) => {
      const deadline = Date.now() + 5000;
      while (!(await done())) {
        assert.ok(Date.now() < deadline, 'timed out');
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    };
    const ofName = (name: string) => offered.filter((o) => o.name === name);
    const tiles = () => ofName('chartTiles')[0]?.value as ChartTiles | undefined;
    const stored = () => tiles()?.getTile('enc', 2, 0, 1);

    try {
      // No WFS proxy: stopped, it keeps its store open in the data dir for the next start,
      // and on Windows the folder cannot then be removed.
      plugin.start({ chartPath, wfsProxy: false }, () => {});
      await until(async () => (await stored()) instanceof Uint8Array);
      assert.strictEqual(await tiles()?.getTile('enc', 3, 7, 7), null);
      assert.strictEqual(await tiles()?.getTile('other', 2, 0, 1), undefined);
      assert.strictEqual(await tiles()?.getTile('__proto__', 2, 0, 1), undefined);
      const listed = tiles()?.charts() ?? [];
      assert.deepStrictEqual(listed.map((c) => [c.id, c.openDataSet]).sort(), [
        ['enc', undefined],
        ['odc', 'brittany']
      ]);
      // The mark is for chartTiles readers; chart resources keep their published shape.
      const odcResource = (await resources?.methods.listResources({}))?.odc;
      assert.ok(odcResource);
      assert.ok(!('_openDataSet' in odcResource));

      await plugin.stop?.();
      assert.strictEqual(await stored(), undefined);

      // A config save restarts the plugin: the same offer reads the charts again.
      plugin.start({ chartPath, wfsProxy: false }, () => {});
      await until(async () => (await stored()) instanceof Uint8Array);
      assert.strictEqual(ofName('chartTiles').length, 1);
    } finally {
      await plugin.stop?.();
      fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});
