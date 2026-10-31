/**
 * Downloads the ENC cells another plugin asks for around the vessel
 * (`requestArea` of the shared ENC store's API): the ENC index units that
 * reach the area are added to one chart set, "Around the vessel", which is
 * downloaded and converted like any other, so its cells are shared in the
 * store and its chart is served. Nothing is downloaded unless the user
 * turned on `encAreaDownloads`; an area only adds units, so the set grows
 * along the voyage, and the user edits or deletes it in the ENC Charts tab
 * like any set. The internet connection decides as for other background
 * work: on a metered, offline or captive link the download waits.
 */

import fs from 'node:fs';
import path from 'node:path';

import type { AreaBbox } from './enc-area.js';
import { unitsIn } from './enc-area.js';
import type { EncIndexLookup } from './enc-chart-set.js';

export const AREA_SET_NAME = 'Around the vessel';
/** More units than this is not an area around a vessel. */
export const MAX_AREA_UNITS = 60;
/** A set left out of date (a failed run) is not downloaded again sooner than this. */
export const AREA_RETRY_MS = 15 * 60_000;
/** How often a waiting download looks for a free conversion slot. */
export const SLOT_RETRY_MS = 60_000;

/** What `requestArea` answers. */
export interface EncAreaRequestResult {
  /** False when the request cannot be served at all: turned off, or not an area. */
  accepted: boolean;
  /** True when a download of the area's cells started. */
  started: boolean;
  /** Why, in a sentence for a status line. */
  reason: string;
  /** The chart set the area's cells go to, once there is one. */
  setId?: string;
}

/** The part of a chart set this module reads and changes. */
export interface AreaChartSet {
  id: string;
  selectedBand4ChartIds: string[];
  selectedUnitIds: string[];
  status: string;
}

export interface AreaRequestDeps {
  /** The user's consent, `encAreaDownloads`. */
  enabled: () => boolean;
  /** The ENC index, or null while it is not loaded. */
  index: () => Pick<EncIndexLookup, 'noaaUnits' | 'otherUnits'> | null;
  /** Load the ENC index when it is missing or stale. */
  refreshIndex: () => void;
  /** Whether background downloads may run now; else why not. */
  mayDownload: () => true | string;
  /** Run `task` once background downloads may run. */
  whenAllowed: (task: () => void) => void;
  /** Run `task` after `ms`; returns what cancels it. */
  later: (task: () => void, ms: number) => () => void;
  getSet: (id: string) => AreaChartSet | null;
  createSet: (name: string) => AreaChartSet;
  saveSet: (set: AreaChartSet) => void;
  busy: (id: string) => boolean;
  /** Whether a conversion slot is free. */
  slotFree: () => boolean;
  /** Download and convert the set. */
  start: (set: AreaChartSet) => void;
  /** Where the area set's id is kept. */
  stateFile: string;
  now: () => number;
  log: (message: string) => void;
}

function validBbox(bbox: unknown): bbox is AreaBbox {
  if (!Array.isArray(bbox) || bbox.length !== 4) {
    return false;
  }
  const [w, s, e, n] = bbox as unknown[];
  const lon = (v: unknown): boolean => typeof v === 'number' && v >= -180 && v <= 180;
  const lat = (v: unknown): boolean => typeof v === 'number' && v >= -90 && v <= 90;
  return lon(w) && lat(s) && lon(e) && lat(n) && (s as number) <= (n as number);
}

function readSetId(file: string): string | null {
  try {
    const json = JSON.parse(fs.readFileSync(file, 'utf8')) as { setId?: unknown };
    return typeof json.setId === 'string' ? json.setId : null;
  } catch {
    return null;
  }
}

function writeSetId(file: string, setId: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${String(process.pid)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ setId }));
  fs.renameSync(tmp, file);
}

/** The area requester the plugin keeps from one start to the next. */
export interface AreaRequester {
  request: (bbox: unknown, requester: string) => EncAreaRequestResult;
  /**
   * Forget a download waiting for the internet connection or a conversion
   * slot: stopping the plugin drops the gate's held tasks, so the next start
   * queues afresh.
   */
  reset: () => void;
}

