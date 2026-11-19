# Local WFS proxy

The plugin runs a WFS server on the loopback interface that other plugins in
the same Signal K server read instead of an upstream WFS, such as Traficom's
depth areas: signalk-underkeel reads its chart box, depth survey and planning
boxes through it, from its build processes too. An area is downloaded once,
kept, and answered from the store the next time.

## How it answers

A request it can answer from the store is a WFS 2.0 `GetFeature` of one
feature type in a box in `urn:ogc:def:crs:EPSG::4326` (latitude, longitude),
as GeoJSON pages (`startIndex`, `count`, `sortBy`) or as a count
(`resultType=hits`). Any other request is passed upstream as it is.

- For an area the store does not hold whole and fresh, each request goes
  upstream and its reply is streamed back as it arrives, so a client sees the
  upstream's own timing. The features of each page are kept, each once by its
  id, and once every page of the area has passed, the area is held.
- For an area the store holds whole (inside boxes it holds, fetched within the
  maximum age), requests are answered from the store: every kept feature whose
  box reaches the area, in a fixed order, paged as asked.
- An area keeps the way its read began, from the store or upstream, until the
  read has been idle for ten minutes, so the pages of one read come from one
  ordering.
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

- `proxyUrl(upstream)`: the URL standing in for the WFS at `upstream`, a base
  URL with no query, or `undefined` when that WFS is not proxied. Send it the
  same query as the upstream. Ask for each read: the URL holds this process's
  port, which a restart of this plugin keeps while it is free.
- `upstreams()`: the upstream WFS base URLs proxied.
- `stats()`: features kept, areas held whole, and bytes on disk.

The URL is `http://127.0.0.1:<port>/<token>/<upstream>`: it listens on
127.0.0.1 only, and the token is random for each server process, so it needs
no Signal K login and is no open proxy.
