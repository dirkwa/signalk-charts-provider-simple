# Local WFS proxy

The plugin runs a WFS server on the loopback interface that other plugins in
the same Signal K server, and their worker processes, read instead of the
upstream WFS servers configured as its sources. An area is downloaded once,
kept, and answered from the store the next time.

## Sources

The servers proxied are added, edited and removed in the **WFS Data** tab of
the Charts Manager, by an administrator; a plugin reads any other directly.
They are kept in `<dataDir>/wfs-sources.json`, and a change applies to the
running proxy at once. Each source has:

- `name`: optional, what the tab shows it as.
- `url`: the WFS base URL, with no query, as the plugins reading it use it,
  and no user or password.
- `answersByBox`: on for a server that answers a box with every feature whose
  geometry reaches it, as GeoServer and MapServer do. Each feature is then
  kept once and a box inside the areas kept is answered from the store. Off
  (the default), an area is answered from the store only for the same box.
- `answerMargin`: with `answersByBox`, how far past a box the server answers,
  as a share of the box's size, east and west by its height and north and
  south by its width. A server that reads a box in its own grid, turned
  against latitude and longitude, returns features up to the box holding it
  turned: about 0.1 for a grid turned by 6°, so 0.12 leaves room. 0 for a
  server that answers the box exactly.
- `idProperty`: only for a server whose GeoJSON features have no `id`: the
  property naming each feature. Without an id a page is passed on but not
  kept.

The store keeps a source's data under the rule `answersByBox`,
`answerMargin` and `idProperty` make; when one of them changes, or the source
is removed, what was kept from it is dropped. Its `name` changes nothing kept.
While the file cannot be read, or holds no list of sources, the tab neither
adds nor removes a source, and nothing kept is dropped.

```json
{
  "sources": [
    { "url": "https://wfs.example.org/geoserver/wfs", "name": "Depth areas", "answersByBox": true, "answerMargin": 0.12 },
    { "url": "https://other.example.org/wfs", "answersByBox": false }
  ]
}
```

## Seeing and deleting what it keeps

The WFS Data tab shows, for each source and feature type, the areas kept, how
many are older than **Download a kept WFS area again after** (read upstream
again when next asked for), the features and their size, and when they were
downloaded; anyone who may read the server sees it. An administrator can
delete what one source keeps, or everything; the file is then compacted, so
the space goes back to the disk. Signal K need not be stopped: a peer's read
from the store in progress keeps the features it began with.

The plugin config's **Space for kept WFS data** limits the pages of the
store's file in use (0: no limit). Above it, the areas read longest ago are
dropped, with the features no area left reaches, until as much data as the
pages are over it is freed; the area read last always stays. Dropping the
oldest first changes no answer the store gives for the areas it still holds.
The pages freed are reused for what is kept next, so the file does not
shrink: only deleting in the WFS Data tab gives the space back to the disk.

The routes behind the tab, under `/plugins/signalk-charts-provider-simple`:

| Route | Access | |
| --- | --- | --- |
| `GET /wfs` | read | the sources, what each keeps, the store's size and limit |
| `POST /wfs/sources` | admin | adds a source (body as above, one entry) |
| `PUT /wfs/sources` | admin | changes the source of the body's `url` |
| `DELETE /wfs/sources?url=` | admin | removes a source and what it kept |
| `DELETE /wfs/data?url=` | admin | deletes what a source kept; without `url`, everything |

## How it answers

A request it can answer from the store is a WFS 2.0 `GetFeature` of one
feature type in a box in `urn:ogc:def:crs:EPSG::4326` (latitude, longitude),
with `srsName=EPSG:4326`, as GeoJSON pages (`startIndex`, `count`, `sortBy`)
or as a count (`resultType=hits`). A page without `count` gets the server's
own default number of features, unknown here, so it is passed upstream.
Without `srsName` a WFS answers in the feature type's own system, which may be
in metres, so such a request is passed upstream as it is, like any other.

- For an area the store does not hold whole and fresh, each request goes
  upstream and its reply is streamed back as fast as the client takes it, so
  a client sees the upstream's own timing. The features of each page are
  staged, and once the read's pages hold as many distinct features as its
  count names (the pages' `numberMatched`, or a `resultType=hits` in the
  same ordering), they are kept and the area is held, all in one
  transaction: a read that breaks off changes nothing. A count from another
  read, or a short page alone, does not end an area: it may describe other
  features, or be the server's own page limit. A count of none holds the
  area once no page asked for in the read is still to come. A read whose
  area a newer read overlapping it was kept for meanwhile is not kept, so it
  cannot bring back what that one dropped, nor is one begun before an area
  of its source was deleted, or before the read of an area dropped for
  space began (one begun later knows all that area did); reads and pages are
  ordered as they come, in the same millisecond too and if the clock is set
  back, while an area's age is counted from the time its read began. A very
  large reply, or one the upstream breaks off, is passed on but not kept; a
  broken one is broken off to the client too.
