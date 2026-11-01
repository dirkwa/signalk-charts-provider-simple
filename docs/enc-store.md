# Shared ENC cells

The plugin keeps S-57 ENC cells as delivered, for other plugins to read: a
plugin that needs the chart data itself, not tiles (signalk-underkeel builds
its depth index from it), uses the cells the user already downloaded here
instead of asking for them again.

## Layout

```
<dataDir>/enc-store/
  <collection>/
    collection.json
    <CELL>/<CELL>.000
    <CELL>/<CELL>.001 …
```

`<dataDir>` is the data directory Signal K gives the plugin; readers take the
store's location from the API's `root` rather than building it. A
**collection** is the cells behind one chart:

| Kind | What it holds | Id | Removed |
| --- | --- | --- | --- |
| `chart-set` | An ENC Charts set's cells, hard linked from its cache | the set's id (`Gulf_of_Finland`) | with the set |
| `conversion` | The cells of an ENC chart converted from an upload, a folder on the server or the Chart Catalog, when **Keep the ENC cells of converted charts** is on | the chart file's name (`US5MA1AM`) | by the user, in the ENC Charts tab |

A converted chart's collection belongs to the chart's path in the chart
folder: it follows the chart when the chart is moved or renamed, and a chart
converted to that path again replaces it. One whose chart was deleted stays
until the user removes it; once another chart is moved or renamed to its
path, it is no longer tied to that path.

A cell's update files are named after the cell, beside it, so GDAL's S-57
driver applies them when it opens the `.000`. Another chart claiming an id
already taken gets `-2`, `-3`, ….

Guarantees for readers:

- A cell is written in a work folder and renamed into place, so a reader sees
  it whole or not at all: while a cell is replaced, its older copy is renamed
  aside first, and for that instant the cell is missing. A reader that finds
  one missing reads it again once told of the change. Names starting with `.`
  are work in progress: skip them.
- A cell whose files did not change keeps them as they are, names, sizes and
  modification times, so a reader that stamps cells by them sees no change.
- Readers are told of a collection once its write is done (below).
- Cells are only read by this plugin once stored; never write into the store.

## In-process API

Plugins in the same Signal K server use
`globalThis.__signalk_chartsProviderEnc`, typed by `ChartsProviderEncApi` in
[`src/types.ts`](../src/types.ts). It gives the store's `root`, the
collections with their cells, and a change listener. It is published once the
plugin has started and withdrawn when it stops; a peer plugin that starts
first waits for it, then reads the layout above under its `root`.

A reader checks that these members exist before calling them
(`ChartsProviderEncApi` in `src/types.ts` gives each call's exact shape):

- `state(id)`: `ready`; `writing` while the collection's cells are written,
  the first ones too (readers hear of it when the write is done, whether it
  worked or not: a failed write leaves the collection as it was, or absent);
  `pending` for a chart set whose cells are not shared yet, with `detail`
  saying whether it is downloading; `absent`. A reader that finds no cells
  can say which.
- `cellsIn`, given an area as west, south, east, north in degrees: the
  stored cells reaching it, one of each name, the newest edition and update
  first, with the path of each `.000`. A cell's extent comes from the ENC
  index (its unit's box, or for a NOAA cell the union of the band-4 boxes
  listing it); a cell the index does not know, or every cell while the
  index is not loaded, is taken to reach every area.
- `requestArea`, given an area as west, south, east, north and the name of
  the asking plugin: with **Download the ENC cells around the vessel** on,
  adds the ENC index units reaching the area to the chart set "Around the
  vessel", kept by its id in `<dataDir>/enc-area.json`, and downloads it.
  The answer has `accepted`, `started` and a `reason`, and `setId` and
  `retryAfterMs` where they apply:
  - `accepted: false`: refused, and nothing changes. The plugin is
    stopped, the setting is off, the area is not one, or it takes more
    than 60 units, of which none is added: ask for a smaller area.
  - `accepted: true, started: true`: the download started.
  - `accepted: true, started: false` and no `retryAfterMs`: no free ENC
    covers the area, the area is downloaded, or the download waits for the
    internet connection and starts once it allows. Asking again with the
    same area changes nothing.
  - `accepted: true, started: false` with `retryAfterMs`: the answer
    depends on something passing (the index loading, the set downloading,
    other conversions running), and may differ for the same area after
    that long. A set left out of date by a failed run is restarted only
    15 minutes after its last download started, so one that failed later
    than that restarts at once; a request that adds units to the set
    starts it at once too.

  Ask again when the area changes, and after `retryAfterMs` when the
  answer has one.

Compatibility: `apiVersion` changes only with a change readers must know
about, and a reader should not use an API of a version it does not know.
Everything else grows by addition: new fields and methods, never a changed
meaning. A listener stays subscribed while the plugin restarts on a config
save.

## REST

Under `/plugins/signalk-charts-provider-simple`, with the server's usual
access control:

| Route | Answer |
| --- | --- |
| `GET /enc-store` | `{ apiVersion, root, keepEncCells, encAreaDownloads, collections }` |
| `GET /enc-store/:collection` | the collection with its cells and their files (`name`, `bytes`, `modified`) |
| `GET /enc-store/:collection/:cell/:file` | one file, e.g. `/enc-store/Gulf_of_Finland/FI5AAAAA/FI5AAAAA.001` |
| `DELETE /enc-store/:collection` | removes a `conversion` collection; a chart set's answers 409 |
| `GET /enc-store/:collection/state` | the collection's `state`, as above |
| `GET /enc-area?bbox=west,south,east,north` | `{ cells }`, as `cellsIn` |
| `POST /enc-area` | `{ bbox, requester }` asks as `requestArea`; answers 400 when it is not accepted |

A collection's `dir` and each cell's `dir` are paths on the server.
