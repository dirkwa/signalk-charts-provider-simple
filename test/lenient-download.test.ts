import { after, before, describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import {
  HttpStatusError,
  RefusedUrlError,
  downloadLenient,
  isMalformedResponse
} from '../dist/catalog/lenient-download.js';
import { PrivateAddressError, publicOnlyLookup } from '../dist/utils/public-host.js';

const BODY = 'S-57 cell bytes';

// Answers like the Brazilian Navy's server: a long header folded onto a
// second line, which HTTP/1.1 no longer allows. Every answer closes its
// connection, as the server does, so the client never reuses one.
function respond(socket: net.Socket, request: string): void {
  const target = request.split(' ')[1] ?? '/';
  const folded = "Content-Security-Policy: default-src 'self';\r\n       img-src 'self';\r\n";
  if (target === '/moved') {
    socket.end(
      `HTTP/1.1 301 Moved\r\nLocation: /cell.zip\r\n${folded}Content-Length: 0\r\nConnection: close\r\n\r\n`
    );
  } else if (target === '/short') {
    socket.end(
      `HTTP/1.1 200 OK\r\nContent-Length: ${String(BODY.length + 10)}\r\nConnection: close\r\n\r\n${BODY}`
    );
  } else if (target === '/cell.zip') {
    socket.end(
      `HTTP/1.1 200 OK\r\n${folded}Content-Length: ${String(BODY.length)}\r\nConnection: close\r\n\r\n${BODY}`
    );
  } else {
    socket.end(`HTTP/1.1 404 Not Found\r\n${folded}Content-Length: 0\r\nConnection: close\r\n\r\n`);
  }
}

describe('lenient download fallback', () => {
  let server: net.Server;
  let base = '';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lenient-download-'));

  before(async () => {
    server = net.createServer((socket) => {
      socket.once('data', (data: Buffer) => {
        respond(socket, data.toString('latin1'));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${String((server.address() as net.AddressInfo).port)}`;
  });

  after(() => {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('recognises the fetch failure a folded header causes', async (t) => {
    const err = await fetch(`${base}/cell.zip`).then(
      () => null,
      (e: unknown) => e
    );
    if (err === null) {
      // Node 22's fetch still accepts folded headers; Node 24's refuses them.
      t.skip('this Node version accepts folded headers');
      return;
    }
    assert.strictEqual(isMalformedResponse(err), true);
  });

  it('recognises a parser error or a body length mismatch by its code or its message', () => {
    const failed = (cause: object) => Object.assign(new TypeError('fetch failed'), { cause });
    assert.strictEqual(isMalformedResponse(failed({ code: 'HPE_INVALID_HEADER_TOKEN' })), true);
    assert.strictEqual(
      isMalformedResponse(
        failed({ message: 'Response does not match the HTTP/1.1 protocol (Unexpected whitespace)' })
      ),
      true
    );
    assert.strictEqual(
      isMalformedResponse(failed({ code: 'UND_ERR_RES_CONTENT_LENGTH_MISMATCH' })),
      true
    );
    assert.strictEqual(isMalformedResponse(failed({ code: 'ECONNRESET' })), false);
  });

  it('recognises a body shorter than its Content-Length, found while reading it', async () => {
    const response = await fetch(`${base}/short`);
    const err = await response.arrayBuffer().then(
      () => null,
      (e: unknown) => e
    );
    assert.ok(err, 'reading a short body should fail');
    assert.strictEqual(isMalformedResponse(err), true);
  });

  it('does not treat other network failures as malformed responses', async () => {
    const closed = net.createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const port = (closed.address() as net.AddressInfo).port;
    closed.close();
    const err = await fetch(`http://127.0.0.1:${String(port)}/`).then(
      () => null,
      (e: unknown) => e
    );
    assert.strictEqual(isMalformedResponse(err), false);
    assert.strictEqual(isMalformedResponse(new Error('boom')), false);
  });

  it('downloads the file, following a redirect', async () => {
    const target = path.join(dir, 'cell.zip');
    await downloadLenient(`${base}/moved`, target, { headers: {}, maxBytes: 1000 });
    assert.strictEqual(fs.readFileSync(target, 'utf8'), BODY);
  });

  it('checks every redirect hop, not only the first URL', async () => {
    const target = path.join(dir, 'refused.zip');
    const err = await downloadLenient(`${base}/moved`, target, {
      headers: {},
      maxBytes: 1000,
      checkUrl: (url) => (url.pathname === '/cell.zip' ? 'not this one' : null)
    }).then(
      () => null,
      (e: unknown) => e
    );
    assert.ok(err instanceof RefusedUrlError);
    assert.match(err.message, /\/cell\.zip: not this one/);
    assert.ok(!fs.existsSync(target));
  });

  it('resolves host names through the given lookup', async () => {
    const local = base.replace('127.0.0.1', 'localhost');
    const err = await downloadLenient(`${local}/cell.zip`, path.join(dir, 'looked-up.zip'), {
      headers: {},
      maxBytes: 1000,
      lookup: publicOnlyLookup
    }).then(
      () => null,
      (e: unknown) => e
    );
    assert.ok(err instanceof PrivateAddressError, String(err));
  });

  it('reports a status other than 200', async () => {
    await assert.rejects(
      downloadLenient(`${base}/missing`, path.join(dir, 'missing'), {
        headers: {},
        maxBytes: 1000
      }),
      (err: unknown) => err instanceof HttpStatusError && err.status === 404
    );
  });

  it('stops a download over the size limit', async () => {
    await assert.rejects(
      downloadLenient(`${base}/cell.zip`, path.join(dir, 'big'), { headers: {}, maxBytes: 4 }),
      /size limit/
    );
  });
});
