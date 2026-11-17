/**
 * The Open Data Charts index as this plugin reads it. The format is
 * published by the open-data-charts repository (`docs/index-format.md`
 * there): additive changes keep `schemaVersion`, unknown fields are
 * ignored, and an entry this version cannot read is skipped, never the
 * whole file. Only a newer `schemaVersion` makes the file unusable, and
 * then the charts already built stay as they are.
 */

import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';
import { parseUnitId, UNIT_ZOOM } from './tiles.js';

export const OPEN_DATA_INDEX_SCHEMA_VERSION = 1;

/** The quality categories this version knows, best first; others show as "Other". */
export const QUALITY_CATEGORIES = [
  { id: 'multibeam', label: 'Multibeam survey' },
  { id: 'survey-recent', label: 'Survey since 1990' },
  { id: 'survey-old', label: 'Survey before 1990' },
  { id: 'model', label: 'Model only' },
  { id: 'model-coarse', label: 'Deep water, coarse model' },
  { id: 'none', label: 'No depth data' }
] as const;

// Ids and versions become parts of cache file names.
const SafeToken = Type.String({ pattern: '^[A-Za-z0-9_-]{1,64}$' });
const HttpUrl = Type.String({ pattern: '^https?://' });
const Sha256 = Type.String({ pattern: '^[0-9a-fA-F]{64}$' });
const Zoom = Type.Integer({ minimum: 0, maximum: 24 });
const Bbox = Type.Tuple([
  Type.Number({ minimum: -180, maximum: 180 }),
  Type.Number({ minimum: -90, maximum: 90 }),
  Type.Number({ minimum: -180, maximum: 180 }),
  Type.Number({ minimum: -90, maximum: 90 })
]);

const OverviewSchema = Type.Object({
  url: HttpUrl,
  sha256: Sha256,
  size: Type.Integer({ minimum: 1 }),
  version: SafeToken,
  minzoom: Zoom,
  maxzoom: Zoom
});

const RegionSchema = Type.Object({
  id: SafeToken,
  name: Type.String({ minLength: 1 }),
  bbox: Bbox,
  overview: Type.Optional(Type.Union([Type.Null(), OverviewSchema])),
  sources: Type.Optional(Type.Array(Type.String()))
});

const UnitSchema = Type.Object({
  id: Type.String(),
  region: SafeToken,
  z: Type.Literal(UNIT_ZOOM),
  x: Type.Integer({ minimum: 0 }),
  y: Type.Integer({ minimum: 0 }),
  bbox: Bbox,
  version: SafeToken,
  url: HttpUrl,
  size: Type.Integer({ minimum: 1 }),
  sha256: Sha256,
  minzoom: Zoom,
  maxzoom: Zoom,
  built: Type.Optional(Type.String()),
  quality: Type.Optional(
    Type.Object({
      best: Type.String(),
      share: Type.Optional(Type.Record(Type.String(), Type.Number()))
    })
  ),
  surveys: Type.Optional(Type.Number()),
  changes: Type.Optional(Type.String())
});

export type OpenDataOverview = Static<typeof OverviewSchema>;
export type OpenDataRegion = Static<typeof RegionSchema>;
export type OpenDataUnit = Static<typeof UnitSchema>;

export interface OpenDataIndex {
  generated: string | null;
  disclaimer: string | null;
  attribution: string | null;
  regions: OpenDataRegion[];
  units: OpenDataUnit[];
}

export type InterpretedOpenDataIndex =
  | { ok: true; index: OpenDataIndex; skipped: number }
  | { ok: false; reason: 'invalid' | 'incompatible'; message: string };

const DAMAGED = 'The Open Data Charts index is damaged. Try Refresh again later.';

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** A unit whose id, tile and zoom range agree, so its rows can be told apart. */
function isUsableUnit(unit: OpenDataUnit): boolean {
  const tile = parseUnitId(unit.id);
  return (
    tile !== null &&
    tile.x === unit.x &&
    tile.y === unit.y &&
    unit.minzoom >= UNIT_ZOOM &&
    unit.minzoom <= unit.maxzoom
  );
}

export function interpretOpenDataIndex(raw: unknown): InterpretedOpenDataIndex {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'invalid', message: DAMAGED };
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.schemaVersion !== 'number' || !Number.isInteger(obj.schemaVersion)) {
    return { ok: false, reason: 'invalid', message: DAMAGED };
  }
  if (obj.schemaVersion > OPEN_DATA_INDEX_SCHEMA_VERSION) {
    return {
      ok: false,
      reason: 'incompatible',
      message:
        'The Open Data Charts index uses a newer format than this version of the plugin. Update the plugin to use it; the charts already built stay as they are.'
    };
  }
  if (
    obj.schemaVersion < OPEN_DATA_INDEX_SCHEMA_VERSION ||
    !Array.isArray(obj.regions) ||
    !Array.isArray(obj.units)
  ) {
    return { ok: false, reason: 'invalid', message: DAMAGED };
  }

  let skipped = 0;
  const regions: OpenDataRegion[] = [];
  const regionIds = new Set<string>();
  for (const item of obj.regions as unknown[]) {
    if (Value.Check(RegionSchema, item) && !regionIds.has(item.id)) {
      regionIds.add(item.id);
      regions.push(item);
    } else {
      skipped++;
    }
  }
  const units: OpenDataUnit[] = [];
  const unitIds = new Set<string>();
  for (const item of obj.units as unknown[]) {
    if (Value.Check(UnitSchema, item) && isUsableUnit(item) && !unitIds.has(item.id)) {
      unitIds.add(item.id);
      units.push(item);
    } else {
      skipped++;
    }
  }
  return {
    ok: true,
    index: {
      generated: optionalString(obj.generated),
      disclaimer: optionalString(obj.disclaimer),
      attribution: optionalString(obj.attribution),
      regions,
      units
    },
    skipped
  };
}
