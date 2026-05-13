import path from 'path';

/**
 * IHO S-57 ENC usage band parsed from the chart's base filename, per the
 * IHO Annex E filename convention `<CC><band><area>` followed by all
 * official national hydrographic offices (NOAA, UKHO, BSH, CHS, AHO, …).
 *
 * Returns 1..6 for maritime ENC bands (Overview..Berthing) and 7..9 for
 * IENC inland-extension bands (River, River Harbour, River Berth) per
 * the IEHG Inland ENC Encoding Guide. Returns `null` when the filename
 * doesn't match the convention — hand-named test files, custom producers
 * — so callers can fall back to the user-requested zoom range.
 *
 * The producer code is two characters of `[A-Z0-9]`. NHOs use letters
 * (`US`, `GB`, `DE`); IENC producers occasionally lead with a digit
 * (RWS Dutch IENC `1V`), which is why this isn't restricted to letters.
 */
export function detectEncBand(filename: string): number | null {
  const base = filename.replace(/\.[^.]+$/, '');
  // Producer code must be 2 alphanumeric chars *with at least one letter*
  // among them. Letter-only (`US`, `DE`) is the maritime case; mixed
  // letter+digit / digit+letter covers IENC producers like RWS `1V`.
  // Pure-digit prefixes (`12`, `00`) are excluded so a degenerate string
  // like `001` (which can fall out of the per-chart `extractChartId`
  // lookup on weird-named files) doesn't get parsed as a band.
  const m = base.match(/^(?:[A-Z][A-Z0-9]|[A-Z0-9][A-Z])(\d)/);
  if (!m) {
    return null;
  }
  const band = parseInt(m[1], 10);
  return band >= 1 && band <= 9 ? band : null;
}

/**
 * Sensible tippecanoe maxzoom for each IHO/IENC band. Mirrors the
 * documented native chart scales: emitting tiles past these zoom levels
 * produces output that has no underlying feature precision to back it
 * up. Renderers (Freeboard-SK, MapLibre, OpenLayers) handle higher
 * zooms by overzooming the captured top-zoom tile, which is correct
 * for chart data.
 *
 * Bands 7..9 are IENC inland extensions (River / River Harbour / River
 * Berth) — narrower native scales than maritime bands.
 */
export const BAND_MAX_ZOOM: Record<number, number> = {
  1: 8, // Overview      ~1:3,500,000
  2: 10, // General       ~1:700,000
  3: 12, // Coastal       ~1:90,000
  4: 14, // Approach      ~1:22,000
  5: 16, // Harbour       ~1:8,000
  6: 18, // Berthing      ~1:3,000
  7: 14, // River         ~1:10,000
  8: 16, // River Harbour ~1:5,000–10,000
  9: 18 // River Berth   ~1:5,000
};

/**
 * Sensible tippecanoe minzoom for each band. For maritime bands 1..6
 * each floor is the ceiling minus 4 — below that, features overplot
 * into illegible blobs and emitting tiles only wastes bytes and CPU.
 *
 * IENC bands 7..9 use a lower floor than the IEHG plan suggests
 * (z9 / z13 / z15 instead of z11 / z13 / z15) because RWS publishes
 * the Waddenzee — tidal coastal water with genuine z9 visibility
 * needs — as IENC band 7. A higher floor would make the chart blank
 * out at coastal-overview zooms, which matters more than the modest
 * overplotting cost on actual rivers at z9–z10.
 */
export const BAND_MIN_ZOOM: Record<number, number> = {
  1: 4, // Overview       ceiling z8
  2: 6, // General        ceiling z10
  3: 8, // Coastal        ceiling z12
  4: 10, // Approach      ceiling z14
  5: 12, // Harbour       ceiling z16
  6: 14, // Berthing      ceiling z18
  7: 9, // River          ceiling z14
  8: 13, // River Harbour ceiling z16
  9: 15 // River Berth    ceiling z18
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

/**
 * A bundle of ENC cells partitioned by IHO band, ready for the per-band
 * tippecanoe pipeline. The `unbanded` bucket holds any cell whose
 * filename doesn't match the IHO Annex E convention — IENC inland cells,
 * hand-named test files, custom producers. The single-pass code path is
 * still available for that bucket so a non-conforming bundle isn't
 * regressed by the per-band rewrite.
 */
export interface BandGrouping {
  /** Map from band number (1..9, with 7..9 being IENC inland) to the list of cell paths in that band. */
  byBand: Map<number, string[]>;
  /** Cells whose filename didn't yield a band — feed these to the legacy single-pass code path. */
  unbanded: string[];
  /** Sorted list of bands actually present (excludes unbanded). */
  bands: number[];
}

/**
 * Partition ENC cell paths into per-band buckets. Cells whose filename
 * doesn't match the IHO Annex E convention land in `unbanded` — the
 * caller should run those through the existing single-pass tippecanoe
 * pipeline (which respects the user-requested -Z/-z directly) so we
 * don't regress IENC/hand-named bundles.
 */
export function groupCellsByBand(encFiles: readonly string[]): BandGrouping {
  const byBand = new Map<number, string[]>();
  const unbanded: string[] = [];
  for (const file of encFiles) {
    const band = detectEncBand(path.basename(file));
    if (band === null) {
      unbanded.push(file);
    } else {
      const list = byBand.get(band) ?? [];
      list.push(file);
      byBand.set(band, list);
    }
  }
  const bands = [...byBand.keys()].sort((a, b) => a - b);
  return { byBand, unbanded, bands };
}
