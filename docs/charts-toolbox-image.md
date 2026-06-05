# charts-toolbox container image

This repository publishes a self-contained container image with **GDAL** and **tippecanoe** preinstalled, for use outside the Signal K plugin context — overnight conversion pipelines, ad-hoc CLI experiments, third-party automation, etc.

This is also the image the plugin's converter is being migrated to use internally, so behaviour will stay in lockstep with what the plugin produces.

## Image reference

```text
ghcr.io/dirkwa/signalk-charts-provider-simple/charts-toolbox:1.1.0
```

Tags:
- `:latest` — rolls automatically with each `main` build. Fine for dev. Don't pin scripts to it.
- `:1.0.0` — **policy-immutable**: the build workflow refuses to overwrite an existing version tag, so once a `:VERSION` is published it never moves. Use this for any reproducible script. For absolute reproducibility — i.e. content-addressable, byte-identical-on-pull — pin to the digest form `…@sha256:<hash>` instead, which you can read off the GHCR UI or via `docker manifest inspect`.
- `:<commit-sha>` — also published, for pinning to a specific build of this repo.

Multi-arch (`linux/amd64` + `linux/arm64`).

## What's inside

- **GDAL 3.13.0** — `ogrinfo`, `ogr2ogr`, `gdalinfo`, `gdal_translate`, `gdaladdo`, `gdal_rasterize`, etc. From the upstream `osgeo/gdal:ubuntu-small-3.13.0` image (Ubuntu 26.04 / glibc).
- **tippecanoe 2.79.0** — `tippecanoe`, `tile-join`, `tippecanoe-decode`, `tippecanoe-overzoom`, `tippecanoe-enumerate`, `tippecanoe-json-tool`. Compiled from `felt/tippecanoe`.
- **GDAL's bundled S-57 catalogue** with **IEHG inland additions** (classes 17xxx — Waterway axis, Distance mark with `wtwdis`, Berth berths, Fairway, etc.). Picked up automatically via `S57_CSV` defaulting to `/usr/share/gdal`. No need to vendor IEHG CSVs separately.
- **`LANG=C.UTF-8` / `LC_ALL=C.UTF-8`** — accented OBJNAM strings (Dutch, German, French) round-trip cleanly.
- **Non-root by default** — runs as `toolbox` (UID 1001). See "File ownership" below.

Image size: ~400 MB (compressed: ~140 MB amd64).

## Quickstart: convert one S-57 ENC zip to vector MBTiles

```bash
mkdir -p /tmp/charts
cd /tmp/charts

# Drop your ENC zip here, then unzip
cp ~/Downloads/MyChart.zip .
unzip -q MyChart.zip                     # creates ENC_ROOT/ etc.

# 1. ogr2ogr each .000 cell to GeoJSON
docker run --rm \
    -v "$PWD:/data" \
    --user "$(id -u):$(id -g)" \
    ghcr.io/dirkwa/signalk-charts-provider-simple/charts-toolbox:1.1.0 \
    sh -c '
        find /data/ENC_ROOT -name "*.000" -print0 | while IFS= read -r -d "" cell; do
            name=$(basename "$cell" .000)
            ogr2ogr -f GeoJSONSeq -skipfailures \
                -mapFieldType DateTime=String \
                "/data/$name.geojsonl" "$cell"
        done
    '

# 2. tippecanoe — band-aware ranges per the IHO/IENC scale system.
# Wrap in sh -c so the /data/*.geojsonl glob expands inside the
# container; passed as a bare argv arg, the runtime would hand
# tippecanoe a literal "*.geojsonl" string and it would error with
# "No such file or directory".
docker run --rm \
    -v "$PWD:/data" \
    --user "$(id -u):$(id -g)" \
    ghcr.io/dirkwa/signalk-charts-provider-simple/charts-toolbox:1.1.0 \
    sh -c '
        tippecanoe \
            -o /data/MyChart.mbtiles \
            -Z 9 -z 14 \
            --layer=enc \
            /data/*.geojsonl
    '
```

Result: `/tmp/charts/MyChart.mbtiles`, ready to drop into a Signal K chart directory or serve directly.

## File ownership: the `--user` flag

The image runs as a non-root user by default (`toolbox`, UID 1001). When you bind-mount a host directory, files written into that directory will be owned by **that** UID, not the host user — which usually means the host user can't read them afterwards.

Pass `--user $(id -u):$(id -g)` to align the in-container UID with your host UID. **All examples in this doc do that.**

### Docker (and Docker Desktop)

```bash
docker run --rm \
    --user "$(id -u):$(id -g)" \
    -v "$PWD:/data" \
    ghcr.io/dirkwa/signalk-charts-provider-simple/charts-toolbox:1.1.0 \
    <command>
```

### Rootless Podman

`--user` works the same way under rootless Podman, but a more robust approach uses `--userns=keep-id`:

```bash
podman run --rm \
    --userns=keep-id:uid=1001,gid=1001 \
    -v "$PWD:/data:Z" \
    ghcr.io/dirkwa/signalk-charts-provider-simple/charts-toolbox:1.1.0 \
    <command>
```

The `:Z` SELinux relabel suffix on the volume is needed on Fedora / RHEL / Rocky hosts; harmless elsewhere.

### Rootful Podman / rootful Docker

Same as Docker — use `--user $(id -u):$(id -g)`.

### CI runners (GitHub Actions ubuntu-latest, etc.)

The runner is typically rootful Docker. Add `--user "$(id -u):$(id -g)"` to your `docker run` invocations. The `${{ github.workspace }}` directory and any other paths you need to write are owned by the runner user; the flag aligns the container with that.

## What the image is NOT

- **Not a CLI wrapper** — there's no `convert-noaa` script or "make me an mbtiles" tool. The image is GDAL + tippecanoe; you orchestrate the steps yourself with shell scripts, `make`, GitHub Actions, etc.
- **Not bundled with the Signal K plugin** — the plugin has its own runtime path through `signalk-container`. This image is for users who want the same converter outside Signal K.
- **Not a publishing pipeline** — if you want overnight NOAA region conversions published to a GitHub Release, that's your workflow to build, in your repo, against this image. The third-party user pursuing that use case owns the publishing logic; we ship the image they invoke.

## Reproducibility

- Both `FROM` lines in the [Dockerfile](../docker/charts-toolbox/Dockerfile) are pinned by SHA256 digest — never by mutable tag.
- `tippecanoe` is checked out by exact commit SHA, not by tag.
- Bumping any of the above is a deliberate edit to the Dockerfile + a bump of [`docker/charts-toolbox/VERSION`](../docker/charts-toolbox/VERSION). The `build-charts-toolbox.yml` workflow refuses to push a duplicate `:VERSION` tag, so digest updates without a VERSION bump fail the build at publish time.

See the "Bumping image digests" comment block at the bottom of the [Dockerfile](../docker/charts-toolbox/Dockerfile) for the maintenance procedure.

## Tippecanoe references

- Repository: <https://github.com/felt/tippecanoe>
- Tile-size and feature-density tuning: see the upstream `tippecanoe -h` output and [`README.md`](https://github.com/felt/tippecanoe#tippecanoe).
- IHO/IENC band-aware zoom mapping (what this plugin uses internally): [src/utils/s57-band.ts](../src/utils/s57-band.ts) — `BAND_MIN_ZOOM` / `BAND_MAX_ZOOM` constants.
