/**
 * Schemas for the merged chart catalog: the single JSON file the
 * publish-catalog workflow builds from chartcatalogs.github.io plus this
 * repo's curated online-chart list, and publishes to GitHub Pages.
 *
 * There are two families, on purpose:
 * - **Source schemas** (`catalog/*.json`) are strict
 *   (`additionalProperties: false`) so a typo in a hand-edited entry fails
 *   the tests instead of silently doing nothing.
 * - **Published schemas** (the built catalog) are tolerant. Released plugins
 *   and third parties read the file for years, so the compatibility policy
 *   is: additive changes (new optional fields, new enum values, new entries)
 *   keep `schemaVersion`; only a breaking change bumps it. Consumers ignore
 *   unknown fields and validate entries one at a time, skipping any they
 *   cannot interpret rather than rejecting the whole file.
 *
 * Every facet the Chart Catalog tab filters on (use, category, format,
 * bbox) is carried explicitly rather than left for consumers to derive.
 */

import { Type, type Static, type TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

export const MERGED_CATALOG_SCHEMA_VERSION = 1;

const STRICT = { additionalProperties: false } as const;

export const ChartUseSchema = Type.Union([Type.Literal('download'), Type.Literal('stream')], {
  description:
    '"download": fetched (and, if needed, converted) once, then works offline. "stream": loaded from the provider while online.'
});

export const ChartCategorySchema = Type.Union([
  Type.Literal('navigation'),
  Type.Literal('weather'),
  Type.Literal('depth'),
  Type.Literal('basemap'),
  Type.Literal('overlay')
]);

export const ChartFormatSchema = Type.Union([
  Type.Literal('mbtiles'),
  Type.Literal('enc'),
  Type.Literal('rnc'),
  Type.Literal('shapefile'),
  Type.Literal('wms'),
  Type.Literal('wmts'),
  Type.Literal('mapstyle'),
  Type.Literal('tiles')
]);

export const BboxSchema = Type.Tuple(
  [
    Type.Number({ minimum: -180, maximum: 180 }),
    Type.Number({ minimum: -90, maximum: 90 }),
    Type.Number({ minimum: -180, maximum: 180 }),
    Type.Number({ minimum: -90, maximum: 90 })
  ],
  {
    description:
      '[west, south, east, north] in degrees. west > east means the box crosses the antimeridian, so a point is inside when lon >= west OR lon <= east.'
  }
);

export const RegionTagsSchema = Type.Array(Type.String({ pattern: '^[a-z0-9]+(-[a-z0-9]+)*$' }), {
  minItems: 1,
  description: 'Descriptive region tags such as "global", "us-conus" or "europe".'
});

const HttpsUrl = Type.String({ pattern: '^https://' });

// chartcatalogs still lists a few plain-http download hosts, which the
// plugin's downloader accepts, so chart zip locations may be http(s).
const HttpOrHttpsUrl = Type.String({ pattern: '^https?://' });

/** Chart resource `type` values as Signal K chart plotters understand them. */
export const OnlineChartTypeSchema = Type.Union([
  Type.Literal('WMS'),
  Type.Literal('WMTS'),
  Type.Literal('tilelayer'),
  Type.Literal('mapstyleJSON'),
  Type.Literal('tileJSON')
]);

const onlineChartSourceProps = {
  type: OnlineChartTypeSchema,
  url: HttpsUrl,
  // Required for WMS/WMTS (enforced by checkOnlineChartEntry). Chosen for
  // the user, so they never have to pick layers from GetCapabilities.
  layers: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })),
  minzoom: Type.Optional(Type.Integer({ minimum: 0, maximum: 24 })),
  maxzoom: Type.Optional(Type.Integer({ minimum: 0, maximum: 24 })),
  tileSize: Type.Optional(Type.Union([Type.Literal(256), Type.Literal(512)])),
  defaultOpacity: Type.Optional(Type.Number({ minimum: 0, maximum: 1 }))
};

