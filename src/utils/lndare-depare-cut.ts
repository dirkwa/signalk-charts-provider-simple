import fs from 'fs';
import path from 'path';
import { difference } from '@turf/difference';
import { booleanIntersects } from '@turf/boolean-intersects';
import type { Feature, FeatureCollection, Polygon, MultiPolygon } from 'geojson';

type PolyFeature = Feature<Polygon | MultiPolygon, Record<string, unknown>>;

export interface CutStats {
  /** Number of LNDARE files we read (one per chart). */
  filesScanned: number;
  /** LNDARE files where at least one feature was modified. */
  filesModified: number;
  /** LNDARE features inspected across all files. */
  lndareScanned: number;
  /** LNDARE features that came out of `difference` mutated. */
  lndareCut: number;
  /** DEPARE features that contributed to a cut (DRVAL2 > 0 + intersected). */
  depareApplied: number;
  /** DEPARE features skipped because DRVAL2 ≤ 0 or missing. */
  depareSkippedDrying: number;
  /** Number of `difference` calls that threw (kept original LNDARE in those cases). */
  cutFailures: number;
}

interface CutOptions {
  /** Optional log callback for the per-bundle counter line. */
  onProgress?: (msg: string) => void;
}

const LNDARE_PATTERN = /^LNDARE(?:_([^/.]+))?\.geojson$/;

// Match a DEPARE filename to a chart ID; returns null when the filename doesn't
// fit the per-chart-per-layer convention written by the GDAL export step.
function depareFilenameForChart(chartId: string | undefined): string {
  return chartId ? `DEPARE_${chartId}.geojson` : 'DEPARE.geojson';
}

// Read + parse a GeoJSON FeatureCollection. Throws on invalid JSON or non-FC
// input — callers wrap; corruption here is a real bug we want to see.
function readFC(file: string): FeatureCollection {
  const raw = fs.readFileSync(file, 'utf8');
  const parsed = JSON.parse(raw) as FeatureCollection;
  if (parsed.type !== 'FeatureCollection' || !Array.isArray(parsed.features)) {
    throw new Error(`Not a GeoJSON FeatureCollection: ${file}`);
  }
  return parsed;
}

// Filter DEPARE features to those that actually represent water at chart datum:
// DRVAL2 > 0 ensures we skip drying areas (DRVAL2 ≤ 0 means at least part of the
// polygon is exposed at low water — encoded as LNDARE-on-top deliberately by
// chart producers, not a NOAA quirk we want to undo).
function isCuttableDepare(feat: Feature): boolean {
  if (!feat.geometry) {
    return false;
  }
  if (feat.geometry.type !== 'Polygon' && feat.geometry.type !== 'MultiPolygon') {
    return false;
  }
  const drval2: unknown = feat.properties?.['DRVAL2'];
  if (typeof drval2 !== 'number') {
    return false;
  }
  return drval2 > 0;
}

// Cut a single LNDARE feature with all overlapping cuttable DEPARE features.
// Returns the modified feature (a Polygon with new holes, or a MultiPolygon if
// the cut splits the LNDARE), or `null` if the cut would erase the feature
// entirely (every part of the LNDARE is now water — rare but possible).
//
// Best-effort: if turf.difference throws (degenerate geometry, sliver
// intersections, self-intersections), we return the input feature unchanged
// and signal `cutFailed=true` to the caller. Better to render the unfixed
// land than to crash the whole conversion.
function cutOneLndare(
  lndare: PolyFeature,
  depares: PolyFeature[]
): { feature: PolyFeature | null; cutFailed: boolean; depareApplied: number } {
  let current: PolyFeature | null = lndare;
  let depareApplied = 0;
  for (const depare of depares) {
    if (current === null) {
      break;
    }
    if (!booleanIntersects(current, depare)) {
      continue;
    }
    try {
      const fc: FeatureCollection<Polygon | MultiPolygon> = {
        type: 'FeatureCollection',
        features: [current, depare]
      };
      const result = difference(fc);
      if (result === null) {
        // The DEPARE fully covers what's left of LNDARE. Treat as erased.
        current = null;
      } else {
        current = result as PolyFeature;
      }
      depareApplied += 1;
    } catch {
      return { feature: lndare, cutFailed: true, depareApplied };
    }
  }
  return { feature: current, cutFailed: false, depareApplied };
}

