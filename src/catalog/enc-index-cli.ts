/**
 * Builds the ENC index (`enc-index.json`) into a static site directory. Run
 * by `.github/workflows/publish-catalog.yml`, and by a maintainer for a
 * first full pass; not used by the plugin at runtime, and left out of the
 * npm package.
 *
 * Reads the published index as its state: archives whose version is
 * unchanged are reused, so a scheduled run downloads only what changed.
 * Each archive read is also saved under `--work`, so an interrupted run
 * picks up where it stopped. GDAL runs in the charts-toolbox image, the
 * same pinned version locally and in CI, so both produce the same file.
 *
 * Writes `changed=true|false` to `$GITHUB_OUTPUT`.
 *
 * Needs Docker (or Podman) and a clone of chartcatalogs. After `npm run
 * build`, run `node dist/catalog/enc-index-cli.js` with:
 *
 *   --chartcatalogs <dir>    a clone of github.com/chartcatalogs/catalogs
 *   --index <file>           catalog/chartcatalogs-index.json
 *   --out <dir>              where enc-index.json and its schema are written
 *   --published-url <url>    the published enc-index.json, read as state
 *   --work <dir>             keep each archive's GDAL report here, so a rerun
 *                            resumes, and a change to the outline rules
 *                            needs no downloads (default: a temp dir)
 *   --direct-sources <file>  catalog/enc-direct-sources.json: producers'
 *                            catalogs read directly (see
 *                            enc-direct-sources.ts)
 *   --sources <ids>          read only these sources (comma-separated, e.g.
 *                            noaa,AT_IENC_Catalog); the rest keep what is
 *                            published
 *   --max-minutes <n>        start no archive after n minutes
 *   --delay-ms <n>           pause between requests to one host (1000)
 *   --runtime <cmd>          docker (default) or podman
 *   --force                  publish past the drop guard
 */

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { Value } from 'typebox/value';
import { CHARTS_TOOLBOX_IMAGE } from '../utils/container-images.js';
import { NOAA_ENC_GEOJSON_URL, parseFootprints } from '../utils/noaa-enc-footprints.js';
import { extractZipSafely } from '../utils/zip-extract.js';
import {
  CELL_MARKER,
  FEATURES_MARKER,
  UPDATE_FILE_NAME,
  archiveJobs,
  assembleEncIndex,
  decideEncIndexPublish,
  encSources,
  jobKey,
  jobsToBuild,
  noaaUnits,
  createGdalReportParser,
  readPublishedEncIndex,
  unitsForArchive,
  type ArchiveJob,
  type ArchiveResult,
  type CellReport,
  type NoaaResult,
  type PublishedEncIndex
} from './build-enc-index.js';
import { parseChartcatalogsXml, type ParsedChartcatalogsXml } from './chartcatalogs-xml.js';
import {
  DIRECT_SOURCE_ADAPTERS,
  EncDirectSourcesFileSchema,
  checkDirectSources,
  type DirectArchive,
  type EncDirectSource
} from './enc-direct-sources.js';
import { NOAA_SOURCE_ID, publishedEncIndexJsonSchema } from './enc-index-schema.js';
import { ExtraCaUnsupportedError, trustExtraCertificates } from './extra-ca.js';
import {
  HttpStatusError,
  byteLimit,
  downloadLenient,
  isMalformedResponse
} from './lenient-download.js';
import { ChartcatalogsIndexSchema, schemaErrors } from './merged-catalog-schema.js';

const USER_AGENT =
  'signalk-charts-provider-simple ENC index (+https://github.com/dirkwa/signalk-charts-provider-simple)';
/** No single ENC archive comes near this; it only protects the runner's disk. */
const MAX_DOWNLOAD_BYTES = 4 * 1024 * 1024 * 1024;
/**
 * Cap on what one archive may expand to. Hosts are read side by side on a
 * CI runner with about 14 GB free, so the plugin's 100 GB default for chart
 * bundles is far too generous here.
 */
const MAX_EXTRACT_BYTES = 4 * 1024 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const RETRY_DELAY_MS = 15000;
/** A GDAL run longer than this is treated as hung on a malformed cell. */
const GDAL_TIMEOUT_MS = 10 * 60 * 1000;
/** How long an archive already in progress may run past `--max-minutes`. */
const DEADLINE_GRACE_MS = 10 * 60 * 1000;

