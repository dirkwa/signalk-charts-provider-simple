/**
 * NOAA ENC coverage footprints.
 *
 * Source: NOAA's official chart-locator footprint GeoJSON
 *   https://www.charts.noaa.gov/InteractiveCatalog/data/enc.geojson
 *
 * The file is large (tens of MB) and uses EPSG:3857 (Web Mercator metre)
 * coordinates. This module fetches it, caches it on disk under the plugin
 * data dir, and turns it into a compact in-memory index:
 *
 *  - the slim band-4 list the Custom Catalogs map renders as selectable
 *    bounding-box areas, and
 *  - the full band-3/4/5 footprint set used to compute which ENCs a custom
 *    catalog includes (every band-3/4/5 cell whose bbox overlaps a selected
 *    band-4 cell's bbox).
 *
 * The geometry / parsing / inclusion helpers are pure and exported so they
 * can be unit-tested without any network access (the boat-dev constraint).
 */

import fs from 'fs';
import https from 'https';
import path from 'path';
import type { DebugFunction } from '../types.js';

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

export interface FootprintIndex {
  /** epoch ms the underlying GeoJSON was fetched (or read from cache). */
  fetchedAt: number;
  /** Whether `fetchedAt` reflects a fresh network fetch or a stale disk read. */
  stale: boolean;
  /** Footprints for bands 3, 4 and 5 (others dropped). */
  all: EncFootprint[];
  byChartId: Map<string, EncFootprint>;
}

/** Slim entry sent to the browser for the selectable map. */
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
 * 4 and 5 features are retained (the bands a custom catalog bundles); features
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

/** Slim band-4 list for the selectable map, sorted by chart id. */
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
 * Compute the full ENC set for a custom catalog from its selected band-4
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

// ---- Fetch + disk cache ----

const CACHE_DIR_NAME = 'noaa-enc-cache';
const CACHE_FILE_NAME = 'enc.geojson';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const MAX_FETCH_BYTES = 256 * 1024 * 1024; // hard ceiling so a bad upstream can't OOM us
const FETCH_TIMEOUT_MS = 60000; // bail if NOAA stalls (connection up, no data)

let dataDir = '';
let debug: DebugFunction = () => {};
let cachedIndex: FootprintIndex | null = null;
let inFlight: Promise<FootprintIndex> | null = null;

export function initNoaaEncFootprints(dir: string, debugFn: DebugFunction): void {
  dataDir = dir;
  debug = debugFn || (() => {});
}

function cacheFilePath(): string {
  return path.join(dataDir, CACHE_DIR_NAME, CACHE_FILE_NAME);
}

function buildIndex(geojson: unknown, fetchedAt: number, stale: boolean): FootprintIndex {
  const all = parseFootprints(geojson);
  const byChartId = new Map<string, EncFootprint>();
  for (const f of all) {
    if (!byChartId.has(f.chartId)) {
      byChartId.set(f.chartId, f);
    }
  }
  return { fetchedAt, stale, all, byChartId };
}

function fetchText(url: string, redirectsLeft = 5): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const req = https
      .get(url, { timeout: FETCH_TIMEOUT_MS }, (response) => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400 && response.headers.location) {
          response.resume();
          if (redirectsLeft <= 0) {
            reject(new Error('Too many redirects fetching NOAA enc.geojson'));
            return;
          }
          // Resolve against the current URL so a relative Location (RFC 7231
          // allows it) follows correctly instead of failing as a bare path.
          const next = new URL(response.headers.location, url).toString();
          fetchText(next, redirectsLeft - 1)
            .then(resolve)
            .catch(reject);
          return;
        }
        if (status !== 200) {
          response.resume();
          reject(new Error(`NOAA enc.geojson returned HTTP ${status}`));
          return;
        }
        let bytes = 0;
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > MAX_FETCH_BYTES) {
            response.destroy();
            reject(new Error('NOAA enc.geojson exceeded the maximum allowed size'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        response.on('error', reject);
      })
      .on('error', reject);
    // 'timeout' fires on inactivity but doesn't abort by itself; destroy with
    // an error so the .on('error') handler rejects.
    req.on('timeout', () => req.destroy(new Error('NOAA enc.geojson request timed out')));
  });
}

function persistCache(raw: string): void {
  try {
    const file = cacheFilePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, raw);
  } catch (err) {
    debug(`Failed to cache NOAA enc.geojson: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function readCache(): { index: FootprintIndex; mtimeMs: number } | null {
  try {
    const file = cacheFilePath();
    const stat = fs.statSync(file);
    const raw = fs.readFileSync(file, 'utf8');
    const json: unknown = JSON.parse(raw);
    return { index: buildIndex(json, stat.mtimeMs, true), mtimeMs: stat.mtimeMs };
  } catch {
    return null;
  }
}

/**
 * Return the footprint index, fetching from NOAA when the in-memory copy is
 * absent/stale (or `forceRefresh` is set). Falls back to the on-disk cache
 * (even if stale) when the network is unreachable, so the feature keeps
 * working offline once the catalog has been fetched at least once.
 */
export async function getFootprintIndex(
  opts: { forceRefresh?: boolean } = {}
): Promise<FootprintIndex> {
  const fresh =
    cachedIndex !== null && !cachedIndex.stale && Date.now() - cachedIndex.fetchedAt < CACHE_TTL_MS;
  if (fresh && !opts.forceRefresh) {
    return cachedIndex as FootprintIndex;
  }

  // Coalesce concurrent callers (two browser tabs opening the page) onto one
  // network fetch.
  if (inFlight && !opts.forceRefresh) {
    return inFlight;
  }

  const doFetch = async (): Promise<FootprintIndex> => {
    try {
      debug('Fetching NOAA enc.geojson…');
      const raw = await fetchText(NOAA_ENC_GEOJSON_URL);
      const json: unknown = JSON.parse(raw);
      const index = buildIndex(json, Date.now(), false);
      persistCache(raw);
      cachedIndex = index;
      debug(`NOAA enc.geojson parsed: ${index.all.length} band-3/4/5 footprints`);
      return index;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      debug(`NOAA enc.geojson fetch failed (${msg}); trying disk cache…`);
      const cached = readCache();
      if (cached) {
        cachedIndex = cached.index;
        return cached.index;
      }
      throw new Error(
        `Could not fetch NOAA ENC footprints and no cached copy is available: ${msg}`
      );
    } finally {
      inFlight = null;
    }
  };

  inFlight = doFetch();
  return inFlight;
}

/**
 * Return the in-memory footprint index without ever hitting the network.
 * Used by endpoints (catalog list / status) that want to report freshness
 * cheaply but must not trigger a multi-MB download as a side effect — the map
 * endpoint is the one place that fetches.
 */
export function peekFootprintIndex(): FootprintIndex | null {
  return cachedIndex;
}
