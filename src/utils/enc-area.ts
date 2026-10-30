/**
 * Which ENC cells reach an area: the ones in the shared ENC store, for a
 * reader that needs only the cells around the vessel, and the ENC index
 * units to download for an area the store does not cover yet. Pure: the
 * store and the index are passed in.
 *
 * A cell's extent comes from the ENC index: the box of its own unit, or for
 * a NOAA cell, which NOAA's band-4 boxes list, the union of the boxes that
 * list it. A cell the index does not know is taken to reach every area, so
 * a reader never misses one.
 */

import path from 'node:path';

import type { EncIndexLookup } from './enc-chart-set.js';
import { parseCellVersion } from './enc-chart-set.js';
import type { EncCollection } from './enc-store.js';

/** `[west, south, east, north]` in degrees; west > east crosses the antimeridian. */
export type AreaBbox = readonly [number, number, number, number];

/** A stored cell that reaches an area. */
export interface EncAreaCell {
  /** The collection it is read from. */
  collection: string;
  cell: string;
  version?: string;
  /** Absolute path of its `.000` file; its updates are beside it. */
  base: string;
  /** Its extent from the ENC index; none when the index does not know it. */
  bbox?: AreaBbox;
}

type Lookup = Pick<EncIndexLookup, 'noaaUnits' | 'otherUnits'>;

/** `[west, east]` spans of a box in longitude, two when it crosses the antimeridian. */
function spans([west, , east]: AreaBbox): [number, number][] {
  return west <= east
    ? [[west, east]]
    : [
        [west, 180],
        [-180, east]
      ];
}

export function bboxesMeet(a: AreaBbox, b: AreaBbox): boolean {
  if (a[1] > b[3] || b[1] > a[3]) {
    return false;
  }
  return spans(a).some(([aw, ae]) => spans(b).some(([bw, be]) => aw <= be && bw <= ae));
}

function union(a: AreaBbox | undefined, b: AreaBbox): AreaBbox {
  // A box across the antimeridian is kept as it is: a union of such boxes is
  // not needed for the few cells that cross it.
  if (!a || a[0] > a[2] || b[0] > b[2]) {
    return a ?? b;
  }
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

/** Each cell's extent as the ENC index gives it. */
export function cellBboxes(lookup: Lookup): Map<string, AreaBbox> {
  const out = new Map<string, AreaBbox>();
  for (const unit of [...lookup.noaaUnits.values(), ...lookup.otherUnits.values()]) {
    for (const cell of unit.cells) {
      out.set(cell.name, union(out.get(cell.name), unit.bbox));
    }
  }
  return out;
}

/** The units whose box reaches `bbox`, NOAA's apart, as a chart set selects them. */
export function unitsIn(lookup: Lookup, bbox: AreaBbox): { noaa: string[]; other: string[] } {
  const pick = (units: Lookup['noaaUnits']): string[] =>
    [...units.values()].filter((u) => bboxesMeet(u.bbox, bbox)).map((u) => u.id);
  return { noaa: pick(lookup.noaaUnits), other: pick(lookup.otherUnits) };
}

/** Edition and update of a cell as one comparable number; -1 without a version. */
function rank(version: string | undefined): number {
  const v = parseCellVersion(version);
  return v ? v.edition * 100_000 + v.update : -1;
}

/**
 * The stored cells reaching `bbox`, one of each name: the newest edition and
 * update where versions say, else the first in collection order. Collections
 * in id order, cells in name order.
 */
export function cellsIn(
  collections: readonly EncCollection[],
  bbox: AreaBbox,
  extents: ReadonlyMap<string, AreaBbox>
): EncAreaCell[] {
  const best = new Map<string, EncAreaCell>();
  const sorted = [...collections].sort((a, b) => a.id.localeCompare(b.id));
  for (const collection of sorted) {
    for (const cell of collection.cells) {
      const extent = extents.get(cell.name);
      const base = cell.files[0];
      if ((extent && !bboxesMeet(extent, bbox)) || !base?.name.endsWith('.000')) {
        continue;
      }
      const found: EncAreaCell = {
        collection: collection.id,
        cell: cell.name,
        base: path.join(cell.dir, base.name),
        ...(cell.version === undefined ? {} : { version: cell.version }),
        ...(extent ? { bbox: extent } : {})
      };
      const kept = best.get(cell.name);
      if (!kept || rank(found.version) > rank(kept.version)) {
        best.set(cell.name, found);
      }
    }
  }
  return [...best.values()].sort((a, b) => a.cell.localeCompare(b.cell));
}
