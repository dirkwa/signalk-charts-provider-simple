/**
 * Owns the land index on disk: whether it is there, building or failed, and
 * the one build that may run at a time.
 *
 * Nothing is downloaded until the user confirms it, the first time they add
 * a masked chart version. That consent is kept in `state.json`, so a build
 * cut short by a restart (a config save restarts the plugin) resumes on the
 * next start without asking again, as long as a masked version still needs
 * it. A failed build does not retry by itself: on a metered connection a
 * gigabyte must not be fetched again on every restart, so the user retries
 * or cancels. Cancelling, or deleting the index, takes the consent back.
 *
 * The build runs in a worker thread and survives a plugin restart, like a
 * chart download does; the next start finds it running and waits for it.
 */

import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { LandIndex, type LandBuildProgress, type LandSource } from './land-index.js';
import type { LandBuildMessage, LandBuildRequest } from './land-index-worker.js';

export type LandIndexStatus = 'absent' | 'building' | 'ready' | 'failed';

export interface LandIndexState {
  status: LandIndexStatus;
  /** Whether the user agreed to the download, and has not cancelled it. */
  requested: boolean;
  progress?: LandBuildProgress;
  error?: string;
  /** Bytes the built index takes on disk. */
  diskBytes?: number;
}

interface StoredState {
  requested?: boolean;
  /** Why the last build failed; it is not resumed on start while set. */
  failed?: string;
}

// Keeps the build's own heap small; V8 otherwise lets it grow far past what
// a gigabyte streamed a record at a time needs.
const BUILD_HEAP_MB = 192;

let dir = '';
let userAgent = '';
let sources: LandSource[] | undefined;
let index: LandIndex | null = null;
let building: { worker: Worker; settled: boolean } | null = null;
let progress: LandBuildProgress | undefined;
let listener: (() => void) | null = null;
/** A cancel finishing up; a new build waits for it, or it would delete the new one's files. */
let cancelling: Promise<void> | null = null;

const indexFile = (): string => path.join(dir, 'land.sqlite');
const stateFile = (): string => path.join(dir, 'state.json');

function readState(): StoredState {
  try {
    const state = JSON.parse(fs.readFileSync(stateFile(), 'utf-8')) as StoredState;
    return {
      requested: state.requested === true,
      ...(typeof state.failed === 'string' ? { failed: state.failed } : {})
    };
  } catch {
    return {};
  }
}

function writeState(state: StoredState): void {
  if (state.requested) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(stateFile(), `${JSON.stringify(state)}\n`);
  } else {
    fs.rmSync(stateFile(), { force: true });
  }
}

function removeBuildFiles(): void {
  // A file still held open (a worker not yet gone, or a virus scanner on
  // Windows) must not take the server down; the next start removes it.
  try {
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      fs.rmSync(`${indexFile()}.building${suffix}`, { force: true });
    }
  } catch (err) {
    console.error(
      `[charts-provider] Could not remove a partial shoreline download: ${String(err)}`
    );
  }
}

/**
 * Point the manager at `<dataDir>/land-index`, open the index if one is
 * built, and resume a build that a restart cut short, if `needed` says a
 * masked version still waits for it. `onChange` runs whenever the index
 * appears, changes or goes, or a build fails.
 */
export function initLandIndex(
  dataDir: string,
  options: {
    userAgent: string;
    onChange: () => void;
    needed: () => Promise<boolean>;
    sources?: LandSource[];
  }
): void {
  const nextDir = path.join(dataDir, 'land-index');
  listener = options.onChange;
  userAgent = options.userAgent;
  sources = options.sources;
  if (nextDir !== dir) {
    index?.close();
    index = null;
    dir = nextDir;
  }
  if (building) {
    return;
  }
  index ??= LandIndex.open(indexFile());
  if (index) {
    return;
  }
  // Left by a build the server did not live to finish.
  removeBuildFiles();
  const state = readState();
  if (state.requested && state.failed === undefined) {
    const startDir = dir;
    const startListener = listener;
    void options
      .needed()
      .catch(() => false)
      .then((needed) => {
        // Unless the plugin stopped, or the user cancelled or asked again, meanwhile.
        if (dir !== startDir || listener !== startListener || building || index) {
          return;
        }
        if (!readState().requested) {
          return;
        }
        if (needed) {
          startBuild();
        } else {
          // Nothing waits for it: adding a version later asks again.
          writeState({});
        }
      });
  }
}