- For a source answering by box (`answersByBox`), each feature is kept once,
  by its id, and an area the store holds whole (inside boxes it holds,
  fetched within the maximum age) is answered from the store: every kept
  feature whose geometry reaches the area grown by the source's
  `answerMargin`, as the server answers features that far outside it (a
  line whose box reaches the area but which passes it by is not). A feature wholly inside a box read again whole that
  the read did not return is dropped: it is gone upstream. One reaching past
  that box, or lying in the margin of its answer, is kept for other areas, as
  it may only reach the box by its own box. Each place a kept feature reaches
  goes by the newest read holding that place: it is not answered where that
  read did not return it. An area is read upstream where those reads say
  both, or where one did not return it though a read of another area has
  returned it since, which says nothing of this one. A feature past the area,
  in the margin, is answered only if the newest read whose answer reached it
  returned it. A line or a point on a box's edge is in the box.
- For any other source, whose way of choosing features for a box the proxy
  does not know, an area is answered from the store only for the same box,
  with the features that box gave, as it gave them.
- Pages from the store come in the order of the one property `sortBy` names
  (`NAME`, `NAME ASC` or `NAME DESC`), else a fixed one. A request, count or
  page, with a `sortBy` of more than one property or a qualified name is
  passed upstream.
- A read is one area in one ordering (`sortBy`). It keeps the way it began,
  from the store or upstream, until it has been idle for ten minutes, so its
  pages come from one ordering; a count in the ordering of a read going on
  upstream goes upstream too. A read from the store answers the features
  the store held when it began, each as it was then, so its count and its
  pages agree whatever is kept or dropped meanwhile. A count
  (`resultType=hits`) ends the area's upstream reads that passed every page,
  or can no longer be kept once none of their pages is on its way, and one of
  its own ordering that no page followed. It does not end a read from
  the store, which answers the same count again until it has been idle,
  however old its areas grow meanwhile: a page carries no mark of the read it
  belongs to, so ending the read under a client still paging would give it
  pages that disagree with its count. So a client cannot ask for a count
  again to see an area kept meanwhile. A change of a source's rule, or its
  removal, ends its reads.
- On a metered, offline or captive connection (signalk-internet), and while
  the connection's state is still being learnt, an area held whole is
  answered from the store whatever its age.
- Redirects are followed only to a server it proxies. A reply that came by
  way of a redirect asking another query is passed on but not kept.
- A page with a feature that has no id or no coordinates is passed on but not
  kept, and its area is never held.

The store is `<dataDir>/wfs-cache/wfs.sqlite`. Deleting it loses nothing but
the downloads; a store an older version of the plugin left is begun again.

A config save restarts the plugin: the stopped proxy serves on for a short
while, and the next start takes it over with its new settings, so a read in
progress keeps its pages and its way. Meanwhile it answers from the store and
carries on the reads going upstream, but begins no new read upstream (it
answers 503) and refreshes no stale area.

## In-process API

Plugins in the same server read the `chartsProviderWfs` PropertyValue, typed
by `ChartsProviderWfsApi` in [`src/types.ts`](../src/types.ts), as they read
`chartTiles`. It is emitted once per server process, the first time the
plugin starts: PropertyValues are kept for good and capped server-wide, while
every config save restarts the plugin. Its members ask for the proxy running
at the time of the call, so while the plugin is stopped, or the proxy is
turned off, they give no URL, no upstreams and no store.

A peer subscribes with `app.onPropertyValues('chartsProviderWfs', …)`, takes
the last value, checks its shape and `apiVersion`, and unsubscribes when it
stops. The server hands the value over whichever plugin starts first.

`ChartsProviderWfsApi` gives each member's exact shape: the proxy's URL
standing in for an upstream WFS (or none when that WFS is not proxied, or no
proxy runs), the upstreams proxied, and what the store holds. Send the proxy's URL the same
query as the upstream, and ask for it for each read: it holds this process's
port, which a restart of this plugin keeps while it is free.

The URL is `http://127.0.0.1:<port>/<token>/<upstream>`: it listens on
127.0.0.1 only, and the token is random for each server process, so it needs
no Signal K login and is no open proxy.
