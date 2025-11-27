# Changelog

## [1.2.0] 2025-01-28
### New:
- Real-time delta notifications to all chart operations in the plugin, following the exact pattern used by SignalK Server's built-in resource provider, so server reloads not needed anymore.

### Changed:
- [RFC-Ressource-Change](https://github.com/dirkwa/signalk-charts-provider-simple/blob/main/docs/RFC-Resource-Change-Notifications.md) changed to [RFC: Resource Provider Delta Notification Best Practice](https://github.com/dirkwa/signalk-charts-provider-simple/blob/main/docs/RFC-Resource-Change-Notifications.md) - thanks Adrian!
- Unnessecary server reload notifications removed

## [1.1.1] 2025-01-28
### New:
- [RFC-Ressource-Change](https://github.com/dirkwa/signalk-charts-provider-simple/blob/main/docs/RFC-Resource-Change-Notifications.md) added to discuss with the community if we can make chart changes instant.

## [1.1.0] 2025-01-28
### New:
- Press and hold, than drag and drop charts to folder on touch and mobile devices - tested win11 & iOS 26

## [1.0.8] 2025-01-27
### Fixes:
- A newly generated folder in Chart Manager was not available in the Download area

### Changes:
- No Scrolling for Chart Manager top buttons, breaks the design
- CSS optimized between mobile and desktop

## [1.0.7] 2025-01-27
### Changes:
- to avoid conflicts use defaultChartsPath as charts-simple

## [1.0.6] 2025-01-27
### Changes:
- Plugin description

## [1.0.5] 2025-01-27
### Fixes:
- Github publishing - remove npm test
- Github publisihing - Firx workflow
### Changes:
- Typo in README.md

## [1.0.0] 2025-01-26
- Initial release
- Material Design 3 UI
- Optimized for touch and mobile
- Download queue management
- Manual Upload
- Folder organization with drag-and-drop
- Root folder and subfolder will be available for charts
- Ability to disable certain charts (requires server reload)
- Rename chart (requires server reload)