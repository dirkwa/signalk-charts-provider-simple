# Signal K Charts Provider Simple

A lightweight Signal K server plugin for managing local nautical charts, written in strict TypeScript. Supports MBTiles, S-57 ENC, BSB raster, and world basemaps with automatic conversion via Docker- or Podman-managed containers.

## Features

- **Local Chart Management**: MBTiles (raster and vector), with folder organization and enable/disable toggles
- **Download Manager**: Built-in download queue with progress tracking and ZIP extraction
- **Chart Catalog**: Browse and download charts from [chartcatalogs.github.io](https://chartcatalogs.github.io/) with automatic update notifications
- **S-57 ENC Conversion**: Convert IENC/ENC charts to vector MBTiles with full S-52 symbology in Freeboard-SK
- **BSB Raster Conversion**: Convert BSB/KAP raster charts and Pilot Charts to raster MBTiles
- **World Basemaps**: GSHHG and OSM coastline basemaps for offline use
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
3. (Optional) Pick a **CPU budget** for chart conversion — see [CPU budget](#cpu-budget-for-chart-conversion) below
4. Enable the plugin
5. Restart Signal K server (first-time install only — later config changes hot-apply on Save without a full restart)

### CPU budget for chart conversion

Chart conversion (S-57 ENC, BSB raster, basemaps) is the only CPU-heavy thing this plugin does. The **CPU budget** dropdown lets you decide how greedy that work is allowed to be:

| Setting | What happens during a conversion | When to pick it |
|---|---|---|
| `single-core` | One job at a time, one thread; each `ogr2ogr` runs sequentially | Multi-tenant Pi (Signal K + Grafana + Node-RED + …) where keeping the rest of the box responsive matters more than conversion speed |
| `half` (default) | `cpus/2` concurrent jobs, each tippecanoe gets `cpus / max-jobs` threads (typically ~2), `ogr2ogr` parallelizes to the same per-job ceiling | Balanced — leaves half the box for everything else. Matches the behaviour of plugin versions before 1.10 |
| `all` | One full-throttle job using every core in both the GDAL export and tippecanoe stages; multi-bundle uploads queue serially | Dedicated chart-prep box, or when you just want a NOAA bundle to finish as fast as possible |

The setting hot-applies — change it in the plugin config and Signal K will restart the plugin automatically; no server restart needed. In-flight conversions keep their already-spawned threads; the next conversion picks up the new budget.

## Usage

### Web Interface

Access the plugin's web interface through your Signal K server:

```
http://[your-server]:3000/plugins/signalk-charts-provider-simple/
```

The interface provides four tabs:

1. **Manage Charts**:
   - View all charts with metadata (name, bounds, zoom levels, size)
   - Enable/disable, organize into folders, upload, delete, rename
   - S-57 charts shown with ENC badge
   - Converting charts shown with progress indicator

2. **Download from URL**:
   - Download charts directly from any URL
   - Supports `.mbtiles` and `.zip` archives
   - Download queue with progress tracking

3. **Convert**:
   - Upload ZIP files containing S-57 ENC (.000) or BSB raster (.kap) charts
   - Drag-and-drop or click to select files
   - Configurable zoom levels for S-57 conversion
   - Live conversion progress with log viewer

4. **Chart Catalog**:
   - Dynamic catalog from [chartcatalogs.github.io](https://chartcatalogs.github.io/)
   - One-click download for MBTiles charts (NOAA)
   - Download & convert for S-57 ENC, BSB raster, Pilot Charts, and basemaps
   - Automatic update notifications (Signal K delta + tab badge)
   - Category filtering (MBTiles / RNC / IENC / General)

### Supported Formats

| Format | Source | Conversion | Output |
|--------|--------|-----------|--------|
| **MBTiles** | Direct download | None needed | Raster or vector tiles |
| **S-57 ENC** (.000) | IENC catalogs, custom upload | GDAL + tippecanoe (containerized) | Vector MBTiles with S-52 styling |
| **BSB Raster** (.kap) | RNC catalogs, custom upload | GDAL (containerized) | Raster MBTiles (PNG) |
| **Pilot Charts** (.kap in .tar.xz) | Pilot catalog | GDAL (containerized) | Raster MBTiles (PNG) |
| **GSHHG Basemap** | General catalog | GDAL (containerized) | Raster MBTiles (PNG) |
| **OSM Basemap** | General catalog | GDAL (containerized) | Raster MBTiles (PNG) |

### Compatible Chart Plotters

- [Freeboard SK](https://www.npmjs.com/package/@signalk/freeboard-sk) — full S-52 symbology for S-57 vector charts
- [OpenCPN](https://opencpn.org/)

## Requirements

- **Node.js >= 22.5** — uses the built-in `node:sqlite` module, no native compilation needed
- **Not supported on Cerbo GX** — Venus OS ships Node.js 20, which lacks the `node:sqlite` module. Use v1.6.x if you need Cerbo support.

### Optional: container runtime (for chart conversion)

To convert S-57 ENC, BSB raster, Pilot Charts, or basemaps, the plugin needs a Docker- or Podman-compatible API socket. Both engines work the same way; pick whichever is easier on your host.

The plugin uses standard images that are pulled automatically on first use:

- `ghcr.io/osgeo/gdal:alpine-small-latest` — GDAL for format conversion
- `ghcr.io/dirkwa/signalk-charts-provider-simple/tippecanoe` — tippecanoe for vector tile generation (multi-arch: amd64 + arm64)

**Bare-metal install (Signal K running directly on the host):**

```bash
# Debian / Ubuntu / Raspberry Pi OS
sudo apt install podman
systemctl --user enable --now podman.socket

# Fedora / RHEL
sudo dnf install podman
systemctl --user enable --now podman.socket
```

**Signal K running in Docker?** See [docs/running-in-docker.md](docs/running-in-docker.md) for the docker-compose snippet.

Conversion concurrency is configurable — see the [CPU budget](#cpu-budget-for-chart-conversion) section. MBTiles charts (display only, no conversion) work without any container runtime.

### Known install warnings

Signal K's appstore installs plugins with `--ignore-scripts`, so any optional native addons in the dependency tree won't compile. CI flags one such case for this plugin:

> `Optional native addons found: cpu-features. App Store uses --ignore-scripts so these will not be compiled.`

This is harmless. `cpu-features` is a transitive optional dependency of `ssh2`, pulled in by `dockerode`. The plugin only ever talks to a local Docker/Podman Unix socket, so the SSH transport (and its native crypto accelerator) is never used. The warning is informational; the plugin runs fully without the addon.

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

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## Support

For issues and feature requests:
- GitHub Issues: https://github.com/dirkwa/signalk-charts-provider-simple/issues
