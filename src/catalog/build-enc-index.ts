/**
 * Pure assembly of the ENC index (see `enc-index-schema.ts` for what it
 * holds). Downloads, archive extraction and GDAL live in `enc-index-cli.ts`;
 * everything here is deterministic, so the same inputs give the same file
 * and the same content hash on a maintainer's machine and in CI.
 *
 * The published index doubles as the build's state. An archive whose
 * version is unchanged is reused from it, and one that fails to download
 * or parse keeps its published units, as the merged catalog does with a
 * broken chartcatalogs file.
 */

import { createHash } from 'node:crypto';
import { Value } from 'typebox/value';
import {
  band4MapEntries,
  computeInclusion,
  coverageByBox,
  noaaEncZipUrl,
  type EncFootprint
} from '../utils/noaa-enc-footprints.js';
import { canonicalJson } from './build-merged-catalog.js';
import type { ParsedChartcatalogsXml } from './chartcatalogs-xml.js';
import {
  ENC_INDEX_SCHEMA_VERSION,
  EncIndexArchiveSchema,
  EncIndexSchema,
  EncIndexUnitSchema,
  NOAA_SOURCE_ID,
  type EncIndex,
  type EncIndexArchive,
  type EncIndexSource,
  type EncIndexUnit,
  type EncOutline
} from './enc-index-schema.js';
import { schemaErrors, type ChartcatalogsIndex } from './merged-catalog-schema.js';
import {
  bboxRing,
  outlineFromCoverage,
  roundCoord,
  type Bbox,
  type Position
} from './enc-outline.js';

export const NOAA_SOURCE_LABEL = 'NOAA ENC (United States)';

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** One chartcatalogs download: an archive (or bare cell) and the version it is listed at. */
export interface ArchiveJob {
  source: string;
  url: string;
  version: string;
  /** The catalog entry's title, used to name the units inside. */
  title: string;
}

export function jobKey(job: { source: string; url: string }): string {
  return `${job.source} ${job.url}`;
}

/** The ENC sources: NOAA plus every chartcatalogs file whose facets say `enc`. */
export function encSources(index: ChartcatalogsIndex): EncIndexSource[] {
  const chartcatalogs = Object.entries(index)
    .filter(([, facets]) => facets.format === 'enc')
    .map(([file, facets]): EncIndexSource => ({
      id: file.replace(/\.xml$/i, ''),
      label: facets.label,
      kind: 'chartcatalogs',
      file
    }));
  const noaa: EncIndexSource = { id: NOAA_SOURCE_ID, label: NOAA_SOURCE_LABEL, kind: 'noaa' };
  return [noaa, ...chartcatalogs].sort((a, b) => compareStrings(a.id, b.id));
}

/**
 * The archives the chartcatalogs ENC sources list today. A URL listed twice
 * in one source is one download, at the newest version given for it.
 */
export function archiveJobs(
  sources: readonly EncIndexSource[],
  files: readonly { file: string; parsed: ParsedChartcatalogsXml | null }[]
): ArchiveJob[] {
  const byFile = new Map(files.map((f) => [f.file, f.parsed]));
  const jobs = new Map<string, ArchiveJob>();
  for (const source of sources) {
    const parsed = source.file ? byFile.get(source.file) : undefined;
    for (const chart of parsed?.charts ?? []) {
      if (!/^https?:\/\//.test(chart.zipfile_location)) {
        continue;
      }
      const job: ArchiveJob = {
        source: source.id,
        url: chart.zipfile_location,
        version: chart.zipfile_datetime_iso8601,
        title: chart.title || chart.number
      };
      const existing = jobs.get(jobKey(job));
      if (!existing || compareStrings(existing.version, job.version) < 0) {
        jobs.set(jobKey(job), job);
      }
    }
  }
  return [...jobs.values()].sort((a, b) => compareStrings(jobKey(a), jobKey(b)));
}

// ---- Reading GDAL's report on an archive's cells ----

/** Line the GDAL script prints before each cell's features. */
export const CELL_MARKER = '@@CELL ';

