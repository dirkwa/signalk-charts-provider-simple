/**
 * Zip-slip-safe extraction of tar archives, plain or compressed with gzip or
 * xz — the pilot chart and shapefile basemap archives chartcatalogs
 * publishes as `.tar.xz`. Pure JavaScript (xz through the WebAssembly
 * decoder of `xz-decompress`), so no `tar` binary or container is needed.
 *
 * Only regular files and directories are extracted. Links, devices and FIFOs
 * are skipped: a symlink would let a later entry write outside the target,
 * and none of the archives carry one a conversion needs. The same abuse
 * limits as the ZIP extractor apply, counted on the bytes actually written.
 */

import fs from 'node:fs';
import path from 'node:path';
import { Readable, pipeline } from 'node:stream';
import zlib from 'node:zlib';
import xz from 'xz-decompress';
import { isWithinBase } from './path-safety.js';
import { DEFAULT_MAX_ENTRIES, DEFAULT_MAX_TOTAL_BYTES, ZipLimitError } from './zip-extract.js';

const BLOCK = 512;

const XZ_MAGIC = [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00];
const GZIP_MAGIC = [0x1f, 0x8b];

function startsWith(head: Buffer, magic: readonly number[]): boolean {
  return magic.every((b, i) => head[i] === b);
}

/** The archive's tar bytes, decompressed according to its magic number. */
function openTarStream(archive: string): Readable {
  const head = Buffer.alloc(6);
  const fd = fs.openSync(archive, 'r');
  try {
    fs.readSync(fd, head, 0, head.length, 0);
  } finally {
    fs.closeSync(fd);
  }
  const raw = fs.createReadStream(archive);
  if (startsWith(head, XZ_MAGIC)) {
    const web = Readable.toWeb(raw) as unknown as ReadableStream<Uint8Array>;
    return Readable.fromWeb(new xz.XzReadableStream(web));
  }
  if (startsWith(head, GZIP_MAGIC)) {
    // pipeline, not pipe: destroying the gunzip stream then closes the file,
    // and a read error reaches the reader instead of going unhandled.
    const gunzip = zlib.createGunzip();
    pipeline(raw, gunzip, () => {});
    return gunzip;
  }
  return raw;
}

/** A NUL-terminated header field. */
function field(header: Buffer, offset: number, length: number): string {
  const slice = header.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  return slice.toString('utf8', 0, end < 0 ? length : end);
}

/** An octal size field, or GNU's base-256 form for sizes past 8 GB. */
function sizeField(header: Buffer, offset: number, length: number): number {
  if ((header[offset] & 0x80) !== 0) {
    let value = 0;
    for (let i = offset + 1; i < offset + length; i++) {
      value = value * 256 + header[i];
    }
    return value;
  }
  const text = field(header, offset, length).trim();
  return text ? parseInt(text, 8) : 0;
}

/** `path=` from a PAX extended header, if it sets one. */
function paxPath(data: Buffer): string | null {
  let pos = 0;
  let found: string | null = null;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    if (space < 0) {
      break;
    }
    const len = parseInt(data.toString('utf8', pos, space), 10);
    if (!Number.isFinite(len) || len <= 0) {
      break;
    }
    const record = data.toString('utf8', space + 1, pos + len - 1);
    const eq = record.indexOf('=');
    if (eq > 0 && record.slice(0, eq) === 'path') {
      found = record.slice(eq + 1);
    }
    pos += len;
  }
  return found;
}

export interface TarExtractOptions {
  maxTotalBytes?: number;
  maxEntries?: number;
  signal?: AbortSignal;
}

/**
 * Extract `archive` into `targetDir`, keeping its directory structure.
 * Returns the absolute paths of the files written.
 */
