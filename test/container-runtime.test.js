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

function jsonResponse(res, body, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function startMockServer() {
  return new Promise((resolve, reject) => {
    mockServer = http.createServer((req, res) => {
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
});
