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
#
# Pinned to an explicit image digest, not just `:26.04`.  Tags can
# be re-published by Canonical when they rebuild for security
# patches; the digest is content-addressed and never moves.  Bump
# both this builder image and the runtime image (Stage 2) together
# when refreshing — see "Bumping image digests" at the bottom of
# this file.
FROM ubuntu:26.04@sha256:f3d28607ddd78734bb7f71f117f3c6706c666b8b76cbff7c9ff6e5718d46ff64 AS tippecanoe-builder

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential \
        libsqlite3-dev \
        zlib1g-dev \
        git \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Pin the felt/tippecanoe checkout to an exact commit SHA instead of
# a tag.  Tags are mutable — anyone with push rights can move them
# — so even though `2.79.0` and this SHA point at the same content
# today, the SHA is the only form that gives true reproducibility.
# The TIPPECANOE_REF arg name is kept for readability; the value is
# a 40-char commit hash.
ARG TIPPECANOE_REF=68ab8dcc229f95b8b25877697d5e8d66783af503
RUN git clone https://github.com/felt/tippecanoe.git /src/tippecanoe \
    && cd /src/tippecanoe \
    && git checkout --quiet ${TIPPECANOE_REF}
WORKDIR /src/tippecanoe
RUN make -j"$(nproc)" \
    && make install PREFIX=/usr/local \
    && strip /usr/local/bin/tippecanoe* /usr/local/bin/tile-join

# ── Stage 2: runtime ─────────────────────────────────────────────────
# Pinned to the digest of `osgeo/gdal:ubuntu-small-3.13.0` at the
# time of writing.  OSGeo doesn't publish a floating
# `:ubuntu-small-latest` tag, but they *do* re-tag `:3.13.0` when
# they rebuild the underlying Ubuntu base for security patches.
# The digest pin makes our image truly content-addressed.
FROM ghcr.io/osgeo/gdal:ubuntu-small-3.13.0@sha256:e0fedbcc5b51bd12617d6a6cf8b7c3244d98cbd29b266925fd9061f40081b351

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
# run-time on Docker / rootful Podman, or
# `--userns=keep-id:uid=1001,gid=1001` on rootless Podman.  The
# `signalk-container` manager (>= 1.4.0) emits the right form for
# the detected runtime automatically; consumer plugins just declare
# `user: { inImageUid: 1001, inImageGid: 1001 }` in their `runJob`
# call.
RUN groupadd --gid 1001 toolbox \
    && useradd --uid 1001 --gid 1001 \
         --home-dir /home/toolbox --create-home \
         --shell /sbin/nologin toolbox
USER toolbox
WORKDIR /home/toolbox

# ─────────────────────────────────────────────────────────────────────
# Bumping image digests
# ─────────────────────────────────────────────────────────────────────
# When refreshing the bases (security patches, GDAL major bumps, new
# tippecanoe release):
#
#   1. `docker pull ubuntu:26.04` (or the new tag), then
#      `docker images ubuntu:26.04 --format '{{.Digest}}'` and paste
#      that into the Stage 1 FROM line.
#   2. Same for the GDAL base — pull the new
#      `osgeo/gdal:ubuntu-small-X.Y.Z` and read its digest.
#   3. For tippecanoe: `git ls-remote --tags
#      https://github.com/felt/tippecanoe` to find the new tag's
#      commit SHA, then update TIPPECANOE_REF.
#   4. Bump `docker/charts-toolbox/VERSION` deliberately — the
#      build-charts-toolbox.yml workflow refuses to push an image
#      tag that already exists in the registry, so a digest update
#      without a VERSION bump fails the build.
# ─────────────────────────────────────────────────────────────────────
