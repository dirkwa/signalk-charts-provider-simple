/**
 * Keeps chart-set downloads on the public internet.
 *
 * Download URLs in the ENC index come from third parties (chartcatalogs
 * contributors, producers' own catalogs). A poisoned entry could otherwise
 * make every boat's plugin request an address on its own network: the
 * router, the Signal K server, other devices. So a chart-set download
 * accepts only http(s) URLs whose host is a public address, checked for
 * the URL itself and every redirect hop (`privateHostReason`), and again
 * when the connection resolves the name (`publicOnlyLookup`), so a name
 * that resolves to a private address is refused too.
 */

import dns from 'dns';
import net from 'net';

const blocked = new net.BlockList();
for (const [prefix, bits] of [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // carrier-grade NAT (also Starlink's client side)
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15], // benchmarking
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4] // reserved, and broadcast
] as const) {
  blocked.addSubnet(prefix, bits, 'ipv4');
}
for (const [prefix, bits] of [
  ['::', 96], // unspecified, loopback, and IPv4-compatible (::a.b.c.d)
  ['64:ff9b::', 96], // NAT64: an IPv4 address reached through translation
  ['64:ff9b:1::', 48], // local-use NAT64
  ['2002::', 16], // 6to4: an IPv4 address inside
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['ff00::', 8] // multicast
] as const) {
  blocked.addSubnet(prefix, bits, 'ipv6');
}

/** Name suffixes that only mean something on a local network. */
const LOCAL_SUFFIXES = ['.local', '.localhost', '.lan', '.home.arpa', '.internal'];

/** True when an IP address is not a public internet address. */
export function isPrivateAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) {
    return blocked.check(address, 'ipv4');
  }
  if (family === 6) {
    // An IPv4 address written as IPv6 is that address, in either form:
    // ::ffff:192.168.1.1, or ::ffff:c0a8:101 as a URL normalises it.
    const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    if (dotted) {
      return blocked.check(dotted[1], 'ipv4');
    }
    const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address);
    if (hex) {
      const high = parseInt(hex[1], 16);
      const low = parseInt(hex[2], 16);
      const v4 = [high >> 8, high & 255, low >> 8, low & 255].join('.');
      return blocked.check(v4, 'ipv4');
    }
    return blocked.check(address, 'ipv6');
  }
  return true;
}

/**
 * Why a download must not go to this URL, or null when it may: only http
 * and https, and not a host that is a private address or a local-network
 * name. Names are checked again when they resolve (`publicOnlyLookup`).
 */
export function privateHostReason(url: URL): string | null {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return `${url.protocol} is not a download protocol`;
  }
  const host = url.hostname
    .replace(/^\[|\]$/g, '')
    .toLowerCase()
    .replace(/\.$/, '');
  if (net.isIP(host)) {
    return isPrivateAddress(host) ? `${host} is a private network address` : null;
  }
  if (host === 'localhost' || LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    return `${host} is a local network name`;
  }
  // A name without a dot is completed by the local resolver's search
  // domains, so it names something on the local network.
  if (!host.includes('.')) {
    return `${host} is a local network name`;
  }
  return null;
}

/** Thrown when a host resolves to an address `isPrivateAddress` refuses. */
export class PrivateAddressError extends Error {
  readonly code = 'EPRIVATEADDRESS';
  constructor(host: string, address: string) {
    super(`${host} resolves to the private network address ${address}`);
    this.name = 'PrivateAddressError';
  }
}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | dns.LookupAddress[],
  family?: number
) => void;

/**
 * A `lookup` for `http(s).get` that resolves like `dns.lookup` but fails
 * when any address the name resolves to is private. Checking at connect
 * time, not before, leaves no window for the name to start resolving
 * elsewhere in between.
 */
export function publicOnlyLookup(
  hostname: string,
  options: dns.LookupOptions,
  callback: LookupCallback
): void {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) {
      callback(err, []);
      return;
    }
    const refused = addresses.find((a) => isPrivateAddress(a.address));
    if (refused) {
      callback(new PrivateAddressError(hostname, refused.address), []);
      return;
    }
    if (options.all) {
      callback(null, addresses);
      return;
    }
    const first = addresses[0];
    callback(null, first.address, first.family);
  });
}
