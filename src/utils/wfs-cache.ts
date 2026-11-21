/**
 * The local WFS proxy's store (`wfs-proxy.ts`): the areas it holds whole
 * (`covered`), each with when it was fetched. For an upstream answered by box
 * (Traficom's), each feature is kept once, by its id, with its box exactly and
 * in an R-tree; for any other, each area keeps the features it gave as it gave
 * them. The pages of a read upstream are staged and published in one
 * transaction once the area is whole, and not at all when a newer read of the
 * area was published meanwhile. A kept feature an area's answer reached that
 * its read did not return is noted absent from it (`covered_absent`): it may be
 * gone, or only reach the area by its own box, so it is kept for other areas, and
 * where the newest read holding a place did not return it, it is not answered
 * there (`answerIn`). A read from the store pins the features it
 * answers (`Pin`): one changed or dropped meanwhile is kept as it was for it.
 * Deleting the file loses nothing but downloads.
 */

import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import {
  answerBox,
  featureBox,
  featureId,
  uncovered,
  type Box,
  type WfsFeature
} from './wfs-query.js';

const SCHEMA_VERSION = '6';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS features (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    upstream TEXT NOT NULL,
    type_name TEXT NOT NULL,
    fid TEXT NOT NULL,
    ord REAL NOT NULL,
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
    mw REAL NOT NULL, ms REAL NOT NULL, me REAL NOT NULL, mn REAL NOT NULL,
    fetched_at INTEGER NOT NULL,
    ord REAL NOT NULL,
    started INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS covered_layer ON covered (upstream, type_name);
  CREATE TABLE IF NOT EXISTS covered_member (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    covered_id INTEGER NOT NULL,
    fid TEXT NOT NULL,
    data BLOB NOT NULL
  );
  CREATE INDEX IF NOT EXISTS covered_member_area ON covered_member (covered_id, fid);
  CREATE TABLE IF NOT EXISTS covered_absent (
    covered_id INTEGER NOT NULL,
    feature_id INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS covered_absent_feature ON covered_absent (feature_id);
  CREATE INDEX IF NOT EXISTS covered_absent_area ON covered_absent (covered_id);
  CREATE TABLE IF NOT EXISTS staged (
    stage INTEGER NOT NULL,
    fid TEXT NOT NULL,
    ord REAL NOT NULL,
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

/**
 * When a read began: the time, which its area's age is counted from, and its place in the
 * order of reads and pages (`orderAt`), which says what it saw. A number is both.
 */
export type ReadStart = number | { at: number; order: number };

const startOf = (start: ReadStart): { at: number; order: number } =>
  typeof start === 'number' ? { at: start, order: start } : start;

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
  ord: number;
  w: number;
  s: number;
  e: number;
  n: number;
  data: Uint8Array;
}

/** Margins this small are rounding where boxes meet edge to edge, degrees. */
const EPS = 1e-9;

const touches = (a: Box, b: Box): boolean =>
  a[2] >= b[0] - EPS && a[0] <= b[2] + EPS && a[3] >= b[1] - EPS && a[1] <= b[3] + EPS;

/**
 * `cover` as it holds `part`: a part with no width or no height, a line or a point, is held by
 * a cover whose edge it lies on, as the upstream answers what touches a box.
 */
function holding(part: Box, [w, s, e, n]: Box): Box {
  const dx = part[2] - part[0] <= EPS ? 2 * EPS : 0;
  const dy = part[3] - part[1] <= EPS ? 2 * EPS : 0;
  return [w - dx, s - dy, e + dx, n + dy];
}

interface HeldArea {
  id: number;
  box: Box;
  /** As far as its read's answer reached (`answerBox`). */
  margin: Box;
  /** Where its read began in the order of reads and pages. */
  order: number;
}

interface NotedAbsent {
  box: Box;
  /** Where its page came in the order of reads and pages. */
  order: number;
  /** The areas it is noted absent from. */
  covers: ReadonlySet<number>;
}

/**
 * Whether a feature noted absent from some areas belongs to an answer for `box`, from
 * `covers`, the newest first. Each place it reaches in `box` goes by the newest area holding
 * it: one that returned it (`seen`); one that did not, the feature not seen since its read
 * began (`gone`); or one that did not though another area's read has seen it since, which
 * tells nothing of this one (`unsure`). Kept where every place says seen, left out where
 * every one says gone, else undefined. A feature past `box`, in the margin of its answer,
 * goes by the newest area whose answer reached it, and is left out unless that one returned
 * it.
 */
function belongs(box: Box, feature: NotedAbsent, covers: readonly HeldArea[]): boolean | undefined {
  const say = (c: HeldArea): 'seen' | 'gone' | 'unsure' =>
    !feature.covers.has(c.id) ? 'seen' : feature.order < c.order ? 'gone' : 'unsure';
  const [fw, fs, fe, fn] = feature.box;
  const reach: Box = [
    Math.max(box[0], fw),
    Math.max(box[1], fs),
    Math.min(box[2], fe),
    Math.min(box[3], fn)
  ];
  if (reach[0] > reach[2] || reach[1] > reach[3]) {
    const newest = covers.find((c) => touches(feature.box, c.margin));
    return newest === undefined || say(newest) === 'seen';
  }
  const said = new Set<string>();
  let rest: Box[] = [reach];
  for (const c of covers) {
    if (rest.length === 0) {
      break;
    }
    const cover = holding(reach, c.box);
    const next = rest.flatMap((part) => uncovered(part, [cover]));
    if (next.length === rest.length && next.every((part, i) => part === rest[i])) {
      continue;
    }
    said.add(say(c));
    rest = next;
  }
  if (rest.length > 0) {
    said.add('seen');
  }
  if (said.size !== 1) {
    return undefined;
  }
  return said.has('seen') ? true : said.has('gone') ? false : undefined;
}

export class WfsCache {
  private readonly db: DatabaseSync;
  private readonly statements: Record<string, StatementSync>;
  private readonly pins = new Set<Pin>();
  private nextStage = 1;
  private lastOrder: number;

  constructor(readonly file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = openStore(file);
    try {
      this.statements = this.prepareAll();
      this.lastOrder =
        (
          this.db
            .prepare(
              'SELECT MAX(m) AS m FROM (SELECT MAX(ord) AS m FROM features UNION ALL SELECT MAX(ord) FROM covered)'
            )
            .get() as { m: number | null }
        ).m ?? -Infinity;
    } catch (err) {
      closeQuietly(this.db);
      throw err;
    }
  }

  /**
   * A place in the order of reads and pages for something at `now`: `now`, or just after the
   * last place given when that is later, in this process or one before it. A read begun after
   * a page came is ordered after it, in the same millisecond too and if the clock is set back;
   * an area's age is counted from its read's time, not from this.
   */
  orderAt(now: number): number {
    this.lastOrder = Math.max(now, this.lastOrder + 0.001);
    return this.lastOrder;
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
        INSERT INTO features (upstream, type_name, fid, ord, w, s, e, n, data)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (upstream, type_name, fid) DO UPDATE SET
          ord = excluded.ord, w = excluded.w, s = excluded.s, e = excluded.e,
          n = excluded.n, data = excluded.data
        WHERE excluded.ord >= features.ord
      `),
      rowOf: p(
        'SELECT id, w, s, e, n FROM features WHERE upstream = ? AND type_name = ? AND fid = ?'
      ),
      boxDelete: p('DELETE FROM feature_box WHERE id = ?'),
      boxInsert: p('INSERT INTO feature_box (id, minx, maxx, miny, maxy) VALUES (?, ?, ?, ?, ?)'),
      stageInsert: p(`
        INSERT OR REPLACE INTO staged (stage, fid, ord, w, s, e, n, data)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `),
      stagedOf: p('SELECT fid, ord, w, s, e, n, data FROM staged WHERE stage = ?'),
      stagedCount: p('SELECT COUNT(*) AS n FROM staged WHERE stage = ?'),
      stageDelete: p('DELETE FROM staged WHERE stage = ?'),
      coversIn: p(`
        SELECT w, s, e, n FROM covered
        WHERE upstream = ? AND type_name = ? AND fetched_at >= ?
          AND e > ? AND w < ? AND n > ? AND s < ?
      `),
      // Reads begun at the same place in the order are ordered by their stages.
      newerOverlapping: p(`
        SELECT 1 FROM covered
        WHERE upstream = ? AND type_name = ? AND (ord > ? OR (ord = ? AND started > ?))
          AND e > ? AND w < ? AND n > ? AND s < ? LIMIT 1
      `),
      newerSameBox: p(`
        SELECT 1 FROM covered
        WHERE upstream = ? AND type_name = ? AND box_text = ?
          AND (ord > ? OR (ord = ? AND started > ?)) LIMIT 1
      `),
      exactIn: p(`
        SELECT id FROM covered
        WHERE upstream = ? AND type_name = ? AND box_text = ? AND fetched_at >= ?
        ORDER BY ord DESC, started DESC, id DESC LIMIT 1
      `),
      coverInsert: p(`
        INSERT INTO covered
          (upstream, type_name, box_text, w, s, e, n, mw, ms, me, mn, fetched_at, ord, started)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      memberInsert: p('INSERT INTO covered_member (covered_id, fid, data) VALUES (?, ?, ?)'),
      // A box inside a newer one, its answer's margin inside the newer one's too, adds nothing
      // to an upstream answered by box: what its margin noted absent, the newer one noted too.
      containedCovers: p(`
        SELECT id FROM covered WHERE upstream = ? AND type_name = ?
          AND (ord < ? OR (ord = ? AND started <= ?))
          AND w >= ? AND s >= ? AND e <= ? AND n <= ?
          AND mw >= ? AND ms >= ? AND me <= ? AND mn <= ? AND id <> ?
      `),
      sameBoxCovers: p(`
        SELECT id FROM covered WHERE upstream = ? AND type_name = ? AND box_text = ?
          AND (ord < ? OR (ord = ? AND started <= ?)) AND id <> ?
      `),
      coverDelete: p('DELETE FROM covered WHERE id = ?'),
      membersDelete: p('DELETE FROM covered_member WHERE covered_id = ?'),
      matchingFids: p(`
        SELECT f.id AS id, f.fid AS fid FROM feature_box b JOIN features f ON f.id = b.id
        WHERE f.upstream = ? AND f.type_name = ?
          AND b.maxx >= ? AND b.minx <= ? AND b.maxy >= ? AND b.miny <= ?
          AND f.e >= ? AND f.w <= ? AND f.n >= ? AND f.s <= ?
      `),
      absentInsert: p('INSERT INTO covered_absent (covered_id, feature_id) VALUES (?, ?)'),
      // The areas whose answers reach a box, the newest first.
      coversNear: p(`
        SELECT id, w, s, e, n, mw, ms, me, mn, ord FROM covered
        WHERE upstream = ? AND type_name = ? AND me >= ? AND mw <= ? AND mn >= ? AND ms <= ?
          AND id <> ?
        ORDER BY ord DESC, started DESC, id DESC
      `),
      absencesOf: p(`
        SELECT a.feature_id AS id, a.covered_id AS cover,
          f.w AS w, f.s AS s, f.e AS e, f.n AS n, f.ord AS ord
        FROM covered_absent a JOIN features f ON f.id = a.feature_id
        WHERE a.feature_id IN (SELECT value FROM json_each(?))
      `),
      absentDeleteCover: p('DELETE FROM covered_absent WHERE covered_id = ?'),
      absentDeleteFeature: p('DELETE FROM covered_absent WHERE feature_id = ?'),
      unseenIn: p(`
        SELECT f.id AS id FROM feature_box b JOIN features f ON f.id = b.id
        WHERE f.upstream = ? AND f.type_name = ? AND f.ord < ?
          AND b.maxx >= ? AND b.minx <= ? AND b.maxy >= ? AND b.miny <= ?
          AND f.w >= ? AND f.e <= ? AND f.s >= ? AND f.n <= ?
      `),
      // Kept since the read began, by another read, reaching the box and not in its pages:
      // the read cannot say whether it is gone, as its pages may have passed before that
      // one was kept, and keeping the area would answer with it.
      keptMeanwhile: p(`
        SELECT 1 FROM feature_box b JOIN features f ON f.id = b.id
        WHERE f.upstream = ? AND f.type_name = ? AND f.ord >= ?
          AND b.maxx >= ? AND b.minx <= ? AND b.maxy >= ? AND b.miny <= ?
          AND f.e >= ? AND f.w <= ? AND f.n >= ? AND f.s <= ?
          AND f.fid NOT IN (SELECT fid FROM staged WHERE stage = ?)
        LIMIT 1
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
   * Stages `features`, received at `order` (`orderAt`); a feature staged before is replaced.
   * Returns false, staging none, when one is not an object or has no id or no
   * coordinates: such a page cannot be answered again from the store.
   */
  stage(stage: number, features: readonly WfsFeature[], order: number): boolean {
    if (features.some((f) => typeof f !== 'object' || f === null || Array.isArray(f))) {
      return false;
    }
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
          order,
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

  /**
   * Whether a read of `area` begun at `since` in the order is out of date: a newer read of it was
   * published, or (by box) a feature reaching it was kept meanwhile that its pages did
   * not give, which it can neither keep nor drop.
   */
  private superseded(
    stage: number | undefined,
    layer: Layer,
    area: Area,
    since: number,
    byBox: boolean
  ): boolean {
    const [w, s, e, n] = area.box;
    const started = stage ?? 0;
    if (!byBox) {
      return (
        this.q('newerSameBox').get(
          layer.upstream,
          layer.typeName,
          area.boxText,
          since,
          since,
          started
        ) !== undefined
      );
    }
    return (
      this.q('newerOverlapping').get(
        layer.upstream,
        layer.typeName,
        since,
        since,
        started,
        w,
        e,
        s,
        n
      ) !== undefined ||
      this.q('keptMeanwhile').get(
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
        n,
        stage ?? -1
      ) !== undefined
    );
  }

  /**
   * Publishes a whole read of `area` begun at `start`, in one transaction: the
   * features `stage` holds (none for a count of none) are kept, and the area is
   * held as of `start`. For an upstream answered `byBox`, a feature wholly inside
   * the box received before the read began and not read again is gone upstream and
   * dropped, and a box inside the new one is no longer held on its own; for any
   * other, the area keeps the features it gave as it gave them. A read that is
   * out of date (`superseded`) is not published: it would bring back what a
   * newer one dropped, or keep a feature it cannot tell is gone. Returns how
   * many features were dropped, or undefined when the read was not published.
   */
  publish(
    stage: number | undefined,
    layer: Layer,
    area: Area,
    start: ReadStart,
    byBox: boolean
  ): number | undefined {
    const { at, order: since } = startOf(start);
    return this.inTransaction(() => {
      if (this.superseded(stage, layer, area, since, byBox)) {
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
      const [mw, ms, me, mn] = byBox ? answerBox(area.box) : area.box;
      const started = stage ?? 0;
      const coveredId = Number(
        this.q('coverInsert').run(
          layer.upstream,
          layer.typeName,
          area.boxText,
          w,
          s,
          e,
          n,
          mw,
          ms,
          me,
          mn,
          at,
          since,
          started
        ).lastInsertRowid
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
          since,
          started,
          coveredId
        ) as { id: number }[]) {
          this.dropCover(id, true);
        }
        return 0;
      }
      for (const r of staged) {
        this.keepFeature(layer, r, coveredId);
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
        this.q('absentDeleteFeature').run(id);
      }
      // Its answer reached them, in its margin too, and its pages did not give them.
      const returned = new Set(staged.map((r) => r.fid));
      for (const r of this.q('matchingFids').all(
        layer.upstream,
        layer.typeName,
        mw,
        me,
        ms,
        mn,
        mw,
        me,
        ms,
        mn
      ) as { id: number; fid: string }[]) {
        if (!returned.has(r.fid)) {
          this.q('absentInsert').run(coveredId, r.id);
        }
      }
      for (const { id } of this.q('containedCovers').all(
        layer.upstream,
        layer.typeName,
        since,
        since,
        started,
        w,
        s,
        e,
        n,
        mw,
        ms,
        me,
        mn,
        coveredId
      ) as { id: number }[]) {
        this.dropCover(id, false);
      }
      return unseen.length;
    });
  }

  /**
   * Keeps a feature a read returned. The areas held already whose answers reach it now, and
   * did not before (it is new to the store, or moved), did not return it: it is noted absent
   * from them. A feature returned again stays noted absent where it was: that another area
   * returned it says nothing of those.
   */
  private keepFeature(layer: Layer, r: StagedRow, coveredId: number): void {
    const before = this.q('rowOf').get(layer.upstream, layer.typeName, r.fid) as
      { id: number; w: number; s: number; e: number; n: number } | undefined;
    if (before) {
      this.preserve('feature', before.id);
    }
    this.q('upsert').run(layer.upstream, layer.typeName, r.fid, r.ord, r.w, r.s, r.e, r.n, r.data);
    const row = this.q('rowOf').get(layer.upstream, layer.typeName, r.fid) as {
      id: number;
      w: number;
      s: number;
      e: number;
      n: number;
    };
    this.q('boxDelete').run(row.id);
    this.q('boxInsert').run(row.id, row.w, row.e, row.s, row.n);
    const was: Box | undefined = before && [before.w, before.s, before.e, before.n];
    for (const c of this.q('coversNear').all(
      layer.upstream,
      layer.typeName,
      row.w,
      row.e,
      row.s,
      row.n,
      coveredId
    ) as { id: number; mw: number; ms: number; me: number; mn: number }[]) {
      if (!was || !touches(was, [c.mw, c.ms, c.me, c.mn])) {
        this.q('absentInsert').run(c.id, row.id);
      }
    }
  }

  private dropCover(id: number, withMembers: boolean): void {
    if (withMembers) {
      for (const m of this.q('membersOf').all(id) as { id: number }[]) {
        this.preserve('member', m.id);
      }
    }
    this.q('coverDelete').run(id);
    this.q('membersDelete').run(id);
    this.q('absentDeleteCover').run(id);
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

  /**
   * For an upstream answered by box, the kept features of `layer` whose boxes reach
   * `answer`, pinned for one read of `box`, leaving out each one the newest reads holding
   * where it reaches `box` did not return (`belongs`). Undefined when the store cannot
   * tell whether one belongs to the answer.
   */
  answerIn(layer: Layer, box: Box, answer: Box): Pin | undefined {
    const ids = this.idsIn(layer, answer);
    const absent = new Map<number, NotedAbsent & { covers: Set<number> }>();
    for (const r of this.q('absencesOf').all(JSON.stringify(ids)) as {
      id: number;
      cover: number;
      w: number;
      s: number;
      e: number;
      n: number;
      ord: number;
    }[]) {
      let a = absent.get(r.id);
      if (!a) {
        a = { box: [r.w, r.s, r.e, r.n], order: r.ord, covers: new Set() };
        absent.set(r.id, a);
      }
      a.covers.add(r.cover);
    }
    if (absent.size === 0) {
      return this.pin('feature', ids);
    }
    const [aw, as, ae, an] = answer;
    const covers = (
      this.q('coversNear').all(layer.upstream, layer.typeName, aw, ae, as, an, -1) as {
        id: number;
        w: number;
        s: number;
        e: number;
        n: number;
        mw: number;
        ms: number;
        me: number;
        mn: number;
        ord: number;
      }[]
    ).map((c): HeldArea => ({
      id: c.id,
      box: [c.w, c.s, c.e, c.n],
      margin: [c.mw, c.ms, c.me, c.mn],
      order: c.ord
    }));
    const left = new Set<number>();
    for (const [id, feature] of absent) {
      const kept = belongs(box, feature, covers);
      if (kept === undefined) {
        return undefined;
      }
      if (!kept) {
        left.add(id);
      }
    }
    return this.pin(
      'feature',
      ids.filter((id) => !left.has(id))
    );
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
