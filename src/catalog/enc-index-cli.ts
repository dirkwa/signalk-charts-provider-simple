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
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { parseArgs } from 'node:util';
import { Value } from 'typebox/value';
import { CHARTS_TOOLBOX_IMAGE } from '../utils/container-images.js';
import { NOAA_ENC_GEOJSON_URL, parseFootprints } from '../utils/noaa-enc-footprints.js';
import { extractZipSafely } from '../utils/zip-extract.js';
import {
  CELL_MARKER,
  archiveJobs,
  assembleEncIndex,
  decideEncIndexPublish,
  encSources,
  jobKey,
  jobsToBuild,
  noaaUnits,
  parseGdalReport,
  readPublishedEncIndex,
  unitsForArchive,
  type ArchiveJob,
  type ArchiveResult,
  type CellReport,
  type NoaaResult,
  type PublishedEncIndex
} from './build-enc-index.js';
import { parseChartcatalogsXml, type ParsedChartcatalogsXml } from './chartcatalogs-xml.js';
import { NOAA_SOURCE_ID, publishedEncIndexJsonSchema } from './enc-index-schema.js';
import { ChartcatalogsIndexSchema, schemaErrors } from './merged-catalog-schema.js';

const USER_AGENT =
  'signalk-charts-provider-simple ENC index (+https://github.com/dirkwa/signalk-charts-provider-simple)';
/** No single ENC archive comes near this; it only protects the runner's disk. */
const MAX_DOWNLOAD_BYTES = 4 * 1024 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 20 * 60 * 1000;
const RETRY_DELAY_MS = 15000;

