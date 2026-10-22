/**
 * What a chart set holds, worked out from the ENC index (`docs/enc-index.md`).
 *
 * A chart set stores the units the user picked: NOAA band-4 boxes in
 * `selectedBand4ChartIds` (the field older plugin versions read) and every
 * other unit in `selectedUnitIds`. This module turns that selection into the
 * S-57 cells to download, each with its archive, its path inside it, any
 * updates published in other archives, and the version the set records
 * once the cell is downloaded.
 *
 * Everything here is pure, so freshness and download planning are tested
 * without a network.
 */

import {
  NOAA_SOURCE_ID,
  type EncIndexArchive,
  type EncIndexUnit
} from '../catalog/enc-index-schema.js';

/** An update file published in another archive than its cell's (see `archives[].updates`). */
export interface SeparateUpdate {
  archive: string;
  archiveKind: 'zip' | 'cell';
  /** Path of the update file inside its archive. */
  path: string;
  /** Its update number, from the file extension (".041" → 41). */
  number: number;
}

/** The ENC index reduced to the lookups a chart set needs. */
export interface EncIndexLookup {
  noaaUnits: ReadonlyMap<string, EncIndexUnit>;
  otherUnits: ReadonlyMap<string, EncIndexUnit>;
  archives: ReadonlyMap<string, EncIndexArchive>;
  /** Keyed by `separateUpdateKey(source, cell)`, in no particular order. */
  separateUpdates: ReadonlyMap<string, SeparateUpdate[]>;
}

export interface ChartSetSelection {
  selectedBand4ChartIds: readonly string[];
  selectedUnitIds: readonly string[];
}

/** One cell a chart set downloads. */
export interface PlannedCell {
  name: string;
  source: string;
  archive: string;
  archiveKind: 'zip' | 'cell';
  /** Path of the base file (".000") inside the archive. */
  path: string;
  /**
   * The version the set records for the cell once downloaded: the index's
   * version, with the update number raised by any separate updates applied.
   * Undefined when the index has no version for the cell.
   */
  version: string | undefined;
  /** Separately published updates to apply, in order. */
  updates: SeparateUpdate[];
}

export interface ChartSetResolution {
  /** Every cell the set brings in, sorted by name, each once. */
  cells: PlannedCell[];
  includedChartIds: string[];
  /** Cell name → the version a fresh download records. */
  chartVersions: Record<string, string>;
  /** Selected unit ids the index no longer lists. */
  missingSelected: string[];
  /** Selected unit id → the cells whose state is shown as the unit's own. */
  coverageByUnit: Record<string, string[]>;
}

export function separateUpdateKey(source: string, cell: string): string {
  return `${source}\u0000${cell}`;
}

const UPDATE_FILE = /^([^/]+)\.(\d{3})$/;

/**
 * Build the lookups from the units and archives an index lists. A non-NOAA
 * id names one cell across the whole index, so `otherUnits` is keyed by id
 * alone; a NOAA id is unique among NOAA units.
 */
export function buildEncIndexLookup(
  units: readonly EncIndexUnit[],
  archives: readonly EncIndexArchive[]
): EncIndexLookup {
  const noaaUnits = new Map<string, EncIndexUnit>();
  const otherUnits = new Map<string, EncIndexUnit>();
  for (const unit of units) {
    const target = unit.source === NOAA_SOURCE_ID ? noaaUnits : otherUnits;
    if (!target.has(unit.id)) {
      target.set(unit.id, unit);
    }
  }
  const archiveByUrl = new Map<string, EncIndexArchive>();
  const separateUpdates = new Map<string, SeparateUpdate[]>();
  for (const archive of archives) {
    archiveByUrl.set(archive.url, archive);
    for (const updatePath of archive.updates ?? []) {
      const match = UPDATE_FILE.exec(updatePath.split('/').pop() ?? '');
      const number = match ? Number(match[2]) : 0;
      if (!match || number === 0) {
        continue;
      }
      const key = separateUpdateKey(archive.source, match[1]);
      const list = separateUpdates.get(key) ?? [];
      list.push({ archive: archive.url, archiveKind: archive.kind, path: updatePath, number });
      separateUpdates.set(key, list);
    }
  }
  return { noaaUnits, otherUnits, archives: archiveByUrl, separateUpdates };
}

