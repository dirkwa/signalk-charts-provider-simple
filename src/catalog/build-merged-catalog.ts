/**
 * Pure assembly of the merged chart catalog. File and network access live
 * in `publish-catalog-cli.ts`; everything here is deterministic so it can be
 * unit-tested and so an unchanged input always yields the same content hash.
 */

import { createHash } from 'node:crypto';
import { Value } from '@sinclair/typebox/value';
import type { ParsedChartcatalogsXml } from './chartcatalogs-xml.js';
import {
  MERGED_CATALOG_SCHEMA_VERSION,
  MergedCatalogSchema,
  MergedChartcatalogsCatalogSchema,
  MergedTilesetSchema,
  TilesetFeedDocumentSchema,
  TilesetFeedFileSchema,
  checkChartcatalogsIndex,
  checkOnlineChartEntry,
  formatForChartType,
  schemaErrors,
  type ChartcatalogsIndex,
  type MergedCatalog,
  type MergedCatalogChart,
  type MergedChartcatalogsCatalog,
  type MergedOnlineChart,
  type MergedTileset,
  type OnlineChartsSourceFile,
  type TilesetFeed,
  type TilesetFeedFile
} from './merged-catalog-schema.js';

export const CHARTCATALOGS_HOMEPAGE = 'https://chartcatalogs.github.io/';
export const CHARTCATALOGS_ISSUES = 'https://github.com/chartcatalogs/catalogs/issues';

export interface ChartcatalogsFile {
  file: string;
  /** `null` when the file exists upstream but could not be parsed. */
  parsed: ParsedChartcatalogsXml | null;
}

/** A tileset feed as listed in the repo, with the document fetched for it. */
export interface TilesetFeedInput {
  feed: TilesetFeed;
  /** The parsed feed document, or `null` when it could not be fetched or parsed. */
  document: unknown;
  /** File sizes in bytes by URL, where the publisher's server reported them. */
  sizes?: Map<string, number>;
}

export interface BuildInputs {
  chartcatalogs: ChartcatalogsFile[];
  chartcatalogsCommit?: string;
  index: ChartcatalogsIndex;
  online: OnlineChartsSourceFile;
  /** `owner/name` of the repo publishing the catalog; issue links point here. */
  repo: string;
  /** chartcatalogs entries from the catalog currently published, by file. */
  previous?: Map<string, MergedChartcatalogsCatalog>;
  tilesetFeeds?: TilesetFeedInput[];
  /** Tilesets in the catalog currently published, for carrying a failed feed forward. */
  previousTilesets?: MergedTileset[];
  now: Date;
}

export interface BuildResult {
  catalog: MergedCatalog;
  /** chartcatalogs files with no entry in the index yet. */
  unindexed: string[];
  /** Index entries whose file chartcatalogs no longer has. */
  staleIndexEntries: string[];
  /** Files that failed to parse or came back empty, kept from the published catalog. */
  carriedForward: string[];
  /** Files that failed to parse and had nothing published to fall back on. */
  skipped: string[];
  /** Charts dropped because their download location is not an http(s) URL. */
  droppedCharts: string[];
  /**
   * Published catalogs whose file chartcatalogs no longer has. They leave
   * the catalog (the file may really have been withdrawn), but the drop
   * guard tolerates a few, so each one is reported.
   */
  removedUpstream: string[];
  /** Feeds that could not be read, whose published regions were kept. */
  carriedForwardFeeds: string[];
  /** Feed regions left out, each with the reason. */
  skippedTilesets: string[];
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function mergeChartcatalogsFile(
  file: string,
  parsed: ParsedChartcatalogsXml,
  index: ChartcatalogsIndex,
  droppedCharts: string[]
): MergedChartcatalogsCatalog {
  const id = file.replace(/\.xml$/i, '');
  // One odd upstream URL must not fail the whole build (the schema would
  // reject the catalog), so bad charts are dropped here and reported.
  const charts: MergedCatalogChart[] = parsed.charts.filter((chart) => {
    const ok = /^https?:\/\//.test(chart.zipfile_location);
    if (!ok) {
      droppedCharts.push(`${file} ${chart.number}`);
    }
    return ok;
  });
  const base = { id, file, use: 'download' as const, header: parsed.header, charts };
  const facets = index[file];
  if (facets) {
    return { ...base, ...facets, indexed: true };
  }
  // Nearly every chartcatalogs catalog is a navigation chart set, so that is
  // the safest default until someone adds the file to the index.
  return { ...base, label: parsed.header.title || id, category: 'navigation', indexed: false };
}

function mergeOnlineCharts(online: OnlineChartsSourceFile): MergedOnlineChart[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const entry of online.charts) {
    if (seen.has(entry.id)) {
      problems.push(`${entry.id}: duplicate id`);
    }
    seen.add(entry.id);
    problems.push(...checkOnlineChartEntry(entry));
  }
  if (problems.length > 0) {
    throw new Error(`Invalid online chart entries:\n  ${problems.join('\n  ')}`);
  }
  return online.charts.map((entry) => ({
    ...entry,
    use: 'stream' as const,
    format: formatForChartType(entry.chart.type)
  }));
}