// Prints a marker line per cell, then the cell's compilation scale and its
// coverage polygons as GeoJSON text sequences. A cell without M_COVR (a few
// producers omit it) gets its data extent instead. GDAL's S-57 driver
// applies any update files (.001, ...) next to the base cell before reading.
// One unreadable cell must not fail the archive, hence the `|| true`s.
const GDAL_SCRIPT = `for f in "$@"; do
  printf '${CELL_MARKER}%s\\n' "$f"
  ogr2ogr -f GeoJSONSeq /vsistdout/ "/data/$f" DSID -select DSPM_CSCL || true
  if ! ogr2ogr -f GeoJSONSeq /vsistdout/ "/data/$f" M_COVR -select CATCOV; then
    ogrinfo -ro -so -al "/data/$f" | grep -m1 '^Extent: ' || true
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

/**
 * The state to build on: the published index, or the seed when nothing is
 * published yet. A seed is state only, so it never makes a build look
 * unchanged.
 */
async function fetchPrevious(
  publishedUrl: string,
  seedUrl: string | undefined
): Promise<{ previous: PublishedEncIndex | null; published: PublishedEncIndex | null }> {
  const text = await fetchText(publishedUrl);
  if (text !== null) {
    const schemaText = await fetchText(new URL('enc-index.schema.json', publishedUrl).href);
    const published = readPublishedEncIndex(JSON.parse(text), schemaText);
    return { previous: published, published };
  }
  if (seedUrl) {
    const seed = await fetchText(seedUrl);
    if (seed !== null) {
      console.log(`No published ENC index yet; starting from the seed at ${seedUrl}`);
      const previous = readPublishedEncIndex(JSON.parse(seed), null);
      return { previous: { ...previous, contentHash: null }, published: null };
    }
    console.log(`::warning::No published ENC index and no seed at ${seedUrl}`);
  }
  return { previous: null, published: null };
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

async function downloadOnce(url: string, target: string): Promise<void> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
    });
  } catch (err) {
    throw new TransientError(message(err));
  }
  if (!response.ok || !response.body) {
    const error = `HTTP ${String(response.status)}`;
    await response.body?.cancel();
    throw response.status >= 500 ? new TransientError(error) : new Error(error);
  }
  let bytes = 0;
  const limit = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      callback(
        bytes > MAX_DOWNLOAD_BYTES ? new Error('download exceeds the size limit') : null,
        chunk
      );
    }
  });
  try {
    await pipeline(Readable.fromWeb(response.body), limit, fs.createWriteStream(target));
  } catch (err) {
    throw new TransientError(message(err));
  }
}

/** Download with one retry for network errors and 5xx answers. */
async function download(url: string, target: string): Promise<void> {
  try {
    await downloadOnce(url, target);
  } catch (err) {
    if (!(err instanceof TransientError)) {
      throw err;
    }
    await sleep(RETRY_DELAY_MS);
    await downloadOnce(url, target);
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

function runGdal(runtime: string, dir: string, cells: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      runtime,
      [
        'run',
        '--rm',
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
    const out: Buffer[] = [];
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => {
      err = (err + chunk.toString()).slice(-4000);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(out).toString('utf8'));
      } else {
        reject(
          new Error(`GDAL exited with ${String(code)}: ${err.trim().split('\n').pop() ?? ''}`)
        );
      }
    });
  });
}

/** Download one archive, read its cells' coverage, and build its units. */
/** What GDAL reported for one downloaded archive. */
interface ArchiveReport {
  kind: 'zip' | 'cell';
  reports: CellReport[];
  /** Update files (.001, ...) in an archive with no base cells. */
  updateFiles: string[];
}

/** Download one archive and read its cells' scale and coverage. */
async function readArchive(job: ArchiveJob, tmp: string, runtime: string): Promise<ArchiveReport> {
  fs.rmSync(tmp, { recursive: true, force: true });
  const contents = path.join(tmp, 'contents');
  fs.mkdirSync(contents, { recursive: true });
  try {
    const downloaded = path.join(tmp, 'download');
    await download(job.url, downloaded);
    const kind = kindOf(downloaded);
    if (kind === 'zip') {
      await extractZipSafely(downloaded, contents);
    } else if (kind === 'cell') {
      fs.renameSync(downloaded, path.join(contents, cellFileName(job)));
    } else {
      throw new Error('the download is neither a ZIP archive nor an S-57 cell');
    }
    const cells = findFiles(contents, /\.000$/i);
    if (cells.length === 0) {
      const updateFiles = findFiles(contents, /\.(?!000)\d{3}$/);
      if (updateFiles.length === 0) {
        throw new Error('no S-57 cell (.000) in the archive');
      }
      return { kind, reports: [], updateFiles };
    }
    return {
      kind,
      reports: parseGdalReport(await runGdal(runtime, contents, cells)),
      updateFiles: []
    };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

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
        saved.key !== jobKey(job) ||
        saved.version !== job.version ||
        (kind !== 'zip' && kind !== 'cell') ||
        !Array.isArray(reports)
      ) {
        return null;
      }
      return {
        kind,
        reports: reports as CellReport[],
        updateFiles: Array.isArray(updateFiles) ? (updateFiles as string[]) : []
      };
    } catch {
      return null;
    }
  }

  put(job: ArchiveJob, report: ArchiveReport): void {
    const file = this.file(job);
    const saved = { key: jobKey(job), version: job.version, ...report };
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(saved));
    fs.renameSync(`${file}.tmp`, file);
  }
}

interface BuildOptions {
  runtime: string;
  work: string;
  delayMs: number;
  deadline: number;
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
            options.runtime
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

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      chartcatalogs: { type: 'string' },
      index: { type: 'string' },
      out: { type: 'string' },
      'published-url': { type: 'string' },
      'seed-url': { type: 'string' },
      'noaa-url': { type: 'string', default: NOAA_ENC_GEOJSON_URL },
      work: { type: 'string' },
      sources: { type: 'string' },
      'max-minutes': { type: 'string' },
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
  const sources = encSources(facets);
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
  const jobs = archiveJobs(sources, files);
  const { previous, published } = await fetchPrevious(publishedUrl, values['seed-url']);
  const noaa = selected(NOAA_SOURCE_ID) ? await readNoaa(values['noaa-url']) : null;

  const pending = jobsToBuild(
    jobs.filter((j) => selected(j.source)),
    previous
  );
  console.log(
    `${String(jobs.length)} chartcatalogs ENC archives; ${String(pending.length)} to read this run`
  );

  const ownWork = !values.work;
  const work = values.work ?? fs.mkdtempSync(path.join(os.tmpdir(), 'enc-index-'));
  const maxMinutes = values['max-minutes'] ? Number(values['max-minutes']) : Infinity;
  let outcome: Awaited<ReturnType<typeof buildJobs>>;
  try {
    outcome = await buildJobs(pending, {
      runtime: values.runtime,
      work,
      delayMs: Number(values['delay-ms']),
      deadline: Date.now() + maxMinutes * 60000
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
    previous,
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
  for (const entry of result.duplicateCells) {
    console.log(`::notice::Duplicate cell ${entry}; kept the newer archive`);
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
