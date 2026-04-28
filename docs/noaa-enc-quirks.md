# NOAA ENC quirks and how this plugin handles them

NOAA US ENC charts are excellent but have a few well-known encoding quirks that catch new users off-guard. This page documents the ones the plugin currently handles, how it handles them, and how to disable that handling if you ever need to.

## 1. Constructed marina basins and inland coastal lagoons render as land

### What you see

Locations like Michigan City Outer Basin (Indiana) or Lake Worth (Palm Beach, Florida) appear tan (land) in the renderer at high zooms, with mooring slips, soundings, and harbour facilities drawn on top — even though they are clearly water bodies with depths, names, and navigation aids.

### Why

NOAA encodes these areas with a coarse `LNDARE` (land area) polygon that doesn't cut a hole for the basin or lagoon, layered over a `DEPARE` (depth area) polygon that has the actual water depths. S-52 — the official chart-rendering specification all conforming renderers follow — puts land on top of water, so the basin shows as land in spite of having correct depth data underneath.

This is a deliberate cell-layering choice by NOAA: high-resolution band-5 cells add harbour-tier detail (mooring facilities, slip lines, soundings, lights) on top of a coarser band-4 / band-3 LNDARE that defines the basic land-vs-water silhouette. The trade-off is that some constructed harbours and lagoons end up looking like land in renderers.

### What the plugin does

When the plugin's `noaaLndareCutByDepare` option is enabled (default **on**, since v1.12), the conversion pipeline runs an extra pass after GDAL exports per-chart-per-layer GeoJSON files:

1. For each chart cell, pair its `LNDARE_<chart>.geojson` with its `DEPARE_<chart>.geojson`.
2. Filter the chart's DEPARE features to those that represent water at chart datum (`DRVAL2 > 0`). This excludes drying flats and intertidal areas, which NOAA encodes the same way deliberately and which **must** stay as land.
3. For each LNDARE polygon that overlaps a kept DEPARE, subtract the DEPARE geometry. The LNDARE polygon ends up with an interior ring (a hole) where the basin or lagoon is.
4. Tippecanoe then sees an LNDARE with a hole and renders the basin as transparent — the underlying DEPARE shows through.

The conversion log includes a counter line so you can see how many cuts were applied:

```
LNDARE cut by DEPARE: scanned 12453 land features in 680 charts; cut 84 (84 DEPARE applied, 211 skipped as drying, 0 cut failures)
```

### Limits and known edge cases

- **Reclaimed land / pier extensions over historic seabed.** NOAA sometimes layers new fill (LNDARE) over a pre-existing DEPARE that hasn't been retired. With `DRVAL2 > 0` filtering most of these survive untouched, but the line between "fill that should still be land" and "basin that should be water" is fuzzy in places. If you spot a pier rendered as water, the plugin's cut almost certainly caused it — disable the option for that bundle.
- **Cut failures on degenerate geometry.** If `@turf/difference` throws on a specific LNDARE/DEPARE pair (slivers, self-intersections, near-coincident edges), the plugin keeps the original LNDARE unchanged and increments the `cutFailures` counter. Conversion continues; the affected feature renders as it would have without the fix.
- **Per-chart-cell scope.** The plugin only cuts LNDARE in chart A with DEPARE from chart A — never cross-cuts across cells. This keeps the operation O(N) across the bundle and avoids damaging cases where a band-3 LNDARE is intentionally drawn over a band-5 DEPARE in a different cell.

### How to disable

Plugin Configuration → "NOAA fix: cut basin/lagoon water out of land polygons" → uncheck. Re-convert any bundles you want rendered without the fix.

You can also override per-conversion via the API by passing `noaaLndareCutByDepare: false` in `S57ConversionOptions`.

### When to disable

- You're seeing visual artifacts on a specific bundle — typically a pier, jetty, or fill area rendered as water that should be land.
- You're working with non-NOAA producers (UKHO, BSH, CHS, AHO, …) where this encoding pattern doesn't apply. The fix is harmless for them — there are simply no overlapping LNDARE/DEPARE pairs to cut — but disabling saves a small amount of conversion time on big bundles.
- You want the bit-for-bit S-57 source to render unchanged for a comparison or audit.

### How to escalate a specific chart cell to NOAA

If you find a cell where the basin/lagoon coding is genuinely wrong (not the cell-layering quirk this fix handles, but actually-incorrect data), NOAA accepts chart inquiries here:

https://nauticalcharts.noaa.gov/customer-service/assist/

Mention the cell ID (e.g. `US5CHIHV` for Michigan City) and describe the encoding issue. Turnaround is typically several weeks; corrections appear in subsequent ENC editions.