// Prints a marker line per cell, then the cell's scale, edition and update
// number and its coverage polygons as GeoJSON text sequences. A cell whose
// M_COVR is missing or empty (a few producers leave it out) has every
// feature dumped instead, for an outline of where its data is. GDAL's S-57
// driver applies any update files (.001, ...) next to the base cell before
// reading. One unreadable cell must not fail the archive, hence the
// `|| true`s.
const GDAL_SCRIPT = `for f in "$@"; do
  printf '${CELL_MARKER}%s\\n' "$f"
  ogr2ogr -f GeoJSONSeq /vsistdout/ "/data/$f" DSID -select DSPM_CSCL,DSID_EDTN,DSID_UPDN || true
  covr=$(ogr2ogr -f GeoJSONSeq /vsistdout/ "/data/$f" M_COVR -select CATCOV || true)
  if [ -n "$covr" ]; then
    printf '%s\\n' "$covr"
  else
    printf '${FEATURES_MARKER}\\n'
    ogr2ogr -f GeoJSONSeq /vsistdout/ "/data/$f" -lco COORDINATE_PRECISION=3 || true
  fi
done`;

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 32);
}

/** A published file's text, or null when it does not exist yet. */
async function fetchText(url: string): Promise<string | null> {
  const response = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(120000)
  });
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`HTTP ${String(response.status)} fetching ${url}`);
  }
  return response.text();
}

/** The published index, read back as the state to build on, or null before the first publish. */
async function fetchPublished(publishedUrl: string): Promise<PublishedEncIndex | null> {
  const text = await fetchText(publishedUrl);
  if (text === null) {
    return null;
  }
  const schemaText = await fetchText(new URL('enc-index.schema.json', publishedUrl).href);
  return readPublishedEncIndex(JSON.parse(text), schemaText);
}

async function readNoaa(url: string): Promise<NoaaResult | { error: string }> {
  try {
    const text = await fetchText(url);
    if (text === null) {
      return { error: `HTTP 404 fetching ${url}` };
    }
    return noaaUnits(parseFootprints(JSON.parse(text)));
  } catch (err) {
    return { error: message(err) };
  }
}

/** The hand-edited direct-source list, validated against its strict schema. */
function readDirectSources(file: string, otherIds: readonly string[]): EncDirectSource[] {
  const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Value.Check(EncDirectSourcesFileSchema, value)) {
    throw new Error(
      `${file} is invalid:\n  ${schemaErrors(EncDirectSourcesFileSchema, value).join('\n  ')}`
    );
  }
  const problems = checkDirectSources(value, otherIds);
  if (problems.length > 0) {
    throw new Error(`${file} is invalid:\n  ${problems.join('\n  ')}`);
  }
  return value.sources;
}

/**
 * Each direct source's archives from its producer's catalog, or null when
 * the catalog could not be read; that source then keeps what the published
 * index has, as a broken chartcatalogs file does.
 */
async function readDirectCatalogs(
  sources: readonly EncDirectSource[]
): Promise<Map<string, DirectArchive[] | null>> {
  const result = new Map<string, DirectArchive[] | null>();
  for (const source of sources) {
    try {
      const text = await fetchText(source.catalog);
      if (text === null) {
        throw new Error(`HTTP 404 fetching ${source.catalog}`);
      }
      result.set(source.id, await DIRECT_SOURCE_ADAPTERS[source.format](text));
    } catch (err) {
      console.log(`::warning::Could not read the ${source.id} catalog: ${message(err)}`);
      result.set(source.id, null);
    }
  }
  return result;
}

async function readChartcatalogs(
  dir: string,
  files: string[]
): Promise<{ file: string; parsed: ParsedChartcatalogsXml | null }[]> {
  const result: { file: string; parsed: ParsedChartcatalogsXml | null }[] = [];
  for (const file of files) {
    try {
      const parsed = await parseChartcatalogsXml(fs.readFileSync(path.join(dir, file), 'utf8'));
      result.push({ file, parsed });
    } catch (err) {
      console.log(`::warning::Could not read ${file}: ${message(err)}`);
      result.push({ file, parsed: null });
    }
  }
  return result;
}

class TransientError extends Error {}

/** The fallback for a response `fetch` cannot parse (see `lenient-download.ts`). */
async function downloadWithLenientHeaders(
  url: string,
  target: string,
  signal: AbortSignal
): Promise<void> {
  try {
    await downloadLenient(url, target, {
      headers: { 'User-Agent': USER_AGENT },
      maxBytes: MAX_DOWNLOAD_BYTES,
      signal
    });
  } catch (err) {
    if (err instanceof HttpStatusError && err.status < 500) {
      throw err;
    }
    throw new TransientError(message(err));
  }
}

