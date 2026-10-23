/**
 * Tests for staging a chart set's cells (`custom-catalog-download.ts`)
 * against a local HTTP server: one download per archive, only the selected
 * cells' files extracted, bare `.000` downloads, separately published
 * updates numbered on for GDAL, and per-host pacing.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import {
  baseEntryTarget,
  downloadAndExtractEncs,
  planArchiveJobs
} from '../dist/utils/custom-catalog-download.js';
import { buildEncIndexLookup, resolveChartSet } from '../dist/utils/enc-chart-set.js';
import type { EncIndexArchive, EncIndexUnit } from '../dist/catalog/enc-index-schema.js';

// A minimal STORED (uncompressed) ZIP, as in zip-extract.test.ts.
function storedZip(entries: { name: string; data: Buffer }[]): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    chunks.push(local, nameBuf, data);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(data.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cd, eocd]);
}

const b = (s: string) => Buffer.from(s, 'utf8');

const FILES: Record<string, Buffer> = {
  '/shared.zip': storedZip([
    { name: 'ENC_ROOT/CATALOG.031', data: b('catalog') },
    { name: 'ENC_ROOT/AA/AA1CELL1.000', data: b('cell1') },
    { name: 'ENC_ROOT/AA/AA1CELL1.001', data: b('cell1-up1') },
    { name: 'ENC_ROOT/AB/AA1CELL2.000', data: b('cell2') },
    { name: 'ENC_ROOT/AC/AA1OTHER.000', data: b('not selected') }
  ]),
  '/raw/3T5RHO01.000': b('rhone'),
  '/reissue.zip': storedZip([{ name: 'ENC_ROOT/EA200001.000', data: b('base-up40') }]),
  '/upd41.zip': storedZip([{ name: 'ENC_ROOT/EA200001.041', data: b('up41') }]),
  '/upd42.zip': storedZip([{ name: 'ENC_ROOT/EA200001.042', data: b('up42') }])
};

let server: http.Server;
let base = '';
const hits = new Map<string, number[]>();
let tmp = '';

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-download-'));
  server = http.createServer((req, res) => {
    const url = req.url ?? '';
    hits.set(url, [...(hits.get(url) ?? []), Date.now()]);
    const body = FILES[url];
    if (!body) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'Content-Length': body.length }).end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

after(() => {
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function unit(
  source: string,
  id: string,
  archive: string,
  p: string,
  version: string,
  extra = {}
): EncIndexUnit {
  return {
    source,
    id,
    title: id,
    bbox: [0, 0, 1, 1],
    outline: {
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 0]
        ]
      ]
    },
    cells: [{ name: id, archive, path: p, version, ...extra }],
    statusCells: [id]
  };
}

function plan(selectedUnitIds: string[]) {
  const shared = `${base}/shared.zip`;
  const units = [
    unit('PL', 'AA1CELL1', shared, 'ENC_ROOT/AA/AA1CELL1.000', 'AA1CELL1_ED001_UP001'),
    unit('PL', 'AA1CELL2', shared, 'ENC_ROOT/AB/AA1CELL2.000', 'AA1CELL2_ED001_UP000'),
    unit('PL', 'AA1OTHER', shared, 'ENC_ROOT/AC/AA1OTHER.000', 'AA1OTHER_ED001_UP000'),
    unit('RHONE', '3T5RHO01', `${base}/raw/3T5RHO01.000`, '3T5RHO01.000', '3T5RHO01_ED001_UP000'),
    unit(
      'SCS',
      'EA200001',
      `${base}/reissue.zip`,
      'ENC_ROOT/EA200001.000',
      'EA200001_ED002_UP040',
      {
        updatesPublishedSeparately: true
      }
    ),
    unit('X', 'XX1GONE0', `${base}/missing.zip`, 'XX1GONE0.000', 'XX1GONE0_ED001_UP000')
  ];
  const archives: EncIndexArchive[] = [
    { url: shared, source: 'PL', version: '2024-05-20T00:00:00Z', kind: 'zip' },
    {
      url: `${base}/raw/3T5RHO01.000`,
      source: 'RHONE',
      version: '2025-01-01T00:00:00Z',
      kind: 'cell'
    },
    { url: `${base}/reissue.zip`, source: 'SCS', version: '2012-06-15T00:00:00Z', kind: 'zip' },
    ...[41, 42, 43].map((n): EncIndexArchive => ({
      url: `${base}/upd${String(n)}.zip`,
      source: 'SCS',
      version: `2012-${String(n - 34).padStart(2, '0')}-15T00:00:00Z`,
      kind: 'zip',
      updates: [`ENC_ROOT/EA200001.${String(n).padStart(3, '0')}`]
    })),
    { url: `${base}/missing.zip`, source: 'X', version: '2020-01-01T00:00:00Z', kind: 'zip' }
  ];
  return resolveChartSet(buildEncIndexLookup(units, archives), {
    selectedBand4ChartIds: [],
    selectedUnitIds
  }).cells;
}

describe('baseEntryTarget', () => {
  it('takes the base file and the update files beside it', () => {
    const p = 'ENC_ROOT/AA/AA1CELL1.000';
    assert.strictEqual(baseEntryTarget('ENC_ROOT/AA/AA1CELL1.000', p), 'AA1CELL1.000');
    assert.strictEqual(baseEntryTarget('ENC_ROOT/AA/AA1CELL1.012', p), 'AA1CELL1.012');
    assert.strictEqual(baseEntryTarget('enc_root/aa/aa1cell1.001', p), 'aa1cell1.001');
  });

  it('leaves other cells, other folders and catalogue files', () => {
    const p = 'ENC_ROOT/AA/AA1CELL1.000';
    assert.strictEqual(baseEntryTarget('ENC_ROOT/AA/AA1CELL2.000', p), null);
    assert.strictEqual(baseEntryTarget('ENC_ROOT/AB/AA1CELL1.000', p), null);
    assert.strictEqual(baseEntryTarget('ENC_ROOT/AA/CATALOG.031', p), null);
    assert.strictEqual(baseEntryTarget('ENC_ROOT/AA/AA1CELL1.TXT', p), null);
  });
});

describe('planArchiveJobs', () => {
  it('downloads a shared archive once for all its cells', () => {
    const jobs = planArchiveJobs(plan(['AA1CELL1', 'AA1CELL2', 'EA200001']));
    const shared = jobs.filter((j) => j.url.endsWith('/shared.zip'));
    assert.strictEqual(shared.length, 1);
    assert.deepStrictEqual(
      shared[0].bases.map((x) => x.cell),
      ['AA1CELL1', 'AA1CELL2']
    );
    assert.deepStrictEqual(
      jobs.filter((j) => j.updates.length > 0).map((j) => j.updates[0].number),
      [41, 42, 43]
    );
  });
});

describe('downloadAndExtractEncs', () => {
  it('stages the selected cells from every kind of archive', async () => {
    hits.clear();
    const encDir = path.join(tmp, 'run1', 'enc');
    const cells = plan(['AA1CELL1', 'AA1CELL2', '3T5RHO01', 'EA200001', 'XX1GONE0']);
    const staged: string[] = [];
    const result = await downloadAndExtractEncs(
      cells,
      encDir,
      path.join(tmp, 'run1', 'zips'),
      { onStaged: (c) => staged.push(c) },
      { delayMs: 0 }
    );

    assert.deepStrictEqual([...result.staged].sort(), [
      '3T5RHO01',
      'AA1CELL1',
      'AA1CELL2',
      'EA200001'
    ]);
    assert.deepStrictEqual(
      result.failed.map((f) => f.chartId),
      ['XX1GONE0']
    );
    assert.deepStrictEqual([...staged].sort(), [...result.staged].sort());
    assert.strictEqual(hits.get('/shared.zip')?.length, 1, 'shared archive downloaded once');

    const read = (...p: string[]) => fs.readFileSync(path.join(encDir, ...p), 'utf8');
    assert.deepStrictEqual(fs.readdirSync(path.join(encDir, 'AA1CELL1')).sort(), [
      'AA1CELL1.000',
      'AA1CELL1.001'
    ]);
    assert.deepStrictEqual(fs.readdirSync(path.join(encDir, 'AA1CELL2')), ['AA1CELL2.000']);
    assert.ok(!fs.existsSync(path.join(encDir, 'AA1OTHER')), 'unselected cell left in the archive');
    assert.strictEqual(read('3T5RHO01', '3T5RHO01.000'), 'rhone');

    // The reissued base has no .001-.040 beside it, so GDAL would never reach
    // .041: the separate updates are numbered on from what is there. Update
    // 43 does not exist, so the run stops after 42.
    assert.deepStrictEqual(fs.readdirSync(path.join(encDir, 'EA200001')).sort(), [
      'EA200001.000',
      'EA200001.001',
      'EA200001.002'
    ]);
    assert.strictEqual(read('EA200001', 'EA200001.001'), 'up41');
    assert.strictEqual(read('EA200001', 'EA200001.002'), 'up42');

    assert.deepStrictEqual(result.versions, {
      '3T5RHO01': '3T5RHO01_ED001_UP000',
      AA1CELL1: 'AA1CELL1_ED001_UP001',
      AA1CELL2: 'AA1CELL2_ED001_UP000',
      EA200001: 'EA200001_ED002_UP042'
    });
  });

  it('pauses between requests to the same host', async () => {
    hits.clear();
    const result = await downloadAndExtractEncs(
      plan(['AA1CELL1', '3T5RHO01']),
      path.join(tmp, 'run2', 'enc'),
      path.join(tmp, 'run2', 'zips'),
      {},
      { delayMs: 150 }
    );
    assert.strictEqual(result.staged.length, 2);
    const times = [...hits.values()].flat().sort((x, y) => x - y);
    assert.strictEqual(times.length, 2);
    assert.ok(times[1] - times[0] >= 140, `requests ${String(times[1] - times[0])} ms apart`);
  });

  it('stops before the next archive once aborted', async () => {
    hits.clear();
    let first = true;
    const result = await downloadAndExtractEncs(
      plan(['AA1CELL1', '3T5RHO01']),
      path.join(tmp, 'run3', 'enc'),
      path.join(tmp, 'run3', 'zips'),
      {
        isAborted: () => {
          const abort = !first;
          first = false;
          return abort;
        }
      },
      { delayMs: 0 }
    );
    assert.strictEqual(result.staged.length, 1);
    assert.strictEqual([...hits.values()].flat().length, 1);
  });
});

describe('a server whose headers Node refuses', () => {
  // Answers like the Brazilian Navy's server: a long header folded onto a
  // second line, on the redirect and on the file.
  const folded = "Content-Security-Policy: default-src 'self';\r\n       img-src 'self';\r\n";
  const body = 'folded-cell';
  let folding: net.Server;
  let url = '';

  before(async () => {
    folding = net.createServer((socket) => {
      socket.once('data', (data: Buffer) => {
        const line = data.toString('latin1').split('\r\n')[0];
        if (line.startsWith('GET /start ')) {
          socket.end(
            `HTTP/1.1 302 Found\r\nLocation: /BR7FOLD1.000\r\n${folded}Content-Length: 0\r\nConnection: close\r\n\r\n`
          );
        } else {
          socket.end(
            `HTTP/1.1 200 OK\r\n${folded}Content-Length: ${String(body.length)}\r\nConnection: close\r\n\r\n${body}`
          );
        }
      });
    });
    await new Promise<void>((resolve) => folding.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${String((folding.address() as AddressInfo).port)}/start`;
  });

  after(() => {
    folding.close();
  });

  it('retries with header parsing relaxed, following the redirect', async () => {
    const lookup = buildEncIndexLookup(
      [unit('BR', 'BR7FOLD1', url, 'BR7FOLD1.000', 'BR7FOLD1_ED001_UP000')],
      [{ url, source: 'BR', version: '2024-01-01T00:00:00Z', kind: 'cell' }]
    );
    const cells = resolveChartSet(lookup, {
      selectedBand4ChartIds: [],
      selectedUnitIds: ['BR7FOLD1']
    }).cells;
    const encDir = path.join(tmp, 'folded', 'enc');
    const result = await downloadAndExtractEncs(
      cells,
      encDir,
      path.join(tmp, 'folded', 'zips'),
      {},
      { delayMs: 0 }
    );
    assert.deepStrictEqual(result.staged, ['BR7FOLD1']);
    assert.strictEqual(
      fs.readFileSync(path.join(encDir, 'BR7FOLD1', 'BR7FOLD1.000'), 'utf8'),
      body
    );
  });

  it('refuses a bare cell whose file name is a path', async () => {
    const lookup = buildEncIndexLookup(
      [unit('BR', 'BR7FOLD2', url, '..\\BR7FOLD2.000', 'BR7FOLD2_ED001_UP000')],
      [{ url, source: 'BR', version: '2024-01-01T00:00:00Z', kind: 'cell' }]
    );
    const cells = resolveChartSet(lookup, {
      selectedBand4ChartIds: [],
      selectedUnitIds: ['BR7FOLD2']
    }).cells;
    const result = await downloadAndExtractEncs(
      cells,
      path.join(tmp, 'unsafe', 'enc'),
      path.join(tmp, 'unsafe', 'zips'),
      {},
      { delayMs: 0 }
    );
    assert.deepStrictEqual(result.staged, []);
    assert.match(result.failed[0]?.error ?? '', /unexpected file name/);
  });
});
