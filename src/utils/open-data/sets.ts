/**
 * Open Data Charts sets: a named selection of units, built into one MBTiles
 * in the chart folder. Each set is JSON under `<dataDir>/open-data-sets/`;
 * fields are only ever added, and a set written by a newer version keeps
 * the fields this one does not know when it is saved again.
 *
 * `built` and `overviews` record what the chart holds, so an update brings
 * in only the units whose version changed.
 */

import fs from 'fs';
import path from 'path';
import { isValidCatalogId, slugifyCatalogName } from '../custom-catalog-manager.js';
import { isWithinBase } from '../path-safety.js';
import type { OpenDataIndex, OpenDataOverview, OpenDataUnit } from './index-schema.js';

export const OPEN_DATA_SET_SCHEMA_VERSION = 1;
export const DEFAULT_OPEN_DATA_FOLDER = 'Open Data Charts';
const SETS_DIR = 'open-data-sets';
const ACKNOWLEDGED_FILE = 'open-data-acknowledged.json';

export interface OpenDataSet {
  schemaVersion: number;
  /** Safe slug; the file stem and the API id. */
  id: string;
  name: string;
  /** Chart-folder-relative folder the chart is built in. */
  folder: string;
  unitIds: string[];
  /** Unit id → version of the rows the chart holds. */
  built: Record<string, string>;
  /** Region id → version of the overview rows the chart holds. */
  overviews: Record<string, string>;
  /** Chart-folder-relative path of the built chart, or null before the first build. */
  chartFile: string | null;
  createdAt: string;
  updatedAt: string;
  lastBuiltAt: string | null;
}

export type OpenDataSetStatus =
  'empty' | 'not_built' | 'changed' | 'update_available' | 'up_to_date';

export interface UnitUpdate {
  id: string;
  from: string;
  to: string;
  changes?: string;
}

export interface SetState {
  status: OpenDataSetStatus;
  updates: UnitUpdate[];
  /** Selected units the index does not list and the chart does not hold. */
  missing: string[];
}

export interface OverviewToAdd extends OpenDataOverview {
  region: string;
}

export interface SetPlan {
  /** No chart to update: build a new one from every selected unit. */
  fresh: boolean;
  /** Units whose rows go in: new to the chart, or at a new version. */
  add: OpenDataUnit[];
  /** Units whose rows go out first: changed, or no longer selected. */
  remove: string[];
  /** The overviews the chart should hold, or null when they stay as they are. */
  overviews: OverviewToAdd[] | null;
  missing: string[];
}

function unitsById(index: OpenDataIndex | null): Map<string, OpenDataUnit> {
  return new Map((index?.units ?? []).map((u) => [u.id, u]));
}

function sameKeys(a: readonly string[], b: Record<string, string>): boolean {
  const keys = Object.keys(b);
  return a.length === keys.length && a.every((id) => id in b);
}

/** The overviews a set needs: those of the regions its units are in. */
function wantedOverviews(set: OpenDataSet, index: OpenDataIndex): OverviewToAdd[] {
  const units = unitsById(index);
  const regions = new Set(
    set.unitIds.map((id) => units.get(id)?.region).filter((r) => r !== undefined)
  );
  const out: OverviewToAdd[] = [];
  for (const region of index.regions) {
    if (regions.has(region.id) && region.overview) {
      out.push({ ...region.overview, region: region.id });
    }
  }
  return out;
}

function overviewsDiffer(set: OpenDataSet, wanted: readonly OverviewToAdd[]): boolean {
  return (
    wanted.length !== Object.keys(set.overviews).length ||
    wanted.some((o) => set.overviews[o.region] !== o.version)
  );
}

/** Selected units the index does not list and the chart does not hold. */
function missingUnits(
  set: OpenDataSet,
  units: Map<string, OpenDataUnit>,
  chartExists: boolean
): string[] {
  return set.unitIds.filter((id) => !units.has(id) && !(chartExists && id in set.built));
}

export function setState(
  set: OpenDataSet,
  index: OpenDataIndex | null,
  chartExists: boolean
): SetState {
  const units = unitsById(index);
  const missing = index ? missingUnits(set, units, chartExists) : [];
  const updates: UnitUpdate[] = [];
  for (const id of set.unitIds) {
    const unit = units.get(id);
    const from = set.built[id] as string | undefined;
    if (unit && from !== undefined && from !== unit.version) {
      updates.push({
        id,
        from,
        to: unit.version,
        ...(unit.changes ? { changes: unit.changes } : {})
      });
    }
  }
  let status: OpenDataSetStatus;
  if (!chartExists) {
    status = set.unitIds.length === 0 ? 'empty' : 'not_built';
  } else if (!sameKeys(set.unitIds, set.built)) {
    status = 'changed';
  } else if (
    updates.length > 0 ||
    (index !== null && overviewsDiffer(set, wantedOverviews(set, index)))
  ) {
    status = 'update_available';
  } else {
    status = 'up_to_date';
  }
  return { status, updates, missing };
}

