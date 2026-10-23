/**
 * Download and stage the S-57 cells of a chart set.
 *
 * The cells come from the ENC index (`enc-chart-set.ts`), each with the
 * archive it is in and its path there. Every cell is staged into its own
 * directory of one combined ENC input tree (`encDir/<cell>/`), and the S-57
 * pipeline (`processS57Directory`) then converts the whole tree in a single
 * pass, producing one MBTiles per chart set.
 *
 * - **One download per archive.** Cells that share an archive (Poland's
 *   Odra, NOAA band-3 cells under several boxes) are fetched once, and only
 *   the selected cells' files are extracted: the base `.000` and the update
 *   files beside it. A "cell" archive is the bare `.000` file itself.
 * - **Separately published updates** (`updatesPublishedSeparately`) are
 *   fetched from their own archives and placed beside the base cell. GDAL
 *   applies update files in extension order from `.001` and stops at the
 *   first one missing, so they are numbered on from the update files the
 *   base archive already had: a reissued base (its own update number is 40,
 *   with no `.001`–`.040` beside it) gets `.041` as `.001`.
 * - **Polite downloads.** One request at a time per host, with a pause
 *   between requests; different hosts download side by side.
 * - **Awkward servers.** A server whose response headers Node's strict
 *   parser refuses, or that leaves an intermediate certificate out of its
 *   TLS handshake, is retried with header parsing relaxed or with the
 *   intermediates in `catalog/extra-ca-certificates.pem` trusted, as the
 *   index build does (`docs/enc-index.md`). TLS is still verified.
 *
 * A cell that fails to download or extract is logged and skipped rather
 * than failing the whole set — a region of dozens of cells shouldn't be
 * lost to one expired URL.
 */

import fs from 'fs';
import path from 'path';
import tls from 'tls';
import { setTimeout as delay } from 'timers/promises';
import { extraCertificateProblem, pemCertificates } from '../catalog/extra-ca.js';
import { downloadLenient } from '../catalog/lenient-download.js';
import { formatCellVersion, parseCellVersion, type PlannedCell } from './enc-chart-set.js';
import { extractZipEntries } from './zip-extract.js';

export interface EncDownloadHooks {
  /** Called before each archive download with 1-based progress. */
  onProgress?: (done: number, total: number, label: string) => void;
  /** Called once a cell's base file is staged. */
  onStaged?: (cellName: string) => void;
  onLog?: (line: string) => void;
  /** Return true to abort the remaining downloads (e.g. the user cancelled). */
  isAborted?: () => boolean;
  /** Aborts the download in flight. */
  signal?: AbortSignal;
}

export interface EncDownloadOptions {
  /** Pause between two requests to the same host. */
  delayMs?: number;
}

export interface EncDownloadResult {
  /** Cells whose base file was staged. */
  staged: string[];
  failed: { chartId: string; error: string }[];
  /**
   * Cell name → the version actually staged: the planned version, unless a
   * separate update failed to download, in which case it counts only the
   * updates applied before it.
   */
  versions: Record<string, string>;
}

/** One archive download and what to take from it. */
export interface ArchiveJob {
  url: string;
  kind: 'zip' | 'cell';
  host: string;
  /** Cells whose base file (and the update files beside it) come from here. */
  bases: { cell: string; path: string }[];
  /** Separately published update files to take from here. */
  updates: { cell: string; path: string; number: number }[];
}

const USER_AGENT =
  'signalk-charts-provider-simple (+https://github.com/dirkwa/signalk-charts-provider-simple)';
const DEFAULT_DELAY_MS = 1000;
const REQUEST_TIMEOUT_MS = 60000;
/** No ENC archive comes near this; it only protects the device's disk. */
const MAX_DOWNLOAD_BYTES = 4 * 1024 * 1024 * 1024;

const SAFE_CELL_NAME = /^[A-Za-z0-9_-]{1,64}$/;
/** The file name a bare `.000` download is saved under, from the index's `path`. */
const SAFE_BASE_FILE = /^[A-Za-z0-9_-]{1,64}\.000$/i;

