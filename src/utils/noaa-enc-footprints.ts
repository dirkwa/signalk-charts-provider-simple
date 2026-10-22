/**
 * NOAA ENC coverage footprints.
 *
 * Source: NOAA's official chart-locator footprint GeoJSON
 *   https://www.charts.noaa.gov/InteractiveCatalog/data/enc.geojson
 *
 * The file is large (tens of MB) and uses EPSG:3857 (Web Mercator metre)
 * coordinates. The ENC index build (`src/catalog/enc-index-cli.ts`) reads it
 * and turns it into the index's NOAA units; the plugin itself never fetches
 * it, and reads those units from the index instead. This module holds the
 * pure parsing and inclusion math the build uses:
 *
 *  - the band-4 list, NOAA's selectable bounding-box areas, and
 *  - the band-3/4/5 bbox-overlap inclusion rule (every band-3/4/5 cell whose
 *    bbox overlaps a selected band-4 cell's bbox), which gives each NOAA
 *    unit its cells.
 */

export const NOAA_ENC_GEOJSON_URL =
  'https://www.charts.noaa.gov/InteractiveCatalog/data/enc.geojson';

const NOAA_ENC_ZIP_BASE = 'https://charts.noaa.gov/ENCs';

/** NOAA ENC ZIP download URL for a chart id, e.g. `US4FL1EP` → …/US4FL1EP.zip */
export function noaaEncZipUrl(chartId: string): string {
  return `${NOAA_ENC_ZIP_BASE}/${encodeURIComponent(chartId)}.zip`;
}

/** Axis-aligned bounding box in EPSG:4326 (degrees). */
export interface BBox {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
}

export interface EncFootprint {
  /** First 8 chars of `enc_ed_up`, e.g. `US4FL1EP`. The chart id. */
  chartId: string;
  /** Full `enc_ed_up` token, e.g. `US4FL1EP_ED003_UP012`. The version. */
  encEdUp: string;
  /** NOAA `scale_band` (1–6); only 3/4/5 are retained by this module. */
  scaleBand: number;
  /** NOAA `scale` denominator, when present. */
  scale: number | null;
  title: string;
  published: string | null;
  /** Footprint bounding box, reprojected to EPSG:4326. */
  bbox: BBox;
}

/** One band-4 area, as the build turns it into a NOAA unit. */
export interface Band4MapEntry {
  chartId: string;
  encEdUp: string;
  title: string;
  scale: number | null;
  bbox: BBox;
}

// ---- Reprojection (EPSG:3857 metres → EPSG:4326 degrees) ----

const WEBMERC_R = 6378137;

function mercToLon(x: number): number {
  return (x / WEBMERC_R) * (180 / Math.PI);
}

function mercToLat(y: number): number {
  return (2 * Math.atan(Math.exp(y / WEBMERC_R)) - Math.PI / 2) * (180 / Math.PI);
}

/**
 * Reproject a single coordinate pair to EPSG:4326. NOAA publishes the file in
 * EPSG:3857 (metres), but we guard defensively: a pair already in lon/lat
 * range is passed through unchanged, so the parser still works if NOAA ever
 * switches the file to 4326.
 *
 * Caveat: this lon/lat-range heuristic also matches genuine EPSG:3857 metres
 * very close to the origin (|x| ≤ 360 m, |y| ≤ 90 m — a ~360 m patch off the
 * Gulf of Guinea). That would be mis-passed-through, but NOAA US-waters
 * footprints are nowhere near (0,0), so it can't occur with this data set.
 */
export function projectCoord(x: number, y: number): [number, number] {
  if (Math.abs(x) <= 360 && Math.abs(y) <= 90) {
    return [x, y];
  }
  return [mercToLon(x), mercToLat(y)];
}

/**
 * Compute the EPSG:4326 bounding box of an arbitrarily-nested GeoJSON
 * coordinate array (Polygon, MultiPolygon, …). Returns null when no numeric
 * coordinate pairs are found.
 */
export function bboxFromCoordinates(coordinates: unknown): BBox | null {
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;

  const walk = (node: unknown): void => {
    if (!Array.isArray(node)) {
      return;
    }
    // A coordinate pair is [number, number, ...]; anything else is a nested
    // ring / polygon list we keep descending into.
    if (typeof node[0] === 'number' && typeof node[1] === 'number') {
      const [lon, lat] = projectCoord(node[0], node[1]);
      if (lon < minLon) {
        minLon = lon;
      }
      if (lat < minLat) {
        minLat = lat;
      }
      if (lon > maxLon) {
        maxLon = lon;
      }
      if (lat > maxLat) {
        maxLat = lat;
      }
      return;
    }
    for (const child of node) {
      walk(child);
    }
  };

  walk(coordinates);

  if (!Number.isFinite(minLon) || !Number.isFinite(minLat)) {
    return null;
  }
  return { minLon, minLat, maxLon, maxLat };
}

/** True when two EPSG:4326 bounding boxes overlap (touching edges count). */
export function bboxesOverlap(a: BBox, b: BBox): boolean {
  return (
    a.minLon <= b.maxLon && a.maxLon >= b.minLon && a.minLat <= b.maxLat && a.maxLat >= b.minLat
  );
}

interface RawFeature {
  properties?: Record<string, unknown> | null;
  geometry?: { coordinates?: unknown } | null;
}

