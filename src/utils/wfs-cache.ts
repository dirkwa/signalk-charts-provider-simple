/**
 * The local WFS proxy's store (`wfs-proxy.ts`): each feature once, by its id,
 * with its box exactly and in an R-tree, and the areas it holds whole
 * (`covered`), each with when it was fetched and, for an upstream answered
 * only box by box, the features that box gave. The pages of a read upstream
 * are staged and published in one transaction once the area is whole, so a
 * read that breaks off changes nothing. A read from the store reads a
 * snapshot (`snapshot`), so what is published meanwhile does not reach it.
 * Deleting the file loses nothing but downloads.
 */

import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { featureBox, featureId, uncovered, type Box, type WfsFeature } from './wfs-query.js';

const SCHEMA_VERSION = '2';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS features (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    upstream TEXT NOT NULL,
    type_name TEXT NOT NULL,
    fid TEXT NOT NULL,
    fetched_at INTEGER NOT NULL,
    w REAL NOT NULL, s REAL NOT NULL, e REAL NOT NULL, n REAL NOT NULL,
    data BLOB NOT NULL,
    UNIQUE (upstream, type_name, fid)
  );
  CREATE VIRTUAL TABLE IF NOT EXISTS feature_box USING rtree(id, minx, maxx, miny, maxy);
  CREATE TABLE IF NOT EXISTS covered (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    upstream TEXT NOT NULL,
    type_name TEXT NOT NULL,
    box_text TEXT NOT NULL,
    w REAL NOT NULL, s REAL NOT NULL, e REAL NOT NULL, n REAL NOT NULL,
    fetched_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS covered_layer ON covered (upstream, type_name);
  CREATE TABLE IF NOT EXISTS covered_member (
    covered_id INTEGER NOT NULL,
    feature_id INTEGER NOT NULL,
    PRIMARY KEY (covered_id, feature_id)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS covered_member_feature ON covered_member (feature_id);
  CREATE TABLE IF NOT EXISTS staged (
    stage INTEGER NOT NULL,
    fid TEXT NOT NULL,
    fetched_at INTEGER NOT NULL,
    w REAL NOT NULL, s REAL NOT NULL, e REAL NOT NULL, n REAL NOT NULL,
    data BLOB NOT NULL,
    UNIQUE (stage, fid)
  );
`;

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

/** An area read whole: its box, and the box as its requests wrote it. */
export interface Area {
  box: Box;
  boxText: string;
}

const closeQuietly = (db: DatabaseSync): void => {
  try {
    db.close();
  } catch {
    // Already closed.
  }
};

/** The store at `file`, in this schema; a store of another schema is only downloads, so begun again. */
function openStore(file: string): DatabaseSync {
  let db = new DatabaseSync(file);
  try {
    db.exec('CREATE TABLE IF NOT EXISTS meta (name TEXT PRIMARY KEY, value TEXT)');
    const version = (
      db.prepare("SELECT value FROM meta WHERE name = 'schema'").get() as
        { value: string } | undefined
    )?.value;
    if (version !== undefined && version !== SCHEMA_VERSION) {
      db.close();
      for (const f of [file, `${file}-wal`, `${file}-shm`]) {
        fs.rmSync(f, { force: true });
      }
      db = new DatabaseSync(file);
      db.exec('CREATE TABLE IF NOT EXISTS meta (name TEXT PRIMARY KEY, value TEXT)');
    }
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(SCHEMA);
    db.prepare("INSERT OR IGNORE INTO meta (name, value) VALUES ('schema', ?)").run(SCHEMA_VERSION);
    // Stages of a process that ended mid-read.
    db.exec('DELETE FROM staged');
    return db;
  } catch (err) {
    closeQuietly(db);
    throw err;
  }
}

const gunzipFeature = (data: Uint8Array): WfsFeature =>
  JSON.parse(zlib.gunzipSync(data).toString('utf8')) as WfsFeature;

/** Reads of kept features, on one connection. */
class FeatureReader {
  private readonly matching: StatementSync;
  private readonly membersOf: StatementSync;
  private readonly dataOf: StatementSync;

  constructor(db: DatabaseSync) {
    // The R-tree rounds boxes outwards: it finds candidates, the exact box decides.
    this.matching = db.prepare(`
      SELECT f.id AS id FROM feature_box b JOIN features f ON f.id = b.id
      WHERE f.upstream = ? AND f.type_name = ?
        AND b.maxx >= ? AND b.minx <= ? AND b.maxy >= ? AND b.miny <= ?
        AND f.e >= ? AND f.w <= ? AND f.n >= ? AND f.s <= ?
      ORDER BY f.fid
    `);
    this.membersOf = db.prepare(`
      SELECT f.id AS id FROM covered_member m JOIN features f ON f.id = m.feature_id
      WHERE m.covered_id = ? ORDER BY f.fid
    `);
    this.dataOf = db.prepare('SELECT data FROM features WHERE id = ?');
  }

  /** The kept features of `layer` whose boxes reach `box`, as row ids in a fixed order. */
  idsIn(layer: Layer, box: Box): number[] {
    const [w, s, e, n] = box;
    return (
      this.matching.all(layer.upstream, layer.typeName, w, e, s, n, w, e, s, n) as { id: number }[]
    ).map((r) => r.id);
  }

  /** The features an area held box by box gave (`WfsCache.exactCover`), as row ids in a fixed order. */
  members(coveredId: number): number[] {
    return (this.membersOf.all(coveredId) as { id: number }[]).map((r) => r.id);
  }

  /** The features kept under `ids`, by id. */
  featuresById(ids: readonly number[]): Map<number, WfsFeature> {
    const out = new Map<number, WfsFeature>();
    for (const id of ids) {
      const row = this.dataOf.get(id) as { data: Uint8Array } | undefined;
      if (row) {
        out.set(id, gunzipFeature(row.data));
      }
    }
    return out;
  }

  /** The features kept under `ids`, in that order. */
  features(ids: readonly number[]): WfsFeature[] {
    const byId = this.featuresById(ids);
    return ids.flatMap((id) => byId.get(id) ?? []);
  }
}

/**
 * The store as it was when the snapshot was taken, for one read from the store:
 * its count and its pages agree, whatever is published or dropped meanwhile.
 */
export class CacheSnapshot extends FeatureReader {
  constructor(
    private readonly db: DatabaseSync,
    private readonly onClose: (s: CacheSnapshot) => void
  ) {
    super(db);
  }

  close(): void {
    try {
      this.db.exec('COMMIT');
    } catch {
      // No transaction open.
    }
    closeQuietly(this.db);
    this.onClose(this);
  }
}

export class WfsCache {
  private readonly db: DatabaseSync;
  private readonly reader: FeatureReader;
  private readonly upsert: StatementSync;
  private readonly rowOf: StatementSync;
  private readonly boxDelete: StatementSync;
  private readonly boxInsert: StatementSync;
  private readonly stageInsert: StatementSync;
  private readonly stagedOf: StatementSync;
  private readonly stageDelete: StatementSync;
  private readonly coversIn: StatementSync;
  private readonly exactIn: StatementSync;
  private readonly coverInsert: StatementSync;
  private readonly memberInsert: StatementSync;
  private readonly containedCovers: StatementSync;
  private readonly sameBoxCovers: StatementSync;
  private readonly coverDelete: StatementSync;
  private readonly membersDelete: StatementSync;
  private readonly unseenIn: StatementSync;
  private readonly featureDelete: StatementSync;
  private readonly featureMembersDelete: StatementSync;
  private readonly snapshots = new Set<CacheSnapshot>();
  private nextStage = 1;

  constructor(readonly file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = openStore(file);
    try {
      this.reader = new FeatureReader(this.db);
      // A page received later replaces a kept feature; one received earlier does not.
      this.upsert = this.db.prepare(`
        INSERT INTO features (upstream, type_name, fid, fetched_at, w, s, e, n, data)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (upstream, type_name, fid) DO UPDATE SET
          fetched_at = excluded.fetched_at, w = excluded.w, s = excluded.s, e = excluded.e,
          n = excluded.n, data = excluded.data
        WHERE excluded.fetched_at >= features.fetched_at
      `);
      this.rowOf = this.db.prepare(
        'SELECT id, w, s, e, n FROM features WHERE upstream = ? AND type_name = ? AND fid = ?'
      );
      this.boxDelete = this.db.prepare('DELETE FROM feature_box WHERE id = ?');
      this.boxInsert = this.db.prepare(
        'INSERT INTO feature_box (id, minx, maxx, miny, maxy) VALUES (?, ?, ?, ?, ?)'
      );
      this.stageInsert = this.db.prepare(`
        INSERT OR REPLACE INTO staged (stage, fid, fetched_at, w, s, e, n, data)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      this.stagedOf = this.db.prepare(
        'SELECT fid, fetched_at, w, s, e, n, data FROM staged WHERE stage = ?'
      );
      this.stageDelete = this.db.prepare('DELETE FROM staged WHERE stage = ?');
      this.coversIn = this.db.prepare(`
        SELECT w, s, e, n FROM covered
        WHERE upstream = ? AND type_name = ? AND fetched_at >= ?
          AND e > ? AND w < ? AND n > ? AND s < ?
      `);
      this.exactIn = this.db.prepare(`
        SELECT id FROM covered
        WHERE upstream = ? AND type_name = ? AND box_text = ? AND fetched_at >= ?
        ORDER BY fetched_at DESC, id DESC LIMIT 1
      `);
      this.coverInsert = this.db.prepare(`
        INSERT INTO covered (upstream, type_name, box_text, w, s, e, n, fetched_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      this.memberInsert = this.db.prepare(
        'INSERT OR IGNORE INTO covered_member (covered_id, feature_id) VALUES (?, ?)'
      );
      // A box inside a newer one adds nothing to an upstream answered by box.
      this.containedCovers = this.db.prepare(`
        SELECT id FROM covered WHERE upstream = ? AND type_name = ? AND fetched_at <= ?
          AND w >= ? AND s >= ? AND e <= ? AND n <= ? AND id <> ?
      `);
      this.sameBoxCovers = this.db.prepare(`
        SELECT id FROM covered WHERE upstream = ? AND type_name = ? AND box_text = ?
          AND fetched_at <= ? AND id <> ?
      `);
      this.coverDelete = this.db.prepare('DELETE FROM covered WHERE id = ?');
      this.membersDelete = this.db.prepare('DELETE FROM covered_member WHERE covered_id = ?');
      this.unseenIn = this.db.prepare(`
        SELECT f.id AS id FROM feature_box b JOIN features f ON f.id = b.id
        WHERE f.upstream = ? AND f.type_name = ? AND f.fetched_at < ?
          AND b.maxx >= ? AND b.minx <= ? AND b.maxy >= ? AND b.miny <= ?
          AND f.w >= ? AND f.e <= ? AND f.s >= ? AND f.n <= ?
      `);
      this.featureDelete = this.db.prepare('DELETE FROM features WHERE id = ?');
      this.featureMembersDelete = this.db.prepare(
        'DELETE FROM covered_member WHERE feature_id = ?'
      );
    } catch (err) {
      closeQuietly(this.db);
      throw err;
    }
  }

  private inTransaction<T>(work: () => T): T {
    this.db.exec('BEGIN');
    try {
      const out = work();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** A new stage for the pages of one read upstream. */
  beginStage(): number {
    return this.nextStage++;
  }

  /**
   * Stages `features`, received at `at`; a feature staged before is replaced.
   * Returns false, staging none, when one has no id or no coordinates: such a
   * page cannot be answered again from the store.
   */
  stage(stage: number, features: readonly WfsFeature[], at: number): boolean {
    const rows = features.map((f) => ({ f, id: featureId(f), box: featureBox(f) }));
    if (rows.some((r) => r.id === undefined || r.box === undefined)) {
      return false;
    }
    this.inTransaction(() => {
      for (const { f, id, box } of rows) {
        const [w, s, e, n] = box as Box;
        this.stageInsert.run(stage, id as string, at, w, s, e, n, zlib.gzipSync(JSON.stringify(f)));
      }
    });
    return true;
  }

  dropStage(stage: number): void {
    this.stageDelete.run(stage);
  }

  /**
   * Publishes a whole read of `area` begun at `since`, in one transaction: the
   * features `stage` holds (none for a count of none) are kept, and the area is
   * held as of `since`. For an upstream answered `byBox`, a feature wholly inside
   * the box fetched before `since` and not read again is gone upstream and
   * dropped, and a box inside the new one is no longer held on its own; for any
   * other, the area keeps the features it gave. Returns how many were dropped.
   */
  publish(
    stage: number | undefined,
    layer: Layer,
    area: Area,
    since: number,
    byBox: boolean
  ): number {
    return this.inTransaction(() => {
      const members: number[] = [];
      if (stage !== undefined) {
        for (const r of this.stagedOf.all(stage) as {
          fid: string;
          fetched_at: number;
          w: number;
          s: number;
          e: number;
          n: number;
          data: Uint8Array;
        }[]) {
          this.upsert.run(
            layer.upstream,
            layer.typeName,
            r.fid,
            r.fetched_at,
            r.w,
            r.s,
            r.e,
            r.n,
            r.data
          );
          const row = this.rowOf.get(layer.upstream, layer.typeName, r.fid) as {
            id: number;
            w: number;
            s: number;
            e: number;
            n: number;
          };
          this.boxDelete.run(row.id);
          this.boxInsert.run(row.id, row.w, row.e, row.s, row.n);
          members.push(row.id);
        }
        this.stageDelete.run(stage);
      }
      const [w, s, e, n] = area.box;
      let dropped = 0;
      if (byBox) {
        const unseen = this.unseenIn.all(
          layer.upstream,
          layer.typeName,
          since,
          w,
          e,
          s,
          n,
          w,
          e,
          s,
          n
        ) as { id: number }[];
        for (const { id } of unseen) {
          this.featureDelete.run(id);
          this.boxDelete.run(id);
          this.featureMembersDelete.run(id);
        }
        dropped = unseen.length;
      }
      const coveredId = Number(
        this.coverInsert.run(layer.upstream, layer.typeName, area.boxText, w, s, e, n, since)
          .lastInsertRowid
      );
      const replaced = byBox
        ? this.containedCovers.all(layer.upstream, layer.typeName, since, w, s, e, n, coveredId)
        : this.sameBoxCovers.all(layer.upstream, layer.typeName, area.boxText, since, coveredId);
      for (const { id } of replaced as { id: number }[]) {
        this.coverDelete.run(id);
        this.membersDelete.run(id);
      }
      if (!byBox) {
        for (const id of members) {
          this.memberInsert.run(coveredId, id);
        }
      }
      return dropped;
    });
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

  /** The newest read whole of the box `boxText` fetched at `since` or later, by its id. */
  exactCover(layer: Layer, boxText: string, since: number): number | undefined {
    const row = this.exactIn.get(layer.upstream, layer.typeName, boxText, since) as
      { id: number } | undefined;
    return row?.id;
  }

  /** The kept features of `layer` whose boxes reach `box`, as row ids in a fixed order. */
  idsIn(layer: Layer, box: Box): number[] {
    return this.reader.idsIn(layer, box);
  }

  /** The features kept under `ids`, in that order. */
  features(ids: readonly number[]): WfsFeature[] {
    return this.reader.features(ids);
  }

  /** The store as it is now, until the snapshot is closed. */
  snapshot(): CacheSnapshot {
    const db = new DatabaseSync(this.file, { readOnly: true });
    try {
      db.exec('BEGIN');
      // A read transaction takes its snapshot at its first read.
      db.prepare('SELECT 1 FROM features LIMIT 1').get();
      const snapshot = new CacheSnapshot(db, (s) => this.snapshots.delete(s));
      this.snapshots.add(snapshot);
      return snapshot;
    } catch (err) {
      closeQuietly(db);
      throw err;
    }
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
    for (const s of [...this.snapshots]) {
      s.close();
    }
    this.db.close();
  }
}