/**
 * Group the cells' downloads by archive, so each archive is fetched once,
 * in the order of the cells. A cell whose name is not a plain file name is
 * left out (and reported by the caller as failed).
 */
export function planArchiveJobs(cells: readonly PlannedCell[]): ArchiveJob[] {
  const jobs = new Map<string, ArchiveJob>();
  const job = (url: string, kind: 'zip' | 'cell'): ArchiveJob => {
    let found = jobs.get(url);
    if (!found) {
      found = { url, kind, host: hostOf(url), bases: [], updates: [] };
      jobs.set(url, found);
    }
    return found;
  };
  for (const cell of cells) {
    if (!SAFE_CELL_NAME.test(cell.name)) {
      continue;
    }
    job(cell.archive, cell.archiveKind).bases.push({ cell: cell.name, path: cell.path });
    for (const update of cell.updates) {
      job(update.archive, update.archiveKind).updates.push({
        cell: cell.name,
        path: update.path,
        number: update.number
      });
    }
  }
  return [...jobs.values()];
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function baseName(p: string): string {
  return p.split('/').pop() ?? p;
}

/** The file in `dir` named `name` regardless of case (archives differ in case). */
function actualName(dir: string, name: string): string {
  return fs.readdirSync(dir).find((f) => f.toLowerCase() === name.toLowerCase()) ?? name;
}

function stem(fileName: string): string {
  return fileName.replace(/\.[^.]*$/, '');
}

/**
 * Where an archive entry goes in a cell's directory, or null when the cell
 * does not want it: its base file, or an update file (`.001`, ...) beside it.
 */
export function baseEntryTarget(entryPath: string, basePath: string): string | null {
  const dir = (p: string): string => p.slice(0, Math.max(0, p.lastIndexOf('/'))).toLowerCase();
  if (dir(entryPath) !== dir(basePath)) {
    return null;
  }
  const entryName = baseName(entryPath);
  if (entryName.toLowerCase() === baseName(basePath).toLowerCase()) {
    return entryName;
  }
  const match = /^(.+)\.(\d{3})$/.exec(entryName);
  if (
    match &&
    match[2] !== '000' &&
    match[1].toLowerCase() === stem(baseName(basePath)).toLowerCase()
  ) {
    return entryName;
  }
  return null;
}

// ---- Trust for servers that leave out an intermediate certificate ----

const EXTRA_CA_FILE = new URL('../../catalog/extra-ca-certificates.pem', import.meta.url);
let trustedWithExtras: string[] | null | undefined;

/** Node's trusted set plus the shipped intermediates, or null when none load. */
function caWithExtras(log: (line: string) => void): string[] | null {
  if (trustedWithExtras !== undefined) {
    return trustedWithExtras;
  }
  let extras: string[] = [];
  try {
    extras = pemCertificates(fs.readFileSync(EXTRA_CA_FILE, 'utf8')).filter((pem) => {
      const problem = extraCertificateProblem(pem);
      if (problem) {
        log(`WARN: ignoring an extra CA certificate: ${problem}`);
      }
      return problem === null;
    });
  } catch {
    // Not shipped (a development checkout without the file): nothing to add.
  }
  const api = tls as Partial<Pick<typeof tls, 'getCACertificates'>>;
  const base = api.getCACertificates ? api.getCACertificates('default') : [...tls.rootCertificates];
  trustedWithExtras = extras.length > 0 ? [...base, ...extras] : null;
  return trustedWithExtras;
}

const CERT_CHAIN_CODES = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_GET_ISSUER_CERT'
]);

function errorCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : '';
}

/**
 * Download one URL, retrying once with header parsing relaxed when the
 * response is not valid HTTP/1.1, and once with the extra intermediates
 * trusted when the certificate chain is incomplete.
 */
