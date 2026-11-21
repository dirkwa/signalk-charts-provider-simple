# Local WFS proxy

The plugin runs a WFS server on the loopback interface that other plugins in
the same Signal K server read instead of an upstream WFS, such as Traficom's
depth areas: signalk-underkeel reads its chart box, depth survey and planning
boxes through it, from its build processes too. An area is downloaded once,
kept, and answered from the store the next time.

## How it answers

A request it can answer from the store is a WFS 2.0 `GetFeature` of one
feature type in a box in `urn:ogc:def:crs:EPSG::4326` (latitude, longitude),
with `srsName=EPSG:4326`, as GeoJSON pages (`startIndex`, `count`, `sortBy`)
or as a count (`resultType=hits`). A page without `count` gets the server's
own default number of features, unknown here, so it is passed upstream. Without `srsName` a WFS answers in the
feature type's own system, Traficom's in metres, so such a request is passed
upstream as it is, like any other.

- For an area the store does not hold whole and fresh, each request goes
  upstream and its reply is streamed back as fast as the client takes it, so
  a client sees the upstream's own timing. The features of each page are
  staged, and once the read's pages hold as many distinct features as its
  count names (the pages' `numberMatched`, or a `resultType=hits` in the
  same ordering), they are kept and the area is held, all in one
  transaction: a read that breaks off changes nothing. A count from another
  read, or a short page alone, does not end an area: it may describe other
  features, or be the server's own page limit. A count of none holds the
  area at once. A read whose area a newer read overlapping it was kept for
  meanwhile is not kept, so it cannot bring back what that one dropped;
  reads and pages are ordered as they come, in the same millisecond too and
  if the clock is set back, while an area's age is counted from the time its
  read began. A
  very large reply, or one the upstream breaks off, is passed on but not
  kept; a broken one is broken off to the client too.
- For Traficom's WFS, each feature is kept once, by its id, and an area the
  store holds whole (inside boxes it holds, fetched within the maximum age)
  is answered from the store: every kept feature whose box reaches the area
  grown by a margin. Traficom reads a box
  in its own grid, turned by up to 6° against latitude and longitude across
  Finland, and answers features that far outside it: the store answers them
  too, and a few more. A feature wholly inside a box read again whole that
  the read did not return is dropped: it is gone upstream. One reaching past
  that box, or lying in the margin of its answer, is kept for other areas, as
  it may only reach the box by its own box. Each place a kept feature reaches
  goes by the newest read holding that place: it is not answered where that
  read did not return it. An area is read upstream where those reads say
  both, or where one did not return it though a read of another area has
  returned it since, which says nothing of this one. A feature past the area,
  in the margin, is answered only if the newest read whose answer reached it
  returned it. A line or a point on a box's edge is in the box.
- For any other WFS, whose way of choosing features for a box the proxy does
  not know, an area is answered from the store only for the same box, with
  the features that box gave, as it gave them.
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
  and one of its own ordering no page followed; it does not end a read from
  the store, which answers the same count again until it has been idle. So
  a client cannot ask for a count again to see an area kept meanwhile.
- On a metered, offline or captive connection (signalk-internet), and while
  the connection's state is still being learnt, an area held whole is
  answered from the store whatever its age.
- Redirects are followed only to a server it proxies.
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

Plugins in the same server use `globalThis.__signalk_chartsProviderWfs`, typed
by `ChartsProviderWfsApi` in [`src/types.ts`](../src/types.ts). It is published
once the proxy listens and withdrawn when the plugin stops.

`ChartsProviderWfsApi` gives each member's exact shape: the proxy's URL
standing in for an upstream WFS (or none when that WFS is not proxied), the
upstreams proxied, and what the store holds. Send the proxy's URL the same
query as the upstream, and ask for it for each read: it holds this process's
port, which a restart of this plugin keeps while it is free.

The URL is `http://127.0.0.1:<port>/<token>/<upstream>`: it listens on
127.0.0.1 only, and the token is random for each server process, so it needs
no Signal K login and is no open proxy.