async function downloadOnce(url: string, target: string, stop?: AbortSignal): Promise<void> {
  const timeout = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
  const signal = stop ? AbortSignal.any([timeout, stop]) : timeout;
  let response: Response;
  try {
    response = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal });
  } catch (err) {
    if (isMalformedResponse(err)) {
      await downloadWithLenientHeaders(url, target, signal);
      return;
    }
    // fetch reports every network failure as "fetch failed"; the reason is
    // in its cause. A certificate the server will keep sending is not worth
    // a retry.
    const code = (err as { cause?: { code?: unknown } }).cause?.code;
    const reason = typeof code === 'string' ? `${message(err)} (${code})` : message(err);
    if (typeof code === 'string' && /CERT|SIGNATURE|SELF_SIGNED/.test(code)) {
      throw new Error(reason, { cause: err });
    }
    throw new TransientError(reason);
  }
  if (!response.ok || !response.body) {
    const error = `HTTP ${String(response.status)}`;
    await response.body?.cancel();
    throw response.status >= 500 ? new TransientError(error) : new Error(error);
  }
  try {
    await pipeline(
      Readable.fromWeb(response.body),
      byteLimit(MAX_DOWNLOAD_BYTES),
      fs.createWriteStream(target)
    );
  } catch (err) {
    // A body that does not match its Content-Length only shows up here,
    // after fetch itself resolved.
    if (isMalformedResponse(err)) {
      await downloadWithLenientHeaders(url, target, signal);
      return;
    }
    throw new TransientError(message(err));
  }
}

/** Download with one retry for network errors and 5xx answers. */
async function download(url: string, target: string, stop?: AbortSignal): Promise<void> {
  try {
    await downloadOnce(url, target, stop);
  } catch (err) {
    if (!(err instanceof TransientError) || stop?.aborted) {
      throw err;
    }
    await sleep(RETRY_DELAY_MS);
    await downloadOnce(url, target, stop);
  }
}

function kindOf(file: string): 'zip' | 'cell' | null {
  const fd = fs.openSync(file, 'r');
  const head = Buffer.alloc(9);
  try {
    fs.readSync(fd, head, 0, head.length, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (head.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
    return 'zip';
  }
  // An ISO 8211 data descriptive record, as every S-57 file starts with.
  return head.subarray(5, 9).toString('latin1') === '3LE1' ? 'cell' : null;
}

/** Paths of the files under `dir` whose name matches, relative, with "/" separators. */
function findFiles(dir: string, pattern: RegExp): string[] {
  const cells: string[] = [];
  const walk = (rel: string): void => {
    for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      if (entry.name.startsWith('._') || entry.name === '__MACOSX') {
        continue;
      }
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(child);
      } else if (entry.isFile() && pattern.test(entry.name)) {
        cells.push(child);
      }
    }
  };
  walk('');
  return cells.sort();
}

function cellFileName(job: ArchiveJob): string {
  const base = decodeURIComponent(new URL(job.url).pathname.split('/').pop() ?? '');
  if (/^[\w.-]+\.000$/i.test(base)) {
    return base;
  }
  return `${job.title.replace(/[^\w-]+/g, '_') || 'cell'}.000`;
}

function runGdal(
  runtime: string,
  dir: string,
  cells: string[],
  name: string
): Promise<CellReport[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      runtime,
      [
        'run',
        '--rm',
        '--name',
        name,
        '--network',
        'none',
        '-v',
        `${dir}:/data:ro`,
        CHARTS_TOOLBOX_IMAGE,
        'sh',
        '-c',
        GDAL_SCRIPT,
        'sh',
        ...cells
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    // Killing the CLI process would leave the container running, so a hung
    // run is removed by name.
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      spawn(runtime, ['rm', '-f', name], { stdio: 'ignore' }).on('error', () => undefined);
    }, GDAL_TIMEOUT_MS);
    // Parsed as it streams: a cell without coverage dumps every feature,
    // and an archive of such cells could be too big to hold as one string.
    const parser = createGdalReportParser();
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on('line', parser.line);
    const linesDone = once(lines, 'close');
    // Only awaited on a clean exit; on any other path the run has already
    // failed, and a stream error must not surface as an unhandled rejection.
    linesDone.catch(() => undefined);
    let err = '';
    child.stderr.on('data', (chunk: Buffer) => {
      err = (err + chunk.toString()).slice(-4000);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`GDAL took longer than ${String(GDAL_TIMEOUT_MS / 60000)} minutes`));
      } else if (code === 0) {
        linesDone.then(() => resolve(parser.finish()), reject);
      } else {
        reject(
          new Error(`GDAL exited with ${String(code)}: ${err.trim().split('\n').pop() ?? ''}`)
        );
      }
    });
  });
}

