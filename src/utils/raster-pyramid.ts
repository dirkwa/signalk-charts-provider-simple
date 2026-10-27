/**
 * Adds overview zoom levels to a raster MBTiles: each new tile is its four
 * children one zoom deeper, box-downsampled (what `gdaladdo -r average` did
 * for the converters). GDAL writes a converted BSB/KAP chart at its native
 * zoom only, so without overviews the chart would vanish as soon as a
 * plotter zooms out.
 *
 * The tiles are built from the level below rather than from the source
 * raster, so each level costs a quarter of the one before; the pixel work
 * runs in the conversion's worker threads.
 */

import { DatabaseSync } from 'node:sqlite';
import { forEachConcurrent, type WorkerPool } from './worker-pool.js';

interface TileRow {
  tile_column: number;
  tile_row: number;
  tile_data: Uint8Array;
}

/**
 * Build `levels` overview zooms below the file's current minimum zoom (never
 * below z0) and update its `minzoom` metadata. Returns the number of tiles
 * added.
 */
export async function addRasterOverviews(
  file: string,
  levels: number,
  pool: WorkerPool
): Promise<number> {
  const db = new DatabaseSync(file);
  try {
    const range = db.prepare('SELECT MIN(zoom_level) AS minz FROM tiles').get() as {
      minz: number | null;
    };
    if (range.minz === null) {
      return 0;
    }
    const children = db.prepare(
      'SELECT tile_column, tile_row, tile_data FROM tiles ' +
        'WHERE zoom_level = ? AND tile_column BETWEEN ? AND ? AND tile_row BETWEEN ? AND ?'
    );
    const insert = db.prepare(
      'INSERT OR REPLACE INTO tiles (zoom_level, tile_column, tile_row, tile_data) VALUES (?, ?, ?, ?)'
    );
    let added = 0;
    let minzoom = range.minz;
    for (let z = range.minz - 1; z >= Math.max(0, range.minz - levels); z--) {
      const parents = db
        .prepare(
          'SELECT DISTINCT tile_column / 2 AS x, tile_row / 2 AS y FROM tiles WHERE zoom_level = ?'
        )
        .all(z + 1) as { x: number; y: number }[];
      if (parents.length === 0) {
        break;
      }
      // One transaction per level: a commit per tile would cost a journal
      // sync each, minutes on an SD card for a large basemap.
      db.exec('BEGIN');
      try {
        await forEachConcurrent(parents, pool.size * 2, async ({ x, y }) => {
          const rows = children.all(
            z + 1,
            x * 2,
            x * 2 + 1,
            y * 2,
            y * 2 + 1
          ) as unknown as TileRow[];
          const { tile } = await pool.run({
            op: 'raster-downsample',
            // Rows count from the south (TMS), so the upper child — the
            // northern one, quadrant row 0 — has the odd row.
            children: rows.map((r) => ({
              raw: r.tile_data,
              dx: r.tile_column - x * 2,
              dy: r.tile_row === y * 2 + 1 ? 0 : 1
            }))
          });
          if (tile) {
            insert.run(z, x, y, tile);
            added++;
          }
        });
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      minzoom = z;
    }
    db.exec('BEGIN');
    db.prepare("DELETE FROM metadata WHERE name = 'minzoom'").run();
    db.prepare("INSERT INTO metadata (name, value) VALUES ('minzoom', ?)").run(String(minzoom));
    db.exec('COMMIT');
    return added;
  } finally {
    db.close();
  }
}
