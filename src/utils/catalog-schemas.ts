/**
 * TypeBox schemas + safe-parse helpers for the catalog manager. The installs
 * map is the one JSON read path validated here: a hand-edited or corrupted
 * `catalog-installs.json` is rejected at the read boundary and the manager
 * falls back to "no installs" instead of surfacing a `Cannot read properties
 * of undefined` far from the cause. The chartcatalogs shapes here define the
 * types the UI and download flow use; the merged catalog itself is validated
 * by `catalog/merged-catalog-schema.ts`.
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

export const CatalogInstallSchema = Type.Recursive((Self) =>
  Type.Object({
    catalogFile: Type.String(),
    zipfile_datetime_iso8601: Type.String(),
    installedAt: Type.String(),
    zipfile_location: Type.String(),
    // Relative path of the produced .mbtiles under chartPath. Optional
    // because the install is recorded before the conversion finishes;
    // the converter calls setInstallFilename() once the file is on disk
    // so the delete flow can find this record by filename.
    installedFilename: Type.Optional(Type.String()),
    // Snapshot of the prior record, captured up-front by trackInstall() so a
    // restart mid-update can roll back to the still-on-disk old version
    // (issue #120 restart window). `null` marks a pending FRESH install
    // ("delete on rollback"). Cleared by setInstallFilename() on success, so
    // its presence means "this install is in-flight". One level deep only —
    // trackInstall strips any nested snapshot.
    previousVersion: Type.Optional(Type.Union([Self, Type.Null()]))
  })
);

export const CatalogInstallsMapSchema = Type.Record(Type.String(), CatalogInstallSchema);

export type CatalogCategory = Static<typeof CatalogCategorySchema>;
export type CatalogRegistryEntry = Static<typeof CatalogRegistryEntrySchema>;
export type CatalogChart = Static<typeof CatalogChartSchema>;
export type CatalogHeader = Static<typeof CatalogHeaderSchema>;
export type CatalogData = Static<typeof CatalogDataSchema>;
export type CatalogInstall = Static<typeof CatalogInstallSchema>;
export type CatalogInstallsMap = Static<typeof CatalogInstallsMapSchema>;

/**
 * Validate `input` against `schema`. On success returns the typed value;
 * on failure returns `null` so the caller can fall back without
 * try/catching every read site.
 */
export function safeParse<T extends TSchema>(schema: T, input: unknown): Static<T> | null {
  return Value.Check(schema, input) ? input : null;
}
