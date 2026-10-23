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

export const DirectSourceFormatSchema = Type.Union(
  [
    Type.Literal('usace-ienc-product-catalog'),
    Type.Literal('html-links'),
    Type.Literal('inspire-atom')
  ],
  {
    description:
      'The catalog format, which picks the adapter. "usace-ienc-product-catalog": the US Army Corps of Engineers’ IENC product catalog XML (their river cells and their buoy overlay each have one). "html-links": the archive links on a publisher’s web page, chosen by `links`. "inspire-atom": the enclosures of an INSPIRE ATOM dataset feed.'
  }
);

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
      description:
        'URL of the producer’s catalog: a machine-readable catalog, or for "html-links" the web page that links the archives.'
    }),
    links: Type.Optional(
      Type.String({
        minLength: 1,
        description:
          'A regular expression the archive URLs must match. Required for "html-links", where it picks the archives out of every link on the page; optional for "inspire-atom".'
      })
    ),
    attribution: Type.Optional(
      Type.String({
        minLength: 1,
        description:
          'Credit the producer’s licence asks for, e.g. for CC BY data. Published with the source in the ENC index.'
      })
    )
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

/** What an adapter makes of a catalog: its archives, and anything odd in it. */
export interface DirectCatalog {
  archives: DirectArchive[];
  /** Entries the adapter could only partly read, for the build's warnings. */
  problems: string[];
}

/**
 * Rules the schema cannot express: ids unique, and none taken by NOAA or a
 * chartcatalogs source; `links` a valid regular expression, and present for
 * "html-links". Returns one message per problem.
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
    if (source.format === 'html-links' && !source.links) {
      problems.push(`${source.id}: "html-links" needs a links pattern`);
    }
    if (source.links) {
      try {
        new RegExp(source.links);
      } catch {
        problems.push(`${source.id}: links is not a valid regular expression`);
      }
    }
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
 * no time zone; the value is only ever compared with itself. An empty time
 * is midnight. '' when the date, or a time that is given, cannot be read or
 * is not a real calendar date or clock time.
 */
export function usaceDateTime(date: string, time: string): string {
  const d = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(date);
  const t = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(time);
  if (!d || (time !== '' && !t)) {
    return '';
  }
  // The shape is not enough: 02/30 or 25:00 must not pass for a real time.
  const [year, month, day] = [Number(d[3]), Number(d[1]), Number(d[2])];
  const [hours, minutes, seconds] = t ? [Number(t[1]), Number(t[2]), Number(t[3] ?? 0)] : [0, 0, 0];
  const calendar = new Date(Date.UTC(year, month - 1, day));
  const realDate =
    calendar.getUTCFullYear() === year &&
    calendar.getUTCMonth() === month - 1 &&
    calendar.getUTCDate() === day;
  if (!realDate || hours > 23 || minutes > 59 || seconds > 59) {
    return '';
  }
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
 * stretch. Cells without an http(s) S-57 download are left out. Throws when
 * the document is not such a catalog.
 *
 * A cell whose posting date or time cannot be read is still listed, with
 * the raw text as its version and a problem reported. The version stays
 * deterministic and still changes on a reissue, and one odd entry does not
 * hold up the rest of the source.
 */
export async function parseUsaceIencCatalog(xml: string): Promise<DirectCatalog> {
  const parsed = (await parseStringPromise(xml)) as XmlNode | null;
  const rootName = Object.keys(parsed ?? {}).find((key) => USACE_ROOT.test(key));
  const root = rootName ? parsed?.[rootName] : undefined;
  if (root === null || typeof root !== 'object') {
    throw new Error('not a USACE IENC product catalog');
  }
  const cells = ((root as XmlNode).Cell ?? []) as XmlNode[];
  const archives: DirectArchive[] = [];
  const problems: string[] = [];
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
    const time = text(s57, 'time_posted');
    let version = usaceDateTime(posted, time);
    if (!version) {
      version = `raw:${posted} ${time}`;
      problems.push(`${name || url}: cannot read the posting date "${posted} ${time}"`);
    }
    archives.push({ url, version, title: [river, stretch].filter(Boolean).join(': ') || name });
  }
  return { archives, problems };
}

// ---- Archive links on a web page ----

/** A numeric character reference's character, or the reference itself when it names none. */
function codePoint(reference: string, value: number): string {
  try {
    return String.fromCodePoint(value);
  } catch {
    return reference;
  }
}

