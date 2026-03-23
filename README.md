# Signal K Charts Provider Simple

A lightweight Signal K server plugin for managing local nautical charts, written in strict TypeScript. Supports MBTiles, S-57 ENC, BSB raster, and world basemaps with automatic conversion via Podman containers.

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
3. Enable the plugin
4. Restart Signal K server

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
| **S-57 ENC** (.000) | IENC catalogs, custom upload | GDAL + tippecanoe (Podman) | Vector MBTiles with S-52 styling |
| **BSB Raster** (.kap) | RNC catalogs, custom upload | GDAL (Podman) | Raster MBTiles (PNG) |
| **Pilot Charts** (.kap in .tar.xz) | Pilot catalog | GDAL (Podman) | Raster MBTiles (PNG) |
| **GSHHG Basemap** | General catalog | GDAL (Podman) | Raster MBTiles (PNG) |
| **OSM Basemap** | General catalog | GDAL (Podman) | Raster MBTiles (PNG) |

### Compatible Chart Plotters

- [Freeboard SK](https://www.npmjs.com/package/@signalk/freeboard-sk) — full S-52 symbology for S-57 vector charts
- [OpenCPN](https://opencpn.org/)

## Requirements

- **Node.js >= 22.5** — uses the built-in `node:sqlite` module, no native compilation needed
- **Not supported on Cerbo GX** — Venus OS ships Node.js 20, which lacks the `node:sqlite` module. Use v1.6.x if you need Cerbo support.

### Optional: Podman (for chart conversion)

To convert S-57 ENC, BSB raster, Pilot Charts, or basemaps, [Podman](https://podman.io/) must be installed. The plugin uses standard container images that are pulled automatically on first use:

- `ghcr.io/osgeo/gdal:alpine-small-latest` — GDAL for format conversion
- `ghcr.io/dirkwa/signalk-charts-provider-simple/tippecanoe` — tippecanoe for vector tile generation (multi-arch: amd64 + arm64)

```bash
# Debian / Ubuntu / Raspberry Pi OS
sudo apt install podman

# Fedora / RHEL
sudo dnf install podman
```

MBTiles charts work without Podman. Chart conversion is limited to 2 concurrent jobs.

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