const onlineChartTemporalProps = {
  kind: Type.Union([Type.Literal('observation'), Type.Literal('forecast')], {
    description:
      '"observation" frames run up to now (radar, satellite); "forecast" frames run from now into the future (wind, waves).'
  }),
  refreshInterval: Type.Integer({
    minimum: 60000,
    maximum: 86400000,
    description: 'How often to re-read the timeline, in milliseconds.'
  }),
  window: Type.Optional(
    Type.String({
      // Days/hours/minutes subset of ISO 8601, written without lookaheads
      // so RE2-based JSON Schema validators accept it.
      pattern: '^P(?:\\d+D(?:T(?:\\d+H(?:\\d+M)?|\\d+M))?|T(?:\\d+H(?:\\d+M)?|\\d+M))$',
      description:
        'How much history (observation) or lead time (forecast) to offer, as an ISO 8601 duration in days, hours and minutes (e.g. "PT2H", "P5D"). Services such as EUMETSAT advertise years of frames.'
    })
  ),
  capabilitiesUrl: Type.Optional(
    Type.String({
      pattern: '^https://',
      description:
        'GetCapabilities URL to read the timeline from, when the service offers a smaller per-layer document than the one at `chart.url`.'
    })
  )
};

function onlineChartEntryProps<C extends TSchema, T extends TSchema>(chart: C, temporal: T) {
  return {
    id: Type.String({ pattern: '^[a-z0-9]+(-[a-z0-9]+)*$' }),
    name: Type.String({ minLength: 1 }),
    description: Type.String({ minLength: 1 }),
    category: ChartCategorySchema,
    regions: RegionTagsSchema,
    bbox: BboxSchema,
    // Where the chart is actually useful, when narrower than the data
    // extent: a satellite's full disk is `bbox` (what a plotter draws), but
    // imagery near the disk's edge is too oblique to be worth offering as
    // "near". Only location filters use it.
    coverage: Type.Optional(BboxSchema),
    provider: Type.String({ minLength: 1 }),
    attribution: Type.String({ minLength: 1 }),
    license: Type.String({ minLength: 1 }),
    licenseUrl: HttpsUrl,
    notForNavigation: Type.Optional(Type.Boolean()),
    chart,
    temporal: Type.Optional(temporal)
  };
}

// ---- Source schemas (strict) ----

export const OnlineChartSourceSchema = Type.Object(onlineChartSourceProps, STRICT);
export const OnlineChartTemporalSchema = Type.Object(onlineChartTemporalProps, STRICT);

/** One curated online chart, as maintained in `catalog/online-charts.json`. */
export const OnlineChartEntrySchema = Type.Object(
  onlineChartEntryProps(OnlineChartSourceSchema, OnlineChartTemporalSchema),
  STRICT
);

export const OnlineChartsSourceFileSchema = Type.Object(
  { charts: Type.Array(OnlineChartEntrySchema, { minItems: 1 }) },
  STRICT
);

const chartcatalogsFacetProps = {
  label: Type.String({ minLength: 1 }),
  category: ChartCategorySchema,
  format: ChartFormatSchema,
  regions: RegionTagsSchema,
  bbox: BboxSchema
};

/**
 * Facets for one chartcatalogs catalog file, as maintained in
 * `catalog/chartcatalogs-index.json`. chartcatalogs carries no coverage
 * data, so this index is what makes "Near me" work for downloadable charts.
 */
export const ChartcatalogsIndexEntrySchema = Type.Object(chartcatalogsFacetProps, STRICT);

export const ChartcatalogsIndexSchema = Type.Record(
  Type.String({ pattern: '^[A-Za-z0-9_]+_Catalog\\.xml$' }),
  ChartcatalogsIndexEntrySchema
);

// ---- Published schemas (tolerant) ----

export const MergedCatalogChartSchema = Type.Object({
  number: Type.String({ minLength: 1 }),
  title: Type.String(),
  format: Type.String(),
  zipfile_location: HttpOrHttpsUrl,
  zipfile_datetime_iso8601: Type.String()
});

