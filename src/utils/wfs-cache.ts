/**
 * The local WFS proxy's store (`wfs-proxy.ts`): the areas it holds whole
 * (`covered`), each with when it was fetched. For an upstream answered by box
 * (Traficom's), each feature is kept once, by its id, with its box exactly and
 * in an R-tree; for any other, each area keeps the features it gave as it gave
 * them. The pages of a read upstream are staged and published in one
 * transaction once the area is whole, and not at all when a newer read of the
 * area was published meanwhile. A read from the store pins the features it
 * answers (`Pin`): one changed or dropped meanwhile is kept as it was for it.
 * Deleting the file loses nothing but downloads.
 */

import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { featureBox, featureId, uncovered, type Box, type WfsFeature } from './wfs-query.js';

const SCHEMA_VERSION = '3';

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
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    covered_id INTEGER NOT NULL,
    fid TEXT NOT NULL,
    data BLOB NOT NULL
  );
  CREATE INDEX IF NOT EXISTS covered_member_area ON covered_member (covered_id, fid);
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

type RowKind = 'feature' | 'member';

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

/**
 * The features one read from the store answers, in a fixed order: each as it was when the
 * read began, however the store changes until `release`.
 */
export class Pin {
  /** Rows changed or dropped since the pin was taken, as they were; null for none. */
  readonly saved = new Map<number, Uint8Array | null>();
  readonly members: ReadonlySet<number>;

  constructor(
    readonly kind: RowKind,
    /** Row ids in the read's order. */
    readonly ids: readonly number[],
    private readonly current: (kind: RowKind, id: number) => Uint8Array | undefined,
    private readonly onRelease: (pin: Pin) => void
  ) {
    this.members = new Set(ids);
  }

  /** Keeps row `id` as it is now, before it changes. */
  preserve(id: number): void {
    if (this.members.has(id) && !this.saved.has(id)) {
      this.saved.set(id, this.current(this.kind, id) ?? null);
    }
  }

  /** The features under `ids`, as the pin holds them, by id. */
  featuresById(ids: readonly number[]): Map<number, WfsFeature> {
    const out = new Map<number, WfsFeature>();
    for (const id of ids) {
      const data = this.saved.has(id) ? this.saved.get(id) : this.current(this.kind, id);
      if (data) {
        out.set(id, gunzipFeature(data));
      }
    }
    return out;
  }

  /** The features under `ids`, in that order. */
  features(ids: readonly number[]): WfsFeature[] {
    const byId = this.featuresById(ids);
    return ids.flatMap((id) => byId.get(id) ?? []);
  }

  release(): void {
    this.onRelease(this);
  }
}

interface StagedRow {
  fid: string;
  fetched_at: number;
  w: number;
  s: number;
  e: number;
  n: number;
  data: Uint8Array;
}

export class WfsCache {
  private readonly db: DatabaseSync;
  private readonly statements: Record<string, StatementSync>;
  private readonly pins = new Set<Pin>();
  private nextStage = 1;

  constructor(readonly file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = openStore(file);
    try {
      this.statements = this.prepareAll();
    } catch (err) {
      closeQuietly(this.db);
      throw err;
    }
  }