export interface CellReport {
  /** Path of the `.000` file inside the archive. */
  path: string;
  /** `DSPM_CSCL`, the compilation scale denominator, when the cell has one. */
  scale: number | null;
  /** Polygons (as GeoJSON rings) of the cell's `M_COVR` coverage objects (CATCOV not 2). */
  coverage: Position[][][];
  /** The union of the cell's layer extents, reported only when it has no `M_COVR` layer. */
  extent?: Bbox;
}

interface ReportFeature {
  properties?: Record<string, unknown> | null;
  geometry?: { type?: unknown; coordinates?: unknown } | null;
}

// ogrinfo's summary line: `Extent: (west, south) - (east, north)`.
const EXTENT_LINE = /^Extent: \(([-\d.]+), ([-\d.]+)\) - \(([-\d.]+), ([-\d.]+)\)/;

/**
 * Parse the GDAL script's output: a `CELL_MARKER` line per cell, followed
 * by that cell's DSID and M_COVR features as GeoJSON text sequences, or by
 * its data extent when it has no M_COVR. Other lines (warnings) are ignored.
 */
export function parseGdalReport(stdout: string): CellReport[] {
  const reports: CellReport[] = [];
  let current: CellReport | null = null;
  for (const line of stdout.split('\n')) {
    if (line.startsWith(CELL_MARKER)) {
      current = { path: line.slice(CELL_MARKER.length).trim(), scale: null, coverage: [] };
      reports.push(current);
      continue;
    }
    if (!current) {
      continue;
    }
    // ogrinfo prints one extent per layer; the cell's is their union.
    const extent = EXTENT_LINE.exec(line);
    if (extent) {
      const [west, south, east, north] = extent.slice(1, 5).map(Number);
      const prev = current.extent;
      current.extent = prev
        ? [
            Math.min(prev[0], west),
            Math.min(prev[1], south),
            Math.max(prev[2], east),
            Math.max(prev[3], north)
          ]
        : [west, south, east, north];
      continue;
    }
    if (!line.startsWith('{')) {
      continue;
    }
    let feature: ReportFeature;
    try {
      feature = JSON.parse(line) as ReportFeature;
    } catch {
      continue;
    }
    const props = feature.properties ?? {};
    if (typeof props.DSPM_CSCL === 'number' && props.DSPM_CSCL > 0) {
      current.scale = Math.round(props.DSPM_CSCL);
    }
    // CATCOV 2 marks an area with no coverage. Some producers leave CATCOV
    // out of their M_COVR objects altogether, which can only mean coverage.
    const noCoverage = props.CATCOV === 2 || props.CATCOV === '2';
    if (noCoverage || !feature.geometry || !Array.isArray(feature.geometry.coordinates)) {
      continue;
    }
    if (feature.geometry.type === 'Polygon') {
      current.coverage.push(feature.geometry.coordinates as Position[][]);
    } else if (feature.geometry.type === 'MultiPolygon') {
      current.coverage.push(...(feature.geometry.coordinates as Position[][][]));
    }
  }
  return reports;
}

/**
 * Revision of the rules in `unitsForArchive` and `enc-outline.ts`. Bump it
 * when a change would give different units for the same archive, so the
 * next build reads every archive again instead of reusing old units.
 */
export const ARCHIVE_REVISION = 1;

export interface ArchiveResult {
  archive: EncIndexArchive;
  units: EncIndexUnit[];
  /** Cells left out, with the reason. */
  problems: string[];
  /**
   * The archive holds only update files (.001, ...) for cells whose base
   * file is in another archive, so it has no units of its own. It is still
   * recorded, so later builds do not download it again.
   */
  updatesOnly: boolean;
}

/** The cell an update file (`EA200001.041`) belongs to. */
/**
 * File name of an S-57 update file: a cell name with a numbered extension
 * other than `.000`. The exchange set's `CATALOG.031` looks the same and
 * is not one.
 */
export const UPDATE_FILE_NAME = /^(?!catalog\.)[^/]+\.(?!000)\d{3}$/i;

