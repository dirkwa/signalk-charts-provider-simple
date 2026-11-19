/**
 * The local WFS proxy's store (`wfs-proxy.ts`): each feature once, by its id,
 * with its box in an R-tree, and the boxes whose features it holds whole
 * (`covered`), each with when it was fetched. A feature reaching several
 * boxes is kept once. Deleting the file loses nothing but downloads.
 */

import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { featureBox, featureId, uncovered, type Box, type WfsFeature } from './wfs-query.js';

const SCHEMA_VERSION = '1';

export interface WfsCacheStats {
  features: number;
  areas: number;
  bytes: number;
}

/** The feature type a feature or box belongs to, on its upstream server. */
export interface Layer {
  upstream: string;
  typeName: string;
}

export class WfsCache {
  private readonly db: DatabaseSync;
  private readonly upsert: StatementSync;
  private readonly rowOf: StatementSync;
  private readonly boxDelete: StatementSync;
  private readonly boxInsert: StatementSync;
  private readonly coversIn: StatementSync;
  private readonly coverInsert: StatementSync;
  private readonly coverPrune: StatementSync;
  private readonly matching: StatementSync;
  private readonly dataOf: StatementSync;

  constructor(readonly file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS meta (name TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS features (
        id INTEGER PRIMARY KEY,
        upstream TEXT NOT NULL,
        type_name TEXT NOT NULL,
        fid TEXT NOT NULL,
        fetched_at INTEGER NOT NULL,
        data BLOB NOT NULL,
        UNIQUE (upstream, type_name, fid)
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS feature_box USING rtree(id, minx, maxx, miny, maxy);
      CREATE TABLE IF NOT EXISTS covered (
        id INTEGER PRIMARY KEY,
        upstream TEXT NOT NULL,
        type_name TEXT NOT NULL,
        w REAL NOT NULL, s REAL NOT NULL, e REAL NOT NULL, n REAL NOT NULL,
        fetched_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS covered_layer ON covered (upstream, type_name);
    `);
    const version = this.db.prepare("SELECT value FROM meta WHERE name = 'schema'").get() as
      { value: string } | undefined;
    if (version === undefined) {
      this.db.prepare("INSERT INTO meta (name, value) VALUES ('schema', ?)").run(SCHEMA_VERSION);
    } else if (version.value !== SCHEMA_VERSION) {
      throw new Error(`${file}: WFS cache schema ${version.value}, expected ${SCHEMA_VERSION}`);
    }
    this.upsert = this.db.prepare(`
      INSERT INTO features (upstream, type_name, fid, fetched_at, data) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (upstream, type_name, fid) DO UPDATE SET fetched_at = excluded.fetched_at, data = excluded.data
    `);
    this.rowOf = this.db.prepare(
      'SELECT id FROM features WHERE upstream = ? AND type_name = ? AND fid = ?'
    );
    this.boxDelete = this.db.prepare('DELETE FROM feature_box WHERE id = ?');
    this.boxInsert = this.db.prepare(
      'INSERT INTO feature_box (id, minx, maxx, miny, maxy) VALUES (?, ?, ?, ?, ?)'
    );
    this.coversIn = this.db.prepare(`
      SELECT w, s, e, n FROM covered
      WHERE upstream = ? AND type_name = ? AND fetched_at >= ?
        AND e > ? AND w < ? AND n > ? AND s < ?
    `);
    this.coverInsert = this.db.prepare(
      'INSERT INTO covered (upstream, type_name, w, s, e, n, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    // A box inside a newer one adds nothing.
    this.coverPrune = this.db.prepare(`
      DELETE FROM covered WHERE upstream = ? AND type_name = ? AND fetched_at <= ?
        AND w >= ? AND s >= ? AND e <= ? AND n <= ? AND id <> ?
    `);
    this.matching = this.db.prepare(`
      SELECT f.id AS id FROM feature_box b JOIN features f ON f.id = b.id
      WHERE f.upstream = ? AND f.type_name = ?
        AND b.maxx >= ? AND b.minx <= ? AND b.maxy >= ? AND b.miny <= ?
      ORDER BY f.fid
    `);
    this.dataOf = this.db.prepare('SELECT data FROM features WHERE id = ?');
  }

  /**
   * Keeps `features` of `layer`, fetched at `at`; a feature already kept is
   * replaced. Returns false, keeping none, when one has no id or no
   * coordinates: such a page cannot be answered again from the store.
   */
  put(layer: Layer, features: readonly WfsFeature[], at: number): boolean {
    const rows = features.map((f) => ({ f, id: featureId(f), box: featureBox(f) }));
    if (rows.some((r) => r.id === undefined || r.box === undefined)) {
      return false;
    }
    this.db.exec('BEGIN');
    try {
      for (const { f, id, box } of rows) {
        const [w, s, e, n] = box as Box;
        this.upsert.run(
          layer.upstream,
          layer.typeName,
          id as string,
          at,
          zlib.gzipSync(JSON.stringify(f))
        );
        const row = this.rowOf.get(layer.upstream, layer.typeName, id as string) as { id: number };
        this.boxDelete.run(row.id);
        this.boxInsert.run(row.id, w, e, s, n);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return true;
  }

  /** Records that every feature of `layer` reaching `box` was fetched at `at`. */
  markCovered(layer: Layer, box: Box, at: number): void {
    const [w, s, e, n] = box;
    const r = this.coverInsert.run(layer.upstream, layer.typeName, w, s, e, n, at);
    this.coverPrune.run(layer.upstream, layer.typeName, at, w, s, e, n, Number(r.lastInsertRowid));
  }

  /** Whether boxes fetched at `since` or later hold every feature of `layer` reaching `box`. */
  covers(layer: Layer, box: Box, since: number): boolean {
    const [w, s, e, n] = box;
    const covers = (
      this.coversIn.all(layer.upstream, layer.typeName, since, w, e, s, n) as {
        w: number;
        s: number;
        e: number;
        n: number;
      }[]
    ).map((c): Box => [c.w, c.s, c.e, c.n]);
    return uncovered(box, covers).length === 0;
  }

  /** The kept features of `layer` whose boxes reach `box`, as row ids in a fixed order. */
  idsIn(layer: Layer, box: Box): number[] {
    const [w, s, e, n] = box;
    return (this.matching.all(layer.upstream, layer.typeName, w, e, s, n) as { id: number }[]).map(
      (r) => r.id
    );
  }

  /** The features kept under `ids`, in that order; one removed meanwhile is left out. */
  features(ids: readonly number[]): WfsFeature[] {
    const out: WfsFeature[] = [];
    for (const id of ids) {
      const row = this.dataOf.get(id) as { data: Uint8Array } | undefined;
      if (row) {
        out.push(JSON.parse(zlib.gunzipSync(row.data).toString('utf8')) as WfsFeature);
      }
    }
    return out;
  }

  stats(): WfsCacheStats {
    const count = (sql: string): number => (this.db.prepare(sql).get() as { n: number }).n;
    let bytes = 0;
    for (const f of [this.file, `${this.file}-wal`]) {
      try {
        bytes += fs.statSync(f).size;
      } catch {
        // No WAL file until the first write.
      }
    }
    return {
      features: count('SELECT COUNT(*) AS n FROM features'),
      areas: count('SELECT COUNT(*) AS n FROM covered'),
      bytes
    };
  }

  close(): void {
    this.db.close();
  }
}
