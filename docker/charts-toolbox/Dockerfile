# Charts toolbox: GDAL + tippecanoe + tile-join in a single image.
#
# Combines what the plugin used to pull as two separate images
# (`ghcr.io/osgeo/gdal:alpine-small-latest` and the local
# `ghcr.io/dirkwa/.../tippecanoe`) so a fresh signalk-container host
# pays one image pull instead of two on first conversion.
#
# Base is the upstream OSGeo `osgeo/gdal:ubuntu-small-3.13.0` image
# (Ubuntu 26.04 + glibc).  Picking glibc over Alpine/musl: ~10% faster
# on S-57's heavy XML/regex paths and far better behaviour around
# multilingual cell names (Dutch/German/French OBJNAM strings).  GDAL
# 3.13 has the IEHG inland additions (classes 17xxx — Waterway axis,
# Distance mark with wtwdis, Berth berths, etc.) merged into its
# bundled `s57objectclasses.csv`, so no IENC catalogue vendoring is
# needed — the S-57 driver picks them up via GDAL's compile-time
# default `/usr/share/gdal/`.

# ── Stage 1: build tippecanoe binaries from felt/tippecanoe ──────────
# Ubuntu 26.04 builder so the linkage matches the runtime stage.
FROM ubuntu:26.04 AS tippecanoe-builder

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential \
        libsqlite3-dev \
        zlib1g-dev \
        git \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Pin the felt/tippecanoe revision via tag rather than a floating master
# so rebuilds of this image at a different time produce identical
# binaries.  Bump deliberately by editing the tag below; not via a
# `:latest` redirect.
ARG TIPPECANOE_REF=2.79.0
RUN git clone --depth 1 --branch ${TIPPECANOE_REF} \
        https://github.com/felt/tippecanoe.git /src/tippecanoe
WORKDIR /src/tippecanoe
RUN make -j"$(nproc)" \
    && make install PREFIX=/usr/local \
    && strip /usr/local/bin/tippecanoe* /usr/local/bin/tile-join

# ── Stage 2: runtime ─────────────────────────────────────────────────
FROM ghcr.io/osgeo/gdal:ubuntu-small-3.13.0

# `libsqlite3-0`, `zlib1g`, `libstdc++6` are already present in the
# GDAL base — verified via `dpkg -l` against the upstream image.
# `LANG=C.UTF-8` makes accented OBJNAM strings round-trip cleanly
# without pulling in the full `locales` package; the `C.utf8` locale
# is built into glibc.
ENV LANG=C.UTF-8 \
    LC_ALL=C.UTF-8

COPY --from=tippecanoe-builder /usr/local/bin/tippecanoe /usr/local/bin/
COPY --from=tippecanoe-builder /usr/local/bin/tippecanoe-decode /usr/local/bin/
COPY --from=tippecanoe-builder /usr/local/bin/tile-join /usr/local/bin/
COPY --from=tippecanoe-builder /usr/local/bin/tippecanoe-enumerate /usr/local/bin/
COPY --from=tippecanoe-builder /usr/local/bin/tippecanoe-overzoom /usr/local/bin/
COPY --from=tippecanoe-builder /usr/local/bin/tippecanoe-json-tool /usr/local/bin/

# Run as a fixed non-root user.  Defense-in-depth: even though every
# `runJob` invocation is a short-lived helper with no network and no
# privileged capabilities, root-by-default in helper containers is a
# bad smell that doesn't pay rent.  UID 1001 is `nogroup`-friendly
# and avoids the well-known UID 1000 collision on many host distros.
#
# Callers that need the container to write into a host-owned bind
# mount with matching UID should pass `--user $(id -u):$(id -g)` at
# run-time — that override beats this default and keeps file
# ownership predictable for the host.  The plugin's `signalk-container`
# manager will gain that flag automatically in 1.4.0; until then,
# in-plugin use of this image needs the manager bump (the converter's
# image swap is gated on it via peer-dep).
RUN groupadd --gid 1001 toolbox \
    && useradd --uid 1001 --gid 1001 \
         --home-dir /home/toolbox --create-home \
         --shell /sbin/nologin toolbox
USER toolbox
WORKDIR /home/toolbox
