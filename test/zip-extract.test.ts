import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { after, before, describe, it } from 'node:test';
import {
  extractMbtilesFromZip,
  extractZipSafely,
  ZipLimitError
} from '../dist/utils/zip-extract.js';

let TMP: string;

// Build a minimal STORED (uncompressed) ZIP on disk so these tests need no
// archiver dependency: local file headers + central directory +
// end-of-central-directory, method 0 throughout. Mirrors the helper in
// download-manager.test.ts.
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
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    chunks.push(local, nameBuf, data);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0, 10);
    cen.writeUInt16LE(0x21, 14);
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

/**
 * Build a single-entry DEFLATE ZIP whose central directory *understates* the
 * uncompressed size. This is the zip-bomb shape that a pre-flight check on
 * declared sizes cannot catch: the archive looks tiny and honest until the
 * stream is actually decompressed.
 */
function lyingDeflateZip(name: string, real: Buffer, declaredSize: number): Buffer {
  const nameBuf = Buffer.from(name, 'utf8');
  const deflated = zlib.deflateRawSync(real);
  const crc = zlib.crc32(real);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8); // method: DEFLATE
  local.writeUInt16LE(0x21, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(deflated.length, 18);
  local.writeUInt32LE(declaredSize, 22); // the lie
  local.writeUInt16LE(nameBuf.length, 26);

  const cen = Buffer.alloc(46);
  cen.writeUInt32LE(0x02014b50, 0);
  cen.writeUInt16LE(20, 4);
  cen.writeUInt16LE(20, 6);
  cen.writeUInt16LE(8, 10); // method: DEFLATE
  cen.writeUInt16LE(0x21, 14);
  cen.writeUInt32LE(crc, 16);
  cen.writeUInt32LE(deflated.length, 20);
  cen.writeUInt32LE(declaredSize, 24); // the lie
  cen.writeUInt16LE(nameBuf.length, 28);
  cen.writeUInt32LE(0, 42);

  const cd = Buffer.concat([cen, nameBuf]);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(30 + nameBuf.length + deflated.length, 16);

  return Buffer.concat([local, nameBuf, deflated, cd, eocd]);
}

function writeZip(name: string, entries: { name: string; data: Buffer }[]): string {
  const zipPath = path.join(TMP, name);
  fs.writeFileSync(zipPath, storedZip(entries));
  return zipPath;
}

function destDir(name: string): string {
  return fs.mkdtempSync(path.join(TMP, `${name}-`));
}

before(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zip-extract-test-'));
});

