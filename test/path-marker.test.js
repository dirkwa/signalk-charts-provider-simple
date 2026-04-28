const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  writeChartPathMarker,
  detectContainerHints,
  MARKER_FILENAME
} = require('../dist/utils/path-marker');

describe('writeChartPathMarker', () => {
  let tmp;

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-charts-marker-'));
  });

  after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('writes the marker JSON at <chartPath>/.charts-provider-marker.json', () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'happy-'));
    const written = writeChartPathMarker(dir, '1.11.2', {
      now: new Date('2026-04-29T05:32:14.123Z')
    });

    assert.strictEqual(
      written,
      path.join(dir, MARKER_FILENAME),
      'returned path matches the documented filename inside chartPath'
    );
    assert.ok(fs.existsSync(written), 'marker file should be present on disk');
  });

  it('persists the documented schema (version, chartPath, writtenAt, containerHints)', () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'schema-'));
    const written = writeChartPathMarker(dir, '1.11.2', {
      now: new Date('2026-04-29T05:32:14.123Z')
    });
    const parsed = JSON.parse(fs.readFileSync(written, 'utf8'));

    // Locked shape so future tooling consumers can rely on it.
    assert.deepStrictEqual(Object.keys(parsed).sort(), [
      'chartPath',
      'containerHints',
      'version',
      'writtenAt'
    ]);
    assert.strictEqual(parsed.version, '1.11.2');
    assert.strictEqual(parsed.chartPath, dir);
    assert.strictEqual(parsed.writtenAt, '2026-04-29T05:32:14.123Z');
    assert.strictEqual(typeof parsed.containerHints, 'object');
    assert.deepStrictEqual(Object.keys(parsed.containerHints).sort(), [
      'homeEnv',
      'isLikelyContainer',
      'uid'
    ]);
    assert.strictEqual(typeof parsed.containerHints.isLikelyContainer, 'boolean');
  });

  it('overwrites the marker on each call (timestamp updates)', () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'overwrite-'));
    const t1 = new Date('2026-04-29T05:00:00.000Z');
    const t2 = new Date('2026-04-29T06:00:00.000Z');

    const w1 = writeChartPathMarker(dir, '1.11.2', { now: t1 });
    const w2 = writeChartPathMarker(dir, '1.11.2', { now: t2 });

    // Same target file, second write overwrites the first.
    assert.strictEqual(w1, w2);
    const parsed = JSON.parse(fs.readFileSync(w2, 'utf8'));
    assert.strictEqual(parsed.writtenAt, t2.toISOString());
  });

  it('returns null and reports via onError when the path is not writable', () => {
    // Point at a directory that doesn't exist — fs.writeFileSync will throw.
    const dir = path.join(tmp, 'definitely-not-here', 'nested');
    const errors = [];
    const result = writeChartPathMarker(dir, '1.11.2', {
      onError: (msg) => errors.push(msg)
    });

    assert.strictEqual(result, null);
    assert.strictEqual(errors.length, 1);
    assert.match(errors[0], /Failed to write chart path marker/);
  });

  it('does not throw when onError is not provided (best-effort)', () => {
    const dir = path.join(tmp, 'still-not-here');
    assert.doesNotThrow(() => writeChartPathMarker(dir, '1.11.2'));
  });
});

describe('detectContainerHints', () => {
  it('returns the documented shape with the correct types', () => {
    const hints = detectContainerHints();
    assert.deepStrictEqual(Object.keys(hints).sort(), ['homeEnv', 'isLikelyContainer', 'uid']);
    assert.strictEqual(typeof hints.isLikelyContainer, 'boolean');
    // homeEnv is `null` when $HOME is unset; uid is `null` on Windows
    // (process.getuid is undefined there). Either way, the keys are always
    // present so the marker schema is platform-stable.
    assert.ok(
      hints.homeEnv === null || typeof hints.homeEnv === 'string',
      `homeEnv must be string|null, got ${typeof hints.homeEnv}`
    );
    assert.ok(
      hints.uid === null || typeof hints.uid === 'number',
      `uid must be number|null, got ${typeof hints.uid}`
    );
  });

  it('emits explicit null (not undefined) when uid or homeEnv is unavailable', () => {
    // Regression guard for Windows: Node has no `process.getuid` there, so
    // the previous implementation produced `uid: undefined`, and
    // JSON.stringify dropped the key from the marker file. The schema must
    // be stable across platforms, so the helper must coerce to `null` and
    // the marker must round-trip through JSON with all three keys present.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-charts-marker-stable-'));
    try {
      const written = writeChartPathMarker(dir, '1.0.0');
      const parsed = JSON.parse(fs.readFileSync(written, 'utf8'));
      assert.deepStrictEqual(Object.keys(parsed.containerHints).sort(), [
        'homeEnv',
        'isLikelyContainer',
        'uid'
      ]);
      // null is allowed; undefined is not (the latter would drop the key).
      assert.notStrictEqual(parsed.containerHints.uid, undefined);
      assert.notStrictEqual(parsed.containerHints.homeEnv, undefined);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports isLikelyContainer correctly for the host this test runs on', () => {
    // Pure consistency check: the value must agree with the indicator-file
    // probe regardless of which environment runs the suite.
    const expected = fs.existsSync('/.dockerenv') || fs.existsSync('/run/.containerenv');
    assert.strictEqual(detectContainerHints().isLikelyContainer, expected);
  });
});

// Silence unused-import warning when the `beforeEach`/`afterEach` hooks aren't used.
void beforeEach;
void afterEach;
