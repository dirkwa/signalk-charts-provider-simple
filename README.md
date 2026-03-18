# Signal K Charts Provider Simple

A lightweight, JavaScript-based Signal K server plugin for managing local nautical charts. This plugin provides a clean interface for organizing, uploading, and serving MBTiles.

## Features

- **Local Chart Management**: Support for MBTiles
- **Download Manager**: Built-in download queue with progress tracking and automatic ZIP extraction
- **Modern Web UI**: Clean, Material Design 3 interface with drag-and-drop chart organization
- **Chart Organization**: Folder-based organization with enable/disable toggles
- **Dual API Support**: Compatible with both Signal K v1 and v2 API


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

The interface provides three tabs:

1. **Manage Charts**:
   - View all charts in your library with chart names displayed from MBTiles metadata
   - View chart metadata (name, description, bounds, zoom levels, tile count, etc.)
   - Edit chart names directly in MBTiles files (personal use only)
   - Enable/disable charts
   - Organize charts into folders
   - Upload new chart files
   - Delete unwanted charts
   - Rename chart files

2. **Download from URL**:
   - Download charts directly from any URL
   - Supports `.mbtiles` files and `.zip` archives
   - Automatic extraction of MBTiles from ZIP files
   - Download queue with progress tracking

3. **Chart Catalog**:
   - Browse 27 chart catalogs from [chartcatalogs.github.io](https://chartcatalogs.github.io/)
   - One-click download for MBTiles charts (e.g., NOAA vector charts)
   - Download and convert IENC (S-57 ENC) charts to vector tiles via [s57-tiler](https://github.com/wdantuma/s57-tiler) (requires Podman)
   - Automatic update notifications when newer chart versions are available
   - Converted S-57 charts are rendered natively in Freeboard-SK with S-52 symbology

### Chart Formats

The plugin supports these chart formats:

- **MBTiles** (`.mbtiles`): SQLite-based map tile format (raster and vector)
- **S-57 ENC** (via catalog): Converted to PBF vector tiles using s57-tiler in Podman

### Compatible Chart Plotters

Charts provided by this plugin work with:
- [Freeboard SK](https://www.npmjs.com/package/@signalk/freeboard-sk)
- [OpenCPN](https://opencpn.org/)

## Legal Notice

### Chart Metadata Editing

This plugin includes a feature to edit chart metadata (chart names) in MBTiles files. **This feature is intended for personal use only.**

**Important:**
- The Signal K community is **not responsible** for any illegal use of this feature
- Modified charts are automatically marked with "USER MODIFIED - DO NOT DISTRIBUTE - PERSONAL USE ONLY" in the description field
- **Do not distribute** modified charts - this may violate copyright laws
- Use this feature responsibly and only for organizing your personal chart library

## Requirements

- **Node.js >= 22.5** — uses the built-in `node:sqlite` module, no native compilation needed
- **Not supported on Cerbo GX** — Venus OS ships Node.js 20, which lacks the `node:sqlite` module. Use v1.6.x if you need Cerbo support.

### Optional: Podman (for IENC/S-57 charts)

To download and convert IENC (S-57 ENC) charts from the Chart Catalog, [Podman](https://podman.io/) must be installed. The plugin uses the [s57-tiler](https://github.com/wdantuma/s57-tiler) container to convert S-57 files to vector tiles.

```bash
# Debian / Ubuntu / Raspberry Pi OS
sudo apt install podman

# Fedora / RHEL
sudo dnf install podman
```

The s57-tiler container image is pulled automatically on first use. MBTiles charts work without Podman.

## Acknowledgments

Inspired by [Signal K Charts Plugin](https://github.com/SignalK/charts-plugin) by Mikko Vesikkala.

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## Support

For issues and feature requests:
- GitHub Issues: https://github.com/dirkwa/signalk-charts-provider-simple/issues

