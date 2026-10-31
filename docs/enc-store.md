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
| `GET /enc-store` | `{ apiVersion, root, keepEncCells, collections }` |
| `GET /enc-store/:collection` | the collection with its cells and their files (`name`, `bytes`, `modified`) |
| `GET /enc-store/:collection/:cell/:file` | one file, e.g. `/enc-store/Gulf_of_Finland/FI5AAAAA/FI5AAAAA.001` |
| `DELETE /enc-store/:collection` | removes a `conversion` collection; a chart set's answers 409 |

A collection's `dir` and each cell's `dir` are paths on the server.
