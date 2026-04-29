import fs from 'fs';

/**
 * Load `node:sqlite` lazily and report the precise failure mode if it isn't
 * available. The module was unflagged in Node 22.5; older Nodes throw a
 * different error than "module exists but DatabaseSync isn't there", and we
 * want both diagnosable from logs.
 */
function loadSqlite():
  | { ok: true; DatabaseSync: typeof import('node:sqlite').DatabaseSync }
  | { ok: false; reason: string } {
  let mod: typeof import('node:sqlite');
  try {
    mod = require('node:sqlite') as typeof import('node:sqlite');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      reason: `node:sqlite module load failed (Node version <22.5 or experimental flag missing?): ${msg}`
    };
  }
  if (typeof mod.DatabaseSync !== 'function') {
    return {
      ok: false,
      reason: 'node:sqlite loaded but DatabaseSync is not a function'
    };
  }
  return { ok: true, DatabaseSync: mod.DatabaseSync };
}

export interface PatchResult {
  ok: boolean;
  type: string | null;
  name: string | null;
  /** Number of attempts made (1 = succeeded first try, 2 = retry succeeded, 0 = sqlite unavailable). */
  attempts: number;
  /** Human-readable diagnostic when ok=false (and a few hints when ok=true). */
  message: string;
}

interface PatchOptions {
  /** Sleep callback for the retry — defaults to a real setTimeout. Tests inject. */
  sleep?: (ms: number) => Promise<void>;
  /** Retry delay in ms (default 500). */
  retryDelayMs?: number;
  /** Callback for progress / failure messages. Caller wires this to appendLog + console.warn. */
  onMessage?: (msg: string) => void;
}

const DEFAULT_RETRY_MS = 500;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Overwrite tippecanoe's default `type=overlay` and `name=/output/...` with
 * the Signal-K-friendly `type=S-57` and `name=S-57 <chart>`. The patcher used
 * to be a one-line try/catch buried inside processS57Zip — failures only
 * logged via `app.debug()`, which is invisible by default. A user reported a
 * .mbtiles still showing tippecanoe defaults and we couldn't tell why; this
 * helper is the loud, retried, verified replacement.
 *
 * Best-effort: never throws. Caller decides whether a failed patch is worth
 * surfacing further (e.g. setPluginError). The .mbtiles file is still
 * functionally a chart even when the patch fails — only the metadata is off.
 */
export async function patchS57Mbtiles(
  outputPath: string,
  chartNumber: string,
  options: PatchOptions = {}
): Promise<PatchResult> {
  const sleeper = options.sleep ?? sleep;
  const retryMs = options.retryDelayMs ?? DEFAULT_RETRY_MS;
  const log = (m: string): void => options.onMessage?.(m);

  if (!fs.existsSync(outputPath)) {
    const message = `MBTiles file does not exist: ${outputPath}`;
    log(message);
    return { ok: false, type: null, name: null, attempts: 0, message };
  }

  const sqlite = loadSqlite();
  if (!sqlite.ok) {
    log(sqlite.reason);
    return { ok: false, type: null, name: null, attempts: 0, message: sqlite.reason };
  }

  const wantedType = 'S-57';
  const wantedName = `S-57 ${chartNumber || 'ENC'}`;

  // Two attempts: first try, then a single retry after retryMs to ride out
  // transient sqlite locks (e.g. another process briefly holding the db).
  // Anything beyond that is unlikely to clear up by waiting longer.
  let lastError = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (attempt === 2) {
      log(`Retrying MBTiles metadata patch after ${retryMs}ms…`);
      await sleeper(retryMs);
    }
    try {
      const db = new sqlite.DatabaseSync(outputPath);
      try {
        // Tippecanoe creates the `metadata` table WITHOUT a UNIQUE constraint
        // on `name`, so a plain `INSERT OR REPLACE` doesn't replace — it
        // just appends. (The MBTiles 1.3 spec calls for unique keys, but
        // tippecanoe's own schema doesn't enforce it.) Earlier versions of
        // this plugin used INSERT OR REPLACE and produced files with two
        // `type` rows: tippecanoe's `overlay` plus our `S-57`. SELECT order
        // then decided which a downstream consumer saw. Robust fix:
        // DELETE the rows we own, then INSERT cleanly.
        db.exec("DELETE FROM metadata WHERE name IN ('type', 'name')");
        db.prepare("INSERT INTO metadata (name, value) VALUES ('type', ?)").run(wantedType);
        db.prepare("INSERT INTO metadata (name, value) VALUES ('name', ?)").run(wantedName);

        // Verify-after-write: read back what we just put. INSERT OR REPLACE
        // should always succeed when the prepare succeeds, but a busy WAL
        // checkpoint or a process-level write filter could swallow it
        // silently — and that's the bug we're trying to make visible.
        const typeRow = db.prepare("SELECT value FROM metadata WHERE name = 'type'").get() as
          | { value?: string }
          | undefined;
        const nameRow = db.prepare("SELECT value FROM metadata WHERE name = 'name'").get() as
          | { value?: string }
          | undefined;
        const gotType = typeRow?.value ?? null;
        const gotName = nameRow?.value ?? null;

        if (gotType !== wantedType || gotName !== wantedName) {
          lastError =
            `MBTiles metadata patch verify failed: ` +
            `type='${gotType}' (wanted '${wantedType}'), ` +
            `name='${gotName}' (wanted '${wantedName}')`;
          log(lastError);
          continue; // try the retry
        }

        const message =
          attempt === 1
            ? `Set MBTiles type=${wantedType}, name='${wantedName}'`
            : `Set MBTiles type=${wantedType}, name='${wantedName}' on retry`;
        log(message);
        return {
          ok: true,
          type: gotType,
          name: gotName,
          attempts: attempt,
          message
        };
      } finally {
        db.close();
      }
    } catch (err) {
      lastError = `MBTiles metadata patch failed (attempt ${attempt}/2): ${
        err instanceof Error ? err.message : String(err)
      }`;
      log(lastError);
    }
  }

  return {
    ok: false,
    type: null,
    name: null,
    attempts: 2,
    message: lastError || 'MBTiles metadata patch failed (unknown reason)'
  };
}