function updateCell(updatePath: string): string {
  const base = updatePath.slice(updatePath.lastIndexOf('/') + 1);
  return base.replace(/\.\d{3}$/, '');
}

function cellName(cellPath: string): string {
  const base = cellPath.slice(cellPath.lastIndexOf('/') + 1);
  return base.replace(/\.000$/i, '');
}

/** A box outline for a cell with no coverage objects, from its data extent. */
function extentOutline(extent: Bbox | undefined): { outline: EncOutline; bbox: Bbox } | null {
  if (!extent?.every(Number.isFinite)) {
    return null;
  }
  const bbox = [
    clampLon(extent[0]),
    clampLat(extent[1]),
    clampLon(extent[2]),
    clampLat(extent[3])
  ] as Bbox;
  if (bbox[0] >= bbox[2] || bbox[1] >= bbox[3]) {
    return null;
  }
  return { outline: { type: 'Polygon', coordinates: [bboxRing(bbox)] }, bbox };
}

function unitTitle(entryTitle: string, name: string, cellCount: number): string {
  if (!entryTitle) {
    return name;
  }
  return cellCount === 1 || entryTitle.includes(name) ? entryTitle : `${name} - ${entryTitle}`;
}

/** One unit per cell GDAL reported for an archive. */
export function unitsForArchive(
  job: ArchiveJob,
  kind: EncIndexArchive['kind'],
  reports: readonly CellReport[],
  updateFiles: readonly string[] = []
): ArchiveResult {
  const problems: string[] = [];
  const units = new Map<string, EncIndexUnit>();
  const sorted = [...reports].sort((a, b) => compareStrings(a.path, b.path));
  for (const report of sorted) {
    const name = cellName(report.path);
    if (units.has(name)) {
      problems.push(`${report.path}: cell ${name} appears twice in the archive; kept the first`);
      continue;
    }
    const reduced = outlineFromCoverage(report.coverage) ?? extentOutline(report.extent);
    if (!reduced) {
      problems.push(`${report.path}: no usable M_COVR coverage`);
      continue;
    }
    if (report.coverage.length === 0) {
      problems.push(`${report.path}: no M_COVR coverage; outlined by its data extent`);
    }
    const unit: EncIndexUnit = {
      source: job.source,
      id: name,
      title: unitTitle(job.title, name, sorted.length),
      ...(report.scale !== null && report.scale >= 1 ? { scale: report.scale } : {}),
      bbox: reduced.bbox,
      outline: reduced.outline,
      cells: [{ name, archive: job.url, path: report.path }],
      statusCells: [name]
    };
    // Downloaded data is checked here, cell by cell: one odd cell must cost
    // that cell, not fail the whole index at the final validation.
    if (!Value.Check(EncIndexUnitSchema, unit)) {
      problems.push(`${report.path}: ${schemaErrors(EncIndexUnitSchema, unit).join('; ')}`);
      continue;
    }
    units.set(name, unit);
  }
  // Update files whose base cell is in this archive are applied by GDAL
  // with it. The rest correct cells published elsewhere.
  const baseCells = new Set(reports.map((r) => cellName(r.path)));
  const separate = updateFiles
    .filter((file) => UPDATE_FILE_NAME.test(file.slice(file.lastIndexOf('/') + 1)))
    .filter((file) => !baseCells.has(updateCell(file)))
    .sort(compareStrings);
  return {
    archive: {
      url: job.url,
      source: job.source,
      version: job.version,
      kind,
      ...(separate.length > 0 ? { updates: separate } : {}),
      revision: ARCHIVE_REVISION
    },
    units: [...units.values()],
    problems,
    updatesOnly: reports.length === 0 && separate.length > 0
  };
}

// ---- NOAA ----

export interface NoaaResult {
  archives: EncIndexArchive[];
  units: EncIndexUnit[];
}

function clampLon(lon: number): number {
  return roundCoord(Math.min(180, Math.max(-180, lon)));
}

