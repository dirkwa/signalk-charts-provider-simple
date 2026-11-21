# Chart coverage

An S-57 chart is opaque where it has data: its depth areas, land and
unsurveyed areas leave no gap there, and it hides every chart beneath it.
A plotter that knows where can skip the tiles of those charts instead of
fetching and decoding them for nothing. Each S-57 chart this plugin builds
says where in its chart resource:

```json
"coverage": [
  { "minzoom": 9, "maxzoom": 12, "tiles": ["10/315/381", "11/629/761", "12/1257/1521"] },
  { "minzoom": 12, "tiles": ["13/2485/3060", "14/4970/6119"] }
]
```

Each entry lists the Web Mercator tiles (`z/x/y`, XYZ rows counted from the
north) the chart fills entirely at every zoom from `minzoom` to `maxzoom`.
Without `maxzoom` the entry holds at every zoom above `minzoom`, including
zooms past the chart's own maxzoom that a plotter overzooms. Where all four
children of a tile are filled, the tile stands in for them, so a tile of
another chart at a zoom the entry holds is hidden when it, or one of its
ancestors, is listed. Entries may overlap. A tile that is not listed may be
partly transparent, so the charts beneath must be drawn there. A chart
without `coverage` says nothing either way. A plotter should skip the
charts beneath only while it draws this chart fully opaque.

## Where it comes from

The plugin writes the coverage into the MBTiles `metadata` table, as the JSON
value of the row `coverage`, when it builds the chart; the loader serves it
from there, so a chart keeps it when it is moved or copied.

- **ENC charts** (converted charts and chart sets): per IHO band, the tiles
  the union of its cells' `M_COVR` areas (CATCOV 1, or no CATCOV) fills, at
  the zooms the band is tiled at. S-57 requires a cell's skin of earth to
  fill its coverage without gaps. Tiles are listed down to z14, or less deep
  for overview bands and when a band would list more than 2000 tiles.
  Above a band's maxzoom the server overzooms only the tiles no larger
  scale has, so a band keeps its maxzoom unless it reaches the chart's top
  zoom.
- **Open Data Charts sets**: one entry from z9 with the set's units, each a
  z9 tile it fills entirely. Below z9 the region overviews draw, which are
  not claimed. A set built before charts carried a coverage gets one on its
  next build.
