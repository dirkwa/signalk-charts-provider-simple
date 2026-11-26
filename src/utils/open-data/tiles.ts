/**
 * Unit geometry. An Open Data Charts unit is one z9 Web-Mercator tile (XYZ,
 * y from the north); every tile at z >= 9 belongs to exactly one unit, its
 * z9 ancestor. MBTiles store rows in TMS order (y from the south), so a row
 * is flipped before the ancestor is taken.
 */

export const UNIT_ZOOM = 9;

/** The metadata row naming the set a chart was put together from. */
export const OPEN_DATA_SET_METADATA_KEY = 'x-odc-set';
const UNIT_COUNT = 2 ** UNIT_ZOOM;

export interface UnitTile {
  x: number;
  y: number;
}

/** The z9 tile (XYZ) a stored tile lies in, or null for a tile above z9. */
export function unitOfTile(zoom: number, column: number, tmsRow: number): UnitTile | null {
  if (zoom < UNIT_ZOOM) {
    return null;
  }
  const scale = 2 ** (zoom - UNIT_ZOOM);
  const xyzRow = 2 ** zoom - 1 - tmsRow;
  return { x: Math.floor(column / scale), y: Math.floor(xyzRow / scale) };
}

/**
 * The same test as `unitOfTile` in SQL over an MBTiles `tiles` table or
 * view, for the unit bound to `:ux` and `:uy`. SQLite integers are 64 bits,
 * so the shifts are exact at every zoom an MBTiles can hold.
 */
export const UNIT_ROWS_SQL =
  `zoom_level >= ${String(UNIT_ZOOM)}` +
  ` AND (tile_column >> (zoom_level - ${String(UNIT_ZOOM)})) = :ux` +
  ` AND ((((1 << zoom_level) - 1) - tile_row) >> (zoom_level - ${String(UNIT_ZOOM)})) = :uy`;

export function unitId(tile: UnitTile): string {
  return `z${String(UNIT_ZOOM)}-${String(tile.x)}-${String(tile.y)}`;
}

/** The tile a unit id names, or null when it is not a z9 unit id. */
export function parseUnitId(id: string): UnitTile | null {
  const m = /^z9-(\d{1,3})-(\d{1,3})$/.exec(id);
  if (!m) {
    return null;
  }
  const x = Number(m[1]);
  const y = Number(m[2]);
  return x < UNIT_COUNT && y < UNIT_COUNT ? { x, y } : null;
}

function latOfRow(row: number): number {
  return (Math.atan(Math.sinh(Math.PI * (1 - (2 * row) / UNIT_COUNT))) * 180) / Math.PI;
}

/** `[west, south, east, north]` of a unit. */
export function unitBounds(tile: UnitTile): [number, number, number, number] {
  return [
    (tile.x / UNIT_COUNT) * 360 - 180,
    latOfRow(tile.y + 1),
    ((tile.x + 1) / UNIT_COUNT) * 360 - 180,
    latOfRow(tile.y)
  ];
}

/** `[west, south, east, north]` around every unit, or null for none. */
export function unionBounds(tiles: readonly UnitTile[]): [number, number, number, number] | null {
  if (tiles.length === 0) {
    return null;
  }
  const all = tiles.map(unitBounds);
  return [
    Math.min(...all.map((b) => b[0])),
    Math.min(...all.map((b) => b[1])),
    Math.max(...all.map((b) => b[2])),
    Math.max(...all.map((b) => b[3]))
  ];
}