function toNumberOrNull(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) {
    return v;
  }
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Parse the NOAA enc.geojson FeatureCollection into footprints. Only band 3,
 * 4 and 5 features are retained (the bands a chart set bundles); features
 * lacking a usable `enc_ed_up`, band, or geometry are skipped.
 */
export function parseFootprints(geojson: unknown): EncFootprint[] {
  const features =
    geojson &&
    typeof geojson === 'object' &&
    Array.isArray((geojson as { features?: unknown }).features)
      ? ((geojson as { features: unknown[] }).features as RawFeature[])
      : [];

  const out: EncFootprint[] = [];
  for (const feature of features) {
    const props = feature.properties;
    if (!props) {
      continue;
    }
    const encEdUp = typeof props.enc_ed_up === 'string' ? props.enc_ed_up : '';
    if (encEdUp.length < 8) {
      continue;
    }
    const scaleBand = toNumberOrNull(props.scale_band);
    if (scaleBand === null || scaleBand < 3 || scaleBand > 5) {
      continue;
    }
    const coords = feature.geometry?.coordinates;
    const bbox = coords !== undefined ? bboxFromCoordinates(coords) : null;
    if (!bbox) {
      continue;
    }
    out.push({
      chartId: encEdUp.substring(0, 8),
      encEdUp,
      scaleBand,
      scale: toNumberOrNull(props.scale),
      title: typeof props.title === 'string' ? props.title : encEdUp.substring(0, 8),
      published: typeof props.published === 'string' ? props.published : null,
      bbox
    });
  }
  return out;
}

/** The band-4 areas, sorted by chart id. */
export function band4MapEntries(all: readonly EncFootprint[]): Band4MapEntry[] {
  return all
    .filter((f) => f.scaleBand === 4)
    .map((f) => ({
      chartId: f.chartId,
      encEdUp: f.encEdUp,
      title: f.title,
      scale: f.scale,
      bbox: f.bbox
    }))
    .sort((a, b) => a.chartId.localeCompare(b.chartId));
}

export interface InclusionResult {
  includedChartIds: string[];
  /** chartId → its current `enc_ed_up`, for every included chart. */
  chartVersions: Record<string, string>;
  /** Selected band-4 ids that no longer exist in the current footprint set. */
  missingSelected: string[];
}

/**
 * Compute the full ENC set for a NOAA selection from its selected band-4
 * chart ids: every band-3/4/5 footprint whose bbox overlaps any selected
 * band-4 footprint's bbox (any overlap qualifies), de-duplicated by chart id.
 */
export function computeInclusion(
  all: readonly EncFootprint[],
  selectedBand4ChartIds: readonly string[]
): InclusionResult {
  const byChartId = new Map<string, EncFootprint>();
  for (const f of all) {
    // Prefer the band-4 record when a chart id somehow appears twice; in
    // practice chart ids are unique per band.
    if (!byChartId.has(f.chartId)) {
      byChartId.set(f.chartId, f);
    }
  }

  const selectedBoxes: BBox[] = [];
  const missingSelected: string[] = [];
  for (const id of selectedBand4ChartIds) {
    const f = byChartId.get(id);
    if (f && f.scaleBand === 4) {
      selectedBoxes.push(f.bbox);
    } else {
      missingSelected.push(id);
    }
  }

  const includedChartIds: string[] = [];
  const chartVersions: Record<string, string> = {};
  for (const f of all) {
    if (chartVersions[f.chartId] !== undefined) {
      continue; // already included
    }
    if (selectedBoxes.some((box) => bboxesOverlap(box, f.bbox))) {
      includedChartIds.push(f.chartId);
      chartVersions[f.chartId] = f.encEdUp;
    }
  }
  includedChartIds.sort((a, b) => a.localeCompare(b));

  return { includedChartIds, chartVersions, missingSelected };
}

/**
 * For each selected band-4 box, the chart ids that count toward that box's
 * download-fill: the band-4 chart itself plus every band-5 chart whose bbox
 * overlaps it. Band 5 (harbour scale) nests inside a band-4 (approach) box,
 * so a box fills as its harbour cells arrive — N band-5 cells → ~1/N per
 * download. Band 3 (coastal) is deliberately excluded: it spans many band-4
 * boxes, so it doesn't belong to any single box's fill.
 *
 * A band-5 cell that straddles two band-4 boxes counts toward both (rare).
 * A selected id that isn't a current band-4 footprint maps to an empty list.
 */
export function coverageByBox(
  all: readonly EncFootprint[],
  band4ChartIds: readonly string[]
): Record<string, string[]> {
  const byChartId = new Map<string, EncFootprint>();
  for (const f of all) {
    if (!byChartId.has(f.chartId)) {
      byChartId.set(f.chartId, f);
    }
  }
  const band5 = all.filter((f) => f.scaleBand === 5);

  const result: Record<string, string[]> = {};
  for (const id of band4ChartIds) {
    const box = byChartId.get(id);
    if (!box || box.scaleBand !== 4) {
      result[id] = [];
      continue;
    }
    const ids = new Set<string>([id]);
    for (const f of band5) {
      if (bboxesOverlap(box.bbox, f.bbox)) {
        ids.add(f.chartId);
      }
    }
    result[id] = [...ids].sort((a, b) => a.localeCompare(b));
  }
  return result;
}
