/**
 * Tests for keeping chart-set downloads off the boat's own network
 * (`public-host.ts`). No network: the names resolved are local ones.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  isPrivateAddress,
  privateHostReason,
  publicOnlyLookup,
  PrivateAddressError
} from '../dist/utils/public-host.js';

describe('isPrivateAddress', () => {
  it('refuses loopback, private, link-local, unique-local and other non-public ranges', () => {
    for (const address of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.251',
      '255.255.255.255',
      '::1',
      '::',
      'fd00::1',
      'fe80::1',
      '::ffff:192.168.1.1',
      '::ffff:c0a8:101',
      '::ffff:7f00:1',
      '::127.0.0.1',
      '64:ff9b::c0a8:101',
      '2002:c0a8:101::1',
      'not-an-address'
    ]) {
      assert.strictEqual(isPrivateAddress(address), true, address);
    }
  });

  it('accepts public addresses', () => {
    for (const address of [
      '8.8.8.8',
      '172.32.0.1',
      '192.169.0.1',
      '2606:4700::1111',
      '::ffff:8.8.8.8',
      '::ffff:808:808'
    ]) {
      assert.strictEqual(isPrivateAddress(address), false, address);
    }
  });
});

describe('privateHostReason', () => {
  const reason = (url: string) => privateHostReason(new URL(url));

  it('accepts a public http(s) URL', () => {
    assert.strictEqual(reason('https://charts.noaa.gov/ENCs/US4FL1EP.zip'), null);
    assert.strictEqual(reason('http://member.eahc.asia/userfiles/file/a.zip'), null);
    assert.strictEqual(reason('https://8.8.8.8/a.zip'), null);
  });

  it('refuses other protocols', () => {
    assert.match(reason('file:///etc/passwd') ?? '', /not a download protocol/);
    assert.match(reason('ftp://example.org/a.zip') ?? '', /not a download protocol/);
  });

  it('refuses private addresses written as the host', () => {
    assert.match(reason('http://192.168.1.1/admin') ?? '', /private network address/);
    assert.match(reason('http://[::1]:3000/signalk') ?? '', /private network address/);
    assert.match(reason('http://[fd12::1]/') ?? '', /private network address/);
    assert.match(reason('http://[::ffff:192.168.1.1]/') ?? '', /private network address/);
    assert.match(reason('http://169.254.169.254/latest/meta-data') ?? '', /private network/);
  });

  it('refuses local network names', () => {
    for (const url of [
      'http://localhost:3000/',
      'http://signalk.local/',
      'http://router.lan/',
      'http://nas.home.arpa/',
      'http://host.internal/',
      'http://router/',
      'http://LOCALHOST./'
    ]) {
      assert.match(reason(url) ?? '', /local network name/, url);
    }
  });
});

describe('publicOnlyLookup', () => {
  it('fails a name that resolves to a private address', async () => {
    const err = await new Promise<unknown>((resolve) => {
      publicOnlyLookup('localhost', {}, (e) => {
        resolve(e);
      });
    });
    assert.ok(err instanceof PrivateAddressError);
    assert.match((err as Error).message, /localhost resolves to the private network address/);
  });
});
