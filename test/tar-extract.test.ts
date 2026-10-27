import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { extractTarArchive } from '../dist/utils/tar-extract.js';

interface Entry {
  name: string;
  data?: string;
  type?: string;
  linkname?: string;
}

/** One 512-byte ustar header. */
function header(name: string, size: number, type: string, linkname = ''): Buffer {
  const h = Buffer.alloc(512);
  h.write(name.slice(0, 100), 0, 'utf8');
  h.write('0000644\0', 100, 'latin1');
  h.write('0000000\0', 108, 'latin1');
  h.write('0000000\0', 116, 'latin1');
  h.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 'latin1');
  h.write('00000000000\0', 136, 'latin1');
  h.write('        ', 148, 'latin1');
  h.write(type, 156, 'latin1');
  h.write(linkname, 157, 'utf8');
  h.write('ustar\0', 257, 'latin1');
  h.write('00', 263, 'latin1');
  let sum = 0;
  for (const b of h) {
    sum += b;
  }
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1');
  return h;
}

function pad(data: Buffer): Buffer {
  const rest = data.length % 512;
  return rest === 0 ? data : Buffer.concat([data, Buffer.alloc(512 - rest)]);
}

function tar(entries: Entry[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    const data = Buffer.from(e.data ?? '', 'utf8');
    parts.push(header(e.name, data.length, e.type ?? '0', e.linkname), pad(data));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  let len = body.length + 1;
  while (String(len).length + body.length !== len) {
    len = String(len).length + body.length;
  }
  return `${String(len)}${body}`;
}

describe('extractTarArchive', () => {
  let tmp: string;

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-charts-tar-'));
  });

  after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const archive = (name: string, bytes: Buffer): string => {
    const file = path.join(tmp, name);
    fs.writeFileSync(file, bytes);
    return file;
  };

  it('extracts files and directories, keeping the structure', async () => {
    const big = 'x'.repeat(70000);
    const file = archive(
      'plain.tar',
      tar([
        { name: 'charts/', type: '5' },
        { name: 'charts/Med01.kap', data: 'KAP1' },
        { name: 'charts/big.bin', data: big },
        { name: 'readme.txt', data: 'hello' }
      ])
    );
    const out = path.join(tmp, 'plain');
    const written = await extractTarArchive(file, out);
    assert.deepStrictEqual(
      written.map((f) => path.relative(out, f)).sort(),
      ['charts/Med01.kap', 'charts/big.bin', 'readme.txt'].map((p) => path.join(...p.split('/')))
    );
    assert.strictEqual(fs.readFileSync(path.join(out, 'charts', 'Med01.kap'), 'utf8'), 'KAP1');
    assert.strictEqual(fs.readFileSync(path.join(out, 'charts', 'big.bin'), 'utf8'), big);
  });

  it('reads gzip-compressed archives', async () => {
    const file = archive('a.tar.gz', zlib.gzipSync(tar([{ name: 'a.shp', data: 'SHP' }])));
    const out = path.join(tmp, 'gz');
    await extractTarArchive(file, out);
    assert.strictEqual(fs.readFileSync(path.join(out, 'a.shp'), 'utf8'), 'SHP');
  });

  it('reads xz-compressed archives', async (t) => {
    const raw = archive('b.tar', tar([{ name: 'nested/b.shp', data: 'XZ!' }]));
    const xz = spawnSync('xz', ['-k', '-f', raw]);
    if (xz.error || xz.status !== 0) {
      t.skip('xz is not installed');
      return;
    }
    const out = path.join(tmp, 'xz');
    await extractTarArchive(`${raw}.xz`, out);
    assert.strictEqual(fs.readFileSync(path.join(out, 'nested', 'b.shp'), 'utf8'), 'XZ!');
  });

  it('takes long names from GNU and PAX headers', async () => {
    const longName = `${'d'.repeat(80)}/${'f'.repeat(80)}.kap`;
    const paxName = `${'p'.repeat(120)}.kap`;
    const file = archive(
      'long.tar',
      tar([
        { name: '././@LongLink', type: 'L', data: `${longName}\0` },
        { name: 'truncated', data: 'gnu' },
        { name: 'PaxHeader', type: 'x', data: paxRecord('path', paxName) },
        { name: 'short', data: 'pax' }
      ])
    );
    const out = path.join(tmp, 'long');
    await extractTarArchive(file, out);
    assert.strictEqual(fs.readFileSync(path.join(out, ...longName.split('/')), 'utf8'), 'gnu');
    assert.strictEqual(fs.readFileSync(path.join(out, paxName), 'utf8'), 'pax');
  });

  it('skips links rather than following them', async () => {
    const file = archive(
      'links.tar',
      tar([
        { name: 'evil', type: '2', linkname: '/etc/passwd' },
        { name: 'ok.txt', data: 'fine' }
      ])
    );
    const out = path.join(tmp, 'links');
    const written = await extractTarArchive(file, out);
    assert.deepStrictEqual(written, [path.join(out, 'ok.txt')]);
    assert.strictEqual(fs.existsSync(path.join(out, 'evil')), false);
  });

  it('refuses entries that escape the target directory', async () => {
    const file = archive('slip.tar', tar([{ name: '../escaped.txt', data: 'no' }]));
    const out = path.join(tmp, 'slip');
    await assert.rejects(extractTarArchive(file, out), /escapes the extraction directory/);
    assert.strictEqual(fs.existsSync(path.join(tmp, 'escaped.txt')), false);
  });

  it('enforces the size budget on the bytes written', async () => {
    const file = archive('bomb.tar', tar([{ name: 'big', data: 'y'.repeat(5000) }]));
    await assert.rejects(
      extractTarArchive(file, path.join(tmp, 'bomb'), { maxTotalBytes: 1000 }),
      /expands past/
    );
  });

  it('holds long-name and PAX header data to the size budget', async () => {
    const file = archive(
      'meta-bomb.tar',
      tar([
        { name: 'PaxHeader', type: 'x', data: paxRecord('comment', 'c'.repeat(5000)) },
        { name: 'short', data: 'pax' }
      ])
    );
    await assert.rejects(
      extractTarArchive(file, path.join(tmp, 'meta-bomb'), { maxTotalBytes: 1000 }),
      /expands past/
    );
  });

  it('rejects a truncated archive', async () => {
    const whole = tar([{ name: 'cut.bin', data: 'z'.repeat(3000) }]);
    const file = archive('cut.tar', whole.subarray(0, 1024));
    await assert.rejects(extractTarArchive(file, path.join(tmp, 'cut')), /truncated/);
  });
});
