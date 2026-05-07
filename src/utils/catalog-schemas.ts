/**
 * TypeBox schemas + safe-parse helpers for the catalog manager's JSON
 * read paths (cached catalog files, installs map, registry cache, GitHub
 * API response).
 *
 * Why: every read site previously did `JSON.parse(...) as CatalogData` and
 * trusted the bytes. A hand-edited or corrupted cache file would put a
 * malformed shape into memory and surface as a `Cannot read properties of
 * undefined` later, far from the actual cause. With these schemas a bad
 * cache is rejected at the read boundary; the manager falls back to
 * "no cache" / "no installs" and the next refresh writes a clean file.
 *
 * The XML parse path is *not* covered here — xml2js's arrays-of-strings
 * shape is awkward to model in TypeBox and the function already filters
 * per-entry with a try/catch.
 */

import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type { TSchema } from '@sinclair/typebox';

export const CatalogCategorySchema = Type.Union([
  Type.Literal('mbtiles'),
  Type.Literal('ienc'),
  Type.Literal('rnc'),
  Type.Literal('general')
]);

export const CatalogRegistryEntrySchema = Type.Object({
  file: Type.String(),
  label: Type.String(),
  category: CatalogCategorySchema
});

export const CatalogChartSchema = Type.Object({
  number: Type.String(),
  title: Type.String(),
  format: Type.String(),
  zipfile_location: Type.String(),
  zipfile_datetime_iso8601: Type.String()
});

// `dateCreated` and `dateValid` are absent from some real catalog XML
// headers (and from cached fixtures written by older builds). The
// parser populates them as `''` when missing; mark optional in the
// schema so a header without them still validates.
export const CatalogHeaderSchema = Type.Object({
  title: Type.String(),
  dateCreated: Type.Optional(Type.String()),
  dateValid: Type.Optional(Type.String())
});

export const CatalogDataSchema = Type.Object({
  fetchedAt: Type.String(),
  catalogFile: Type.String(),
  header: CatalogHeaderSchema,
  charts: Type.Array(CatalogChartSchema)
});

export const CatalogInstallSchema = Type.Object({
  catalogFile: Type.String(),
  zipfile_datetime_iso8601: Type.String(),
  installedAt: Type.String(),
  zipfile_location: Type.String()
});

export const CatalogInstallsMapSchema = Type.Record(Type.String(), CatalogInstallSchema);

export const CatalogRegistryCacheSchema = Type.Array(CatalogRegistryEntrySchema);

// Shape returned by GitHub's contents API for a directory listing. We
// only consume `name`; the real response has many more fields, so the
// schema validates one field by-name and ignores the rest via
// additionalProperties (TypeBox default).
export const GithubContentsListingSchema = Type.Array(
  Type.Object({
    name: Type.String()
  })
);

export type CatalogCategory = Static<typeof CatalogCategorySchema>;
export type CatalogRegistryEntry = Static<typeof CatalogRegistryEntrySchema>;
export type CatalogChart = Static<typeof CatalogChartSchema>;
export type CatalogHeader = Static<typeof CatalogHeaderSchema>;
export type CatalogData = Static<typeof CatalogDataSchema>;
export type CatalogInstall = Static<typeof CatalogInstallSchema>;
export type CatalogInstallsMap = Static<typeof CatalogInstallsMapSchema>;
export type CatalogRegistryCache = Static<typeof CatalogRegistryCacheSchema>;
export type GithubContentsListing = Static<typeof GithubContentsListingSchema>;

/**
 * Validate `input` against `schema`. On success returns the typed value;
 * on failure returns `null` so the caller can fall back without
 * try/catching every read site.
 */
export function safeParse<T extends TSchema>(schema: T, input: unknown): Static<T> | null {
  return Value.Check(schema, input) ? input : null;
}