/** What GDAL reported for one downloaded archive. */
interface ArchiveReport {
  kind: 'zip' | 'cell';
  reports: CellReport[];
  /** Update files (.001, ...) in the archive. */
  updateFiles: string[];
}

/** Download one archive and read its cells' scale and coverage. */
async function readArchive(
  job: ArchiveJob,
  tmp: string,
  runtime: string,
  stop?: AbortSignal
): Promise<ArchiveReport> {
  fs.rmSync(tmp, { recursive: true, force: true });
  const contents = path.join(tmp, 'contents');
  fs.mkdirSync(contents, { recursive: true });
  try {
    const downloaded = path.join(tmp, 'download');
    await download(job.url, downloaded, stop);
    const kind = kindOf(downloaded);
    if (kind === 'zip') {
      await extractZipSafely(downloaded, contents, { maxTotalBytes: MAX_EXTRACT_BYTES });
    } else if (kind === 'cell') {
      fs.renameSync(downloaded, path.join(contents, cellFileName(job)));
    } else {
      throw new Error('the download is neither a ZIP archive nor an S-57 cell');
    }
    const cells = findFiles(contents, /\.000$/i);
    const updateFiles = findFiles(contents, UPDATE_FILE_NAME);
    if (cells.length === 0) {
      if (updateFiles.length === 0) {
        throw new Error('no S-57 cell (.000) in the archive');
      }
      return { kind, reports: [], updateFiles };
    }
    return {
      kind,
      reports: await runGdal(
        runtime,
        contents,
        cells,
        `enc-index-${path.basename(tmp)}-${String(process.pid)}`
      ),
      updateFiles
    };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** Bumped when what the cache saves changes, so older entries are read again. */
const CACHE_FORMAT = 3;

/**
 * What GDAL reported for each archive read, saved as it is read, so an
 * interrupted run resumes without downloading again. Raw reports rather
 * than units, so a change to the outline rules needs no downloads either.
 */
class WorkCache {
  constructor(private readonly dir: string) {
    fs.mkdirSync(dir, { recursive: true });
  }

  private file(job: ArchiveJob): string {
    return path.join(this.dir, `${hashKey(jobKey(job))}.json`);
  }

  get(job: ArchiveJob): ArchiveReport | null {
    try {
      const saved = JSON.parse(fs.readFileSync(this.file(job), 'utf8')) as Record<string, unknown>;
      const { kind, reports, updateFiles } = saved;
      if (
        saved.format !== CACHE_FORMAT ||
        saved.key !== jobKey(job) ||
        saved.version !== job.version ||
        (kind !== 'zip' && kind !== 'cell') ||
        !Array.isArray(reports) ||
        !Array.isArray(updateFiles)
      ) {
        return null;
      }
      return { kind, reports: reports as CellReport[], updateFiles: updateFiles as string[] };
    } catch {
      return null;
    }
  }

  put(job: ArchiveJob, report: ArchiveReport): void {
    const file = this.file(job);
    const saved = { format: CACHE_FORMAT, key: jobKey(job), version: job.version, ...report };
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(saved));
    fs.renameSync(`${file}.tmp`, file);
  }
}

interface BuildOptions {
  runtime: string;
  work: string;
  delayMs: number;
  /** No archive is started after this time (epoch ms). */
  deadline: number;
  /** Aborts downloads still running well past the deadline. */
  stop?: AbortSignal;
}

/**
 * Read every job, one host at a time per host: each host gets its own
 * sequential queue with a pause between requests, and hosts run side by
 * side. Jobs not started before the deadline are left for the next run.
 */
async function buildJobs(
  jobs: ArchiveJob[],
  options: BuildOptions
): Promise<{ built: Map<string, ArchiveResult>; failed: Map<string, string> }> {
  const built = new Map<string, ArchiveResult>();
  const failed = new Map<string, string>();
  const cache = new WorkCache(path.join(options.work, 'results'));

  const todo: ArchiveJob[] = [];
  for (const job of jobs) {
    const saved = cache.get(job);
    if (saved) {
      built.set(jobKey(job), unitsForArchive(job, saved.kind, saved.reports, saved.updateFiles));
    } else {
      todo.push(job);
    }
  }
  if (built.size > 0) {
    console.log(`Resuming: ${String(built.size)} archive(s) already read in ${options.work}`);
  }

  const byHost = new Map<string, ArchiveJob[]>();
  for (const job of todo) {
    const host = new URL(job.url).host;
    byHost.set(host, [...(byHost.get(host) ?? []), job]);
  }
  let done = 0;
  await Promise.all(
    [...byHost].map(async ([host, queue]) => {
      for (const [i, job] of queue.entries()) {
        if (Date.now() > options.deadline) {
          return;
        }
        if (i > 0) {
          await sleep(options.delayMs);
        }
        const key = jobKey(job);
        try {
          const report = await readArchive(
            job,
            path.join(options.work, 'tmp', hashKey(key)),
            options.runtime,
            options.stop
          );
          cache.put(job, report);
          const result = unitsForArchive(job, report.kind, report.reports, report.updateFiles);
          for (const problem of result.problems) {
            console.log(`::warning::${job.url}: ${problem}`);
          }
          built.set(key, result);
          console.log(
            `[${String(++done)}/${String(todo.length)}] ${host}: ${result.updatesOnly ? 'update files only' : `${String(result.units.length)} cell(s)`} from ${job.url}`
          );
        } catch (err) {
          failed.set(key, message(err));
          console.log(
            `[${String(++done)}/${String(todo.length)}] ${host}: FAILED ${job.url}: ${message(err)}`
          );
        }
      }
    })
  );
  return { built, failed };
}

function positiveNumber(flag: string, value: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`${flag} must be a number of zero or more, not "${value}"`);
  }
  return n;
}