  private prepareAll(): Record<string, StatementSync> {
    const p = (sql: string): StatementSync => this.db.prepare(sql);
    return {
      // The R-tree rounds boxes outwards: it finds candidates, the exact box decides.
      matching: p(`
        SELECT f.id AS id FROM feature_box b JOIN features f ON f.id = b.id
        WHERE f.upstream = ? AND f.type_name = ?
          AND b.maxx >= ? AND b.minx <= ? AND b.maxy >= ? AND b.miny <= ?
          AND f.e >= ? AND f.w <= ? AND f.n >= ? AND f.s <= ?
        ORDER BY f.fid
      `),
      membersOf: p('SELECT id FROM covered_member WHERE covered_id = ? ORDER BY fid'),
      featureData: p('SELECT data FROM features WHERE id = ?'),
      memberData: p('SELECT data FROM covered_member WHERE id = ?'),
      // A page received later replaces a kept feature; one received earlier does not.
      upsert: p(`
        INSERT INTO features (upstream, type_name, fid, fetched_at, w, s, e, n, data)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (upstream, type_name, fid) DO UPDATE SET
          fetched_at = excluded.fetched_at, w = excluded.w, s = excluded.s, e = excluded.e,
          n = excluded.n, data = excluded.data
        WHERE excluded.fetched_at >= features.fetched_at
      `),
      rowOf: p(
        'SELECT id, w, s, e, n FROM features WHERE upstream = ? AND type_name = ? AND fid = ?'
      ),
      boxDelete: p('DELETE FROM feature_box WHERE id = ?'),
      boxInsert: p('INSERT INTO feature_box (id, minx, maxx, miny, maxy) VALUES (?, ?, ?, ?, ?)'),
      stageInsert: p(`
        INSERT OR REPLACE INTO staged (stage, fid, fetched_at, w, s, e, n, data)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `),
      stagedOf: p('SELECT fid, fetched_at, w, s, e, n, data FROM staged WHERE stage = ?'),
      stagedCount: p('SELECT COUNT(*) AS n FROM staged WHERE stage = ?'),
      stageDelete: p('DELETE FROM staged WHERE stage = ?'),
      coversIn: p(`
        SELECT w, s, e, n FROM covered
        WHERE upstream = ? AND type_name = ? AND fetched_at >= ?
          AND e > ? AND w < ? AND n > ? AND s < ?
      `),
      newerOverlapping: p(`
        SELECT 1 FROM covered
        WHERE upstream = ? AND type_name = ? AND fetched_at > ?
          AND e > ? AND w < ? AND n > ? AND s < ? LIMIT 1
      `),
      newerSameBox: p(`
        SELECT 1 FROM covered
        WHERE upstream = ? AND type_name = ? AND box_text = ? AND fetched_at > ? LIMIT 1
      `),
      exactIn: p(`
        SELECT id FROM covered
        WHERE upstream = ? AND type_name = ? AND box_text = ? AND fetched_at >= ?
        ORDER BY fetched_at DESC, id DESC LIMIT 1
      `),
      coverInsert: p(`
        INSERT INTO covered (upstream, type_name, box_text, w, s, e, n, fetched_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `),
      memberInsert: p('INSERT INTO covered_member (covered_id, fid, data) VALUES (?, ?, ?)'),
      // A box inside a newer one adds nothing to an upstream answered by box.
      containedCovers: p(`
        SELECT id FROM covered WHERE upstream = ? AND type_name = ? AND fetched_at <= ?
          AND w >= ? AND s >= ? AND e <= ? AND n <= ? AND id <> ?
      `),
      sameBoxCovers: p(`
        SELECT id FROM covered WHERE upstream = ? AND type_name = ? AND box_text = ?
          AND fetched_at <= ? AND id <> ?
      `),
      coverDelete: p('DELETE FROM covered WHERE id = ?'),
      membersDelete: p('DELETE FROM covered_member WHERE covered_id = ?'),
      unseenIn: p(`
        SELECT f.id AS id FROM feature_box b JOIN features f ON f.id = b.id
        WHERE f.upstream = ? AND f.type_name = ? AND f.fetched_at < ?
          AND b.maxx >= ? AND b.minx <= ? AND b.maxy >= ? AND b.miny <= ?
          AND f.w >= ? AND f.e <= ? AND f.s >= ? AND f.n <= ?
      `),
      featureDelete: p('DELETE FROM features WHERE id = ?')
    };
  }

