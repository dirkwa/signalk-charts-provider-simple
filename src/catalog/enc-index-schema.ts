/**
 * Schema for the ENC index: one JSON file, published next to the merged
 * chart catalog, that lists every free ENC as a map of selectable units.
 *
 * A unit is what a user picks on the map: an outline to draw and the S-57
 * cells that picking it brings in, each with the archive it is downloaded
 * from and its path inside that archive.
 *
 * - NOAA units are NOAA's band-4 boxes. Each lists every band-3/4/5 cell
 *   whose box overlaps it, so a NOAA unit id is the band-4 chart id a NOAA
 *   chart set already stores.
 * - Every other S-57 cell is its own unit, outlined by its real `M_COVR`
 *   coverage. A source shipped as one archive still has one unit per cell,
 *   and a cell several sources publish appears once (EuRIS's copy first).
 *
 * The file is also the build's state between runs: `archives` records the
 * version each archive was read at, so the next run downloads only archives
 * whose version changed.
 *
 * Compatibility follows the merged catalog (`docs/chart-catalog.md`):
 * additive changes keep `schemaVersion`, and consumers ignore unknown
 * fields and skip entries they cannot interpret rather than the whole file.
 */

import { Type, type Static } from 'typebox';
import { BboxSchema } from './merged-catalog-schema.js';

export const ENC_INDEX_SCHEMA_VERSION = 1;

/** Source id of NOAA's ENCs. chartcatalogs sources use their catalog file stem. */
export const NOAA_SOURCE_ID = 'noaa';

const HttpOrHttpsUrl = Type.String({ pattern: '^https?://' });

const PositionSchema = Type.Tuple(
  [Type.Number({ minimum: -180, maximum: 180 }), Type.Number({ minimum: -90, maximum: 90 })],
  { description: '[longitude, latitude] in degrees (WGS 84).' }
);

const RingSchema = Type.Array(PositionSchema, {
  minItems: 4,
  description: 'A closed ring: the first and last positions are equal.'
});

const PolygonSchema = Type.Object({
  type: Type.Literal('Polygon'),
  coordinates: Type.Array(RingSchema, { minItems: 1, maxItems: 1 })
});

const MultiPolygonSchema = Type.Object({
  type: Type.Literal('MultiPolygon'),
  coordinates: Type.Array(Type.Array(RingSchema, { minItems: 1, maxItems: 1 }), { minItems: 1 })
});

export const EncOutlineSchema = Type.Union([PolygonSchema, MultiPolygonSchema], {
  description:
    'Where the unit is, as a GeoJSON Polygon or MultiPolygon with exterior rings only, for drawing and hit-testing. NOAA units are their band-4 box; other units are their cell’s M_COVR coverage, simplified.'
});

export const EncIndexSourceSchema = Type.Object({
  id: Type.String({
    minLength: 1,
    description:
      '"noaa"; the chartcatalogs catalog file name without ".xml" (the merged catalog’s entry id for that file); or a direct source’s own id.'
  }),
  label: Type.String({ minLength: 1, description: 'Display name of the source.' }),
  kind: Type.Union([Type.Literal('noaa'), Type.Literal('chartcatalogs'), Type.Literal('direct')], {
    description:
      '"noaa": NOAA’s ENC footprints. "chartcatalogs": a chartcatalogs.github.io catalog file. "direct": a producer’s own catalog, read directly.'
  }),
  file: Type.Optional(
    Type.String({ description: 'The chartcatalogs catalog file the source comes from.' })
  ),
  catalog: Type.Optional(
    Type.String({ description: 'For a direct source: the producer’s catalog URL.' })
  )
});

export const EncIndexArchiveSchema = Type.Object({
  url: HttpOrHttpsUrl,
  source: Type.String({ minLength: 1 }),
  version: Type.String({
    description:
      'What the archive was read at: NOAA’s edition/update token, the chartcatalogs zipfile_datetime_iso8601, or a direct source’s catalog date for it. A build downloads the archive again only when its source reports a different version.'
  }),
  kind: Type.Union([Type.Literal('zip'), Type.Literal('cell')], {
    description: '"zip": a ZIP archive. "cell": the download is a bare S-57 cell file.'
  }),
  updates: Type.Optional(
    Type.Array(Type.String({ minLength: 1 }), {
      description:
        'Paths of update files (".001", ...) inside the archive whose base cell is not in it: corrections for cells published in another archive of the same source. Each file is named after its cell. Applying one needs it next to the base cell, and only to the edition it was written for.'
    })
  ),
  shadowed: Type.Optional(
    Type.Array(Type.String({ minLength: 1 }), {
      description:
        'Cells in this archive whose unit the index takes from another source (EuRIS first). Recorded so the archive is read again if that source stops publishing one of them.'
    })
  ),
  revision: Type.Optional(
    Type.Integer({
      minimum: 1,
      description:
        'Revision of the rules that turned a downloaded archive into units. A build reads an archive again when its revision is older than the build’s own. Absent for NOAA, which is rebuilt from its footprint file on every run.'
    })
  )
});

