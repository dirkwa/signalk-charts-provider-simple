/**
 * The worker threads that do the plugin's pixel work: synthesizing missing
 * raster tiles (raster-compose.ts) and masking online chart tiles
 * (raster-mask.ts). Decoding and encoding take tens of milliseconds per
 * tile, so they stay off the server's event loop; one pool serves both, so
 * together they never take more cores than MAX_WORKERS.
 */

import os from 'node:os';
import { Worker } from 'node:worker_threads';
import type { RasterJob, RasterTile } from './raster-compose.js';
import type { MaskJob, MaskResult } from './raster-mask.js';
import type { RasterReply, RasterRequest, RasterWorkerJob } from './raster-worker.js';

// Leave a core for the server itself; two workers already fill a screen of
// holes in about half the time of one.
const MAX_WORKERS = Math.max(1, Math.min(2, os.availableParallelism() - 1));

interface PoolWorker {
  worker: Worker;
  pending: Map<number, { resolve: (reply: RasterReply) => void; reject: (err: Error) => void }>;
}

let pool: PoolWorker[] = [];
let nextJobId = 0;

function spawnWorker(): PoolWorker {
  const worker = new Worker(new URL('./raster-worker.js', import.meta.url));
  const entry: PoolWorker = { worker, pending: new Map() };
  worker.on('message', (reply: RasterReply) => {
    const job = entry.pending.get(reply.id);
    entry.pending.delete(reply.id);
    if (entry.pending.size === 0) {
      // An idle worker must not keep the server process alive.
      worker.unref();
    }
    job?.resolve(reply);
  });
  const fail = (err: Error) => {
    pool = pool.filter((p) => p !== entry);
    for (const job of entry.pending.values()) {
      job.reject(err);
    }
    entry.pending.clear();
  };
  worker.on('error', fail);
  worker.on('exit', (code) => {
    fail(new Error(`raster worker exited with code ${String(code)}`));
  });
  return entry;
}

function run(work: RasterWorkerJob): Promise<RasterReply> {
  let entry = pool.reduce<PoolWorker | undefined>(
    (best, p) => (!best || p.pending.size < best.pending.size ? p : best),
    undefined
  );
  if (!entry || (entry.pending.size > 0 && pool.length < MAX_WORKERS)) {
    entry = spawnWorker();
    pool.push(entry);
  }
  const target = entry;
  return new Promise((resolve, reject) => {
    const id = nextJobId++;
    target.pending.set(id, { resolve, reject });
    target.worker.ref();
    const request: RasterRequest = { id, work };
    target.worker.postMessage(request);
  });
}

/** A missing raster tile, synthesized from its stored neighbours. */
export async function composeInWorker(job: RasterJob): Promise<RasterTile | null> {
  const reply = await run({ kind: 'compose', job });
  if (reply.kind !== 'compose' || !reply.tile) {
    return null;
  }
  const { data, contentType } = reply.tile;
  return {
    data: Buffer.from(data.buffer, data.byteOffset, data.byteLength),
    contentType
  };
}

/** A tile with the part its mask cuts away made transparent. */
export async function maskInWorker(job: MaskJob): Promise<MaskResult> {
  const reply = await run({ kind: 'mask', job });
  if (reply.kind !== 'mask') {
    return { kind: 'failed' };
  }
  const { result } = reply;
  return result.kind === 'masked'
    ? {
        kind: 'masked',
        data: Buffer.from(result.data.buffer, result.data.byteOffset, result.data.byteLength)
      }
    : result;
}
