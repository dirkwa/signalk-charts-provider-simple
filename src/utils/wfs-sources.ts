/**
 * The WFS servers the local WFS proxy keeps (`docs/wfs-proxy.md`), as the WFS
 * Data tab edits them, in `<dataDir>/wfs-sources.json`. The file is the
 * plugin's own: an entry it cannot read is skipped, not the file, and the
 * fields of an entry this version does not know are kept when it is saved.
 */

import fs from 'fs';
import path from 'path';
import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';
import { normalizeUpstream } from './wfs-proxy.js';

const MAX_URL_LENGTH = 2048;

export const WfsSourceConfigSchema = Type.Object({
  url: Type.String({ minLength: 1, maxLength: MAX_URL_LENGTH }),
  name: Type.Optional(Type.String({ maxLength: 120 })),
  answersByBox: Type.Optional(Type.Boolean()),
  answerMargin: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
  idProperty: Type.Optional(Type.String({ maxLength: 120 }))
});

export type WfsSourceConfig = Static<typeof WfsSourceConfigSchema>;

const KNOWN_FIELDS = new Set(Object.keys(WfsSourceConfigSchema.properties));

export class WfsSourceError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

/** `source` as kept: its URL normalized, empty text left out, a margin only when answered by box. */
function cleaned(source: WfsSourceConfig): WfsSourceConfig {
  const url = normalizeUpstream(source.url);
  if (url === undefined) {
    throw new WfsSourceError(
      'The URL is not an http or https URL, or holds a user or password',
      400
    );
  }
  // Normalizing escapes characters, so a URL that fitted may no longer: it would not be read back.
  if (url.length > MAX_URL_LENGTH) {
    throw new WfsSourceError(
      `The URL is longer than ${String(MAX_URL_LENGTH)} characters once written out`,
      400
    );
  }
  const name = source.name?.trim();
  const idProperty = source.idProperty?.trim();
  const byBox = source.answersByBox === true;
  return {
    url,
    ...(name ? { name } : {}),
    answersByBox: byBox,
    ...(byBox ? { answerMargin: source.answerMargin ?? 0 } : {}),
    ...(idProperty ? { idProperty } : {})
  };
}

const unknownFields = (entry: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(entry).filter(([k]) => !KNOWN_FIELDS.has(k)));

/**
 * The file's entries; none when there is no file. Throws when it cannot be read, or holds no
 * list of sources, so it is not written over.
 */
function readEntries(file: string): Record<string, unknown>[] {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw err;
  }
  const parsed: unknown = JSON.parse(text);
  const sources = (parsed as { sources?: unknown } | null)?.sources;
  if (!Array.isArray(sources)) {
    throw new Error('it holds no list of sources');
  }
  return sources.filter(
    (s): s is Record<string, unknown> =>
      Value.Check(WfsSourceConfigSchema, s) &&
      (normalizeUpstream(s.url)?.length ?? Infinity) <= MAX_URL_LENGTH
  );
}

export class WfsSourceList {
  private entries: Record<string, unknown>[] = [];
  /** Why the file could not be read: until it can, it is not written, so its sources are not lost. */
  private unreadable: string | undefined;

  constructor(readonly file: string) {
    this.load();
  }

  private load(): void {
    try {
      this.entries = readEntries(this.file);
      this.unreadable = undefined;
    } catch (err) {
      this.unreadable = `${this.file} could not be read: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  private writable(): void {
    if (this.unreadable !== undefined) {
      this.load();
    }
    if (this.unreadable !== undefined) {
      throw new WfsSourceError(this.unreadable, 500);
    }
  }

  /** Whether the file was read: until it is, what the store keeps is not pruned by this list. */
  readable(): boolean {
    return this.unreadable === undefined;
  }

  list(): WfsSourceConfig[] {
    return this.entries.map((e) => cleaned(e as WfsSourceConfig));
  }

  /** Adds `source`; with `replace`, takes the place of the source of its URL instead. */
  save(source: WfsSourceConfig, replace: boolean): WfsSourceConfig {
    this.writable();
    const next = cleaned(source);
    const at = this.indexOf(next.url);
    if (replace && at < 0) {
      throw new WfsSourceError('No WFS server of that URL is kept', 404);
    }
    if (!replace && at >= 0) {
      throw new WfsSourceError('That WFS server is kept already', 409);
    }
    const entries = [...this.entries];
    if (at >= 0) {
      entries[at] = { ...unknownFields(entries[at] ?? {}), ...next };
    } else {
      entries.push(next);
    }
    this.write(entries);
    return next;
  }

  /** Removes the source of `url`; returns whether there was one. */
  remove(url: string): boolean {
    this.writable();
    const at = this.indexOf(normalizeUpstream(url) ?? url);
    if (at < 0) {
      return false;
    }
    this.write(this.entries.filter((_, i) => i !== at));
    return true;
  }

  private indexOf(url: string): number {
    return this.entries.findIndex((e) => normalizeUpstream(String(e.url)) === url);
  }

  private write(entries: Record<string, unknown>[]): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${String(process.pid)}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify({ sources: entries }, null, 2)}\n`);
    fs.renameSync(tmp, this.file);
    this.entries = entries;
  }
}
