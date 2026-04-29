/**
 * Tests for the container-runtime wrapper around dockerode.
 * Spins up a mock Docker API server on a unix socket and points the wrapper at it via DOCKER_HOST.
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SOCKET_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-charts-test-'));
const SOCKET_PATH = path.join(SOCKET_DIR, 'mock.sock');

let mockServer;
let mockBehavior = 'docker';
// Captures the most recent /containers/create body so tests can assert on it.
let lastCreatePayload = null;

function jsonResponse(res, body, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function startMockServer() {
  return new Promise((resolve, reject) => {
    mockServer = http.createServer(async (req, res) => {
      const url = req.url.replace(/^\/v[0-9.]+/, '');
      if (url === '/_ping') {
        res.writeHead(200);
        res.end('OK');
        return;
      }
      if (url === '/version') {
        if (mockBehavior === 'docker') {
          jsonResponse(res, {
            Version: '29.4.0',
            Components: [{ Name: 'Engine', Version: '29.4.0' }]
          });
        } else if (mockBehavior === 'podman') {
          jsonResponse(res, {
            Version: '5.4.2',
            Components: [{ Name: 'Podman Engine', Version: '5.4.2' }]
          });
        } else {
          res.writeHead(500);
          res.end();
        }
        return;
      }
      // Minimal /containers/create + lifecycle for runContainer's happy path.
      if (req.method === 'POST' && url.startsWith('/containers/create')) {
        const body = await readBody(req);
        try {
          lastCreatePayload = JSON.parse(body);
        } catch {
          lastCreatePayload = null;
        }
        jsonResponse(res, { Id: 'mock-container', Warnings: [] }, 201);
        return;
      }
      if (req.method === 'POST' && url.match(/^\/containers\/[^/]+\/attach/)) {
        // Hijack to a raw stream and immediately end it (no stdout/stderr).
        res.writeHead(200, { 'Content-Type': 'application/vnd.docker.raw-stream' });
        res.end();
        return;
      }
      if (req.method === 'POST' && url.match(/^\/containers\/[^/]+\/start/)) {
        res.writeHead(204);
        res.end();
        return;
      }
      if (req.method === 'POST' && url.match(/^\/containers\/[^/]+\/wait/)) {
        jsonResponse(res, { StatusCode: 0 });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    mockServer.once('error', reject);
    mockServer.listen(SOCKET_PATH, () => resolve());
  });
}

// Unix-socket bind on Windows fails with EACCES; Node only supports named-pipe
// paths there. The plugin's runtime targets Docker/Podman daemons, which are
// Linux-only at runtime — running this harness on Windows tests an unsupported
// host. Skip the whole suite there.
const skipOnWindows = process.platform === 'win32' ? describe.skip : describe;

skipOnWindows('container-runtime', () => {
  let runtime;

  before(async () => {
    await startMockServer();
    process.env.DOCKER_HOST = `unix://${SOCKET_PATH}`;
    runtime = require('../dist/utils/container-runtime');
  });

  after(() => {
    delete process.env.DOCKER_HOST;
    if (mockServer) {
      mockServer.close();
    }
    try {
      fs.rmSync(SOCKET_DIR, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  beforeEach(() => {
    runtime._resetCacheForTests();
  });

  describe('checkContainerRuntime()', () => {
    it('detects a Docker engine', async () => {
      mockBehavior = 'docker';
      const status = await runtime.checkContainerRuntime();
      assert.strictEqual(status.available, true);
      assert.strictEqual(status.engine, 'docker');
      assert.strictEqual(status.socketPath, SOCKET_PATH);
      assert.match(status.version, /docker version 29\.4\.0/);
    });

    it('detects a Podman engine via the docker-compatible API', async () => {
      mockBehavior = 'podman';
      const status = await runtime.checkContainerRuntime();
      assert.strictEqual(status.available, true);
      assert.strictEqual(status.engine, 'podman');
      assert.match(status.version, /podman version 5\.4\.2/);
    });

    it('caches the resolved status across calls', async () => {
      mockBehavior = 'docker';
      const first = await runtime.checkContainerRuntime();
      const second = await runtime.checkContainerRuntime();
      assert.strictEqual(first, second);
    });

    it('does not cache transient failures', async () => {
      mockBehavior = 'fail';
      const first = await runtime.checkContainerRuntime();
      assert.strictEqual(first.available, false);

      mockBehavior = 'docker';
      const second = await runtime.checkContainerRuntime();
      assert.strictEqual(second.available, true);
      assert.strictEqual(second.engine, 'docker');
    });
  });

  describe('runContainer()', () => {
    beforeEach(() => {
      mockBehavior = 'docker';
      lastCreatePayload = null;
    });

    it('runs the container as the host process UID:GID', async () => {
      // Day reported on Discord: containers were running as root inside,
      // producing root-owned files on the host that the (non-root) Signal K
      // Node process couldn't write to later — the metadata patch failed
      // with "attempt to write a readonly database". Setting User to the
      // host process's uid:gid makes file ownership match the consumer.
      if (typeof process.getuid !== 'function' || typeof process.getgid !== 'function') {
        // Defensive: this branch shouldn't be reachable on Linux/macOS but
        // means the assertion below would be wrong on a hypothetical Node
        // build without these calls.
        return;
      }
      await runtime.runContainer({
        image: 'busybox',
        cmd: ['true'],
        binds: ['/tmp/in:/input:ro']
      });
      assert.ok(lastCreatePayload, 'container create was called');
      assert.strictEqual(
        lastCreatePayload.User,
        `${process.getuid()}:${process.getgid()}`,
        'User must match the host UID:GID so bind-mount file ownership is correct'
      );
    });

    it('passes through bind mounts and labels', async () => {
      await runtime.runContainer({
        image: 'busybox',
        cmd: ['true'],
        binds: ['/host:/in:ro', '/out:/out'],
        phase: 'gdal-export',
        job: 'IN_ENCs'
      });
      assert.deepStrictEqual(lastCreatePayload.HostConfig.Binds, ['/host:/in:ro', '/out:/out']);
      assert.strictEqual(
        lastCreatePayload.Labels['io.signalk.charts-provider.plugin'],
        'signalk-charts-provider-simple'
      );
      assert.strictEqual(
        lastCreatePayload.Labels['io.signalk.charts-provider.phase'],
        'gdal-export'
      );
      assert.strictEqual(lastCreatePayload.Labels['io.signalk.charts-provider.job'], 'IN_ENCs');
    });
  });
});