/** The entities that turn up in HTML attribute values. */
function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (ref, hex: string) => codePoint(ref, parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (ref, dec: string) => codePoint(ref, Number(dec)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** The file name a URL ends in, without its extension, for a title. */
function fileStem(url: string): string {
  const raw = new URL(url).pathname.split('/').pop() ?? '';
  let name = raw;
  try {
    name = decodeURIComponent(raw);
  } catch {
    // A stray "%" or an unencoded byte: keep the name as it is written.
  }
  return name.replace(/\.[^.]+$/, '') || url;
}

/**
 * The base version of an archive known only by its link. A WordPress upload
 * sits under `/wp-content/uploads/YYYY/MM/`, and a reissue usually gets a
 * new URL (a new month, or a `-1` suffix), so the upload month is stable.
 * Elsewhere the URL itself is the base. A file replaced in place keeps its
 * URL, so the builder adds the server's own date to this (`withServerDate`).
 */
export function linkVersion(url: string): string {
  const upload = /\/wp-content\/uploads\/(\d{4})\/(\d{2})\//.exec(url);
  return upload ? `${upload[1]}-${upload[2]}` : url;
}

/**
 * An archive's version with the server's own date for the file added: its
 * `Last-Modified`, or its `ETag` when it sends no date. Used for page links,
 * whose base version cannot see a file replaced in place. The base alone
 * when the server sends neither.
 */
export function withServerDate(
  base: string,
  headers: { lastModified: string | null; etag: string | null }
): string {
  const date = headers.lastModified ?? headers.etag;
  return date ? `${base} ${date}` : base;
}

/**
 * The archives a publisher's web page links: every `href` on the page
 * (outside HTML comments), resolved against it, kept when it matches the
 * source's `links` pattern. Titled by file name. A link that cannot be read
 * is skipped and reported. A page whose layout changed so that nothing
 * matches yields no archives, which leaves the source as published.
 */
export function parseHtmlLinks(html: string, source: EncDirectSource): Promise<DirectCatalog> {
  const pattern = new RegExp(source.links ?? '(?!)');
  const page = html.replace(/<!--[\s\S]*?-->/g, '');
  const urls = new Set<string>();
  const problems: string[] = [];
  for (const match of page.matchAll(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    const href = (match[1] ?? match[2] ?? '').trim();
    let url: string;
    try {
      url = new URL(decodeEntities(href), source.catalog).href;
    } catch {
      problems.push(`cannot read the link "${href}"`);
      continue;
    }
    if (/^https?:\/\//.test(url) && pattern.test(url)) {
      urls.add(url);
    }
  }
  const archives = [...urls]
    .sort()
    .map((url): DirectArchive => ({ url, version: linkVersion(url), title: fileStem(url) }));
  return Promise.resolve({ archives, problems });
}

// ---- INSPIRE ATOM dataset feed ----

/**
 * The archives an INSPIRE ATOM dataset feed offers: each entry's enclosure
 * links, kept when they match the source's `links` pattern (if any),
 * versioned by the entry's `updated` and titled by the link's title. An
 * entry without a readable `updated` is versioned by its raw text, with a
 * problem reported. Throws when the document is not an ATOM feed.
 */
export async function parseInspireAtom(
  xml: string,
  source: EncDirectSource
): Promise<DirectCatalog> {
  const parsed = (await parseStringPromise(xml)) as XmlNode | null;
  const feed = parsed?.feed;
  if (feed === null || typeof feed !== 'object') {
    throw new Error('not an ATOM feed');
  }
  const pattern = source.links ? new RegExp(source.links) : null;
  const entries = ((feed as XmlNode).entry ?? []) as XmlNode[];
  const archives: DirectArchive[] = [];
  const problems: string[] = [];
  for (const entry of entries) {
    const updated = text(entry, 'updated');
    const links = (entry.link ?? []) as { $?: Record<string, string> }[];
    for (const link of links) {
      const attrs = link.$ ?? {};
      const url = (attrs.href ?? '').trim();
      if (
        attrs.rel !== 'enclosure' ||
        !/^https?:\/\//.test(url) ||
        (pattern && !pattern.test(url))
      ) {
        continue;
      }
      let version = updated;
      if (Number.isNaN(Date.parse(updated))) {
        version = `raw:${updated}`;
        problems.push(`${url}: cannot read the entry date "${updated}"`);
      }
      const title = (attrs.title ?? '').replace(/\s+-\s+[A-Za-z0-9]+$/, '').trim();
      archives.push({ url, version, title: title || fileStem(url) });
    }
  }
  archives.sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
  return { archives, problems };
}

/** Each format's adapter: catalog text in, the archives it lists out. */
export const DIRECT_SOURCE_ADAPTERS: Record<
  DirectSourceFormat,
  (catalog: string, source: EncDirectSource) => Promise<DirectCatalog>
> = {
  'usace-ienc-product-catalog': parseUsaceIencCatalog,
  'html-links': parseHtmlLinks,
  'inspire-atom': parseInspireAtom
};