async function downloadArchive(
  url: string,
  target: string,
  signal: AbortSignal | undefined,
  log: (line: string) => void
): Promise<void> {
  let lenient = false;
  let ca: string[] | undefined;
  for (;;) {
    try {
      await downloadLenient(url, target, {
        headers: { 'User-Agent': USER_AGENT },
        maxBytes: MAX_DOWNLOAD_BYTES,
        signal,
        insecureHTTPParser: lenient,
        ...(ca ? { ca } : {}),
        timeoutMs: REQUEST_TIMEOUT_MS
      });
      return;
    } catch (err) {
      fs.rmSync(target, { force: true });
      const code = errorCode(err);
      if (!lenient && code.startsWith('HPE_')) {
        lenient = true;
        continue;
      }
      const extras = ca ? null : CERT_CHAIN_CODES.has(code) ? caWithExtras(log) : null;
      if (extras) {
        ca = extras;
        continue;
      }
      throw err;
    }
  }
}

/** Wait `ms`, or less if the run is aborted meanwhile; never rejects. */
async function pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
  try {
    await delay(ms, undefined, { signal });
  } catch {
    // Aborted: the caller checks the signal next.
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function downloadAndExtractEncs(
  cells: readonly PlannedCell[],
  encDir: string,
  stagingDir: string,
  hooks: EncDownloadHooks = {},
  options: EncDownloadOptions = {}
): Promise<EncDownloadResult> {
  fs.mkdirSync(encDir, { recursive: true });
  fs.mkdirSync(stagingDir, { recursive: true });
  const log = (line: string): void => hooks.onLog?.(line);
  const delayMs = options.delayMs ?? DEFAULT_DELAY_MS;

  const failedByCell = new Map<string, string>();
  for (const cell of cells) {
    if (!SAFE_CELL_NAME.test(cell.name)) {
      failedByCell.set(cell.name, 'not a valid cell name');
    }
  }
  const jobs = planArchiveJobs(cells);
  const cellDir = (cell: string): string => path.join(encDir, cell);
  const stagedBase = new Map<string, string>(); // cell → base file name
  // Separate updates fetched, by cell: update number → file in stagingDir.
  const fetchedUpdates = new Map<string, Map<number, string>>();

  const byHost = new Map<string, ArchiveJob[]>();
  for (const job of jobs) {
    byHost.set(job.host, [...(byHost.get(job.host) ?? []), job]);
  }

  let done = 0;
  let seq = 0;
  const runJob = async (job: ArchiveJob): Promise<void> => {
    const download = path.join(stagingDir, `archive-${String(++seq)}.dl`);
    const cellsHere = [...new Set([...job.bases, ...job.updates].map((x) => x.cell))];
    hooks.onProgress?.(++done, jobs.length, cellsHere.slice(0, 3).join(', '));
    try {
      await downloadArchive(job.url, download, hooks.signal, log);
      if (job.kind === 'cell') {
        for (const base of job.bases) {
          // The name comes from third-party data via the index: only a plain
          // `<cell>.000` file name is written, never a path.
          const name = baseName(base.path);
          if (!SAFE_BASE_FILE.test(name)) {
            failedByCell.set(base.cell, `unexpected file name ${base.path}`);
            log(`WARN: ${base.cell} skipped (unexpected file name ${base.path})`);
            continue;
          }
          fs.mkdirSync(cellDir(base.cell), { recursive: true });
          fs.copyFileSync(download, path.join(cellDir(base.cell), name));
          stagedBase.set(base.cell, name);
          hooks.onStaged?.(base.cell);
        }
        return;
      }
      if (job.bases.length > 0) {
        // One pass over the archive for every cell taken from it.
        const written = await extractZipEntries(download, encDir, (entry) => {
          for (const base of job.bases) {
            const name = baseEntryTarget(entry, base.path);
            if (name !== null) {
              return `${base.cell}/${name}`;
            }
          }
          return null;
        });
        const writtenNames = new Set(written.map((w) => baseName(w).toLowerCase()));
        for (const base of job.bases) {
          const name = baseName(base.path);
          if (!writtenNames.has(name.toLowerCase())) {
            failedByCell.set(base.cell, `${base.path} is not in the archive`);
            log(`WARN: ${base.cell} skipped (${base.path} is not in its archive)`);
            continue;
          }
          stagedBase.set(base.cell, actualName(cellDir(base.cell), name));
          hooks.onStaged?.(base.cell);
        }
      }
      if (job.updates.length > 0) {
        const held = path.join(stagingDir, 'updates');
        const written = new Set(
          await extractZipEntries(download, held, (entry) => {
            const update = job.updates.find((u) => u.path.toLowerCase() === entry.toLowerCase());
            return update ? `${update.cell}/${String(update.number)}.upd` : null;
          })
        );
        for (const update of job.updates) {
          if (![...written].some((w) => w.toLowerCase() === update.path.toLowerCase())) {
            continue;
          }
          const map = fetchedUpdates.get(update.cell) ?? new Map<number, string>();
          map.set(update.number, path.join(held, update.cell, `${String(update.number)}.upd`));
          fetchedUpdates.set(update.cell, map);
        }
      }
    } catch (err) {
      const reason = message(err);
      for (const base of job.bases) {
        failedByCell.set(base.cell, reason);
        log(`WARN: ${base.cell} skipped (${reason})`);
      }
      if (job.updates.length > 0) {
        log(
          `WARN: updates for ${[...new Set(job.updates.map((u) => u.cell))].join(', ')} not ` +
            `downloaded (${reason}); the chart set stays flagged for an update`
        );
      }
    } finally {
      fs.rmSync(download, { force: true });
    }
  };

  await Promise.all(
    [...byHost.values()].map(async (queue) => {
      for (const [i, job] of queue.entries()) {
        if (hooks.isAborted?.() || hooks.signal?.aborted) {
          return;
        }
        if (i > 0 && delayMs > 0) {
          await pause(delayMs, hooks.signal);
          if (hooks.isAborted?.() || hooks.signal?.aborted) {
            return;
          }
        }
        await runJob(job);
      }
    })
  );

  const versions: Record<string, string> = {};
  const staged: string[] = [];
  for (const cell of cells) {
    const baseFile = stagedBase.get(cell.name);
    if (baseFile === undefined || failedByCell.has(cell.name)) {
      continue;
    }
    staged.push(cell.name);
    const applied = placeSeparateUpdates(cell, cellDir(cell.name), baseFile, fetchedUpdates);
    if (applied < cell.updates.length) {
      log(
        `WARN: ${cell.name}: ${String(cell.updates.length - applied)} published update(s) missing; ` +
          `applied the ${String(applied)} before the first gap`
      );
    }
    const parsed = parseCellVersion(cell.version);
    if (cell.updates.length === 0 || !parsed) {
      if (cell.version !== undefined) {
        versions[cell.name] = cell.version;
      }
    } else {
      const baseUpdate = (cell.updates[0]?.number ?? 1) - 1;
      versions[cell.name] = formatCellVersion(cell.name, parsed.edition, baseUpdate + applied);
    }
  }

  const stagedSet = new Set(staged);
  const failed = cells
    .filter((c) => !stagedSet.has(c.name))
    .map((c) => ({
      chartId: c.name,
      error: failedByCell.get(c.name) ?? 'download did not run'
    }));
  return { staged, failed, versions };
}

/**
 * Put a cell's separately published updates beside its base file, numbered
 * on from the update files already there, up to the first one that did not
 * download. Returns how many were placed.
 */
function placeSeparateUpdates(
  cell: PlannedCell,
  dir: string,
  baseFile: string,
  fetched: ReadonlyMap<string, ReadonlyMap<number, string>>
): number {
  if (cell.updates.length === 0) {
    return 0;
  }
  const baseStem = stem(baseFile);
  const present = fs
    .readdirSync(dir)
    .filter((f) => stem(f).toLowerCase() === baseStem.toLowerCase())
    .map((f) => /\.(\d{3})$/.exec(f)?.[1])
    .filter((n): n is string => n !== undefined && n !== '000').length;
  const files = fetched.get(cell.name);
  let applied = 0;
  for (const update of cell.updates) {
    const file = files?.get(update.number);
    if (file === undefined) {
      break;
    }
    const ext = String(present + applied + 1).padStart(3, '0');
    fs.renameSync(file, path.join(dir, `${baseStem}.${ext}`));
    applied += 1;
  }
  return applied;
}