export const EncIndexCellSchema = Type.Object({
  name: Type.String({ minLength: 1, description: 'S-57 cell name, e.g. "US4FL1EP".' }),
  archive: HttpOrHttpsUrl,
  path: Type.String({
    minLength: 1,
    description:
      'Path of the cell’s base file (".000") inside the archive, with "/" separators. For a "cell" archive it is the file name the download should be saved as. Update files (".001", ...) sit next to it.'
  }),
  version: Type.Optional(
    Type.String({
      minLength: 1,
      description:
        'The cell’s edition and update as one token in NOAA’s form, e.g. "US4FL1EP_ED003_UP012" (NOAA’s own enc_ed_up, unchanged) or "1R7WAD01_ED005_UP002" (from the cell’s DSID, plus any update files next to it). Compare it with a stored copy to see whether the cell changed.'
    })
  ),
  updatesPublishedSeparately: Type.Optional(
    Type.Literal(true, {
      description:
        'Another archive of the same source, dated no earlier than this cell’s, holds update files for it (see `archives[].updates`). A download of the cell’s own archive lacks those corrections.'
    })
  )
});

export const EncIndexUnitSchema = Type.Object({
  source: Type.String({ minLength: 1 }),
  id: Type.String({
    minLength: 1,
    description:
      'The band-4 chart id for NOAA, the S-57 cell name otherwise. Non-NOAA ids are unique across the index: a cell several sources publish appears once, from EuRIS when it has the cell. NOAA ids are unique among NOAA units.'
  }),
  title: Type.String(),
  scale: Type.Optional(Type.Integer({ minimum: 1, description: 'Compilation scale denominator.' })),
  bbox: BboxSchema,
  outline: EncOutlineSchema,
  cells: Type.Array(EncIndexCellSchema, {
    minItems: 1,
    description:
      'Every cell selecting the unit brings in. For NOAA: each band-3/4/5 cell whose box overlaps the unit’s band-4 box.'
  }),
  statusCells: Type.Array(Type.String({ minLength: 1 }), {
    minItems: 1,
    description:
      'Names of the cells whose state (downloaded, out of date) is shown as the unit’s own. A subset of `cells`. For NOAA: the band-4 cell and the band-5 cells overlapping it, but not band 3, which spans many boxes and would mark them all on one update.'
  })
});

export const EncIndexSchema = Type.Object({
  schemaVersion: Type.Integer({ minimum: 1 }),
  generatedAt: Type.String(),
  contentHash: Type.String({
    description: 'SHA-256 of the content, excluding generatedAt. Changes only when the data does.'
  }),
  sources: Type.Array(EncIndexSourceSchema),
  archives: Type.Array(EncIndexArchiveSchema),
  units: Type.Array(EncIndexUnitSchema)
});

/**
 * What a consumer such as this plugin needs from each entry, and nothing
 * more. The schemas above close some value lists (a source's `kind`, the
 * scale as an integer) that the compatibility policy lets grow, so reading
 * a published file against them would drop entries over a change the
 * consumer never reads. Only what the plugin acts on is strict: an archive
 * `kind` the downloader cannot handle, or an outline it cannot draw.
 */
export const EncIndexSourceReadSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  label: Type.String({ minLength: 1 })
});

export const EncIndexArchiveReadSchema = Type.Object({
  url: HttpOrHttpsUrl,
  source: Type.String({ minLength: 1 }),
  version: Type.String(),
  kind: Type.Union([Type.Literal('zip'), Type.Literal('cell')]),
  updates: Type.Optional(Type.Array(Type.String({ minLength: 1 })))
});

export const EncIndexUnitReadSchema = Type.Object({
  source: Type.String({ minLength: 1 }),
  id: Type.String({ minLength: 1 }),
  title: Type.String(),
  scale: Type.Optional(Type.Number()),
  bbox: BboxSchema,
  outline: EncOutlineSchema,
  cells: Type.Array(EncIndexCellSchema, { minItems: 1 }),
  statusCells: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })
});

export type EncOutline = Static<typeof EncOutlineSchema>;
export type EncIndexSource = Static<typeof EncIndexSourceSchema>;
export type EncIndexArchive = Static<typeof EncIndexArchiveSchema>;
export type EncIndexCell = Static<typeof EncIndexCellSchema>;
export type EncIndexUnit = Static<typeof EncIndexUnitSchema>;
export type EncIndex = Static<typeof EncIndexSchema>;
export type EncIndexSourceRead = Static<typeof EncIndexSourceReadSchema>;
export type EncIndexArchiveRead = Static<typeof EncIndexArchiveReadSchema>;
export type EncIndexUnitRead = Static<typeof EncIndexUnitReadSchema>;

/** The schema as published next to the index, with its own `$id`. */
export function publishedEncIndexJsonSchema(id: string): Record<string, unknown> {
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: id,
    ...EncIndexSchema
  };
}
