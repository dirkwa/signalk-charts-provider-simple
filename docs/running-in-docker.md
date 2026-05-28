# Running Signal K (and this plugin) in Docker

Chart **display** (serving tiles from `.mbtiles`) needs nothing extra and works
the same whether Signal K runs bare-metal or in a container. This page is only
about chart **conversion** (S-57 ENC → vector MBTiles, BSB → raster MBTiles,
basemaps), which runs OCI containers.

## Conversion is delegated to `signalk-container`

From 2.0 onward this plugin does **not** talk to a Docker/Podman socket itself.
All container work — runtime detection, image pulls, launching conversion jobs,
mounting the Signal K data directory, and resolving host paths — is delegated to
the [`signalk-container`](https://github.com/dirkwa/signalk-container) plugin.

That means there is nothing Docker-specific to configure here. Install
`signalk-container` from the App Store (the Charts Provider Simple detail page
lists it as a recommended plugin) and make sure it reports a healthy runtime in
its config panel. If conversion is unavailable, the Convert and Chart Catalog
tabs show a warning; chart display keeps working regardless.

## Where to set up the runtime

All host/runtime setup — mounting the Docker/Podman socket into a containerised
Signal K, socket permissions, `DOCKER_HOST`, SELinux `:Z`, host-UID ownership,
named-volume vs. bind-mount data sharing — now lives with `signalk-container`,
which handles the bare-metal, Docker, and Podman topologies automatically. See:

- [`signalk-container` README](https://github.com/dirkwa/signalk-container#readme)
  — runtime detection, settings, and the config panel.
- [`signalk-container` plugin developer / setup docs](https://github.com/dirkwa/signalk-container/tree/main/doc)
  — deployment topologies and host configuration.

## See also

- [Issue #7](https://github.com/dirkwa/signalk-charts-provider-simple/issues/7) —
  the original Podman-host report that prompted the 1.x version of this doc, now
  resolved by the `signalk-container` architecture.
