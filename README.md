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

The interface provides two main tabs:

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
   - Simple, clean interface without complex chart browsing

### Chart Formats

The plugin supports this chart formats:

- **MBTiles** (`.mbtiles`): SQLite-based map tile format

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

## Acknowledgments

Inspired by [Signal K Charts Plugin](https://github.com/SignalK/charts-plugin) by Mikko Vesikkala.

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## Support

For issues and feature requests:
- GitHub Issues: https://github.com/dirkwa/signalk-charts-provider-simple/issues

