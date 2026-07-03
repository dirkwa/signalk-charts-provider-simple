import { describe, it } from 'node:test';
import assert from 'node:assert';

import { shellQuote, withOutputChmod } from '../dist/utils/container-fs.js';

// `withOutputChmod` wraps a plain-argv container command (gdaladdo, tile-join,
// gdal_translate) in a `bash -c` script that runs it and then chmod 666's the
// output — while the container is still the owning UID 1001 — so the host
// SignalK process (commonly a different UID) can patch the file's metadata
// afterward instead of hitting "attempt to write a readonly database". This
// helper used to be copy-pasted into both converters; the tests below exercise
// the single shared copy directly.
describe('withOutputChmod (container output becomes host-writable)', () => {
  it('returns a 3-element bash -c command running the original argv then a chmod', () => {
    const cmd = withOutputChmod(
      ['gdaladdo', '-r', 'average', '/output/x.mbtiles'],
      '/output/x.mbtiles'
    );
    assert.strictEqual(cmd.length, 3);
    assert.strictEqual(cmd[0], 'bash');
    assert.strictEqual(cmd[1], '-c');
    const lines = cmd[2].split('\n');
    const argvLine = lines.findIndex((l: string) => l.includes('gdaladdo'));
    const chmodLine = lines.findIndex((l: string) => l.includes('chmod 666'));
    assert.ok(argvLine >= 0 && chmodLine >= 0);
    assert.ok(chmodLine > argvLine, 'chmod must run after the original command, not before');
  });

  it('runs `set -e` first so a failing original command skips the chmod', () => {
    const cmd = withOutputChmod(['gdaladdo', '/output/x.mbtiles'], '/output/x.mbtiles');
    assert.strictEqual(cmd[2].split('\n')[0], 'set -e');
  });

  it('shell-quotes both the argv and the chmod target so paths with spaces survive', () => {
    const cmd = withOutputChmod(
      ['gdaladdo', '-r', 'average', '/out put/x.mbtiles'],
      '/out put/x.mbtiles'
    );
    assert.match(cmd[2], /'\/out put\/x\.mbtiles'/);
    assert.match(cmd[2], /chmod 666 '\/out put\/x\.mbtiles'/);
  });

  // The chmod target is passed independently of the argv, so a caller can chmod
  // a different path than any single argv element (e.g. the `-o` output) — make
  // sure both are quoted from the one source of truth.
  it('quotes an argv element and the chmod target independently', () => {
    const cmd = withOutputChmod(
      ['tile-join', '-o', '/output/joined.mbtiles'],
      '/output/joined.mbtiles'
    );
    // Every argv element is single-quoted, including the tool name itself.
    assert.match(cmd[2], /'tile-join' '-o' '\/output\/joined\.mbtiles'/);
    assert.match(cmd[2], /chmod 666 '\/output\/joined\.mbtiles'/);
  });
});

describe('shellQuote (POSIX single-quote escaping)', () => {
  it('wraps a plain string in single quotes', () => {
    assert.strictEqual(shellQuote('/output/x.mbtiles'), `'/output/x.mbtiles'`);
  });

  // A hostile chart title must not break out of the single-quoted argv: the
  // POSIX escape closes the quote, emits an escaped quote, then reopens.
  it('escapes embedded single quotes and shell metacharacters', () => {
    assert.strictEqual(shellQuote(`evil'; rm -rf / #`), `'evil'\\''; rm -rf / #'`);
  });
});