function clampLat(lat: number): number {
  return roundCoord(Math.min(90, Math.max(-90, lat)));
}

/**
 * NOAA's units from its footprint list: one per band-4 box, listing the
 * band-3/4/5 cells `computeInclusion` gives for that box alone and the
 * status cells `coverageByBox` gives for it. Ids and versions are NOAA's
 * own chart ids and `enc_ed_up` tokens, unchanged, so a NOAA chart set
 * saved today maps onto the index by name: its selected band-4 ids are
 * unit ids, and its stored versions compare equal while nothing changed.
 */
export function noaaUnits(footprints: readonly EncFootprint[]): NoaaResult {
  const versions = new Map<string, string>();
  for (const f of footprints) {
    if (!versions.has(f.chartId)) {
      versions.set(f.chartId, f.encEdUp);
    }
  }
  const archives = [...versions].map(([chartId, version]): EncIndexArchive => ({
    url: noaaEncZipUrl(chartId),
    source: NOAA_SOURCE_ID,
    version,
    kind: 'zip'
  }));

  const band4 = band4MapEntries(footprints);
  const statusCells = coverageByBox(
    footprints,
    band4.map((entry) => entry.chartId)
  );
  const units = band4.map((entry): EncIndexUnit => {
    const bbox: Bbox = [
      clampLon(entry.bbox.minLon),
      clampLat(entry.bbox.minLat),
      clampLon(entry.bbox.maxLon),
      clampLat(entry.bbox.maxLat)
    ];
    const { includedChartIds } = computeInclusion(footprints, [entry.chartId]);
    return {
      source: NOAA_SOURCE_ID,
      id: entry.chartId,
      title: entry.title,
      ...(entry.scale !== null && entry.scale > 0 ? { scale: Math.round(entry.scale) } : {}),
      bbox,
      outline: { type: 'Polygon', coordinates: [bboxRing(bbox)] },
      cells: includedChartIds.map((name) => ({
        name,
        archive: noaaEncZipUrl(name),
        path: `ENC_ROOT/${name}/${name}.000`
      })),
      statusCells: statusCells[entry.chartId]
    };
  });
  return { archives, units };
}

// ---- The published index, read back as state ----

interface PreviousArchive {
  archive: EncIndexArchive;
  units: EncIndexUnit[];
}

export interface PublishedEncIndex {
  contentHash: string | null;
  unitCount: number;
  unitsBySource: Map<string, number>;
  /** chartcatalogs archives that still validate, with their units, by `jobKey`. */
  archives: Map<string, PreviousArchive>;
  /** NOAA's archives and units, or null when the index has none. */
  noaa: NoaaResult | null;
  /** The published `enc-index.schema.json` text, or null if absent. */
  schemaText: string | null;
}

/**
 * Read a published index loosely. It may predate the current schema, so
 * the counts the drop guard uses come from the raw arrays, and archives and
 * units are validated one by one: an archive with any unit that no longer
 * validates is rebuilt rather than carried forward.
 */
