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
or as a count (`resultType=hits`). Without `srsName` a WFS answers in the
feature type's own system, Traficom's in metres, so such a request is passed
upstream as it is, like any other.

- For an area the store does not hold whole and fresh, each request goes
  upstream and its reply is streamed back as it arrives, so a client sees the
  upstream's own timing. The features of each page are kept, each once by its
  id, and once every page of the area has passed, the area is held. A feature
  wholly inside the area that the read did not return is dropped: it is gone
  upstream. A count of none holds the area at once and drops what it kept
  inside. A read from the store that listed a dropped feature still gets it.
- For an area the store holds whole (inside boxes it holds, fetched within the
  maximum age), requests are answered from the store: every kept feature whose
  box reaches the area grown by an eighth of its size, paged as asked, in the
  order of the one property `sortBy` names (`NAME`, `NAME ASC` or
  `NAME DESC`), else a fixed one. A `sortBy` of more than one property is
  passed upstream. Traficom reads a box in its own grid, turned by up to 6° against
  latitude and longitude across Finland, and answers features that far
  outside it: the store answers them too, and a few more.
- A read is one area in one ordering (`sortBy`). It keeps the way it began,
  from the store or upstream, and from the store the features it answers,
  until it has been idle for ten minutes, so its pages come from one ordering.
  A count (`resultType=hits`) for an area whose read has passed every page
  begins a new read.
- On a metered, offline or captive connection (signalk-internet), an area held
  whole is answered from the store whatever its age.
- A page with a feature that has no id or no coordinates is passed on but not
  kept, and its area is never held.

The store is `<dataDir>/wfs-cache/wfs.sqlite`. Deleting it loses nothing but
the downloads.

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
