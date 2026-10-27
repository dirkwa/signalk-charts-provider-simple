# Signal K Charts Provider Simple

A lightweight Signal K server plugin for managing local nautical charts, written in strict TypeScript. Supports MBTiles, S-57 ENC, BSB raster, and world basemaps, with automatic conversion: GDAL and tippecanoe in a Docker- or Podman-managed helper container when one is available, and otherwise GDAL compiled to WebAssembly with a built-in parallel vector tiler, inside Signal K, with nothing else to install.

## Features

- **Local Chart Management**: MBTiles and PMTiles (raster and vector), with folder organization and enable/disable toggles. PMTiles archives are downloaded, uploaded or placed in the chart folder and served as they are; their metadata is read-only
- **Folder Groups**: Enable/disable whole chart folders at once (OpenCPN-style groups, including nested folders); clients like Freeboard-SK see the change live via `resources.charts` deltas
- **Download Manager**: Built-in download queue with progress tracking and ZIP extraction
- **Chart Catalog**: Browse and download charts from [chartcatalogs.github.io](https://chartcatalogs.github.io/) with automatic update notifications
- **Online Charts and Satellite imagery**: Add weather radar and satellite, online nautical charts, depth layers, base maps and satellite imagery with one click — no download, no conversion
- **ENC Charts**: Pick chart areas on a map from every free ENC source (NOAA, the European inland waterways and more); the plugin downloads their ENC cells and converts them into a single vector MBTiles named after your chart set
- **S-57 ENC Conversion**: Convert IENC/ENC charts to vector MBTiles with full S-52 symbology in Freeboard-SK
- **BSB Raster Conversion**: Convert BSB/KAP raster charts and Pilot Charts to raster MBTiles
- **World Basemaps**: OSM coastline basemaps for offline use
- **Custom Upload**: Upload your own ZIP files containing S-57 ENC or BSB charts for conversion
- **Modern Web UI**: Material Design 3 interface with drag-and-drop
- **Dual API Support**: Compatible with Signal K v1 and v2 API

## Installation

### From Signal K Appstore

1. Open your Signal K server admin interface
2. Navigate to Appstore
3. Search for "Charts Provider Simple"
4. Click Install

### Manual Installation

```bash
cd ~/.signalk
npm install signalk-charts-provider-simple
```

## Configuration

1. Navigate to **Server → Plugin Config → Charts Provider Simple**
2. Set your chart directory path (defaults to `~/.signalk/charts-simple`)
3. (Optional) Pick a **CPU budget** for chart conversion — see [CPU budget](#cpu-budget-for-chart-conversion) below — and a **Chart conversion engine** (`auto` by default — see [Chart conversion](#chart-conversion-helper-container-with-a-built-in-fallback))
4. Enable the plugin
5. Restart Signal K server (first-time install only — later config changes hot-apply on Save without a full restart)

### CPU budget for chart conversion

Chart conversion (S-57 ENC, BSB raster, basemaps) is the only CPU-heavy thing this plugin does. The **CPU budget** dropdown lets you decide how greedy that work is allowed to be:

| Setting | What happens during a conversion | When to pick it |
|---|---|---|
| `single-core` | One job at a time: one worker thread, or a helper container capped at one core with each `ogr2ogr` run sequentially | Multi-tenant Pi (Signal K + Grafana + Node-RED + …) where keeping the rest of the box responsive matters more than conversion speed |
| `half` (default) | One job at a time on half the cores: that many worker threads, or tippecanoe threads and parallel `ogr2ogr` exports | Balanced — leaves half the box for everything else |
| `all` | One full-throttle job using every core in every stage; another conversion is refused (HTTP 429) until it finishes | Dedicated chart-prep box, or when you just want a chart set to finish as fast as possible |

Conversion runs in a helper container or in worker threads, never on Signal K's event loop. A catalog download that converts its chart holds its slot from the moment it is requested, so downloads started together cannot go on to run more conversions than the budget allows. The setting hot-applies — change it in the plugin config and Signal K will restart the plugin automatically; no server restart needed. In-flight conversions keep their containers and workers; the next conversion picks up the new budget.

## Usage

### Web Interface

Access the plugin's web interface through your Signal K server:

```
http://[your-server]:3000/plugins/signalk-charts-provider-simple/
```

The interface provides seven tabs:

1. **Manage Charts**:
   - View all charts with metadata (name, bounds, zoom levels, size)
   - Enable/disable, organize into folders, upload, delete, rename
   - **Upload ZIP** imports a whole archive at once: every `.mbtiles` inside it
     is extracted into the selected folder (nested folders are flattened, and
     non-chart files in the archive are ignored). Multi-GB archives are
     supported — large ones upload in chunks automatically, so a slow WiFi
     link can't run into the server's request timeout. Extraction needs
     roughly twice the archive size free on disk while it runs.
   - S-57 charts shown with ENC badge
   - Converting charts shown with progress indicator
   - **Water only** versions: in **Meta → Edit** of an online chart kept offline, tick **+Water only** to add a copy of the chart with the land cut away, so satellite imagery or another chart underneath shows on land (for example NOAA charts over satellite imagery). It is its own chart layer, named after the chart, and shares the chart's kept tiles and offline areas; untick it to remove it. Masking uses OpenStreetMap's land polygons, which need a one-time download (about 1 GB, about 390 MB on disk once built) that you are asked to confirm the first time; the version appears in chart plotters once it is ready. The land polygons count lakes and most rivers as land, so on inland water the chart is cut away too, and what the chart draws ashore (lights, landmarks, labels) goes with the land
   - **Land only** versions: tick **+Land only** for a copy with the water cut away, so it can lie on top of your other charts, for example satellite imagery showing the land over a nautical chart. It is not for navigation: you are asked to acknowledge that before it is added. Lakes and most rivers count as land, and near the shore it can cover rocks and buoys the chart draws, so it pulls the land back a small margin from the coastline, starts at reduced opacity, and shows nothing rather than the full image whenever it cannot be masked

2. **Download from URL**:
   - Download charts directly from any URL
   - Supports `.mbtiles` and `.pmtiles` files, and `.zip` archives of `.mbtiles`
   - Download queue with progress tracking

3. **Convert**:
   - Upload ZIP files containing S-57 ENC (.000) or BSB raster (.kap) charts
   - Drag-and-drop or click to select files
   - Or convert charts already on the Signal K server: enter the full path of a folder holding the charts, loose or in ZIP files, or of one ZIP file. The folder is only read. With Signal K in Docker, the path is inside the container
   - Configurable zoom levels for S-57 conversion
   - Live conversion progress with log viewer

4. **Chart Catalog**:
   - Downloadable charts from [chartcatalogs.github.io](https://chartcatalogs.github.io/), sectioned by what the charts show, with **Near me** narrowing each section to where you are
   - One-click download for MBTiles charts (NOAA)
   - Download & convert for BSB raster, Pilot Charts, and basemaps; ENC (S-57) charts are built into chart sets in the ENC Charts tab
   - Automatic update notifications (Signal K delta + tab badge)
   - Filters: what the chart shows (Navigation, Depth & Seabed, Base maps); chart type under "More filters"; and **Near me**, using the boat's position

5. **Online Charts**:
   - A curated list of online charts, sectioned into navigation charts, depth and seabed, weather (radar, weather satellites, forecasts) and base maps, with **Near me** to show only what covers the boat
   - Press **Add** and the chart appears in Manage Charts and in chart plotters that read the Signal K v2 charts API, such as Freeboard-SK. Most stream from their provider and need an internet connection to display. Charts whose license allows it carry a **Kept offline** badge: they are served through your server, which keeps every tile it fetches, so the areas you have already viewed keep working without internet. To prepare for a passage, press **Offline area** on such a chart, here or in Manage Charts, frame the area on the map, choose the zoom levels and download it ahead of time. Online charts go into an "Online Charts" folder by default, so you can switch them all off at once when you're offline
   - Live weather layers (radar, satellite, forecasts) keep their recent images or forecast steps up to date, so chart plotters with a time slider (Freeboard-SK) can play them back
   - Add an online chart by URL: a `{z}/{x}/{y}` tile service (also `{-y}`, `{z-N}`, `{bbox}` and `{bbox_3857}`) or a WMS the list does not have. Tick **Keep tiles for offline use** only when the provider's terms allow it; the chart is then kept offline like a catalog chart

6. **Satellite**:
   - Satellite and aerial imagery side by side (such as EOxCloudless and USGS aerial imagery), so you can pick by sharpness, age, cloud cover and licence. Imagery shows reefs and shallows that a chart may not, as a layer beneath or instead of the chart
   - Added and kept offline the same way as the online charts, including **Offline area**

7. **ENC Charts**:
   - Build a named **chart set** by clicking chart areas on a map (Leaflet + OpenSeaMap): NOAA's band-4 boxes in US waters, and the cells of every other free ENC source, such as the European inland waterways (EuRIS), the Rhône, Poland, Brazil, the South China Sea and the US inland river buoys, drawn as their real coverage
   - Click an area to add or remove it. Dragging across the map adds every area the box touches; a box over areas that are all in the set already removes them. Where areas overlap, a click picks the smallest. Move the map with two fingers, the scroll wheel, or **Move map** (then Shift+drag still selects)
   - One chart set can mix sources, e.g. NOAA charts plus the US inland river buoy overlay
   - Each NOAA box automatically pulls in the overlapping band-3 and band-5 ENCs
   - The chart areas come from the ENC index this project publishes (see [`docs/enc-index.md`](docs/enc-index.md)); the plugin keeps the last copy, so the map works offline once it has been downloaded
   - Download & convert produces one `.mbtiles` per chart set, with live progress and a log. Each archive is downloaded once, and updates a source publishes separately are applied
   - Out-of-date detection when a source publishes a new edition or update of a cell, or your selection changes; the set lists the cells that changed
   - Each chart set keeps its downloaded cells, so an update downloads and reads only the cells that changed before building the chart again. The set's details show how much disk they take; deleting the set frees it
   - Chart sets made in the NOAA Charts tab of earlier versions carry over as they are. A set that includes other sources still opens in an earlier version, which shows only its NOAA part and drops the rest if it saves the set

### Supported Formats

| Format | Source | Conversion | Output |
|--------|--------|-----------|--------|
| **MBTiles** | Direct download | None needed | Raster or vector tiles |
| **PMTiles** | Direct download, upload or the chart folder | None needed | Raster or vector tiles |
| **S-57 ENC** (.000) | ENC Charts tab, custom upload, server folder | GDAL + tippecanoe (containerized), or GDAL (WebAssembly) + built-in vector tiler | Vector MBTiles with S-52 styling |
| **BSB Raster** (.kap) | RNC catalogs, custom upload, server folder | GDAL (containerized or WebAssembly) | Raster MBTiles (PNG) |
| **Pilot Charts** (.kap in .tar.xz) | Pilot catalog | GDAL (containerized or WebAssembly) | Raster MBTiles (PNG) |
| **OSM Basemap** | General catalog | GDAL (containerized or WebAssembly) | Raster MBTiles (PNG) |

### Compatible Chart Plotters

- [Freeboard SK](https://www.npmjs.com/package/@signalk/freeboard-sk) — full S-52 symbology for S-57 vector charts
- [OpenCPN](https://opencpn.org/)

## Requirements

- **Node.js >= 22.5** — uses the built-in `node:sqlite` module, no native compilation needed
- **Not supported on Cerbo GX** — Venus OS ships Node.js 20, which lacks the `node:sqlite` module. Use v1.6.x if you need Cerbo support.

### Recommended for metered connections: `signalk-internet` plugin

The [`signalk-internet`](https://github.com/meri-imperiumi/signalk-internet) plugin tells Signal K whether the boat's connection is online, metered (for example satellite data billed per GB), offline or behind a sign-in page. While it reports metered, offline or a sign-in page, this plugin checks for nothing on its own (no chart catalog or ENC index checks, no resumed shoreline download) and online charts show only the tiles already kept on the server, without asking their provider. To keep fetching online chart tiles on a metered connection, turn on **Download online chart tiles on metered connections** in the plugin settings. Downloads you start yourself (Refresh, chart downloads, offline areas, chart sets) always run. Without `signalk-internet` nothing changes.

### Chart conversion: helper container, with a built-in fallback

Displaying charts (serving tiles from `.mbtiles`) needs nothing extra, and neither does converting them (S-57 ENC, BSB raster, Pilot Charts, basemaps). Each conversion picks one of two toolchains:

1. **Helper container (preferred).** With the [`signalk-container`](https://github.com/dirkwa/signalk-container) plugin and a Docker- or Podman-compatible runtime, charts convert with GDAL, tippecanoe and tile-join in the `charts-toolbox` image, each IHO band of an ENC bundle in its own tippecanoe pass. The Signal K App Store lists `signalk-container` as a recommended plugin on the Charts Provider Simple detail page.
2. **Built in (fallback).** Otherwise [GDAL](https://gdal.org/) compiled to WebAssembly ([gdal3.js](https://gdal3.js.org/)) reads the charts inside Signal K and the plugin's own parallel vector tiler builds the MBTiles. Nothing has to be installed, and it works the same on a Raspberry Pi, bare metal, or with Signal K itself in Docker.

The built-in toolchain takes over whenever the container one cannot run a conversion: `signalk-container` is not installed or found no runtime, the helper image is missing and cannot be downloaded (a boat offline), or a folder the conversion reads cannot be mounted into the helper container. The conversion log names the toolchain used and why, and the Convert tab says which one is in use. The **Chart conversion engine** setting can pin either one: `container` fails a conversion the container cannot run instead of falling back, `wasm` never uses a container. See [docs/chart-conversion.md](docs/chart-conversion.md) for how both work.

`signalk-container` itself needs a Docker- or Podman-compatible runtime on the host. Both engines work the same way; pick whichever is easier:

```bash
# Debian / Ubuntu / Raspberry Pi OS
sudo apt install podman
systemctl --user enable --now podman.socket

# Fedora / RHEL
sudo dnf install podman
systemctl --user enable --now podman.socket
```

The container toolchain uses one combined image that `signalk-container` pulls automatically on first conversion:

- `ghcr.io/dirkwa/signalk-charts-provider-simple/charts-toolbox:1.1.0` — GDAL + tippecanoe + tile-join + helpers in a single image (multi-arch: amd64 + arm64). The plugin pins to a specific `:VERSION` tag rather than `:latest` so a published image tag is permanent for any host that pulled it; bumping the toolbox image is a co-ordinated edit of `docker/charts-toolbox/VERSION` and the matching constant in `src/utils/container-images.ts`.

`signalk-container` transparently handles the deployment topologies:

- **Bare-metal Signal K** — straight bind mount of the data dir.
- **Signal K in Docker / Podman with a named volume** — the helper container mounts the same named volume.
- **Signal K in Docker / Podman with bind-mounted data** — the helper container gets the resolved host path, even when the in-container path doesn't match the host path.

**Signal K running in Docker?** Runtime and socket setup is handled by `signalk-container` — see [docs/running-in-docker.md](docs/running-in-docker.md). Without it, the built-in toolchain converts inside the Signal K container.

Chart sets keep each downloaded cell's GDAL output, keyed by the toolchain that read it: when the toolchain changes (the container became available, or the setting changed), the next update reads the cells again once.

Conversion concurrency is configurable — see the [CPU budget](#cpu-budget-for-chart-conversion) section.

### Standalone container image (third-party use)

The same `charts-toolbox` image the plugin uses internally is also available for use **outside** Signal K — overnight NOAA region pipelines, ad-hoc shell-script automation, GitHub Actions workflows under your own account, etc.

Pull it directly from GHCR:

```bash
docker pull ghcr.io/dirkwa/signalk-charts-provider-simple/charts-toolbox:1.1.0
```

See [docs/charts-toolbox-image.md](docs/charts-toolbox-image.md) for a quickstart, the `--user` / `--userns=keep-id` flag forms per runtime, and reproducibility notes.

## Legal Notice

### Chart Metadata Editing

This plugin includes a feature to edit chart metadata (chart names) in MBTiles files. **This feature is intended for personal use only.**

**Important:**
- The Signal K community is **not responsible** for any illegal use of this feature
- Modified charts are automatically marked with "USER MODIFIED - DO NOT DISTRIBUTE - PERSONAL USE ONLY" in the description field
- **Do not distribute** modified charts - this may violate copyright laws
- Use this feature responsibly and only for organizing your personal chart library

## Acknowledgments

Inspired by [Signal K Charts Plugin](https://github.com/SignalK/charts-plugin) by Mikko Vesikkala.

Masked chart versions use land polygons © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors, available under the Open Database License, from [osmdata.openstreetmap.de](https://osmdata.openstreetmap.de/data/land-polygons.html). The land-masking approach comes from [signalk-noaa-sonar-charts](https://github.com/joelkoz/signalk-noaa-sonar-charts) (Apache License 2.0).

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

**Online charts** are curated in this repository. To add or fix one, see
[Maintaining the catalog](docs/chart-catalog.md#maintaining-the-catalog). If you know a good
free service but don't want to write the entry yourself, open a
[Suggest an online chart](https://github.com/dirkwa/signalk-charts-provider-simple/issues/new?template=suggest-online-chart.yml)
issue.

## Support

For issues and feature requests:
- GitHub Issues: https://github.com/dirkwa/signalk-charts-provider-simple/issues
