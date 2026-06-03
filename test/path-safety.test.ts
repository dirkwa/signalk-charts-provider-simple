import { describe, it } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';

import { isWithinBase, arePairWithinBase, validateChartName } from '../dist/utils/path-safety.js';

const BASE = '/srv/charts';

describe('isWithinBase', () => {
  it('accepts the base itself', () => {
    assert.strictEqual(isWithinBase(BASE, BASE), true);
  });

  it('accepts a direct child', () => {
    assert.strictEqual(isWithinBase(path.join(BASE, 'foo.mbtiles'), BASE), true);
  });

  it('accepts a deep descendant', () => {
    assert.strictEqual(isWithinBase(path.join(BASE, 'a', 'b', 'c.mbtiles'), BASE), true);
  });

  it('accepts a path that resolves into base via "../" cancellation', () => {
    // path.normalize collapses `a/../foo` → `foo`; the helper sees the
    // resolved location, not the literal string.
    assert.strictEqual(isWithinBase(path.join(BASE, 'a', '..', 'foo'), BASE), true);
  });

  it('rejects an escape via leading "../"', () => {
    assert.strictEqual(isWithinBase(path.join(BASE, '..', 'etc', 'passwd'), BASE), false);
  });

  it('rejects a sibling that shares a prefix (the bug bare startsWith would miss)', () => {
    // /srv/charts-evil/foo starts with `/srv/charts` if you don't add path.sep.
    assert.strictEqual(isWithinBase('/srv/charts-evil/foo', BASE), false);
  });

  it('rejects a completely unrelated absolute path', () => {
    assert.strictEqual(isWithinBase('/etc/passwd', BASE), false);
  });

  it('normalizes the base too — trailing slash should not break the check', () => {
    assert.strictEqual(isWithinBase(path.join(BASE, 'x.mbtiles'), BASE + '/'), true);
  });
});

describe('arePairWithinBase', () => {
  it('accepts when both are inside', () => {
    assert.strictEqual(
      arePairWithinBase(path.join(BASE, 'a.mbtiles'), path.join(BASE, 'sub', 'b.mbtiles'), BASE),
      true
    );
  });

  it('rejects if either escapes (source escapes)', () => {
    assert.strictEqual(arePairWithinBase('/etc/passwd', path.join(BASE, 'b.mbtiles'), BASE), false);
  });

  it('rejects if either escapes (target escapes)', () => {
    assert.strictEqual(arePairWithinBase(path.join(BASE, 'a.mbtiles'), '/etc/shadow', BASE), false);
  });
});

describe('validateChartName', () => {
  it('accepts an ordinary name', () => {
    assert.strictEqual(validateChartName('Chesapeake').valid, true);
  });

  it('accepts a name with spaces', () => {
    assert.strictEqual(validateChartName('NOAA Chesapeake Bay').valid, true);
  });

  it('accepts a unicode name with parentheses', () => {
    assert.strictEqual(validateChartName('Île de Ré (2024)').valid, true);
  });

  it('accepts a name that already carries the .mbtiles suffix', () => {
    assert.strictEqual(validateChartName('already.mbtiles').valid, true);
  });

  it('rejects an empty name', () => {
    assert.strictEqual(validateChartName('').valid, false);
  });

  it('rejects a forward-slash traversal', () => {
    assert.strictEqual(validateChartName('../../tmp/pwn').valid, false);
  });

  it('rejects an absolute path', () => {
    assert.strictEqual(validateChartName('/etc/passwd').valid, false);
  });

  it('rejects a nested path even without traversal', () => {
    assert.strictEqual(validateChartName('sub/chart').valid, false);
  });

  it('rejects a backslash so the name stays safe on Windows hosts', () => {
    // POSIX treats `\` as an ordinary byte, but a chart copied to a
    // Windows host would see it as a separator — reject it here.
    assert.strictEqual(validateChartName('sub\\evil').valid, false);
  });

  it('rejects ".." on its own', () => {
    assert.strictEqual(validateChartName('..').valid, false);
  });

  it('rejects an embedded ".." sequence', () => {
    assert.strictEqual(validateChartName('a..b').valid, false);
  });
});