function isIsoTime(value: string | undefined): value is string {
  return value !== undefined && /^\d{4}-\d{2}-\d{2}T/.test(value) && !isNaN(Date.parse(value));
}

/** Why a feed region can't be published, or null when it can. */
function regionProblem(
  raw: TilesetFeedFile,
  updated: string | undefined,
  seen: Set<string>
): string | null {
  if (seen.has(raw.id)) {
    return 'duplicate id';
  }
  if (raw.bounds[1] >= raw.bounds[3]) {
    return 'bounds south must be below north';
  }
  if (raw.minzoom !== undefined && raw.maxzoom !== undefined && raw.minzoom > raw.maxzoom) {
    return 'minzoom is greater than maxzoom';
  }
  if (!isIsoTime(updated)) {
    return 'no date to tell an update by';
  }
  return null;
}

/**
 * The regions of every tileset feed. A feed that cannot be read, or that
 * suddenly lists nothing usable, keeps its published regions: one failed
 * fetch must not remove a chart from every boat's catalog, or turn off the
 * update notice for boats that installed it.
 */
function mergeTilesets(
  inputs: TilesetFeedInput[],
  previous: MergedTileset[],
  repo: string,
  carriedForwardFeeds: string[],
  skippedTilesets: string[]
): MergedTileset[] {
  const ids = new Set<string>();
  for (const { feed } of inputs) {
    if (ids.has(feed.id)) {
      throw new Error(`Invalid tileset feeds:\n  ${feed.id}: duplicate id`);
    }
    ids.add(feed.id);
  }

  const tilesets: MergedTileset[] = [];
  for (const { feed, document, sizes } of inputs) {
    const regions: MergedTileset[] = [];
    if (Value.Check(TilesetFeedDocumentSchema, document)) {
      const seen = new Set<string>();
      for (const raw of document.files) {
        const rawId = (raw as { id?: unknown } | null)?.id;
        const label = `${feed.id} ${typeof rawId === 'string' ? rawId : '<no id>'}`;
        if (!Value.Check(TilesetFeedFileSchema, raw)) {
          skippedTilesets.push(
            `${label}: ${schemaErrors(TilesetFeedFileSchema, raw)[0] ?? 'invalid'}`
          );
          continue;
        }
        const updated = isIsoTime(raw.newestArrival) ? raw.newestArrival : document.generated;
        const problem = regionProblem(raw, updated, seen);
        if (problem !== null || !isIsoTime(updated)) {
          skippedTilesets.push(`${label}: ${problem ?? 'invalid'}`);
          continue;
        }
        seen.add(raw.id);
        const size = sizes?.get(raw.url);
        regions.push({
          id: `${feed.id}-${raw.id}`,
          feed: feed.id,
          name: raw.name,
          description: feed.description,
          use: 'download',
          category: feed.category,
          format: 'mbtiles',
          bbox: raw.bounds,
          provider: feed.provider,
          attribution: feed.attribution,
          license: feed.license,
          licenseUrl: feed.licenseUrl,
          homepage: feed.homepage,
          issues:
            feed.issues ?? `https://github.com/${repo}/issues/new?template=catalog-problem.yml`,
          ...(feed.notForNavigation !== undefined
            ? { notForNavigation: feed.notForNavigation }
            : {}),
          folder: feed.folder,
          file: {
            url: raw.url,
            updated,
            ...(size !== undefined ? { size } : {}),
            ...(raw.minzoom !== undefined ? { minzoom: raw.minzoom } : {}),
            ...(raw.maxzoom !== undefined ? { maxzoom: raw.maxzoom } : {})
          }
        });
      }
    }
    if (regions.length === 0) {
      const kept = previous.filter((t) => t.feed === feed.id);
      if (kept.length > 0) {
        carriedForwardFeeds.push(feed.id);
      }
      regions.push(...kept);
    }
    tilesets.push(...regions);
  }
  return tilesets.sort((a, b) => compareStrings(a.id, b.id));
}

