# Changelog

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