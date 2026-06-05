/**
 * Container images the converters pull through `signalk-container`'s
 * runtime layer.  Single source of truth — both `s57-converter.ts`
 * and `rnc-converter.ts` import from here, so bumping the image
 * version is one edit, not two.
 *
 * The toolbox image bundles GDAL + tippecanoe + tile-join + helpers
 * in a single image, replacing the two upstream-pulled images
 * (`osgeo/gdal:alpine-small-latest` + the legacy
 * `ghcr.io/dirkwa/.../tippecanoe`) the converter used before PR #94.
 * A fresh `signalk-container` host pays one image pull on first
 * conversion instead of two.
 *
 * Pinned to an explicit `:VERSION` tag, not `:latest`.  The
 * `build-charts-toolbox.yml` workflow refuses to overwrite a
 * published version tag, so once a `:1.0.0` is in the registry it's
 * permanent — every host that pulled it has the same content
 * forever.  Bumping = update `docker/charts-toolbox/VERSION`,
 * rebuild + push, then update the version in this file.
 */
export const CHARTS_TOOLBOX_IMAGE =
  'ghcr.io/dirkwa/signalk-charts-provider-simple/charts-toolbox:1.1.0';
