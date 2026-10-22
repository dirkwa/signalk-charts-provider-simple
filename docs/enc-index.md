# The ENC index

The ENC index lists every free ENC (Electronic Navigational Chart) as a map of
**selectable units**. Each unit has an outline to draw and click, and the S-57
cells that picking it brings in. Each cell has the archive it downloads from
and its path inside that archive. One index covers NOAA and every chartcatalogs
source whose format is `enc` in `catalog/chartcatalogs-index.json`.

It is published next to the merged chart catalog (`docs/chart-catalog.md`) as
`enc-index.json`, with its JSON Schema as `enc-index.schema.json`. It follows
the merged catalog's compatibility policy:

- Additive changes keep `schemaVersion`.
- Consumers ignore unknown fields.
- Consumers skip entries they cannot interpret, never the whole file.

## Why it is built in CI

chartcatalogs lists ENC downloads, but not where each chart is. Its catalogs
have one hand-entered box per source, and many entries are archives holding
dozens of cells: Austria ships 269 cells in one ZIP. The only way to know where
each cell is, is to download every archive and read each cell's `M_COVR`
(coverage) objects. Doing that once, in CI, means:

- a boat downloads one file instead of hundreds of archives;
- the plugin draws a map without knowing any source's quirks;
- the map still works when NOAA's server is down.

## What a unit is

- **NOAA:** the units are NOAA's band-4 boxes, outlined by the box.
  - `cells` lists every band-3/4/5 cell whose box overlaps it, as the NOAA
    Charts tab includes them.
  - `statusCells` lists the band-4 cell and the band-5 cells overlapping it.
    These are the cells whose state the tab shows as the box's own. Band 3
    spans many boxes, so it is left out of `statusCells`.
- **Other sources:** every S-57 cell is its own unit, outlined by its real
  coverage. River cells follow the river: their bounding boxes overlap heavily
  but their outlines barely do, so a click lands on the stretch the user meant.
  A cell inside a shared archive is still its own unit, mapped to that archive.
  A cell with no `M_COVR` at all (a few producers omit it) is outlined by its
  data extent instead.
- **Update-only archives** hold update files (`.001`, ...) for cells whose base
  file is in another archive, such as the South China Sea notices to mariners.
  They have no units of their own, but are listed in `archives` so later builds
  do not download them again.

NOAA unit ids are NOAA's band-4 chart ids, and NOAA archive versions are NOAA's
`enc_ed_up` tokens, unchanged. A NOAA chart set saved by the plugin therefore
maps onto the index by name: its selected band-4 ids are unit ids, and its
stored versions match until NOAA really updates a cell. Unit ids are unique
within a source; a unit is identified by its `source` and `id` together.

Outlines keep exterior rings only and are simplified with a fixed tolerance
(about 11 m), with coordinates rounded to about 1 m. That keeps a river's
outline on the river while keeping the file small.

## How it is built

`.github/workflows/publish-catalog.yml` builds the index in the same job as the
merged catalog, because a Pages deployment replaces the whole site.
`src/catalog/build-enc-index.ts` holds the logic and does no I/O, and
`src/catalog/enc-index-cli.ts` is the I/O around it.

- **The published index is the build's state.** `archives` records the version
  each archive was read at: NOAA's `enc_ed_up`, or the chartcatalogs
  `zipfile_datetime_iso8601`. A run downloads only archives whose version
  changed, so after the first build a run costs a few downloads.
- **Rules have a revision.** Each archive also records `ARCHIVE_REVISION`. When
  a change to the outline rules would give different units for the same
  archive, bumping it makes the next runs read every archive again instead of
  reusing old units.
- **A failure keeps what was published.** An archive that fails to download or
  read keeps its published units, at its old version, with a warning, so the
  next run tries it again. The same applies to NOAA's footprint file.
- **A drop guard** refuses to publish when units fall sharply. It checks the
  total, and each source that had at least ten units. A maintainer can
  override it with the workflow's `force` input once the drop is understood.
- **A time budget.** A run reads changed archives for at most 45 minutes. Any
  left over keep their published units and are read on the next run.
- **Polite downloads.** Archives are fetched one at a time per host, with a
  pause between requests. Different hosts run side by side.
- **Identical output everywhere.** GDAL runs in the charts-toolbox image
  (`docs/charts-toolbox-image.md`) at the version the plugin pins. Coordinates
  are simplified and rounded by fixed rules, and everything is sorted. So a
  maintainer's machine and CI produce the same file and content hash.

## Running it locally

The first full build downloads every archive, about 1700 of them, mostly from
small government servers. It runs on a maintainer's machine rather than in CI.
It needs Docker (or Podman with `--runtime podman`) and a clone of
chartcatalogs:

```bash
git clone --depth 1 https://github.com/chartcatalogs/catalogs.git /tmp/chartcatalogs
npm run build
node dist/catalog/enc-index-cli.js \
  --chartcatalogs /tmp/chartcatalogs \
  --index catalog/chartcatalogs-index.json \
  --out /tmp/enc-index \
  --work /tmp/enc-index-work \
  --published-url https://dirkwa.github.io/signalk-charts-provider-simple/enc-index.json
```

- `--work` keeps what each archive gave, so an interrupted run picks up where it
  stopped and a rerun after a change to the outline rules downloads nothing.
- `--sources noaa,AT_IENC_Catalog` reads only those sources. Every other source
  keeps what the published index has.
- `--max-minutes` and `--delay-ms` set the time budget and the pause between
  requests to one host.

**Seeding CI.** Until an index is published, CI starts from the
`enc-index.json` asset of this repository's `enc-index-seed` release, if there
is one. Upload a local first build there, and the first CI run only reads what
changed since. Without a seed, CI builds the index over several runs, 45 minutes
at a time.
