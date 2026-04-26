import path from 'path';

/**
 * IHO S-57 ENC usage band parsed from the chart's base filename, per the
 * IHO Annex E filename convention `<CC><band><area>` followed by all
 * official national hydrographic offices (NOAA, UKHO, BSH, CHS, AHO, …).
 *
 * Returns 1..6 when the filename conforms, or `null` otherwise (IENC inland
 * charts and ad-hoc files don't follow this convention; callers fall back
 * to the user-requested maxzoom in that case).
 */
export function detectEncBand(filename: string): number | null {
  const base = filename.replace(/\.[^.]+$/, '');
  const m = base.match(/^[A-Z]{2}(\d)/);
  if (!m) {
    return null;
  }
  const band = parseInt(m[1], 10);
  return band >= 1 && band <= 6 ? band : null;
}

/**
 * Sensible tippecanoe maxzoom for each IHO band. Mirrors the documented
 * native chart scales: emitting tiles past these zoom levels produces
 * output that has no underlying feature precision to back it up. Renderers
 * (Freeboard-SK, MapLibre, OpenLayers) handle higher zooms by overzooming
 * the captured top-zoom tile, which is correct for chart data.
 */
export const BAND_MAX_ZOOM: Record<number, number> = {
  1: 8, // Overview  ~1:3,500,000
  2: 10, // General   ~1:700,000
  3: 12, // Coastal   ~1:90,000
  4: 14, // Approach  ~1:22,000
  5: 16, // Harbour   ~1:8,000
  6: 18 // Berthing  ~1:3,000   (rare — only major commercial ports)
};

/**
 * Sensible tippecanoe minzoom for each IHO band: each band's ceiling minus 4.
 * Band-3 features start emitting at z8 (~150 km tile), band-5 at z12 (~10 km
 * tile), band-6 at z14. Below these zooms the features overplot into
 * illegible blobs anyway, so emitting tiles there only wastes bytes and CPU
 * without adding navigational value.
 */
export const BAND_MIN_ZOOM: Record<number, number> = {
  1: 4, // Overview  ceiling z8
  2: 6, // General   ceiling z10
  3: 8, // Coastal   ceiling z12
  4: 10, // Approach ceiling z14
  5: 12, // Harbour  ceiling z16
  6: 14 // Berthing  ceiling z18
};

/**
 * Pull the chart-ID portion out of a per-chart-per-layer filename like
 * 'HRBFAC_US5MA1SK.geojson'. The consolidator (s57-converter.ts) writes
 * these as `<LAYER>_<CHART>.geojson` for multi-chart bundles, where LAYER
 * is uppercase letters/underscores with no digits and CHART always has
 * digits (NOAA chart IDs follow the IHO Annex E filename convention).
 *
 * For files already named '<CHART>.geojson' (single-chart bundles or raw
 * .000 inputs), returns the basename minus extension unchanged.
 */
function extractChartId(filename: string): string {
  const base = path.basename(filename).replace(/\.[^.]+$/, '');
  const underscore = base.lastIndexOf('_');
  if (underscore === -1) {
    return base;
  }
  const tail = base.slice(underscore + 1);
  return /\d/.test(tail) ? tail : base;
}

/**
 * Band of the highest-resolution chart that contributed to a consolidated
 * S-57 layer. After consolidation, each merged file is the union of features
 * from one or more source charts; the layer's *effective* band is the
 * highest among its sources, because that's the smallest scale at which any
 * of those features were captured. Returns `null` for IENC / non-conforming
 * filenames.
 *
 * Accepts both raw chart names (e.g. 'US5MA1SK.000') and per-layer-per-chart
 * filenames produced by the GDAL export step (e.g. 'HRBFAC_US5MA1SK.geojson').
 */
export function highestBandForFiles(filenames: readonly string[]): number | null {
  let highest: number | null = null;
  for (const f of filenames) {
    const b = detectEncBand(extractChartId(f));
    if (b !== null && (highest === null || b > highest)) {
      highest = b;
    }
  }
  return highest;
}

/**
 * Resolve the effective tippecanoe maxzoom for a bundle of ENC files.
 * Highest band in the bundle wins; user-requested maxzoom is the ceiling
 * (we never raise it past what the user asked for).
 *
 * Always returns an object:
 *   - `effective`: the maxzoom the caller should pass to tippecanoe.
 *   - `highestBand`: the highest band detected, or `null` when no file in
 *     the bundle conforms to IHO Annex E (IENC, hand-named, custom
 *     producers). Caller can use this to log a fallback path.
 *   - `bands`: unique sorted list of bands detected across the bundle,
 *     for diagnostics. Empty when nothing matches.
 *
 * On `highestBand === null`, `effective` equals `userRequestedMaxzoom`
 * unchanged — i.e. behaviour matches the pre-band-clamp pipeline.
 */
export function bandClampedMaxzoom(
  encFiles: readonly string[],
  userRequestedMaxzoom: number
): { effective: number; highestBand: number | null; bands: number[] } {
  const bands = [
    ...new Set(
      encFiles.map((f) => detectEncBand(path.basename(f))).filter((b): b is number => b !== null)
    )
  ].sort((a, b) => a - b);

  if (bands.length === 0) {
    return { effective: userRequestedMaxzoom, highestBand: null, bands: [] };
  }

  const highestBand = bands[bands.length - 1];
  const bandCeiling = BAND_MAX_ZOOM[highestBand];
  const effective =
    bandCeiling !== undefined ? Math.min(userRequestedMaxzoom, bandCeiling) : userRequestedMaxzoom;
  return { effective, highestBand, bands };
}