/**
 * Intermediates some ENC servers leave out of their handshake, trusted in
 * addition to Node's roots (see `extra-ca.ts`). The file sits in the repo's
 * `catalog/` folder; the CLI runs from a checkout, never the npm package.
 */
const EXTRA_CA_FILE = new URL('../../catalog/extra-ca-certificates.pem', import.meta.url);

async function main(): Promise<void> {
  if (fs.existsSync(EXTRA_CA_FILE)) {
    try {
      const added = trustExtraCertificates(fs.readFileSync(EXTRA_CA_FILE, 'utf8'));
      console.log(`Trusting ${String(added)} extra intermediate CA certificate(s)`);
    } catch (err) {
      // An older Node only costs the servers that need these certificates.
      if (!(err instanceof ExtraCaUnsupportedError)) {
        throw err;
      }
      console.log(`::warning::${err.message}; downloads that need them will fail`);
    }
  }
  const { values } = parseArgs({
    options: {
      chartcatalogs: { type: 'string' },
      index: { type: 'string' },
      out: { type: 'string' },
      'published-url': { type: 'string' },
      'noaa-url': { type: 'string', default: NOAA_ENC_GEOJSON_URL },
      work: { type: 'string' },
      sources: { type: 'string' },
      'max-minutes': { type: 'string' },
      'direct-sources': { type: 'string' },
      'delay-ms': { type: 'string', default: '1000' },
      runtime: { type: 'string', default: 'docker' },
      force: { type: 'boolean', default: false }
    }
  });
  const { chartcatalogs: ccDir, index: indexFile, out } = values;
  const publishedUrl = values['published-url'];
  if (!ccDir || !indexFile || !out || !publishedUrl) {
    throw new Error('--chartcatalogs, --index, --out and --published-url are required');
  }

  const facets: unknown = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
  if (!Value.Check(ChartcatalogsIndexSchema, facets)) {
    throw new Error(
      `${indexFile} is invalid:\n  ${schemaErrors(ChartcatalogsIndexSchema, facets).join('\n  ')}`
    );
  }
  const direct = values['direct-sources']
    ? readDirectSources(
        values['direct-sources'],
        encSources(facets).map((s) => s.id)
      )
    : [];
  const sources = encSources(facets, direct);
  // --sources limits what is read this run; every other source keeps what
  // the published index has.
  const only = values.sources ? new Set(values.sources.split(',').map((s) => s.trim())) : null;
  const selected = (id: string): boolean => !only || only.has(id);
  for (const id of only ?? []) {
    if (!sources.some((s) => s.id === id)) {
      throw new Error(`--sources: unknown ENC source "${id}"`);
    }
  }

  const files = await readChartcatalogs(
    ccDir,
    sources.flatMap((s) => (s.file ? [s.file] : []))
  );
  const directArchives = await readDirectCatalogs(direct);
  const jobs = archiveJobs(
    sources,
    files,
    new Map([...directArchives].flatMap(([id, archives]) => (archives ? [[id, archives]] : [])))
  );
  const published = await fetchPublished(publishedUrl);
  const noaa = selected(NOAA_SOURCE_ID) ? await readNoaa(values['noaa-url']) : null;

  const unreadSources = new Set([
    ...sources
      .filter((s) => s.file && !files.find((f) => f.file === s.file)?.parsed?.charts.length)
      .map((s) => s.id),
    ...[...directArchives].filter(([, archives]) => !archives?.length).map(([id]) => id)
  ]);
  const pending = jobsToBuild(jobs, published, unreadSources).filter((j) => selected(j.source));
  console.log(`${String(jobs.length)} ENC archives; ${String(pending.length)} to read this run`);

  const ownWork = !values.work;
  const work = values.work ?? fs.mkdtempSync(path.join(os.tmpdir(), 'enc-index-'));
  const maxMinutes = values['max-minutes']
    ? positiveNumber('--max-minutes', values['max-minutes'])
    : Infinity;
  const budgetMs = maxMinutes * 60000;
  let outcome: Awaited<ReturnType<typeof buildJobs>>;
  try {
    outcome = await buildJobs(pending, {
      runtime: values.runtime,
      work,
      delayMs: positiveNumber('--delay-ms', values['delay-ms']),
      deadline: Date.now() + budgetMs,
      ...(Number.isFinite(budgetMs)
        ? { stop: AbortSignal.timeout(budgetMs + DEADLINE_GRACE_MS) }
        : {})
    });
  } finally {
    if (ownWork) {
      fs.rmSync(work, { recursive: true, force: true });
    }
  }

  const { built, failed } = outcome;
  const result = assembleEncIndex({
    sources,
    jobs,
    built,
    failed,
    noaa,
    unreadSources,
    previous: published,
    now: new Date()
  });
  for (const entry of result.carriedForward) {
    console.log(`::warning::Could not read ${entry}; kept the published units`);
  }
  for (const entry of result.skipped) {
    console.log(`::warning::Could not read ${entry}; never published, left out`);
  }
  for (const entry of result.removedUpstream) {
    console.log(`::warning::${entry} is no longer listed; removed from the index`);
  }
  for (const entry of result.separateUpdates) {
    console.log(`::notice::${entry} has updates published in a separate archive; flagged`);
  }
  const duplicates = new Map<string, number>();
  for (const { kept, dropped } of result.duplicateCells) {
    const pair = kept === dropped ? `${kept} (twice)` : `${kept} over ${dropped}`;
    duplicates.set(pair, (duplicates.get(pair) ?? 0) + 1);
  }
  for (const [pair, count] of [...duplicates].sort(([a], [b]) => (a < b ? -1 : 1))) {
    console.log(`::notice::${String(count)} cell(s) published more than once: kept ${pair}`);
  }
  if (result.deferred.length > 0) {
    console.log(
      `::notice::${String(result.deferred.length)} archive(s) or source(s) not read this run; they keep their published units and are read next run`
    );
  }

  const { index } = result;
  const schemaText = JSON.stringify(
    publishedEncIndexJsonSchema(new URL('enc-index.schema.json', publishedUrl).href),
    null,
    2
  );
  const { publish, blockers } = decideEncIndexPublish(index, published, schemaText, values.force);
  if (blockers.length > 0) {
    const text = `Refusing to publish the ENC index:\n  ${blockers.join('\n  ')}`;
    if (!values.force) {
      throw new Error(text);
    }
    console.log(`::warning::Forced past: ${text}`);
  }

  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'enc-index.json'), JSON.stringify(index));
  fs.writeFileSync(path.join(out, 'enc-index.schema.json'), schemaText);

  console.log(
    `ENC index ${index.contentHash.slice(0, 12)}: ${String(index.units.length)} units from ${String(index.sources.length)} sources, ${String(index.archives.length)} archives (${String(result.reused)} reused, ${String(built.size)} read, ${String(failed.size)} failed); ${publish ? 'publishing' : 'unchanged, not publishing'}`
  );
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `changed=${String(publish)}\n`);
  }
}

main().catch((err: unknown) => {
  console.error(message(err));
  process.exit(1);
});