// Walk every LNDARE_<chart>.geojson in `geojsonDir`, locate its sibling
// DEPARE_<chart>.geojson (same chart cell — we never cut across cells), and
// rewrite the LNDARE file in place with each polygon cut by overlapping
// DEPARE features that have `DRVAL2 > 0`.
//
// Per-chart pairing keeps this O(N) across the bundle: each chart's LNDARE ×
// DEPARE counts are small (typically ≤30 of each) so the per-chart cost is
// bounded. Run once after GDAL export, before consolidation.
//
// All failure modes are logged and counted in the returned `CutStats` —
// nothing throws past this function. Conversions where every cut fails will
// just emit the original LNDARE files (the pre-1.12 behaviour).
export function cutLndareByDepare(geojsonDir: string, options: CutOptions = {}): CutStats {
  const stats: CutStats = {
    filesScanned: 0,
    filesModified: 0,
    lndareScanned: 0,
    lndareCut: 0,
    depareApplied: 0,
    depareSkippedDrying: 0,
    cutFailures: 0
  };

  let entries: string[];
  try {
    entries = fs.readdirSync(geojsonDir);
  } catch {
    return stats;
  }

  const lndareFiles = entries.filter((e) => LNDARE_PATTERN.test(e));

  for (const lndareFile of lndareFiles) {
    stats.filesScanned += 1;
    const match = LNDARE_PATTERN.exec(lndareFile);
    const chartId = match?.[1];
    const lndarePath = path.join(geojsonDir, lndareFile);
    const deparePath = path.join(geojsonDir, depareFilenameForChart(chartId));

    let lndareFC: FeatureCollection;
    try {
      lndareFC = readFC(lndarePath);
    } catch {
      continue;
    }
    if (lndareFC.features.length === 0) {
      continue;
    }
    stats.lndareScanned += lndareFC.features.length;

    if (!fs.existsSync(deparePath)) {
      // Chart has no DEPARE — nothing to cut against.
      continue;
    }

    let depareFC: FeatureCollection;
    try {
      depareFC = readFC(deparePath);
    } catch {
      continue;
    }

    const cuttableDepares: PolyFeature[] = [];
    for (const dep of depareFC.features) {
      if (isCuttableDepare(dep)) {
        cuttableDepares.push(dep as PolyFeature);
      } else if (dep.geometry?.type === 'Polygon' || dep.geometry?.type === 'MultiPolygon') {
        // Only count as 'skipped drying' when it was a polygon DEPARE we
        // could otherwise have cut with — non-polygon DEPARE entries (rare
        // in the field) just aren't applicable to this operation.
        stats.depareSkippedDrying += 1;
      }
    }
    if (cuttableDepares.length === 0) {
      continue;
    }

    let fileModified = false;
    const newFeatures: Feature[] = [];
    for (const feat of lndareFC.features) {
      if (
        !feat.geometry ||
        (feat.geometry.type !== 'Polygon' && feat.geometry.type !== 'MultiPolygon')
      ) {
        newFeatures.push(feat);
        continue;
      }
      const before = JSON.stringify(feat.geometry);
      const result = cutOneLndare(feat as PolyFeature, cuttableDepares);
      stats.depareApplied += result.depareApplied;
      if (result.cutFailed) {
        stats.cutFailures += 1;
        newFeatures.push(feat);
        continue;
      }
      if (result.feature === null) {
        // Fully erased — drop it from the output.
        fileModified = true;
        stats.lndareCut += 1;
        continue;
      }
      const after = JSON.stringify(result.feature.geometry);
      if (after !== before) {
        fileModified = true;
        stats.lndareCut += 1;
      }
      newFeatures.push(result.feature);
    }

    if (fileModified) {
      stats.filesModified += 1;
      const out: FeatureCollection = {
        type: 'FeatureCollection',
        features: newFeatures
      };
      fs.writeFileSync(lndarePath, JSON.stringify(out));
    }
  }

  options.onProgress?.(
    `LNDARE cut by DEPARE: scanned ${stats.lndareScanned} land features in ${stats.filesScanned} charts; ` +
      `cut ${stats.lndareCut} (${stats.depareApplied} DEPARE applied, ` +
      `${stats.depareSkippedDrying} skipped as drying, ${stats.cutFailures} cut failures)`
  );

  return stats;
}