export function readPublishedEncIndex(raw: unknown, schemaText: string | null): PublishedEncIndex {
  const obj = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const rawUnits = Array.isArray(obj.units) ? (obj.units as unknown[]) : [];
  const rawArchives = Array.isArray(obj.archives) ? (obj.archives as unknown[]) : [];

  const unitsBySource = new Map<string, number>();
  for (const unit of rawUnits) {
    const source = (unit as { source?: unknown } | null)?.source;
    if (typeof source === 'string') {
      unitsBySource.set(source, (unitsBySource.get(source) ?? 0) + 1);
    }
  }

  const archives = new Map<string, PreviousArchive>();
  const noaa: NoaaResult = { archives: [], units: [] };
  for (const archive of rawArchives) {
    if (!Value.Check(EncIndexArchiveSchema, archive)) {
      continue;
    }
    if (archive.source === NOAA_SOURCE_ID) {
      noaa.archives.push(archive);
    } else {
      archives.set(jobKey(archive), { archive, units: [] });
    }
  }
  const rawUnitsByArchive = new Map<string, number>();
  for (const unit of rawUnits) {
    const loose = unit as { source?: unknown; cells?: { archive?: unknown }[] } | null;
    const url = Array.isArray(loose?.cells) ? loose.cells[0]?.archive : undefined;
    if (typeof loose?.source === 'string' && typeof url === 'string') {
      const key = jobKey({ source: loose.source, url });
      rawUnitsByArchive.set(key, (rawUnitsByArchive.get(key) ?? 0) + 1);
    }
    if (!Value.Check(EncIndexUnitSchema, unit)) {
      continue;
    }
    if (unit.source === NOAA_SOURCE_ID) {
      noaa.units.push(unit);
      continue;
    }
    archives.get(jobKey({ source: unit.source, url: unit.cells[0].archive }))?.units.push(unit);
  }
  // Dropping an archive with an invalid unit makes the next build download
  // it again, rather than carrying the rest forward without that unit. One
  // that never had units (update files only) is kept as it is.
  for (const [key, entry] of archives) {
    if (entry.units.length < (rawUnitsByArchive.get(key) ?? 0)) {
      archives.delete(key);
    }
  }

  return {
    contentHash: typeof obj.contentHash === 'string' ? obj.contentHash : null,
    unitCount: rawUnits.length,
    unitsBySource,
    archives,
    noaa: noaa.units.length > 0 ? noaa : null,
    schemaText
  };
}

/** True when the published index holds this archive at this version, built by these rules. */
export function isUnchanged(job: ArchiveJob, previous: PublishedEncIndex | null): boolean {
  const archive = previous?.archives.get(jobKey(job))?.archive;
  return archive?.version === job.version && archive.revision === ARCHIVE_REVISION;
}

/** The jobs a build has to download, in a stable order. */
export function jobsToBuild(
  jobs: readonly ArchiveJob[],
  previous: PublishedEncIndex | null
): ArchiveJob[] {
  return jobs.filter((job) => !isUnchanged(job, previous));
}

// ---- Assembly ----

export interface EncIndexInputs {
  sources: readonly EncIndexSource[];
  /** Every chartcatalogs archive the sources list today. */
  jobs: readonly ArchiveJob[];
  /** Archives read this run, by `jobKey`. */
  built: ReadonlyMap<string, ArchiveResult>;
  /** Archives that failed to download or read this run, by `jobKey`, with the reason. */
  failed: ReadonlyMap<string, string>;
  /** NOAA's units, an error, or null when NOAA was not read this run. */
  noaa: NoaaResult | { error: string } | null;
  /**
   * chartcatalogs sources whose catalog file could not be read, or listed
   * nothing, this run. Their published archives are kept rather than
   * treated as withdrawn: a broken upstream file is far more likely than a
   * withdrawn source.
   */
  unreadSources?: ReadonlySet<string>;
  previous: PublishedEncIndex | null;
  now: Date;
}

export interface EncIndexBuildResult {
  index: EncIndex;
  /** Archives taken unchanged from the published index. */
  reused: number;
  /** Failed this run; the published units were kept. */
  carriedForward: string[];
  /** Failed this run with nothing published to fall back on. */
  skipped: string[];
  /** Not read this run (time budget or source filter); published units kept where there were any. */
  deferred: string[];
  /** Published archives that their source no longer lists. */
  removedUpstream: string[];
  /** Cells listed by two archives of one source; the newer archive wins. */
  duplicateCells: string[];
  /** Cells flagged because another archive holds updates for them. */
  separateUpdates: string[];
}

/**
 * Flag every cell that an archive of its own source, dated no earlier than
 * the cell's own archive, holds update files for. Older update archives are
 * taken to be for an earlier edition (South China Sea still lists its
 * edition 2 notices beside edition 3), or already folded into a newer
 * reissue. Recomputed on every build, so a flag clears when the update
 * archive goes away or a newer base arrives.
 */