  private q(name: string): StatementSync {
    return this.statements[name];
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

  private currentData = (kind: RowKind, id: number): Uint8Array | undefined =>
    (
      this.q(kind === 'feature' ? 'featureData' : 'memberData').get(id) as
        { data: Uint8Array } | undefined
    )?.data;

  /** Keeps row `id` as it is for the reads that pinned it, before it changes or goes. */
  private preserve(kind: RowKind, id: number): void {
    for (const pin of this.pins) {
      if (pin.kind === kind) {
        pin.preserve(id);
      }
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
        this.q('stageInsert').run(
          stage,
          id as string,
          at,
          w,
          s,
          e,
          n,
          zlib.gzipSync(JSON.stringify(f))
        );
      }
    });
    return true;
  }

  /** How many distinct features `stage` holds. */
  stagedCount(stage: number): number {
    return (this.q('stagedCount').get(stage) as { n: number }).n;
  }

  dropStage(stage: number): void {
    this.q('stageDelete').run(stage);
  }

  /** Whether a read of `area` published after `since` makes one begun then out of date. */
  private superseded(layer: Layer, area: Area, since: number, byBox: boolean): boolean {
    const [w, s, e, n] = area.box;
    const newer = byBox
      ? this.q('newerOverlapping').get(layer.upstream, layer.typeName, since, w, e, s, n)
      : this.q('newerSameBox').get(layer.upstream, layer.typeName, area.boxText, since);
    return newer !== undefined;
  }

  /**
   * Publishes a whole read of `area` begun at `since`, in one transaction: the
   * features `stage` holds (none for a count of none) are kept, and the area is
   * held as of `since`. For an upstream answered `byBox`, a feature wholly inside
   * the box fetched before `since` and not read again is gone upstream and
   * dropped, and a box inside the new one is no longer held on its own; for any
   * other, the area keeps the features it gave as it gave them. A read of an
   * area that a newer one overlapping it was published for is not published:
   * it would bring back what the newer one dropped. Returns how many features
   * were dropped, or undefined when the read was not published.
   */
  publish(
    stage: number | undefined,
    layer: Layer,
    area: Area,
    since: number,
    byBox: boolean
  ): number | undefined {
    return this.inTransaction(() => {
      if (this.superseded(layer, area, since, byBox)) {
        if (stage !== undefined) {
          this.q('stageDelete').run(stage);
        }
        return undefined;
      }
      const staged =
        stage === undefined ? [] : (this.q('stagedOf').all(stage) as unknown as StagedRow[]);
      if (stage !== undefined) {
        this.q('stageDelete').run(stage);
      }
      const [w, s, e, n] = area.box;
      const coveredId = Number(
        this.q('coverInsert').run(layer.upstream, layer.typeName, area.boxText, w, s, e, n, since)
          .lastInsertRowid
      );
      if (!byBox) {
        for (const r of staged) {
          this.q('memberInsert').run(coveredId, r.fid, r.data);
        }
        for (const { id } of this.q('sameBoxCovers').all(
          layer.upstream,
          layer.typeName,
          area.boxText,
          since,
          coveredId
        ) as { id: number }[]) {
          this.dropCover(id, true);
        }
        return 0;
      }
      for (const r of staged) {
        this.keepFeature(layer, r);
      }
      const unseen = this.q('unseenIn').all(
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
        this.preserve('feature', id);
        this.q('featureDelete').run(id);
        this.q('boxDelete').run(id);
      }
      for (const { id } of this.q('containedCovers').all(
        layer.upstream,
        layer.typeName,
        since,
        w,
        s,
        e,
        n,
        coveredId
      ) as { id: number }[]) {
        this.dropCover(id, false);
      }
      return unseen.length;
    });
  }

  private keepFeature(layer: Layer, r: StagedRow): void {
    const before = this.q('rowOf').get(layer.upstream, layer.typeName, r.fid) as
      { id: number } | undefined;
    if (before) {
      this.preserve('feature', before.id);
    }
    this.q('upsert').run(
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
    const row = this.q('rowOf').get(layer.upstream, layer.typeName, r.fid) as {
      id: number;
      w: number;
      s: number;
      e: number;
      n: number;
    };
    this.q('boxDelete').run(row.id);
    this.q('boxInsert').run(row.id, row.w, row.e, row.s, row.n);
  }

  private dropCover(id: number, withMembers: boolean): void {
    if (withMembers) {
      for (const m of this.q('membersOf').all(id) as { id: number }[]) {
        this.preserve('member', m.id);
      }
    }
    this.q('coverDelete').run(id);
    this.q('membersDelete').run(id);
  }

  /** Whether boxes fetched at `since` or later hold every feature of `layer` reaching `box`. */
  covers(layer: Layer, box: Box, since: number): boolean {
    const [w, s, e, n] = box;
    const covers = (
      this.q('coversIn').all(layer.upstream, layer.typeName, since, w, e, s, n) as {
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
    const row = this.q('exactIn').get(layer.upstream, layer.typeName, boxText, since) as
      { id: number } | undefined;
    return row?.id;
  }

  /** The kept features of `layer` whose boxes reach `box`, as row ids in a fixed order. */
  idsIn(layer: Layer, box: Box): number[] {
    const [w, s, e, n] = box;
    return (
      this.q('matching').all(layer.upstream, layer.typeName, w, e, s, n, w, e, s, n) as {
        id: number;
      }[]
    ).map((r) => r.id);
  }

  /** The features kept under `ids`, in that order. */
  features(ids: readonly number[]): WfsFeature[] {
    return ids.flatMap((id) => {
      const data = this.currentData('feature', id);
      return data ? [gunzipFeature(data)] : [];
    });
  }

  private pin(kind: RowKind, ids: number[]): Pin {
    const pin = new Pin(kind, ids, this.currentData, (p) => this.pins.delete(p));
    this.pins.add(pin);
    return pin;
  }

  /** The kept features of `layer` whose boxes reach `box`, pinned for one read. */
  pinIn(layer: Layer, box: Box): Pin {
    return this.pin('feature', this.idsIn(layer, box));
  }

  /** The features the read whole `coveredId` (`exactCover`) gave, pinned for one read. */
  pinArea(coveredId: number): Pin {
    return this.pin(
      'member',
      (this.q('membersOf').all(coveredId) as { id: number }[]).map((r) => r.id)
    );
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
      features:
        count('SELECT COUNT(*) AS n FROM features') +
        count('SELECT COUNT(*) AS n FROM covered_member'),
      areas: count('SELECT COUNT(*) AS n FROM covered'),
      bytes
    };
  }

  close(): void {
    this.pins.clear();
    this.db.close();
  }
}