/** JSON with object keys sorted, so key order never changes the hash. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => compareStrings(a, b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Hash of what a user would actually see. chartcatalogs re-commits every
 * hour just to refresh its header dates, so those dates, the upstream
 * commit id and our own `generatedAt` are excluded by name; anything else,
 * including fields added later, is hashed.
 */
export function computeContentHash(catalog: Omit<MergedCatalog, 'contentHash'>): string {
  const { generatedAt: _generatedAt, ...content } = catalog;
  const { commit: _commit, ...chartcatalogsSource } = content.sources.chartcatalogs;
  const hashed = {
    ...content,
    sources: { ...content.sources, chartcatalogs: chartcatalogsSource },
    chartcatalogs: content.chartcatalogs.map((c) => {
      const { dateCreated: _created, dateValid: _valid, ...header } = c.header;
      return { ...c, header };
    })
  };
  return createHash('sha256').update(canonicalJson(hashed)).digest('hex');
}

export function buildMergedCatalog(inputs: BuildInputs): BuildResult {
  const indexProblems = checkChartcatalogsIndex(inputs.index);
  if (indexProblems.length > 0) {
    throw new Error(`Invalid chartcatalogs index:\n  ${indexProblems.join('\n  ')}`);
  }

  const files = [...inputs.chartcatalogs].sort((a, b) => compareStrings(a.file, b.file));
  const carriedForward: string[] = [];
  const skipped: string[] = [];
  const droppedCharts: string[] = [];
  const chartcatalogs: MergedChartcatalogsCatalog[] = [];

  for (const { file, parsed } of files) {
    const previous = inputs.previous?.get(file);
    // A file that still exists upstream but is broken or suddenly empty is
    // far more likely an upstream mistake than a withdrawn catalog, so keep
    // what users can see today rather than wiping it from every plugin.
    if (previous && (!parsed || parsed.charts.length === 0)) {
      const facets = inputs.index[file];
      chartcatalogs.push(facets ? { ...previous, ...facets, indexed: true } : previous);
      carriedForward.push(file);
      continue;
    }
    if (!parsed) {
      skipped.push(file);
      continue;
    }
    chartcatalogs.push(mergeChartcatalogsFile(file, parsed, inputs.index, droppedCharts));
  }

  const carriedForwardFeeds: string[] = [];
  const skippedTilesets: string[] = [];
  const tilesets = mergeTilesets(
    inputs.tilesetFeeds ?? [],
    inputs.previousTilesets ?? [],
    inputs.repo,
    carriedForwardFeeds,
    skippedTilesets
  );

  const fileNames = new Set(files.map((f) => f.file));
  const withoutHash: Omit<MergedCatalog, 'contentHash'> = {
    schemaVersion: MERGED_CATALOG_SCHEMA_VERSION,
    generatedAt: inputs.now.toISOString(),
    sources: {
      chartcatalogs: {
        homepage: CHARTCATALOGS_HOMEPAGE,
        issues: CHARTCATALOGS_ISSUES,
        license: 'CC0-1.0',
        ...(inputs.chartcatalogsCommit ? { commit: inputs.chartcatalogsCommit } : {})
      },
      online: {
        homepage: `https://github.com/${inputs.repo}`,
        issues: `https://github.com/${inputs.repo}/issues/new?template=catalog-problem.yml`
      }
    },
    chartcatalogs,
    online: mergeOnlineCharts(inputs.online),
    tilesets
  };

  const catalog: MergedCatalog = { ...withoutHash, contentHash: computeContentHash(withoutHash) };
  if (!Value.Check(MergedCatalogSchema, catalog)) {
    throw new Error(
      `Merged catalog failed validation:\n  ${schemaErrors(MergedCatalogSchema, catalog).join('\n  ')}`
    );
  }

  return {
    catalog,
    unindexed: chartcatalogs.filter((c) => !c.indexed).map((c) => c.file),
    staleIndexEntries: Object.keys(inputs.index).filter((f) => !fileNames.has(f)),
    carriedForward,
    skipped,
    droppedCharts,
    removedUpstream: [...(inputs.previous?.keys() ?? [])]
      .filter((f) => !fileNames.has(f))
      .sort(compareStrings),
    carriedForwardFeeds,
    skippedTilesets
  };
}

