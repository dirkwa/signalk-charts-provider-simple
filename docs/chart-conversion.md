# Chart conversion

The plugin converts S-57 ENC, BSB/KAP raster charts, pilot charts and
shapefile basemaps to MBTiles with one of two toolchains:

- **The container toolchain** (preferred): GDAL, tippecanoe and tile-join in
  the `charts-toolbox` image, run as helper jobs through the
  [`signalk-container`](https://github.com/dirkwa/signalk-container) plugin
  (`src/utils/s57-container.ts`, `src/utils/rnc-container.ts`; the image is
  described in [charts-toolbox-image.md](charts-toolbox-image.md)).
- **The WebAssembly toolchain** (fallback): GDAL compiled to WebAssembly and a
  built-in vector tiler, inside the Signal K process. Nothing else has to be
  installed: no Docker or Podman, no helper image, no `signalk-container`, no
  GDAL or tippecanoe on the host. A Raspberry Pi, a Signal K container and a
  bare-metal server convert the same way. Most of this page describes it.

## Choosing the toolchain

`src/utils/conversion-backend.ts` picks the toolchain once per conversion,
before it writes anything, so a fallback never meets a half-finished container
run. The container toolchain is used when all of these hold:

1. `signalk-container` published its manager and detected a Docker or Podman
   runtime. A conversion requested while the startup discovery still runs
   waits for it, rather than falling back only because the plugins started
   in a different order; a manager published after the discovery gave up is
   taken up once its runtime is detected (`container-manager.ts`).
2. The `charts-toolbox` image is present, or could be pulled now. A boat
   offline without the image converts with WebAssembly instead of failing.
3. Every folder the conversion mounts resolves to a mount source for the
   helper container (`resolveHostPath`). S-57 cells are staged (hardlinked,
   or copied across file systems) into the conversion's scratch folder in the
   data dir, with their update files, so a folder of cells outside the data
   dir still converts in the container; BSB charts are read where they lie,
   so a folder the container cannot mount falls back.

Otherwise the WebAssembly toolchain runs, and the conversion log says why. The
plugin's `conversionEngine` setting pins a toolchain: `container` fails a
conversion it cannot run there, with the reason, and `wasm` never looks for a
container. `GET /catalog-s57-status` reports the runtime and the toolchain the
next conversion is expected to use; the Convert tab shows it.

What differs between the two:

| | Container | WebAssembly |
|---|---|---|
| S-57 tiling | One tippecanoe per IHO band, then tile-join (`join` progress stage, `joining` chart-set phase); a single-band bundle runs one tippecanoe with its maxzoom clamped to the band's | Every band in one pass of the built-in tiler |
| Raster overviews | `gdaladdo -r average` | Averaged from the tiles below (`raster-pyramid.ts`) |
| CPU budget | Tippecanoe threads and parallel exports, also enforced as the job's CPU cap | Worker threads (both from `concurrency.ts`) |
| Cancel | Kills the job where signalk-container supports it, else stops at the next band | Terminates the worker threads |

Both share the rest: archive extraction in JavaScript (ZIP, `.tar`,
`.tar.gz`, `.tar.xz`), one cell of each name (`uniqueCells`), output naming,
metadata patches, the quarantine, and the chart-set cache. The cache keys
each cell's GeoJSON by the GDAL build that wrote it (`backendBuildId`: the
charts-toolbox image, or the gdal3.js version), so a chart set whose
toolchain changed reads its cells again once. A chart set's run picks its
toolchain once, for both its GDAL export and its tiling.

Helper containers left running by a Signal K crash are reaped at the
process's first start, once signalk-container is found and before this
process has started a job of its own: start() runs again on every config
save while the previous start's conversions keep running.

## The WebAssembly toolchain

```
              ┌─────────── conversion worker threads (worker-pool.ts) ───────────┐
 .000 / .kap  │  GDAL (gdal3.js,       GeoJSON    vector tiler                    │
 .shp ──────► │  WebAssembly)  ──────────────────► bucket → tile shards → merge   │──► .mbtiles
 .tar.xz      │  one instance per worker           (geojson-vt + vt-pbf)          │
              │                                    raster overviews (pngjs/jpeg)  │
              └───────────────────────────────────────────────────────────────────┘
```