after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('extractMbtilesFromZip', () => {
  it('extracts only .mbtiles entries, flattened to basenames', async () => {
    const zip = writeZip('multi.zip', [
      { name: 'charts/a.mbtiles', data: Buffer.from('AAA') },
      { name: 'charts/nested/deep/b.mbtiles', data: Buffer.from('BBB') },
      { name: 'readme.txt', data: Buffer.from('hello') },
      { name: 'charts/notes.md', data: Buffer.from('notes') }
    ]);
    const dest = destDir('multi');

    const result = await extractMbtilesFromZip(zip, dest);

    assert.deepEqual(result.files.sort(), ['a.mbtiles', 'b.mbtiles']);
    assert.equal(result.skipped, 2);
    assert.deepEqual(fs.readdirSync(dest).sort(), ['a.mbtiles', 'b.mbtiles']);
    assert.equal(fs.readFileSync(path.join(dest, 'a.mbtiles'), 'utf8'), 'AAA');
    assert.equal(fs.readFileSync(path.join(dest, 'b.mbtiles'), 'utf8'), 'BBB');
  });

  it('matches the .mbtiles suffix case-insensitively', async () => {
    const zip = writeZip('case.zip', [{ name: 'FOO.MBTILES', data: Buffer.from('X') }]);
    const dest = destDir('case');

    const result = await extractMbtilesFromZip(zip, dest);

    assert.deepEqual(result.files, ['FOO.MBTILES']);
  });

  it('disambiguates same-named charts from different folders', async () => {
    const zip = writeZip('dup.zip', [
      { name: 'east/chart.mbtiles', data: Buffer.from('EAST') },
      { name: 'west/chart.mbtiles', data: Buffer.from('WEST') },
      { name: 'north/chart.mbtiles', data: Buffer.from('NORTH') }
    ]);
    const dest = destDir('dup');

    const result = await extractMbtilesFromZip(zip, dest);

    assert.deepEqual(result.files, ['chart.mbtiles', 'chart-2.mbtiles', 'chart-3.mbtiles']);
    // No entry is lost to a silent overwrite.
    assert.equal(fs.readFileSync(path.join(dest, 'chart.mbtiles'), 'utf8'), 'EAST');
    assert.equal(fs.readFileSync(path.join(dest, 'chart-2.mbtiles'), 'utf8'), 'WEST');
    assert.equal(fs.readFileSync(path.join(dest, 'chart-3.mbtiles'), 'utf8'), 'NORTH');
  });

  it('disambiguates names that collide only by case', async () => {
    // Distinct entries in the archive, but the same file on Windows and
    // macOS. Keying collisions on the exact basename would let the second
    // overwrite the first and report a chart that isn't there.
    const zip = writeZip('dupcase.zip', [
      { name: 'east/Chart.mbtiles', data: Buffer.from('EAST') },
      { name: 'west/chart.mbtiles', data: Buffer.from('WEST') }
    ]);
    const dest = destDir('dupcase');

    const result = await extractMbtilesFromZip(zip, dest);

    assert.equal(result.files.length, 2);
    // Every returned name must name a file that actually exists.
    for (const name of result.files) {
      assert.ok(fs.existsSync(path.join(dest, name)), `${name} missing on disk`);
    }
    // The two names differ by more than case, so neither can shadow the
    // other on a case-insensitive filesystem.
    const lowered = result.files.map((f) => f.toLowerCase());
    assert.equal(new Set(lowered).size, 2, `names still collide: ${result.files.join(', ')}`);
  });

  it('flattens traversal paths instead of escaping destDir', async () => {
    const zip = writeZip('slip.zip', [
      { name: '../../../evil.mbtiles', data: Buffer.from('EVIL') },
      { name: 'ok.mbtiles', data: Buffer.from('OK') }
    ]);
    const dest = destDir('slip');

    const result = await extractMbtilesFromZip(zip, dest);

    // The traversal entry is kept but declawed: written as a bare basename
    // inside destDir, never above it.
    assert.deepEqual(result.files.sort(), ['evil.mbtiles', 'ok.mbtiles']);
    for (const name of result.files) {
      assert.equal(path.dirname(path.join(dest, name)), dest);
    }
    assert.ok(!fs.existsSync(path.join(dest, '..', '..', '..', 'evil.mbtiles')));
  });

  it('returns an empty result for an archive with no charts', async () => {
    const zip = writeZip('empty.zip', [{ name: 'readme.txt', data: Buffer.from('nothing') }]);
    const dest = destDir('empty');

    const result = await extractMbtilesFromZip(zip, dest);

    assert.deepEqual(result.files, []);
    assert.equal(result.skipped, 1);
  });

  it('rejects an archive with too many entries before writing anything', async () => {
    const entries = Array.from({ length: 5 }, (_, i) => ({
      name: `c${i}.mbtiles`,
      data: Buffer.from('x')
    }));
    const zip = writeZip('many.zip', entries);
    const dest = destDir('many');

    await assert.rejects(
      () => extractMbtilesFromZip(zip, dest, { maxEntries: 3 }),
      (err: unknown) => err instanceof ZipLimitError
    );
    assert.deepEqual(fs.readdirSync(dest), []);
  });

  it('rejects an archive declaring more uncompressed bytes than allowed', async () => {
    const zip = writeZip('big.zip', [{ name: 'big.mbtiles', data: Buffer.alloc(4096, 0x41) }]);
    const dest = destDir('big');

    await assert.rejects(
      () => extractMbtilesFromZip(zip, dest, { maxTotalBytes: 100 }),
      (err: unknown) => err instanceof ZipLimitError
    );
    assert.deepEqual(fs.readdirSync(dest), []);
  });

  it('stops a lying DEFLATE entry mid-stream instead of after it is on disk', async () => {
    // 32 MB of zeros deflates to a few KB, but the header claims 1000 bytes,
    // so the declared-size pre-check waves it through. Only enforcing the
    // budget *while* streaming catches this — checking after the write means
    // the disk already took the hit.
    const REAL = 32 * 1024 * 1024;
    const CAP = 1024 * 1024;
    const zipPath = path.join(TMP, 'lying.zip');
    fs.writeFileSync(zipPath, lyingDeflateZip('bomb.mbtiles', Buffer.alloc(REAL, 0), 1000));
    const dest = destDir('lying');

    // The archive itself is tiny — this is not caught by a file-size limit.
    assert.ok(fs.statSync(zipPath).size < CAP);

    await assert.rejects(
      () => extractMbtilesFromZip(zipPath, dest, { maxTotalBytes: CAP }),
      (err: unknown) => err instanceof ZipLimitError
    );

    // Nothing partial is left behind, and nothing near the real size was
    // ever written.
    assert.deepEqual(fs.readdirSync(dest), []);
  });

  it('reports progress per extracted chart', async () => {
    const zip = writeZip('progress.zip', [
      { name: 'a.mbtiles', data: Buffer.from('A') },
      { name: 'skipme.txt', data: Buffer.from('T') },
      { name: 'b.mbtiles', data: Buffer.from('B') }
    ]);
    const dest = destDir('progress');
    const seen: { done: number; total: number; name: string }[] = [];

    await extractMbtilesFromZip(
      zip,
      dest,
      {},
      { onEntry: (done, total, name) => seen.push({ done, total, name }) }
    );

    // Totals count charts, not archive entries.
    assert.deepEqual(seen, [
      { done: 1, total: 2, name: 'a.mbtiles' },
      { done: 2, total: 2, name: 'b.mbtiles' }
    ]);
  });

  it('rejects a file that is not a ZIP at all', async () => {
    const notZip = path.join(TMP, 'not-a-zip.zip');
    fs.writeFileSync(notZip, Buffer.from('this is plain text, not an archive'));
    const dest = destDir('notzip');

    await assert.rejects(() => extractMbtilesFromZip(notZip, dest));
  });
});

