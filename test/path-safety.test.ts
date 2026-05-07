import { describe, it } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';

import { isWithinBase, arePairWithinBase } from '../dist/utils/path-safety.js';

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
