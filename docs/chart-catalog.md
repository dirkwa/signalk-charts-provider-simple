# The merged chart catalog

The Chart Catalog tab reads a single catalog file that this repository builds and
publishes to its GitHub Pages site. It merges two sources:

- **Downloadable charts** from [chartcatalogs.github.io](https://chartcatalogs.github.io/)
  (CC0). These are ENC, RNC, MBTiles and shapefile chart sets that the plugin
  downloads and, where needed, converts. They are listed in the catalog as
  `chartcatalogs` entries, one per chartcatalogs catalog file.
- **Online charts** curated in this repository (`catalog/online-charts.json`). These
  are weather layers, online nautical charts, depth layers and base maps that
  stream from their provider while the boat has internet. They are listed as
  `online` entries.

The published file is public and has no plugin-specific assumptions, so other
chart plotters and plugins can use it as-is. Its JSON Schema is published next
to it as `catalog.schema.json`.

**Compatibility.** Additive changes (new optional fields, new category or format
values, new entries) keep the same `schemaVersion`; only a breaking change bumps
it. Consumers, including released versions of this plugin, must ignore unknown
fields and validate entries one at a time, skipping any they cannot interpret
rather than rejecting the whole file.

## Why one merged file

- **One place to find charts.** Boaters don't care whether a chart is downloaded
  or streamed until they choose one, so both kinds share one tab and one set of
  filters.
- **Facets chartcatalogs does not carry.** chartcatalogs has no coverage data, so
  "Near me", category and type filters are impossible from its XML alone.
  `catalog/chartcatalogs-index.json` adds a label, category, format, region tags
  and a bounding box for each chartcatalogs catalog file, and the build joins it
  in.
- **One request, no GitHub API.** Listing chartcatalogs through the GitHub API
  is rate-limited for unauthenticated clients; a single file on Pages is not.
- **No XML parsing on the boat.** The build converts the XML once, in CI.

## How the plugin reads it

The plugin downloads the catalog when it starts, when the Chart Catalog tab is
opened and the copy is more than a few hours old, when the user clicks
**Refresh catalog index**, and before the daily chart-update check. It keeps the
last good copy, so the tab keeps working when the boat is offline or a download
fails, and revalidates with the ETag so an unchanged catalog is not downloaded
again. Development servers can point it at a fork's Pages site with the
`CHARTS_CATALOG_URL` environment variable.

## Adding online charts

Pressing **Add** on an online chart writes `<catalogId>.onlinechart.json` into
the chosen chart folder (by default "Online Charts"). The file holds only the
catalog id and the chart's display name; the plugin looks the entry up in the
downloaded catalog whenever it serves the chart. So a corrected URL or layer in
the catalog reaches every boat on its next catalog refresh, and a chart whose
entry is removed from the catalog stays listed in Manage Charts, marked as no
longer available, instead of silently disappearing.

## Time-varying online charts

Entries with a `temporal` block (radar, satellite, forecasts) are served with a
`time` block and a `refreshInterval`, following the Plotter Extensions API's
`charts.time` convention, so a chart plotter can offer a time slider and
animation. The plugin keeps the `time` block current by reading the service's
capabilities document at the entry's refresh interval, only for enabled charts,
and only while a chart plotter is actually reading the chart: a chart that is
added but not displayed costs no data, which matters on a boat's metered
connection (some capabilities documents are megabytes). Entries that share a
capabilities document share one download. Services describe their timelines in
several forms (explicit lists, regular intervals, lists of intervals with gaps,
and "now"/"current" markers); all are reduced to the entry's `window` and kept
on the service's own time grid.

## How publishing works

`.github/workflows/publish-catalog.yml` runs every six hours, on changes to the
catalog sources, and on demand. It clones chartcatalogs, builds the merged
catalog, and deploys to Pages only when the **content hash** changed.

- The hash leaves out timestamps and the chartcatalogs commit id. chartcatalogs
  commits hourly, but almost always only to refresh the dates in its file
  headers; those runs are no-ops.
- A chartcatalogs file that fails to parse, or suddenly has no charts, is
  **carried forward** from the published catalog with a warning. A single broken
  upstream file must not remove a catalog from every user's Chart Catalog.
- A **drop guard** refuses to publish if the number of chartcatalogs catalogs or
  charts falls sharply against the catalog already on Pages, which catches
  whole-source failures such as a truncated clone. A maintainer can override it
  with the workflow's `force` input once the drop is understood.
- A chart whose download location is not an http(s) URL is dropped with a
  warning rather than failing the build.
- A change to the published JSON Schema deploys even when the content is
  unchanged.
- GitHub disables scheduled workflows in a public repository after 60 days
  without repository activity. If the catalog stops refreshing during a quiet
  period, re-enable the workflow from the Actions tab.

## Maintaining the catalog

**Adding an online chart.** Add an entry to `catalog/online-charts.json`. Each
field is described in `OnlineChartEntrySchema` in
`src/catalog/merged-catalog-schema.ts`; the published `catalog.schema.json` carries
the same descriptions. The unit tests validate every entry against the schema and
against rules the schema can't express (WMS/WMTS entries must name their layer;
only WMS/WMTS entries can be temporal).

To see an entry in the Chart Catalog tab before opening a pull request, run
`npm run catalog:preview`. It builds the catalog from your working copy the same
way the workflow does, serves it locally, and prints how to point a development
Signal K server at it. Each "Refresh catalog index" rebuilds it, so edits show up
without a restart, and an invalid entry is reported in the terminal.

Before adding a source, confirm that:

- its license allows use by third-party apps without a key or registration;
- it serves EPSG:3857 and sends CORS headers on map/tile requests (plotters
  fetch tiles from the browser);
- for WMS/WMTS, the named layer is the single best choice for a boater, so the
  user never has to pick one.

Write the name and description for a non-technical boater: say what the chart
shows and where, not how it is served.

An entry's `bbox` is the extent the service draws, and chart plotters clip the
layer to it, so it must cover all of the data. When the useful area is
narrower (a geostationary satellite's full disk becomes too oblique to use
near its edge), give it as `coverage`; only the "Near me" filter reads it.

**When the workflow warns that a chartcatalogs file is not indexed.** chartcatalogs
added a catalog. It is still published (so no chart disappears), but without
location or type facets, so "Near me" and the Type filter skip it. Add the file
to `catalog/chartcatalogs-index.json`.

**Problem reports.** The Chart Catalog links each chart to the tracker for its
source: chartcatalogs entries to the chartcatalogs issue tracker, online entries
to this repository's "Online chart problem" issue form, which applies the
`catalog` label.

**Suggestions.** Boaters who know a good service but don't write code can use the
"Suggest an online chart" issue form, which also applies the `catalog` label. A
maintainer or contributor then checks the source against the list above and adds
the entry.