describe('extractZipSafely', () => {
  it('preserves the archive directory structure', async () => {
    const zip = writeZip('tree.zip', [
      { name: 'ENC_ROOT/US5NY1CM/US5NY1CM.000', data: Buffer.from('CELL') },
      { name: 'ENC_ROOT/CATALOG.031', data: Buffer.from('CAT') }
    ]);
    const dest = destDir('tree');

    const written = await extractZipSafely(zip, dest);

    assert.equal(written, 2);
    assert.equal(
      fs.readFileSync(path.join(dest, 'ENC_ROOT/US5NY1CM/US5NY1CM.000'), 'utf8'),
      'CELL'
    );
    assert.equal(fs.readFileSync(path.join(dest, 'ENC_ROOT/CATALOG.031'), 'utf8'), 'CAT');
  });

  it('skips entries that would escape destDir', async () => {
    const zip = writeZip('escape.zip', [
      { name: '../escaped.txt', data: Buffer.from('NOPE') },
      { name: 'inside.txt', data: Buffer.from('YES') }
    ]);
    const dest = destDir('escape');

    const written = await extractZipSafely(zip, dest);

    assert.equal(written, 1);
    assert.deepEqual(fs.readdirSync(dest), ['inside.txt']);
    assert.ok(!fs.existsSync(path.join(dest, '..', 'escaped.txt')));
  });

  it('enforces the entry-count limit', async () => {
    const zip = writeZip('tree-many.zip', [
      { name: 'a.txt', data: Buffer.from('a') },
      { name: 'b.txt', data: Buffer.from('b') }
    ]);
    const dest = destDir('tree-many');

    await assert.rejects(
      () => extractZipSafely(zip, dest, { maxEntries: 1 }),
      (err: unknown) => err instanceof ZipLimitError
    );
  });

  it('enforces the declared uncompressed-size limit', async () => {
    const zip = writeZip('tree-big.zip', [{ name: 'big.bin', data: Buffer.alloc(4096, 0x42) }]);
    const dest = destDir('tree-big');

    await assert.rejects(
      () => extractZipSafely(zip, dest, { maxTotalBytes: 100 }),
      (err: unknown) => err instanceof ZipLimitError
    );
    assert.deepEqual(fs.readdirSync(dest), []);
  });

  it('stops a lying DEFLATE entry mid-stream', async () => {
    const zipPath = path.join(TMP, 'tree-lying.zip');
    fs.writeFileSync(
      zipPath,
      lyingDeflateZip('ENC_ROOT/bomb.000', Buffer.alloc(32 * 1024 * 1024, 0), 1000)
    );
    const dest = destDir('tree-lying');

    await assert.rejects(
      () => extractZipSafely(zipPath, dest, { maxTotalBytes: 1024 * 1024 }),
      (err: unknown) => err instanceof ZipLimitError
    );
    // The partial entry is cleaned up, leaving only the empty parent dir the
    // extractor created for it.
    assert.ok(!fs.existsSync(path.join(dest, 'ENC_ROOT', 'bomb.000')));
  });
});