/** What the drop guard and change detection need to know about the live catalog. */
export interface PublishedState {
  contentHash: string | null;
  catalogCount: number;
  chartCount: number;
  /** chartcatalogs entries that still validate, for carrying forward. */
  chartcatalogs: Map<string, MergedChartcatalogsCatalog>;
  /** Tilesets that still validate, for carrying a failed feed forward. */
  tilesets: MergedTileset[];
  /** The published `catalog.schema.json` text, or null if absent. */
  schemaText: string | null;
}

/**
 * Read the published catalog loosely. It may predate the current schema
 * (that is exactly when a build change is riskiest), so the counts the drop
 * guard relies on are taken from the raw arrays rather than a full parse.
 */
export function readPublishedState(raw: unknown, schemaText: string | null): PublishedState {
  const obj = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const rawCatalogs = Array.isArray(obj.chartcatalogs) ? (obj.chartcatalogs as unknown[]) : [];
  const chartcatalogs = new Map<string, MergedChartcatalogsCatalog>();
  let chartCount = 0;
  for (const entry of rawCatalogs) {
    const charts = (entry as { charts?: unknown } | null)?.charts;
    chartCount += Array.isArray(charts) ? charts.length : 0;
    if (Value.Check(MergedChartcatalogsCatalogSchema, entry)) {
      chartcatalogs.set(entry.file, entry);
    }
  }
  const tilesets = (Array.isArray(obj.tilesets) ? (obj.tilesets as unknown[]) : []).filter(
    (t): t is MergedTileset => Value.Check(MergedTilesetSchema, t)
  );
  return {
    contentHash: typeof obj.contentHash === 'string' ? obj.contentHash : null,
    catalogCount: rawCatalogs.length,
    chartCount,
    chartcatalogs,
    tilesets,
    schemaText
  };
}

function chartCount(catalog: MergedCatalog): number {
  return catalog.chartcatalogs.reduce((n, c) => n + c.charts.length, 0);
}

/**
 * Reasons not to replace the published catalog with `next`. Per-file
 * breakage is absorbed by carrying entries forward; these thresholds catch
 * whole-source failures such as a truncated clone.
 */
export function publishBlockers(next: MergedCatalog, published: PublishedState | null): string[] {
  const blockers: string[] = [];
  if (next.chartcatalogs.length === 0) {
    blockers.push('no chartcatalogs catalogs were read');
  }
  if (next.online.length === 0) {
    blockers.push('the online chart list is empty');
  }
  if (published) {
    const after = next.chartcatalogs.length;
    if (after < Math.floor(published.catalogCount * 0.8)) {
      blockers.push(
        `chartcatalogs catalogs dropped from ${String(published.catalogCount)} to ${String(after)}`
      );
    }
    const chartsAfter = chartCount(next);
    if (chartsAfter < Math.floor(published.chartCount * 0.5)) {
      blockers.push(
        `chartcatalogs charts dropped from ${String(published.chartCount)} to ${String(chartsAfter)}`
      );
    }
  }
  return blockers;
}

export interface PublishDecision {
  publish: boolean;
  blockers: string[];
}

/**
 * Whether to deploy. The site also carries the JSON Schema, so a schema
 * change with identical content must still deploy, or third parties would
 * keep validating against a stale schema.
 */
export function decidePublish(
  next: MergedCatalog,
  published: PublishedState | null,
  schemaText: string,
  force: boolean
): PublishDecision {
  const blockers = publishBlockers(next, published);
  const changed =
    !published || published.contentHash !== next.contentHash || published.schemaText !== schemaText;
  return { publish: force || (changed && blockers.length === 0), blockers };
}