- **GDAL in WebAssembly** (`src/utils/gdal-wasm.ts`). The
  [gdal3.js](https://gdal3.js.org/) package is GDAL compiled to WebAssembly,
  with the S-57, BSB, MBTiles, GeoJSON and shapefile drivers. The plugin
  drives GDAL's C API directly (`GDALVectorTranslate`, `GDALTranslate`,
  `GDALRasterize`) rather than gdal3.js's helpers, which fix all output under
  one directory and cannot pass dataset open options; the S-57 sounding layer
  needs `SPLIT_MULTIPOINT` and `ADD_SOUNDG_DEPTH`. Host directories are
  mounted into the Emscripten file system with NODEFS, so GDAL reads and
  writes the real files in place: a chart larger than the WebAssembly heap
  still converts.
- **Worker threads** (`src/utils/worker-pool.ts`,
  `src/utils/conversion-worker.ts`). Each conversion opens a pool sized by the
  CPU budget (`concurrency.ts`), and each worker loads its own GDAL instance on
  first use. The pool closes when the conversion ends, which frees the
  WebAssembly heaps (they never shrink). Cancelling a conversion terminates its
  workers, so a GDAL call or a tiling shard stops at once.
- **Vector tiler** (`src/utils/vector-tiler.ts`,
  `src/utils/vector-tile-shard.ts`), the replacement for tippecanoe and
  tile-join. See below.
- **Raster overviews** (`src/utils/raster-pyramid.ts`), the replacement for
  `gdaladdo`: GDAL writes a BSB chart or a basemap at its native zoom only,
  and each lower zoom is built from the four tiles below it.
- **Archives** (`src/utils/tar-extract.ts`): `.tar`, `.tar.gz` and `.tar.xz`
  are read in JavaScript (xz through the WebAssembly decoder of
  `xz-decompress`), zip-slip-safe, links skipped.

### S-57: one pass for every band

An ENC bundle mixes IHO usage bands, from overview (band 1) to berthing
(band 6). Each band is meant to be seen at its own scales: a harbour plan's
detail clutters the overview zooms, and a coastal chart's coarse coastline
draws over the harbour plan at high zoom.