/** A chartcatalogs catalog file, converted to JSON and given its facets. */
export const MergedChartcatalogsCatalogSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  file: Type.String({ minLength: 1 }),
  label: chartcatalogsFacetProps.label,
  use: Type.Literal('download'),
  category: ChartCategorySchema,
  indexed: Type.Boolean({
    description:
      'false when chartcatalogs added this file after the index was last updated. The catalog is still listed, but has no format, regions or bbox, so location and type filters skip it.'
  }),
  format: Type.Optional(ChartFormatSchema),
  regions: Type.Optional(RegionTagsSchema),
  bbox: Type.Optional(BboxSchema),
  header: Type.Object({
    title: Type.String(),
    dateCreated: Type.Optional(Type.String()),
    dateValid: Type.Optional(Type.String())
  }),
  charts: Type.Array(MergedCatalogChartSchema)
});

/** A curated online chart with its derived facets. */
export const MergedOnlineChartSchema = Type.Object({
  ...onlineChartEntryProps(
    Type.Object(onlineChartSourceProps),
    Type.Object(onlineChartTemporalProps)
  ),
  use: Type.Literal('stream'),
  format: ChartFormatSchema
});

export const MergedCatalogSchema = Type.Object(
  {
    schemaVersion: Type.Literal(MERGED_CATALOG_SCHEMA_VERSION, {
      description: 'Bumped only for breaking changes; additive changes keep the same version.'
    }),
    generatedAt: Type.String({
      description:
        'When this content was built. The catalog is republished only when its content changes, so this is effectively the time of the last change.'
    }),
    contentHash: Type.String({
      pattern: '^[0-9a-f]{64}$',
      description:
        'SHA-256 of the content, excluding timestamps and upstream commit ids. Unchanged hash means nothing a user would see has changed.'
    }),
    sources: Type.Object({
      chartcatalogs: Type.Object({
        homepage: HttpsUrl,
        issues: HttpsUrl,
        license: Type.String(),
        commit: Type.Optional(Type.String())
      }),
      online: Type.Object({
        homepage: HttpsUrl,
        issues: HttpsUrl
      })
    }),
    chartcatalogs: Type.Array(MergedChartcatalogsCatalogSchema),
    online: Type.Array(MergedOnlineChartSchema)
  },
  {
    title: 'Signal K merged chart catalog',
    description:
      'Downloadable charts from chartcatalogs.github.io merged with curated online charts. Consumers should ignore unknown fields and validate entries individually, skipping entries they cannot interpret.'
  }
);

// ---- Consumer read schema (lenient) ----

/**
 * What a consumer of the published catalog needs from an online chart entry
 * to list, add and serve it. Unlike the published schema it accepts any
 * category string (a consumer shows an unknown one under its own name) but
 * keeps the chart `type` closed, because a consumer can't promise a chart
 * plotter will draw a type it doesn't know. Facets it doesn't use (regions,
 * format) are left unchecked and so are not part of the type.
 */
export const OnlineChartReadSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  name: Type.String({ minLength: 1 }),
  description: Type.String(),
  category: Type.String(),
  bbox: BboxSchema,
  // Only a location-filter hint; a consumer checks it before use rather than
  // dropping the entry over it.
  coverage: Type.Optional(Type.Unknown()),
  provider: Type.String(),
  attribution: Type.Optional(Type.String()),
  license: Type.String(),
  licenseUrl: Type.String(),
  notForNavigation: Type.Optional(Type.Boolean()),
  chart: Type.Object({
    type: OnlineChartTypeSchema,
    url: HttpsUrl,
    layers: Type.Optional(Type.Array(Type.String())),
    minzoom: Type.Optional(Type.Integer({ minimum: 0, maximum: 24 })),
    maxzoom: Type.Optional(Type.Integer({ minimum: 0, maximum: 24 })),
    tileSize: Type.Optional(Type.Number()),
    defaultOpacity: Type.Optional(Type.Number({ minimum: 0, maximum: 1 }))
  }),
  temporal: Type.Optional(
    Type.Object({
      kind: Type.String(),
      refreshInterval: Type.Integer({ minimum: 60000, maximum: 86400000 }),
      window: Type.Optional(Type.String()),
      capabilitiesUrl: Type.Optional(HttpsUrl)
    })
  )
});

