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
    // homeEnv may be undefined in unusual environments; uid undefined on Windows.
    if (hints.homeEnv !== undefined) {
      assert.strictEqual(typeof hints.homeEnv, 'string');
    }
    if (hints.uid !== undefined) {
      assert.strictEqual(typeof hints.uid, 'number');
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