/** Edition and update number of a version token such as `US4FL1EP_ED003_UP012`. */
export function parseCellVersion(
  version: string | undefined
): { name: string; edition: number; update: number } | null {
  const match = version ? /^(.+)_ED(\d+)_UP(\d+)$/.exec(version) : null;
  if (!match) {
    return null;
  }
  return { name: match[1], edition: Number(match[2]), update: Number(match[3]) };
}

/** The token for `name` at an edition and update, in the index's form. */
export function formatCellVersion(name: string, edition: number, update: number): string {
  return `${name}_ED${String(edition).padStart(3, '0')}_UP${String(update).padStart(3, '0')}`;
}

function archiveTime(archive: EncIndexArchive | undefined): number {
  const t = archive ? Date.parse(archive.version) : NaN;
  return Number.isFinite(t) ? t : NaN;
}

/**
 * The separately published updates that apply to a cell flagged
 * `updatesPublishedSeparately`: those numbered after the cell's own update,
 * from archives of its source dated no earlier than its own archive, taken
 * in order up to the first gap. An update for another edition comes from
 * an older archive or carries a number already folded into the base, so
 * those rules leave it out; a gap means a correction is missing, and GDAL
 * must not apply later ones on top of it.
 */
export function separateUpdatesFor(
  lookup: EncIndexLookup,
  source: string,
  cell: { name: string; archive: string; version?: string; updatesPublishedSeparately?: true }
): SeparateUpdate[] {
  if (!cell.updatesPublishedSeparately) {
    return [];
  }
  const parsed = parseCellVersion(cell.version);
  if (!parsed) {
    return [];
  }
  const baseTime = archiveTime(lookup.archives.get(cell.archive));
  const candidates = (lookup.separateUpdates.get(separateUpdateKey(source, cell.name)) ?? [])
    .filter((u) => u.number > parsed.update)
    .filter((u) => {
      const t = archiveTime(lookup.archives.get(u.archive));
      return Number.isNaN(baseTime) || Number.isNaN(t) || t >= baseTime;
    })
    .sort((a, b) => a.number - b.number);

  const run: SeparateUpdate[] = [];
  let next = parsed.update + 1;
  for (const update of candidates) {
    if (update.number < next) {
      continue; // the same update published twice; keep the first
    }
    if (update.number !== next) {
      break;
    }
    run.push(update);
    next += 1;
  }
  return run;
}

/** The unit a selected id names: NOAA ids are band-4 boxes, the rest cells. */
function selectedUnits(
  lookup: EncIndexLookup,
  selection: ChartSetSelection
): { units: EncIndexUnit[]; missing: string[] } {
  const units: EncIndexUnit[] = [];
  const missing: string[] = [];
  const pick = (ids: readonly string[], from: ReadonlyMap<string, EncIndexUnit>): void => {
    for (const id of ids) {
      const unit = from.get(id);
      if (unit) {
        units.push(unit);
      } else {
        missing.push(id);
      }
    }
  };
  pick(selection.selectedBand4ChartIds, lookup.noaaUnits);
  pick(selection.selectedUnitIds, lookup.otherUnits);
  return { units, missing };
}

/**
 * Every cell a selection brings in. Units that share a cell (NOAA band-3
 * cells span many boxes) bring it in once.
 */
export function resolveChartSet(
  lookup: EncIndexLookup,
  selection: ChartSetSelection
): ChartSetResolution {
  const { units, missing } = selectedUnits(lookup, selection);
  const byName = new Map<string, PlannedCell>();
  const coverageByUnit: Record<string, string[]> = {};
  for (const unit of units) {
    coverageByUnit[unit.id] = [...unit.statusCells].sort((a, b) => a.localeCompare(b));
    for (const cell of unit.cells) {
      if (byName.has(cell.name)) {
        continue;
      }
      const archive = lookup.archives.get(cell.archive);
      const updates = separateUpdatesFor(lookup, unit.source, cell);
      const parsed = parseCellVersion(cell.version);
      const last = updates.at(-1);
      byName.set(cell.name, {
        name: cell.name,
        source: unit.source,
        archive: cell.archive,
        archiveKind: archive?.kind ?? 'zip',
        path: cell.path,
        version:
          parsed && last ? formatCellVersion(cell.name, parsed.edition, last.number) : cell.version,
        updates
      });
    }
  }
  const cells = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  const chartVersions: Record<string, string> = {};
  for (const cell of cells) {
    if (cell.version !== undefined) {
      chartVersions[cell.name] = cell.version;
    }
  }
  return {
    cells,
    includedChartIds: cells.map((c) => c.name),
    chartVersions,
    missingSelected: missing,
    coverageByUnit
  };
}
