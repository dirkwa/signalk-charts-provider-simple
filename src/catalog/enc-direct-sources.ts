/**
 * Direct ENC sources: producers' own machine-readable catalogs that the ENC
 * index builder reads itself, rather than through chartcatalogs.github.io.
 * They are listed by hand in `catalog/enc-direct-sources.json`. Each catalog
 * format has one adapter here, which turns the producer's catalog into the
 * same archive list the chartcatalogs path produces; from there a direct
 * source is built like any other. A new catalog in a known format is a
 * config entry; a new format is one adapter.
 */

import { Type, type Static } from 'typebox';
import { parseStringPromise } from 'xml2js';
import { NOAA_SOURCE_ID } from './enc-index-schema.js';

const STRICT = { additionalProperties: false } as const;

export const DirectSourceFormatSchema = Type.Union([Type.Literal('usace-ienc-product-catalog')], {
  description:
    'The catalog format, which picks the adapter. "usace-ienc-product-catalog": the US Army Corps of Engineers’ IENC product catalog XML (their river cells and their buoy overlay each have one).'
});

export const EncDirectSourceSchema = Type.Object(
  {
    id: Type.String({
      pattern: '^[A-Za-z0-9_-]+$',
      description: 'Source id in the ENC index. Must not be "noaa" or a chartcatalogs file stem.'
    }),
    label: Type.String({ minLength: 1, description: 'Display name of the source.' }),
    format: DirectSourceFormatSchema,
    catalog: Type.String({
      pattern: '^https://',
      description: 'URL of the producer’s machine-readable catalog.'
    })
  },
  STRICT
);

export const EncDirectSourcesFileSchema = Type.Object(
  { sources: Type.Array(EncDirectSourceSchema) },
  STRICT
);

export type DirectSourceFormat = Static<typeof DirectSourceFormatSchema>;
export type EncDirectSource = Static<typeof EncDirectSourceSchema>;
export type EncDirectSourcesFile = Static<typeof EncDirectSourcesFileSchema>;

/** One archive a direct source's catalog lists. */
export interface DirectArchive {
  url: string;
  /** The catalog's own date for the archive; a different value means a new download. */
  version: string;
  /** Names the units inside. */
  title: string;
}

/**
 * Rules the schema cannot express: ids unique, and none taken by NOAA or a
 * chartcatalogs source. Returns one message per problem.
 */
export function checkDirectSources(
  file: EncDirectSourcesFile,
  otherIds: readonly string[]
): string[] {
  const problems: string[] = [];
  const taken = new Set([NOAA_SOURCE_ID, ...otherIds]);
  const seen = new Set<string>();
  for (const source of file.sources) {
    if (seen.has(source.id)) {
      problems.push(`${source.id}: duplicate id`);
    } else if (taken.has(source.id)) {
      problems.push(`${source.id}: id already used by another ENC source`);
    }
    seen.add(source.id);
  }
  return problems;
}

// ---- USACE IENC product catalog ----

type XmlNode = Record<string, unknown>;

/** The trimmed text of a child element, or '' (xml2js gives every element as an array). */
function text(node: XmlNode | undefined, name: string): string {
  const value = (node?.[name] as unknown[] | undefined)?.[0];
  return typeof value === 'string' ? value.trim() : '';
}

function child(node: XmlNode | undefined, name: string): XmlNode | undefined {
  const value = (node?.[name] as unknown[] | undefined)?.[0];
  return value !== null && typeof value === 'object' ? (value as XmlNode) : undefined;
}

/**
 * The catalog's MM/DD/YYYY date and HH:MM[:SS] time as an ISO timestamp,
 * so versions sort and compare like chartcatalogs dates. The catalog gives
 * no time zone; the value is only ever compared with itself. '' when the
 * date cannot be read.
 */
export function usaceDateTime(date: string, time: string): string {
  const d = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(date);
  if (!d) {
    return '';
  }
  const t = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(time);
  const pad = (s: string): string => s.padStart(2, '0');
  const clock = t ? `${pad(t[1])}:${t[2]}:${t[3] ?? '00'}` : '00:00:00';
  return `${d[3]}-${pad(d[1])}-${pad(d[2])}T${clock}Z`;
}

// USACE publishes one catalog per product, all in the same layout: the
// river cells (IENCU37ProductCatalog), the buoy overlay
// (IENCBuoyProductCatalog), and so on.
const USACE_ROOT = /^IENC\w*ProductCatalog$/;

/**
 * The S-57 archives a USACE IENC product catalog lists: each `<Cell>`'s
 * `<s57_file>`, versioned by its posting date and titled by its river and
 * stretch. Cells without an http(s) S-57 download are left out.
 *
 * Throws when the document is not such a catalog, or when a cell's posting
 * date cannot be read: an archive without a version would never be read
 * again, so the whole source is left as published (with a warning) until
 * the adapter learns the new form.
 */
export async function parseUsaceIencCatalog(xml: string): Promise<DirectArchive[]> {
  const parsed = (await parseStringPromise(xml)) as XmlNode | null;
  const rootName = Object.keys(parsed ?? {}).find((key) => USACE_ROOT.test(key));
  const root = rootName ? parsed?.[rootName] : undefined;
  if (root === null || typeof root !== 'object') {
    throw new Error('not a USACE IENC product catalog');
  }
  const cells = ((root as XmlNode).Cell ?? []) as XmlNode[];
  const archives: DirectArchive[] = [];
  for (const cell of cells) {
    const s57 = child(cell, 's57_file');
    const url = text(s57, 'location');
    if (!/^https?:\/\//.test(url)) {
      continue;
    }
    const name = text(cell, 'name');
    const river = text(cell, 'river_name');
    const where = child(cell, 'location');
    const from = text(where, 'from');
    const to = text(where, 'to');
    const stretch = from && to ? `${from} to ${to}` : from || to;
    const posted = text(s57, 'date_posted');
    const version = usaceDateTime(posted, text(s57, 'time_posted'));
    if (!version) {
      throw new Error(`${name || url}: cannot read the posting date "${posted}"`);
    }
    archives.push({ url, version, title: [river, stretch].filter(Boolean).join(': ') || name });
  }
  return archives;
}

/** Each format's adapter: catalog text in, the archives it lists out. */
export const DIRECT_SOURCE_ADAPTERS: Record<
  DirectSourceFormat,
  (catalog: string) => Promise<DirectArchive[]>
> = {
  'usace-ienc-product-catalog': parseUsaceIencCatalog
};
