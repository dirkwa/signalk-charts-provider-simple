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
many cells; Austria ships all of its cells in one ZIP. The only way to know where
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
  A cell with no `M_COVR` at all (a few producers omit it) is outlined by the
  grid squares its features fall in. The USACE buoy overlay, one cell covering
  the US inland rivers, then outlines the rivers rather than a box from the
  Gulf of Mexico to the Great Lakes.
- **One unit per cell.** EuRIS republishes most European national producers'
  cells, one cell per download and usually newer than the national catalogs.
  A cell several sources publish appears once, from EuRIS when it has it, so
  a national source contributes only the cells EuRIS lacks. Among the
  others, the newest edition wins. An archive records the cells it leaves to
  another source in `shadowed`; if that source stops publishing one, the
  archive is read again and its own copy comes back.
- **Updates published separately.** A few sources publish update files
  (`.001`, ...) in their own archives, apart from the base cells they correct.
  Examples are the South China Sea notices to mariners and one Dutch "Closed
  Edition" archive.
  - Such an archive lists those files' paths in its `updates`.
  - A cell gets `updatesPublishedSeparately` when an archive of its source,
    dated no earlier than the cell's own, holds updates for it. A download of
    the cell's archive alone lacks those corrections.
  - Older update archives are taken to be for an earlier edition, or already
    folded into a newer reissue.
  - The flag only applies to its own source's copy of the cell: when EuRIS
    supplies the cell, the national corrections do not apply to it.
  - The index does not say how to apply the updates. That needs each update
    matched to the edition it was written for.

NOAA unit ids are NOAA's band-4 chart ids, and NOAA archive versions are NOAA's
`enc_ed_up` tokens, unchanged. A NOAA chart set saved by the plugin therefore
maps onto the index by name: its selected band-4 ids are unit ids, and its
stored versions match until NOAA really updates a cell.

Every cell carries a `version` in that same form, so one freshness rule works
for every source. For other sources it is built from the cell's DSID edition
and update number, counting any update files next to the cell, e.g.
`1R7WAD01_ED005_UP002`. A chart set can then fetch only the cells whose
version changed.

Outlines keep exterior rings only and are simplified with one fixed tolerance
and rounding (`src/catalog/enc-outline.ts`), fine enough to keep a river's
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
- **A drop guard** refuses to publish when cells fall sharply. It checks the
  total, and each source that had at least ten cells, counting the cells a
  source leaves to EuRIS as its own, so EuRIS taking them over is not a drop.
  A maintainer can override it with the workflow's `force` input once the
  drop is understood.
- **A time budget.** The workflow gives each run a fixed time to read changed
  archives. Any left over keep their published units and are read on the next
  run.
- **Missing intermediate certificates.** A few download servers leave an
  intermediate certificate out of their TLS handshake, which browsers work
  around and Node does not. `catalog/extra-ca-certificates.pem` holds those
  intermediates, and the builder adds them to Node's trusted set, so every
  download is still verified up to a root Node already trusts. A test checks
  that each one is an intermediate under such a root.
- **Malformed response headers.** The Brazilian Navy's download server folds
  a long header across lines, which HTTP/1.1 deprecated and Node's `fetch`
  refuses.
  A download that fails that way is retried once with only header parsing
  relaxed (`src/catalog/lenient-download.ts`); TLS is verified as before.
- **Polite downloads.** Archives are fetched one at a time per host, with a
  pause between requests. Different hosts run side by side.
- **Identical output everywhere.** GDAL runs in the charts-toolbox image
  (`docs/charts-toolbox-image.md`) at the version the plugin pins. Coordinates
  are simplified and rounded by fixed rules, and everything is sorted. So a
  maintainer's machine and CI produce the same file and content hash.

## The first build

The first build downloads every archive, mostly from small government
servers, which set the pace. CI does it under the time budget: each run
publishes what it has read, and the next scheduled run carries on, so the
index fills over a few runs, all from the same image. The CLI is the same one
CI runs and can be run locally to debug an odd source; its header comment
lists its flags.
