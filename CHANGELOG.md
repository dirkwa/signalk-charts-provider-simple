# Changelog

## [1.8.4] 2026-03-20
### Fixed:
- ZIP download showed "Extracting" immediately instead of download progress
- Direct (non-ZIP) downloads capped progress at 90% instead of showing full 0-100%
- Clean up invalid/partial .mbtiles files on startup (e.g., from interrupted downloads)
- Clean up orphaned SQLite companion files (.mbtiles-journal, .partial_tiles.db) on startup
- Clean up leftover temp directories from interrupted conversions on startup

## [1.8.3] 2026-03-20
### Fixed:
- Prune stale catalog install entries on startup when chart files no longer exist on disk

## [1.8.2] 2026-03-20
### Fixed:
- Downloads from redirecting URLs (e.g., GitHub releases) saved ZIP as raw .mbtiles instead of extracting

## [1.8.1] 2026-03-19
### Fixed:
- Upload button now visible in All Folders view (defaults to root folder)

## [1.8.0] 2026-03-19
### Added:
- **Chart Catalog** tab: browse and download charts from chartcatalogs.github.io
  - Dynamic catalog registry fetched from GitHub (auto-discovers new catalogs)
  - Category filtering (MBTiles / RNC / IENC / General)
  - One-click download for MBTiles charts (e.g., NOAA)
  - Automatic update notifications via Signal K delta and tab badge
  - Source attribution with link to catalog issue tracker
- **S-57 ENC conversion**: IENC/ENC charts converted to vector MBTiles
  - Uses GDAL (ogr2ogr) + tippecanoe in Podman containers
  - All S-57 layers in single MBTiles file — full S-52 symbology in Freeboard-SK
  - Configurable zoom levels, live conversion progress with log viewer
  - Auto-generates CATALOG.031 for ENC ZIPs that lack one (e.g., Dutch IENC)
- **BSB raster conversion**: RNC charts (.kap) converted to raster MBTiles via GDAL
- **Pilot Charts**: .tar.xz archives with monthly BSB charts converted to MBTiles
- **World basemaps**: GSHHG and OSM coastline basemaps rasterized to MBTiles for offline use
- **Convert tab**: upload custom ZIP files (S-57 ENC or BSB raster) for conversion
- **Conversion concurrency limit**: max 2 concurrent Podman conversions
- **Download timeout**: 60s idle timeout with clear error messages for dead servers
- **Manage Charts**: S-57 badge, "Converting" indicator, directory chart support
- **Podman warning**: shown when Podman not installed, with install instructions

### Changed:
- charts-loader reads `type` from MBTiles metadata (S-57 charts register as type `S-57`)
- `type: overlay` from GDAL automatically mapped to `tilelayer` for Freeboard-SK
- Install tracking matches by URL for duplicate chart numbers
- Catalog registry is dynamic (no hardcoded list)

### Fixed:
- Progress bar CSS (removed legacy conflicting styles)
- extractZip hanging (switched from unzipper.Parse to Extract)
- Friendly error messages for invalid ZIP files (HTML error pages from dead servers)
- Delete handler supports directory-based charts and cleans empty parent folders
- Install tracking cleanup on chart deletion (handles filename-to-catalog-number mapping)

## [1.7.0] 2026-03-14
### Changed:
- Replaced `better-sqlite3` with Node.js built-in `node:sqlite` module
  - No more native C++ addon — eliminates `node-gyp`, `prebuild-install`, and all related build issues
  - Zero install-time compilation or binary downloads
  - Requires Node.js >= 22.5.0

## [1.6.0] 2026-01-14
### Changed:
- Replaced `@mapbox/mbtiles` with custom `better-sqlite3` implementation
  - Fixes "Could not locate the bindings file" error on Node.js 22 and 24
  - No more dependency on problematic `sqlite3` native module
  - Synchronous tile serving for better performance

### Added:
- ESLint and Prettier for code quality
  - ESLint 9 with flat config
  - Prettier for consistent code formatting
  - npm scripts: `lint`, `lint:fix`, `format`, `format:check`
- Comprehensive test suite using Node.js built-in test runner
  - 17 unit tests for MBTiles reader
  - 8 integration tests for plugin, charts loader, and tile serving
- GitHub Actions CI workflow
  - Runs linting and formatting checks
  - Tests on Node.js 22 and 24

### Notes:
- Node.js 22+ now fully supported with prebuilt `better-sqlite3` binaries
- Node.js 24 support confirmed working

## [1.5.2] 2026-01-11
### Fixed:
- Installation fails on systems with Python 3.12+ due to removed `distutils` module
  - Updated `better-sqlite3` from v11 to v12 which uses a compatible `node-gyp`
  - Fixes "ModuleNotFoundError: No module named 'distutils'" during npm install