/** Detach from a stopped plugin; a running build carries on for the next start. */
export function stopLandIndex(): void {
  listener = null;
}

/** The built index, or null until one is ready. */
export function getLandIndex(): LandIndex | null {
  return index;
}

export function landIndexState(): LandIndexState {
  const state = dir === '' ? {} : readState();
  const requested = state.requested === true;
  if (building) {
    return { status: 'building', requested, ...(progress ? { progress } : {}) };
  }
  if (index) {
    let diskBytes = 0;
    try {
      diskBytes = fs.statSync(indexFile()).size;
    } catch {
      // Removed under us; the next start notices.
    }
    return { status: 'ready', requested, diskBytes };
  }
  if (requested && state.failed !== undefined) {
    return { status: 'failed', requested, error: state.failed };
  }
  return { status: 'absent', requested };
}

/** Download and build the index, once the user has agreed to it. Does nothing if built or building. */
export async function requestLandIndex(): Promise<void> {
  if (!dir) {
    throw new Error('The land index is not set up');
  }
  await cancelling;
  writeState({ requested: true });
  if (!index && !building) {
    startBuild();
  }
}

function startBuild(): void {
  progress = undefined;
  const request: LandBuildRequest = {
    file: indexFile(),
    userAgent,
    ...(sources ? { sources } : {})
  };
  fs.mkdirSync(dir, { recursive: true });
  const worker = new Worker(new URL('./land-index-worker.js', import.meta.url), {
    workerData: request,
    resourceLimits: { maxOldGenerationSizeMb: BUILD_HEAP_MB }
  });
  const run = { worker, settled: false };
  building = run;
  const finish = (error: string | null): void => {
    if (run.settled) {
      return;
    }
    run.settled = true;
    building = null;
    // A worker that crashed (out of memory, say) cleaned up nothing. A build
    // started again meanwhile writes the same file, so it is left alone.
    void worker
      .terminate()
      .catch(() => undefined)
      .then(() => {
        if (!building && !fs.existsSync(indexFile())) {
          removeBuildFiles();
        }
      });
    if (error === null) {
      index = LandIndex.open(indexFile());
    }
    if (!index) {
      const reason = error ?? 'The new land index could not be opened';
      console.error(`[charts-provider] Shoreline data download failed: ${reason}`);
      writeState({ requested: true, failed: reason });
    }
    listener?.();
  };
  worker.on('message', (message: LandBuildMessage) => {
    if (message.type === 'progress') {
      progress = message.progress;
    } else if (message.type === 'done') {
      console.log(`[charts-provider] Shoreline data ready (version ${message.version})`);
      finish(null);
    } else {
      finish(message.message);
    }
  });
  worker.on('error', (err) => {
    finish(err.message);
  });
  worker.on('exit', (code) => {
    finish(`The build stopped unexpectedly (exit code ${String(code)})`);
  });
  // Building must not keep the server process alive on shutdown.
  worker.unref();
}

/**
 * Stop a running build, or delete the built index, and take back the
 * consent to download it.
 */
export async function deleteLandIndex(): Promise<void> {
  const run = building;
  building = null;
  progress = undefined;
  const removal = (async () => {
    if (run) {
      run.settled = true;
      await run.worker.terminate();
    }
    index?.close();
    index = null;
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      fs.rmSync(indexFile() + suffix, { force: true });
    }
    removeBuildFiles();
    writeState({});
  })();
  cancelling = removal;
  try {
    await removal;
  } finally {
    if (cancelling === removal) {
      cancelling = null;
    }
    listener?.();
  }
}

/** Resolves once a running build has finished. For tests. */
export async function landIndexBuildSettled(): Promise<void> {
  while (building) {
    await new Promise((r) => setTimeout(r, 20));
  }
}