export function planSet(set: OpenDataSet, index: OpenDataIndex, chartExists: boolean): SetPlan {
  const units = unitsById(index);
  const selected = new Set(set.unitIds);
  const missing = missingUnits(set, units, chartExists);
  const wanted = wantedOverviews(set, index);
  if (!chartExists) {
    return {
      fresh: true,
      add: set.unitIds.map((id) => units.get(id)).filter((u) => u !== undefined),
      remove: [],
      overviews: wanted,
      missing
    };
  }
  const add: OpenDataUnit[] = [];
  const remove: string[] = [];
  for (const id of set.unitIds) {
    const unit = units.get(id);
    // A unit the index stopped listing keeps the rows the chart has.
    if (!unit || set.built[id] === unit.version) {
      continue;
    }
    if (id in set.built) {
      remove.push(id);
    }
    add.push(unit);
  }
  for (const id of Object.keys(set.built)) {
    if (!selected.has(id)) {
      remove.push(id);
    }
  }
  return {
    fresh: false,
    add,
    remove,
    overviews: overviewsDiffer(set, wanted) ? wanted : null,
    missing
  };
}

/** The set as the chart will hold it once `plan` is applied. */
export function afterPlan(
  set: OpenDataSet,
  plan: SetPlan
): Pick<OpenDataSet, 'built' | 'overviews'> {
  const built: Record<string, string> = plan.fresh ? {} : { ...set.built };
  for (const id of plan.remove) {
    delete built[id];
  }
  for (const unit of plan.add) {
    built[unit.id] = unit.version;
  }
  const overviews =
    plan.overviews === null
      ? { ...set.overviews }
      : Object.fromEntries(plan.overviews.map((o) => [o.region, o.version]));
  return { built, overviews };
}

export class OpenDataSetStore {
  private readonly dir: string;
  private readonly ackFile: string;

  constructor(dataDir: string) {
    this.dir = path.join(dataDir, SETS_DIR);
    this.ackFile = path.join(dataDir, ACKNOWLEDGED_FILE);
  }

  private file(id: string): string | null {
    if (!isValidCatalogId(id)) {
      return null;
    }
    const file = path.join(this.dir, `${id}.json`);
    return isWithinBase(file, this.dir) ? file : null;
  }

  list(): OpenDataSet[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return [];
    }
    return names
      .filter((n) => n.endsWith('.json'))
      .map((n) => this.get(n.slice(0, -'.json'.length)))
      .filter((s) => s !== null)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  get(id: string): OpenDataSet | null {
    const file = this.file(id);
    if (!file) {
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? normalizeSet(parsed as Record<string, unknown>, id)
      : null;
  }

  create(name: string): OpenDataSet {
    const base = slugifyCatalogName(name);
    let id = base;
    for (let n = 2; fs.existsSync(path.join(this.dir, `${id}.json`)); n++) {
      id = `${base.slice(0, 70)}_${String(n)}`;
    }
    const now = new Date().toISOString();
    const set: OpenDataSet = {
      schemaVersion: OPEN_DATA_SET_SCHEMA_VERSION,
      id,
      name: name.trim(),
      folder: DEFAULT_OPEN_DATA_FOLDER,
      unitIds: [],
      built: {},
      overviews: {},
      chartFile: null,
      createdAt: now,
      updatedAt: now,
      lastBuiltAt: null
    };
    this.save(set);
    return set;
  }

  save(set: OpenDataSet): void {
    const file = this.file(set.id);
    if (!file) {
      throw new Error(`Invalid set id: ${set.id}`);
    }
    let previous: Record<string, unknown> = {};
    try {
      previous = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    } catch {
      // A new set.
    }
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ...previous, ...set }, null, 2));
    fs.renameSync(tmp, file);
  }

  delete(id: string): boolean {
    const file = this.file(id);
    if (!file || !fs.existsSync(file)) {
      return false;
    }
    fs.rmSync(file);
    return true;
  }

  acknowledged(): boolean {
    return fs.existsSync(this.ackFile);
  }

  acknowledge(): void {
    fs.writeFileSync(this.ackFile, JSON.stringify({ acknowledgedAt: new Date().toISOString() }));
  }
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((v): v is string => typeof v === 'string'))]
    : [];
}

function stringRecord(value: unknown): Record<string, string> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).filter((e): e is [string, string] => typeof e[1] === 'string')
  );
}

function safeFolder(value: unknown): string {
  if (typeof value !== 'string' || value === '' || path.isAbsolute(value)) {
    return DEFAULT_OPEN_DATA_FOLDER;
  }
  const normal = path.normalize(value);
  return normal.startsWith('..') ? DEFAULT_OPEN_DATA_FOLDER : normal;
}

function normalizeSet(raw: Record<string, unknown>, id: string): OpenDataSet {
  const text = (v: unknown, fallback: string): string => (typeof v === 'string' ? v : fallback);
  const now = new Date().toISOString();
  return {
    schemaVersion:
      typeof raw.schemaVersion === 'number' ? raw.schemaVersion : OPEN_DATA_SET_SCHEMA_VERSION,
    id,
    name: text(raw.name, id),
    folder: safeFolder(raw.folder),
    unitIds: stringList(raw.unitIds),
    built: stringRecord(raw.built),
    overviews: stringRecord(raw.overviews),
    chartFile: typeof raw.chartFile === 'string' ? raw.chartFile : null,
    createdAt: text(raw.createdAt, now),
    updatedAt: text(raw.updatedAt, now),
    lastBuiltAt: typeof raw.lastBuiltAt === 'string' ? raw.lastBuiltAt : null
  };
}