export async function extractTarArchive(
  archive: string,
  targetDir: string,
  options: TarExtractOptions = {}
): Promise<string[]> {
  const maxTotal = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const root = path.resolve(targetDir);
  fs.mkdirSync(root, { recursive: true });

  const written: string[] = [];
  let totalBytes = 0;
  let entries = 0;

  let pending: Buffer = Buffer.alloc(0);
  // The entry being read: its data goes to `fd` (or nowhere when skipped,
  // or into `meta` for a long-name / PAX header), `remaining` bytes to go
  // plus padding to the block.
  let remaining = 0;
  let padding = 0;
  let fd: number | null = null;
  let meta: Buffer[] | null = null;
  let metaKind: 'longname' | 'pax' | null = null;
  let nextName: string | null = null;
  let ended = false;

  const closeEntry = (): void => {
    if (fd !== null) {
      fs.closeSync(fd);
      fd = null;
    }
    if (meta && metaKind) {
      const data = Buffer.concat(meta);
      nextName =
        metaKind === 'longname' ? data.toString('utf8').replace(/\0.*$/s, '') : paxPath(data);
    }
    meta = null;
    metaKind = null;
  };

  const startEntry = (header: Buffer): void => {
    const size = sizeField(header, 124, 12);
    const type = String.fromCharCode(header[156] || 0x30);
    let name = field(header, 0, 100);
    const prefix = field(header, 345, 155);
    if (header.toString('latin1', 257, 262) === 'ustar' && prefix) {
      name = `${prefix}/${name}`;
    }
    if (nextName !== null && type !== 'L' && type !== 'x') {
      name = nextName;
      nextName = null;
    }
    remaining = size;
    padding = (BLOCK - (size % BLOCK)) % BLOCK;

    if (type === 'L' || type === 'x') {
      // Buffered in memory, so held to the archive's limit before reading.
      if (size > maxTotal) {
        throw new ZipLimitError(`Archive expands past ${String(maxTotal)} bytes`);
      }
      meta = [];
      metaKind = type === 'L' ? 'longname' : 'pax';
      return;
    }
    if (type !== '0' && type !== '5' && type !== '7') {
      // Links, devices, FIFOs and global PAX headers carry nothing to write.
      return;
    }
    const target = path.resolve(root, name);
    if (target === root || !isWithinBase(target, root)) {
      if (target !== root) {
        throw new Error(`Archive entry escapes the extraction directory: ${name}`);
      }
      return;
    }
    entries++;
    if (entries > maxEntries) {
      throw new ZipLimitError(`Archive has more than ${String(maxEntries)} entries`);
    }
    if (type === '5') {
      fs.mkdirSync(target, { recursive: true });
      return;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fd = fs.openSync(target, 'w');
    written.push(target);
  };

  const consume = (chunk: Buffer): void => {
    pending = pending.length > 0 ? Buffer.concat([pending, chunk]) : chunk;
    let pos = 0;
    while (!ended) {
      if (remaining > 0) {
        const n = Math.min(remaining, pending.length - pos);
        if (n === 0) {
          break;
        }
        const data = pending.subarray(pos, pos + n);
        if (fd !== null) {
          totalBytes += n;
          if (totalBytes > maxTotal) {
            throw new ZipLimitError(`Archive expands past ${String(maxTotal)} bytes`);
          }
          fs.writeSync(fd, data);
        } else if (meta) {
          meta.push(Buffer.from(data));
        }
        remaining -= n;
        pos += n;
        if (remaining > 0) {
          break;
        }
      }
      if (padding > 0) {
        const n = Math.min(padding, pending.length - pos);
        padding -= n;
        pos += n;
        if (padding > 0) {
          break;
        }
      }
      closeEntry();
      if (pending.length - pos < BLOCK) {
        break;
      }
      const header = pending.subarray(pos, pos + BLOCK);
      pos += BLOCK;
      if (header.every((b) => b === 0)) {
        // End-of-archive marker.
        ended = true;
        break;
      }
      startEntry(header);
    }
    pending = pending.subarray(pos);
  };

  const stream = openTarStream(archive);
  try {
    for await (const chunk of stream) {
      if (options.signal?.aborted) {
        throw new Error('Conversion cancelled');
      }
      consume(chunk as Buffer);
      if (ended) {
        break;
      }
    }
    if (remaining > 0) {
      throw new Error('Archive is truncated');
    }
  } finally {
    stream.destroy();
    if (fd !== null) {
      fs.closeSync(fd);
    }
  }
  return written;
}