export type ChartUse = Static<typeof ChartUseSchema>;
export type ChartCategory = Static<typeof ChartCategorySchema>;
export type ChartFormat = Static<typeof ChartFormatSchema>;
export type Bbox = Static<typeof BboxSchema>;
export type OnlineChartType = Static<typeof OnlineChartTypeSchema>;
export type OnlineChartEntry = Static<typeof OnlineChartEntrySchema>;
export type OnlineChartsSourceFile = Static<typeof OnlineChartsSourceFileSchema>;
export type ChartcatalogsIndexEntry = Static<typeof ChartcatalogsIndexEntrySchema>;
export type ChartcatalogsIndex = Static<typeof ChartcatalogsIndexSchema>;
export type MergedCatalogChart = Static<typeof MergedCatalogChartSchema>;
export type MergedChartcatalogsCatalog = Static<typeof MergedChartcatalogsCatalogSchema>;
export type MergedOnlineChart = Static<typeof MergedOnlineChartSchema>;
export type MergedCatalog = Static<typeof MergedCatalogSchema>;
export type OnlineCatalogChart = Static<typeof OnlineChartReadSchema>;

/** The published JSON Schema document, with the root identifiers it needs. */
export function publishedJsonSchema(id: string): Record<string, unknown> {
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: id,
    ...MergedCatalogSchema
  };
}

/** The Type-filter facet for an online chart's resource type. */
export function formatForChartType(type: OnlineChartType): ChartFormat {
  switch (type) {
    case 'WMS':
      return 'wms';
    case 'WMTS':
      return 'wmts';
    case 'mapstyleJSON':
      return 'mapstyle';
    case 'tilelayer':
    case 'tileJSON':
      return 'tiles';
  }
}

function checkBbox(label: string, [, south, , north]: Bbox): string[] {
  return south < north ? [] : [`${label}: bbox south must be below north`];
}

/**
 * Rules the schema cannot express. Returns one message per problem (empty
 * when the entry is fine) so a build can report every bad entry at once.
 */
export function checkOnlineChartEntry(entry: OnlineChartEntry): string[] {
  const problems: string[] = [];
  const { chart, temporal } = entry;
  const isOgc = chart.type === 'WMS' || chart.type === 'WMTS';
  if (isOgc && !chart.layers) {
    problems.push(`${entry.id}: ${chart.type} charts must name their layer`);
  }
  if (!isOgc && chart.layers) {
    problems.push(`${entry.id}: layers only apply to WMS/WMTS charts`);
  }
  if (temporal && !isOgc) {
    // A time-varying tile layer needs a `{time}` URL template, which the
    // catalog does not model yet.
    problems.push(`${entry.id}: only WMS/WMTS charts can be temporal`);
  }
  if (chart.minzoom !== undefined && chart.maxzoom !== undefined && chart.minzoom > chart.maxzoom) {
    problems.push(`${entry.id}: minzoom is greater than maxzoom`);
  }
  return [...problems, ...checkBbox(entry.id, entry.bbox)];
}

/** Rules for `catalog/chartcatalogs-index.json` the schema cannot express. */
export function checkChartcatalogsIndex(index: ChartcatalogsIndex): string[] {
  return Object.entries(index).flatMap(([file, entry]) => checkBbox(file, entry.bbox));
}

/** Schema errors as short `path: message` strings, capped for log output. */
export function schemaErrors(schema: TSchema, value: unknown): string[] {
  return [...Value.Errors(schema, value)]
    .slice(0, 20)
    .map((e) => `${e.path || '<root>'}: ${e.message}`);
}