/** `requestArea(bbox, requester)` over `deps`. */
export function createAreaRequester(deps: AreaRequestDeps): AreaRequester {
  let lastStart = -Infinity;
  let waiting = false;
  let cancelRetry: (() => void) | null = null;

  // A waiting download starts once the connection allows and a conversion
  // slot is free, looking again for a slot every SLOT_RETRY_MS.
  const runWaiting = (id: string): void => {
    cancelRetry = null;
    const set = deps.getSet(id);
    if (!set || deps.busy(set.id)) {
      waiting = false;
      return;
    }
    if (deps.mayDownload() !== true) {
      deps.whenAllowed(() => {
        runWaiting(id);
      });
      return;
    }
    if (!deps.slotFree()) {
      cancelRetry = deps.later(() => {
        runWaiting(id);
      }, SLOT_RETRY_MS);
      return;
    }
    waiting = false;
    lastStart = deps.now();
    deps.start(set);
  };

  const areaSet = (): AreaChartSet => {
    const kept = readSetId(deps.stateFile);
    const set = kept === null ? null : deps.getSet(kept);
    if (set) {
      return set;
    }
    const created = deps.createSet(AREA_SET_NAME);
    writeSetId(deps.stateFile, created.id);
    return created;
  };

  const startWhenReady = (set: AreaChartSet): EncAreaRequestResult => {
    const allowed = deps.mayDownload();
    if (allowed !== true) {
      if (!waiting) {
        waiting = true;
        deps.whenAllowed(() => {
          runWaiting(set.id);
        });
      }
      return {
        accepted: true,
        started: false,
        reason: `the area's cells are downloaded once the internet connection allows: ${allowed}`,
        setId: set.id
      };
    }
    if (!deps.slotFree()) {
      return {
        accepted: true,
        started: false,
        reason: 'other conversions are running; ask again later',
        setId: set.id
      };
    }
    lastStart = deps.now();
    deps.start(set);
    return { accepted: true, started: true, reason: 'downloading the area', setId: set.id };
  };

  const request = (bbox: unknown, requester: string): EncAreaRequestResult => {
    if (!deps.enabled()) {
      return {
        accepted: false,
        started: false,
        reason:
          'Charts Provider downloads no ENC for an area: turn on "Download the ENC cells around the vessel" in its settings'
      };
    }
    if (!validBbox(bbox)) {
      return { accepted: false, started: false, reason: 'not an area: [west, south, east, north]' };
    }
    const lookup = deps.index();
    if (!lookup) {
      deps.refreshIndex();
      return {
        accepted: true,
        started: false,
        reason: 'the ENC index is not loaded yet; ask again'
      };
    }
    const units = unitsIn(lookup, bbox);
    const count = units.noaa.length + units.other.length;
    if (count === 0) {
      return { accepted: true, started: false, reason: 'no free ENC covers the area' };
    }
    if (count > MAX_AREA_UNITS) {
      return {
        accepted: false,
        started: false,
        reason: `the area takes ${String(count)} chart units, more than ${String(MAX_AREA_UNITS)}: ask for a smaller one`
      };
    }
    const set = areaSet();
    if (deps.busy(set.id)) {
      return {
        accepted: true,
        started: false,
        reason: 'the area chart set is being downloaded; ask again when it is done',
        setId: set.id
      };
    }
    const noaa = units.noaa.filter((id) => !set.selectedBand4ChartIds.includes(id));
    const other = units.other.filter((id) => !set.selectedUnitIds.includes(id));
    if (noaa.length + other.length > 0) {
      set.selectedBand4ChartIds = [...set.selectedBand4ChartIds, ...noaa];
      set.selectedUnitIds = [...set.selectedUnitIds, ...other];
      set.status = 'out_of_date';
      deps.saveSet(set);
      deps.log(
        `${requester} asked for the ENC around [${bbox.join(', ')}]: added ${String(noaa.length + other.length)} chart unit(s) to "${AREA_SET_NAME}"`
      );
      return startWhenReady(set);
    }
    if (set.status === 'converted') {
      return { accepted: true, started: false, reason: 'the area is downloaded', setId: set.id };
    }
    if (deps.now() - lastStart < AREA_RETRY_MS) {
      return {
        accepted: true,
        started: false,
        reason: 'the area was downloaded a moment ago and is not ready; ask again later',
        setId: set.id
      };
    }
    return startWhenReady(set);
  };

  return {
    request,
    reset: () => {
      waiting = false;
      cancelRetry?.();
      cancelRetry = null;
    }
  };
}