function flagSeparateUpdates(
  units: readonly EncIndexUnit[],
  archives: readonly EncIndexArchive[]
): { units: EncIndexUnit[]; flagged: string[] } {
  const versionOf = new Map(archives.map((a) => [jobKey(a), a.version]));
  const updatedAt = new Map<string, string[]>();
  for (const archive of archives) {
    for (const file of archive.updates ?? []) {
      const key = `${archive.source} ${updateCell(file)}`;
      updatedAt.set(key, [...(updatedAt.get(key) ?? []), archive.version]);
    }
  }
  const flagged: string[] = [];
  const result = units.map((unit) => ({
    ...unit,
    cells: unit.cells.map((cell) => {
      const { updatesPublishedSeparately: _stale, ...plain } = cell;
      const own = versionOf.get(jobKey({ source: unit.source, url: cell.archive })) ?? '';
      const later = (updatedAt.get(`${unit.source} ${cell.name}`) ?? []).some(
        (version) => compareStrings(version, own) >= 0
      );
      if (!later) {
        return plain;
      }
      flagged.push(`${unit.source} ${cell.name}`);
      return { ...plain, updatesPublishedSeparately: true as const };
    })
  }));
  return { units: result, flagged };
}

export function computeEncIndexHash(index: Omit<EncIndex, 'contentHash'>): string {
  const { generatedAt: _generatedAt, ...content } = index;
  return createHash('sha256').update(canonicalJson(content)).digest('hex');
}

export function assembleEncIndex(inputs: EncIndexInputs): EncIndexBuildResult {
  const { previous } = inputs;
  const archives: EncIndexArchive[] = [];
  const units: EncIndexUnit[] = [];
  const carriedForward: string[] = [];
  const skipped: string[] = [];
  const deferred: string[] = [];
  let reused = 0;

  const take = (entry: { archive: EncIndexArchive; units: EncIndexUnit[] } | NoaaResult): void => {
    if ('archive' in entry) {
      archives.push(entry.archive);
    } else {
      archives.push(...entry.archives);
    }
    units.push(...entry.units);
  };

  const { noaa } = inputs;
  if (noaa && !('error' in noaa) && noaa.units.length > 0) {
    take(noaa);
  } else if (previous?.noaa) {
    take(previous.noaa);
    if (noaa) {
      carriedForward.push(`${NOAA_SOURCE_ID}: ${'error' in noaa ? noaa.error : 'no units'}`);
    } else {
      deferred.push(NOAA_SOURCE_ID);
    }
  } else if (noaa) {
    skipped.push(`${NOAA_SOURCE_ID}: ${'error' in noaa ? noaa.error : 'no units'}`);
  } else {
    deferred.push(NOAA_SOURCE_ID);
  }

  const listed = new Set<string>();
  for (const job of inputs.jobs) {
    const key = jobKey(job);
    listed.add(key);
    const built = inputs.built.get(key);
    const published = previous?.archives.get(key);
    const failure =
      built && built.units.length === 0 && !built.updatesOnly
        ? 'no S-57 cell with usable coverage'
        : inputs.failed.get(key);
    if (built && failure === undefined) {
      take(built);
    } else if (failure === undefined && published && isUnchanged(job, previous)) {
      take(published);
      reused++;
    } else if (failure !== undefined) {
      if (published) {
        take(published);
        carriedForward.push(`${key}: ${failure}`);
      } else {
        skipped.push(`${key}: ${failure}`);
      }
    } else {
      if (published) {
        take(published);
      }
      deferred.push(key);
    }
  }

  const unread = new Set<string>();
  for (const [key, entry] of previous?.archives ?? []) {
    if (!listed.has(key) && inputs.unreadSources?.has(entry.archive.source)) {
      take(entry);
      listed.add(key);
      unread.add(entry.archive.source);
    }
  }
  for (const source of [...unread].sort(compareStrings)) {
    carriedForward.push(`${source}: its catalog could not be read`);
  }

  const duplicateCells: string[] = [];
  const versionOf = new Map(archives.map((a) => [jobKey(a), a.version]));
  const kept = new Map<string, EncIndexUnit>();
  for (const unit of units) {
    const key = `${unit.source} ${unit.id}`;
    const other = kept.get(key);
    if (!other) {
      kept.set(key, unit);
      continue;
    }
    const version = (u: EncIndexUnit): string =>
      versionOf.get(jobKey({ source: u.source, url: u.cells[0].archive })) ?? '';
    const order =
      compareStrings(version(unit), version(other)) ||
      compareStrings(other.cells[0].archive, unit.cells[0].archive);
    if (order > 0) {
      kept.set(key, unit);
    }
    duplicateCells.push(`${key}: in ${other.cells[0].archive} and ${unit.cells[0].archive}`);
  }

  const { units: flaggedUnits, flagged } = flagSeparateUpdates([...kept.values()], archives);
  const sortedUnits = flaggedUnits.sort(
    (a, b) => compareStrings(a.source, b.source) || compareStrings(a.id, b.id)
  );
  const withUnits = new Set(sortedUnits.map((u) => u.source));
  const withoutHash: Omit<EncIndex, 'contentHash'> = {
    schemaVersion: ENC_INDEX_SCHEMA_VERSION,
    generatedAt: inputs.now.toISOString(),
    sources: inputs.sources.filter((s) => withUnits.has(s.id)),
    archives: archives.sort(
      (a, b) => compareStrings(a.source, b.source) || compareStrings(a.url, b.url)
    ),
    units: sortedUnits
  };
  const index: EncIndex = { ...withoutHash, contentHash: computeEncIndexHash(withoutHash) };
  if (!Value.Check(EncIndexSchema, index)) {
    throw new Error(
      `ENC index failed validation:\n  ${schemaErrors(EncIndexSchema, index).join('\n  ')}`
    );
  }

  return {
    index,
    reused,
    carriedForward,
    skipped,
    deferred,
    removedUpstream: [...(previous?.archives.keys() ?? [])]
      .filter((key) => !listed.has(key))
      .sort(compareStrings),
    duplicateCells,
    separateUpdates: [...new Set(flagged)].sort(compareStrings)
  };
}