GDAL exports each cell's layers to `<LAYER>__<cell>.geojson`, one cell per
worker at a time. The export then becomes the tiler's sources, one per layer
and band, each shown at that band's zooms within the user's range
(`planTileSources`, with each band's zooms in `s57-band.ts`). The
tiler builds the whole bundle in one pass, with no per-band runs to join.

Within its band's zooms, a feature with an S-57 `SCAMIN` starts only at the
zoom where S-52 would show it (`s57-scamin.ts`): below that scale no client
draws it, so overview tiles would only carry it, soundings above all. The
zoom comes from the feature's position farthest from the equator, so no part
of it is cut early, and is capped at the band's maxzoom so clients
overzooming still show it. The tiler carries the zoom with the feature
through the shards and leaves it out of the tile's attributes. The container
toolchain stamps the same zoom as the feature's `tippecanoe.minzoom`.

Two copies of a cell, such as a folder of cells beside the ZIP it came from,
would write the same GeoJSON files, so only the first copy found is
converted and the others are logged as skipped.

### The vector tiler

The tiler takes GeoJSON files, each with an output layer and a zoom range, and
writes an MBTiles. The heavy steps (reading the GeoJSON, sorting features into
shards, tiling and encoding) run on the workers; the main thread plans the
work and writes the finished tiles into SQLite. No step holds a whole bundle
in memory.

1. **Bucket.** Workers read the GeoJSON files and sort each feature into the
   *shards* it reaches. A shard is the subtree of the tile pyramid under one
   tile at its source's minzoom; a feature goes into every shard its bounding
   box, plus the tile buffer, touches. Shards are line-delimited files on
   disk.
2. **Tile.** Each shard is self-contained, so the workers tile shards in
   parallel, largest first. A shard builds a
   [geojson-vt](https://github.com/mapbox/geojson-vt) index per source and
   walks its subtree depth-first, encoding a tile with
   [vt-pbf](https://github.com/mapbox/vt-pbf) wherever a source in range has
   features, and dropping visited tiles from the indexes as it goes.
3. **Merge.** Sources with different minzooms shard at different levels, so
   two shards can produce the same tile: adjacent bands share two zooms. When
   that can happen, tiles go to a scratch table first, and tiles with several
   parts have their same-named layers merged feature by feature. Otherwise
   tiles go straight into the MBTiles, compressed by the workers.

Two details make the shards cheap:

- **Re-rooting.** geojson-vt starts every index at the world tile, so a z12
  shard would clip and transform its features through twelve levels before
  reaching its own tile. Each shard instead rescales its coordinates so that
  its tile becomes a tile at a fixed shallow zoom (`vector-tile-shard.ts`).
  Scaling by a power of two keeps every tile
  boundary, so the tiles are the same, after a few levels of work instead of
  twelve.
- **Exact pre-clipping.** Before re-rooting, each feature is clipped to the
  shard plus its buffer, which is exactly where geojson-vt would clip it at
  the shard's tile. Nothing then reaches the edge of the rescaled world, where
  geojson-vt would clamp latitudes or wrap copies across the antimeridian.

Geometry is kept as it is: no simplification, no dropped small polygons, no
feature or tile size limits, and a generous tile buffer (`vector-tiler.ts`),
so that harbour basins and narrow channels survive. List
attributes (`COLOUR`, `CATLIT`, …) are joined with commas and null attributes
dropped. The MBTiles `json` metadata lists every layer with its zoom range and
attribute types.

### Raster charts and basemaps

GDAL's translate API, called in the workers, tiles a BSB/KAP chart into a PNG
MBTiles at its native zoom. Overview zooms are then added below it, as many
as the container toolchain adds (`rnc-converter.ts`). A basemap shapefile is
rasterized to a world GeoTIFF, tiled the same way, and given overview zooms
of its own (`s57-converter.ts`). Each overview tile is
averaged, in the workers, from the tiles below it; a quarter with no tile
below it stays transparent.

## Charts already on the server

The Convert tab can also convert charts already on the Signal K server's
disk instead of an upload (`POST /convert-local`,
`src/utils/local-chart-source.ts`). The user gives the full path of a folder
or of one ZIP file; `~` is the server's home folder. A folder is searched
recursively for S-57 cells (`.000`) or BSB charts (`.kap`, `.bsb`), loose or
inside ZIP files, without following links or entering hidden folders. A ZIP is
looked into without extracting it and used only if it holds a chart file; one
that cannot be read is skipped and reported. A path that holds far more
entries than any chart folder, such as a disk's root, is refused once the
search reaches that limit (`local-chart-source.ts`), instead of being
searched in full. S-57 update files (`.001`, …) are read with the cells
wherever they lie: an archive holding only updates is extracted too, and a
cell whose updates sit in another folder or archive is linked together with
them into the work folder, since GDAL applies only the updates beside a
cell.

The source is only read. Loose charts are converted where they lie (the
container toolchain stages S-57 cells into its scratch folder first, see
above), and ZIP
files are extracted into a new `convert-local-…` folder in the plugin's data
directory, removed when the conversion ends. Leftover work folders are swept
only at the server process's first start, so a plugin restart meanwhile (a
config save) leaves it in place. The S-57 cells of the whole
folder become one MBTiles, named after the folder or ZIP; BSB charts become one
MBTiles each, as with an upload. When Signal K runs in Docker, the path is
inside the container, so the folder must be mounted into it.

## Caches and versions

The chart-set cache keeps each cell's GeoJSON between runs, keyed by the
GDAL build that wrote it (`backendBuildId()`: the charts-toolbox image for the
container toolchain, `gdalBuildId()`, the pinned gdal3.js version, for the
WebAssembly one). A GeoJSON written by another GDAL build makes the next
update export its cell again. The ENC index builder
(`src/catalog/enc-index-cli.ts`) reads cells with the WebAssembly GDAL, so
its CI job needs no container runtime.
