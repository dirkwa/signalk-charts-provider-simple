# The ENC index

The ENC index lists every free ENC (Electronic Navigational Chart) as a map of
**selectable units**. Each unit has an outline to draw and click, and the S-57
cells that picking it brings in. Each cell has the archive it downloads from
and its path inside that archive. One index covers NOAA, every chartcatalogs
source whose format is `enc` in `catalog/chartcatalogs-index.json`, and the
direct sources in `catalog/enc-direct-sources.json` (see below).

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
- **One unit per cell.** A cell several sources publish appears once. A
  direct source's copy wins (see below), then EuRIS's: EuRIS republishes most
  European national producers' cells, one cell per download and usually newer
  than the national catalogs, so a national source contributes only the cells
  EuRIS lacks. Among the others, the newest edition wins, and between equal
  editions the archive with fewer cells, the smaller download. The order is by
  source, not by version, because a chartcatalogs copy's date can be years
  stale. An archive records the cells it leaves to
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

## Direct sources

Some producers publish their ENCs with a catalog of their own: a
machine-readable catalog, an INSPIRE download feed, or a web page that links
the archives. The builder reads them itself, so a new source does not wait on
chartcatalogs, and its versions follow the producer's reissues.

- The US Army Corps of Engineers' inland river cells are one; chartcatalogs
  does not carry them.
- USACE's buoy overlay is another. chartcatalogs lists it too, but with a
  date that has not moved in years while USACE reissues the overlay as buoys
  move.
- A direct source's copy of a cell wins over a chartcatalogs copy. The
  chartcatalogs archive records the cell as shadowed. Its copy returns when
  the cell leaves a direct catalog that still lists others, or when the
  source is removed from the list. A direct catalog that lists nothing at all
  counts as unreadable, so it keeps what is published.

How they are configured and read:

- `catalog/enc-direct-sources.json` lists them by hand, checked against a
  strict schema (`src/catalog/enc-direct-sources.ts`): an id, a label, the
  catalog's format and its URL. A `links` pattern picks the archives out of a
  web page or feed, and an `attribution` carries the credit a licence such as
  CC BY asks for into the index's source entry.
- The formats are described with `format` in the schema. A catalog entry is
  versioned by the catalog's date for it. A web page link has no date of its
  own, so its version combines the link (for a WordPress upload, its upload
  month) with the server's `Last-Modified` from a HEAD request. A file
  replaced in place under the same URL is then still read again.
- A page or feed is scraped, so its layout can change. When nothing on it
  matches any more, the source counts as unreadable and keeps what is
  published, with a warning, rather than losing its cells.
- Each format has one adapter in that module, which turns the producer's
  catalog into the list of archives the source offers, each with the
  catalog's own date for it. A catalog that cannot be fetched or read leaves
  the source as published, with a warning; an entry whose date cannot be read
  is versioned by its raw text, with a warning, so the rest of the source
  keeps updating. From there a direct source is built like any other:
  coverage from `M_COVR`, a version per cell, reuse while the date is
  unchanged, carry-forward when the catalog or an archive cannot be read, the
  drop guard and one unit per cell.
- Adding a catalog in a format the builder already reads is a config entry.
  A new format also needs an adapter, a format name in the schema, and a
  test with a sample of the catalog.

Direct sources appear only in the ENC index, with `kind` "direct" and their
catalog URL; the merged catalog and the Chart Catalog tab are unaffected.

## How it is built

`.github/workflows/publish-catalog.yml` builds the index in the same job as the
merged catalog, because a Pages deployment replaces the whole site.
`src/catalog/build-enc-index.ts` holds the logic and does no I/O, and
`src/catalog/enc-index-cli.ts` is the I/O around it.

- **The published index is the build's state.** `archives` records the version
  each archive was read at: NOAA's `enc_ed_up`, the chartcatalogs
  `zipfile_datetime_iso8601`, or a direct source's catalog date. A run
  downloads only archives whose version changed, so after the first build a
  run costs a few downloads.
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
  a long header across lines, which HTTP/1.1 deprecated. Depending on the
  Node version, `fetch` refuses the header or misreads the body after it.
  A download that fails that way is retried once with only header parsing
  relaxed (`src/catalog/lenient-download.ts`); TLS is verified as before.
- **Polite downloads.** Archives are fetched one at a time per host, with a
  pause between requests. Different hosts run side by side.
- **Identical output everywhere.** GDAL is the plugin's own WebAssembly
  build (gdal3.js, `docs/chart-conversion.md`) at the version `package.json`
  pins. Coordinates are simplified and rounded by fixed rules, and everything
  is sorted. So a maintainer's machine and CI produce the same file and
  content hash.

## The first build

The first build downloads every archive, mostly from small government
servers, which set the pace. CI does it under the time budget: each run
publishes what it has read, and the next scheduled run carries on, so the
index fills over a few runs, all with the same GDAL. The CLI is the same one
CI runs and can be run locally to debug an odd source; its header comment
lists its flags.

## How the plugin uses it

The ENC Charts tab draws the index's units, and a chart set stores the units
the user picked.

- **Reading the index.** The plugin downloads the index when it starts if the
  user has chart sets, when the tab is opened and the copy is more than a few
  hours old, when the user clicks **Refresh**, and before a chart set is
  downloaded. It keeps the last good copy, so the tab keeps working offline,
  and revalidates with the ETag. Serving charts never depends on the index.
  `ENC_INDEX_URL` points a development server at another copy.
- **Downloading a set.** Each archive is downloaded once, however many of the
  set's cells it holds, and only those cells' files are extracted. Requests
  go to one host at a time, with a pause between them, and use the same TLS
  and header fallbacks as the build. The archive URLs come from third
  parties, so the plugin downloads only from public internet addresses: a
  URL, or any redirect, whose host is or resolves to a loopback, private,
  link-local or unique-local address, or a local network name such as
  `.local`, fails that archive.
- **Updates per cell.** A chart set keeps each cell it downloaded, with the
  version it was downloaded at and its GDAL output. An update downloads and
  runs GDAL only on cells whose version in the index changed, then builds
  the set's chart from every cell again.
- **Separately published updates.** For a cell with
  `updatesPublishedSeparately`, the plugin applies the updates numbered after
  the cell's own update, from archives of its source dated no earlier than
  the cell's, in order up to the first gap. GDAL applies update files in
  extension order from `.001` and stops at the first missing one, so a
  reissued base (update 40, with no `.001` to `.040` beside it) gets `.041`
  as `.001`. The set records the cell's version with the update number it
  reached.
- **Entries it cannot read.** Following the compatibility policy, the plugin
  skips an entry it cannot interpret, such as an archive kind its downloader
  does not know, and the units that need it. A chart set that selected such
  a unit says it needs a newer plugin and will not rebuild without it. A
  non-NOAA unit with a NOAA unit's id is also left out: it is a copy of
  NOAA's own cell, which the NOAA box brings in.
- **Update status.** A set is out of date when any of its cells' versions in
  the index differs from the version recorded at download, or its units
  bring in different cells. The same rule applies to every source.