// ---- Publishing ----

function unitsBySource(index: EncIndex): Map<string, number> {
  const counts = new Map<string, number>();
  for (const unit of index.units) {
    counts.set(unit.source, (counts.get(unit.source) ?? 0) + 1);
  }
  return counts;
}

/**
 * Reasons not to replace the published index with `next`. A failed archive
 * or NOAA download is absorbed by carrying it forward; these thresholds
 * catch whole-source failures, such as a truncated NOAA footprint file or a
 * source dropped from the chartcatalogs index by mistake.
 */
export function encIndexBlockers(next: EncIndex, published: PublishedEncIndex | null): string[] {
  const blockers: string[] = [];
  if (next.units.length === 0) {
    blockers.push('the index has no units');
  }
  if (published) {
    if (next.units.length < Math.floor(published.unitCount * 0.8)) {
      blockers.push(
        `units dropped from ${String(published.unitCount)} to ${String(next.units.length)}`
      );
    }
    const after = unitsBySource(next);
    for (const [source, before] of [...published.unitsBySource].sort(([a], [b]) =>
      compareStrings(a, b)
    )) {
      const now = after.get(source) ?? 0;
      if (before >= 10 && now < Math.floor(before * 0.5)) {
        blockers.push(`${source} units dropped from ${String(before)} to ${String(now)}`);
      }
    }
  }
  return blockers;
}

export interface EncIndexPublishDecision {
  publish: boolean;
  blockers: string[];
}

/** Whether to deploy: on a content or schema change, unless a blocker objects. */
export function decideEncIndexPublish(
  next: EncIndex,
  published: PublishedEncIndex | null,
  schemaText: string,
  force: boolean
): EncIndexPublishDecision {
  const blockers = encIndexBlockers(next, published);
  const changed =
    !published || published.contentHash !== next.contentHash || published.schemaText !== schemaText;
  return { publish: force || (changed && blockers.length === 0), blockers };
}