## [1.5.1] 2025-12-04
### Changed:
- Migrated to `registerWithRouter` pattern for route registration ([#1](https://github.com/dirkwa/signalk-charts-provider-simple/issues/1))
  - Routes now properly scoped under `/plugins/signalk-charts-provider-simple/`
  - Avoids potential name clashes with official Signal K handlers and other plugins
  - Tile URLs updated accordingly in Resources API responses

### Fixed:
- Real-time delta notifications now work correctly for enable/disable chart toggle
  - Fixed chart identifier lookup for charts in subfolders
  - Delta data now always uses v2 format for proper client compatibility
- Downloaded and uploaded charts are now automatically enabled
  - Previously disabled charts are re-enabled when re-downloaded or re-uploaded

### Notes:
- This is a breaking change for any external tools directly accessing the old `/signalk/chart-tiles/` paths
- Chart consumers (Freeboard SK, etc.) will automatically use the new paths via the Resources API

## [1.5.0] 2025-12-04
### Changed:
- Switched from `sqlite3` to `better-sqlite3` for improved performance and simpler synchronous API
- Node.js 22 LTS recommended (prebuilt binaries available)

### Fixed:
- Upload progress overlay no longer disappears when a download completes in the background

### Notes:
- For Node.js 24+, manual installation of build tools may be required as prebuilt binaries are not yet available

## [1.4.0] 2025-11-30
### New:
- Chart Metadata Editor - Edit chart names directly in MBTiles files
  - "Info" button renamed to "Meta" for clarity
  - Click "Edit" in metadata modal to modify chart name
  - Legal warning displayed before editing
  - Auto-updates description to "USER MODIFIED - DO NOT DISTRIBUTE - PERSONAL USE ONLY"
  - Personal use only - helps identify charts for navigation vs distribution
  - Real-time delta updates to Freeboard SK after metadata changes
- Chart Name Display - MBTiles chart names now shown in detail view
  - Automatically reads chart name from MBTiles metadata
  - Displayed in accent color between Size and Folder
  - Fast single-query per chart (no performance impact)
  - Updates automatically when chart name is edited

### Important:
- This feature is for personal use only
- Modified charts should not be distributed
- Signal K community is not responsible for any illegal use of this feature

## [1.3.0] 2025-11-30
### New:
- Chart Info button - View detailed MBTiles metadata directly in the Chart Manager
  - Displays chart name, description, version, type, format
  - Shows geographic bounds (SW/NE coordinates), zoom levels, center point
  - Tile count with formatting
  - Attribution, credits, tags, and legend information
  - Beautiful modal dialog matching the existing Material Design 3 theme
  - Works for both grid and list view

## [1.2.0] 2025-11-28
### New:
- Real-time delta notifications to all chart operations in the plugin, following the exact pattern used by SignalK Server's built-in resource provider, so server reloads not needed anymore.

### Changed:
- "RFC-Ressource-Change" changed to [RFC: Resource Provider Delta Notification Best Practice](https://github.com/dirkwa/signalk-charts-provider-simple/blob/main/docs/RFC-Resource-Change-Notifications.md) - thanks Adrian!
- Unnessecary server reload notifications removed

## [1.1.1] 2025-11-28
### New:
- [RFC-Ressource-Change](https://github.com/dirkwa/signalk-charts-provider-simple/blob/main/docs/RFC-Resource-Change-Notifications.md) added to discuss with the community if we can make chart changes instant.

## [1.1.0] 2025-11-28
### New:
- Press and hold, than drag and drop charts to folder on touch and mobile devices - tested win11 & iOS 26

## [1.0.8] 2025-11-27
### Fixes:
- A newly generated folder in Chart Manager was not available in the Download area

### Changes:
- No Scrolling for Chart Manager top buttons, breaks the design
- CSS optimized between mobile and desktop

## [1.0.7] 2025-11-27
### Changes:
- to avoid conflicts use defaultChartsPath as charts-simple

## [1.0.6] 2025-11-27
### Changes:
- Plugin description

## [1.0.5] 2025-11-27
### Fixes:
- Github publishing - remove npm test
- Github publisihing - Firx workflow
### Changes:
- Typo in README.md

## [1.0.0] 2025-11-26
- Initial release
- Material Design 3 UI
- Optimized for touch and mobile
- Download queue management
- Manual Upload
- Folder organization with drag-and-drop
- Root folder and subfolder will be available for charts
- Ability to disable certain charts (requires server reload)
- Rename chart (requires server reload)