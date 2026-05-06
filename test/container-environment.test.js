const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const { detectContainerRuntime } = require('../dist/utils/container-environment');

// Stub fs.existsSync / fs.readFileSync so the test isn't sensitive to
// whether the test host is itself a container. Each test sets up the
// signals it cares about and the rest fall through to "not present".
let originalExistsSync;
let originalReadFileSync;

beforeEach(() => {
  originalExistsSync = fs.existsSync;
  originalReadFileSync = fs.readFileSync;
});

afterEach(() => {
  fs.existsSync = originalExistsSync;
  fs.readFileSync = originalReadFileSync;
});

function stubFs({ paths = new Set(), files = {} } = {}) {
  fs.existsSync = (p) => paths.has(p);
  fs.readFileSync = (p, enc) => {
    if (files[p] !== undefined) {
      return enc ? files[p] : Buffer.from(files[p]);
    }
    const err = new Error(`ENOENT: ${p}`);
    err.code = 'ENOENT';
    throw err;
  };
}

describe('detectContainerRuntime', () => {
  it('returns "docker" when /.dockerenv exists', () => {
    stubFs({ paths: new Set(['/.dockerenv']) });
    assert.strictEqual(detectContainerRuntime(), 'docker');
  });

  it('returns "podman" when only /run/.containerenv exists', () => {
    stubFs({ paths: new Set(['/run/.containerenv']) });
    assert.strictEqual(detectContainerRuntime(), 'podman');
  });

  it('prefers docker over podman when both files exist', () => {
    // Some setups (e.g. docker-in-podman) emit both. Pick the more
    // specific signal first; the warning text is the same either way.
    stubFs({ paths: new Set(['/.dockerenv', '/run/.containerenv']) });
    assert.strictEqual(detectContainerRuntime(), 'docker');
  });

  it('returns "unknown-container" when only /proc/1/cgroup mentions a container manager', () => {
    stubFs({
      paths: new Set(),
      files: { '/proc/1/cgroup': '12:devices:/docker/abc123\n11:cpu:/docker/abc123\n' }
    });
    assert.strictEqual(detectContainerRuntime(), 'unknown-container');
  });

  it('matches kubepods, containerd, libpod in cgroup as container signals', () => {
    for (const needle of ['kubepods', 'containerd', 'libpod']) {
      stubFs({
        paths: new Set(),
        files: { '/proc/1/cgroup': `1:name=systemd:/${needle}/abc\n` }
      });
      assert.strictEqual(
        detectContainerRuntime(),
        'unknown-container',
        `expected detection from cgroup line containing "${needle}"`
      );
    }
  });

  it('returns null on a normal host (no marker files, plain init cgroup)', () => {
    stubFs({
      paths: new Set(),
      files: { '/proc/1/cgroup': '12:freezer:/init.scope\n11:cpu:/init.scope\n' }
    });
    assert.strictEqual(detectContainerRuntime(), null);
  });

  it('returns null when /proc/1/cgroup is unreadable and no marker files exist', () => {
    // Stubs throw ENOENT for every readFileSync — the function must
    // swallow and return null rather than propagating.
    stubFs({ paths: new Set(), files: {} });
    assert.strictEqual(detectContainerRuntime(), null);
  });
});
