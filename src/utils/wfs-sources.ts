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

export const WfsSourceConfigSchema = Type.Object({
  url: Type.String({ minLength: 1, maxLength: 2048 }),
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
    throw new WfsSourceError('The URL is not an http or https URL', 400);
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

function readEntries(file: string): Record<string, unknown>[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
  const sources = (parsed as { sources?: unknown } | null)?.sources;
  if (!Array.isArray(sources)) {
    return [];
  }
  return sources.filter(
    (s): s is Record<string, unknown> =>
      Value.Check(WfsSourceConfigSchema, s) && normalizeUpstream(s.url) !== undefined
  );
}

export class WfsSourceList {
  private entries: Record<string, unknown>[];

  constructor(readonly file: string) {
    this.entries = readEntries(file);
  }

  list(): WfsSourceConfig[] {
    return this.entries.map((e) => cleaned(e as WfsSourceConfig));
  }

  /** Adds `source`; with `replace`, takes the place of the source of its URL instead. */
  save(source: WfsSourceConfig, replace: boolean): WfsSourceConfig {
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
