/**
 * The worker threads chart conversion runs on. Each conversion opens its own
 * pool and closes it when done, so the WASM heaps of its GDAL instances (which
 * never shrink) are released with it, and a cancel can stop work mid-task:
 * aborting the conversion's signal terminates every worker, which stops a
 * GDAL call or a tile shard at once rather than at the next boundary.
 *
 * The pool's size is the conversion's share of the CPU budget
 * (concurrency.ts), and for tiling also what the free memory holds;
 * workers start on demand, so a one-file conversion starts one.
 */

import { Worker } from 'node:worker_threads';
import type {
  ConversionTask,
  TaskEvent,
  TaskResult,
  WorkerReply,
  WorkerRequest
} from './conversion-worker.js';

/** Thrown for every task still pending when the pool's signal aborts. */
export class PoolAbortedError extends Error {
  constructor() {
    super('Conversion cancelled');
    this.name = 'AbortError';
  }
}

/** A task failed inside its worker; `log` holds GDAL's messages, if any. */
export class TaskFailedError extends Error {
  constructor(
    message: string,
    readonly log: string[]
  ) {
    super(message);
    this.name = 'TaskFailedError';
  }
}

interface Pending {
  task: ConversionTask;
  transfer: ArrayBuffer[];
  onEvent?: (event: TaskEvent) => void;
  resolve: (result: TaskResult) => void;
  reject: (err: Error) => void;
}

interface PoolWorker {
  worker: Worker;
  current: (Pending & { id: number }) | null;
}

export interface RunOptions {
  /** Buffers moved to the worker rather than copied. */
  transfer?: ArrayBuffer[];
  /** Intermediate output of the task (tile batches, progress). */
  onEvent?: (event: TaskEvent) => void;
}

export class WorkerPool {
  private readonly workers: PoolWorker[] = [];
  private readonly queue: Pending[] = [];
  /** Workers being terminated, which close() waits for. */
  private readonly stopping: Promise<unknown>[] = [];
  private nextId = 0;
  private closed = false;
  private readonly onAbort = (): void => {
    this.terminate(new PoolAbortedError());
  };

  constructor(
    readonly size: number,
    private readonly signal?: AbortSignal,
    /** Old-generation limit of each worker; undefined leaves V8's default. */
    private readonly heapMb?: number
  ) {
    signal?.addEventListener('abort', this.onAbort, { once: true });
  }

  run<O extends ConversionTask['op']>(
    task: Extract<ConversionTask, { op: O }>,
    options: RunOptions = {}
  ): Promise<Extract<TaskResult, { op: O }>> {
    if (this.signal?.aborted) {
      return Promise.reject(new PoolAbortedError());
    }
    if (this.closed) {
      return Promise.reject(new Error('Worker pool is closed'));
    }
    return new Promise((resolve, reject) => {
      this.queue.push({
        task,
        transfer: options.transfer ?? [],
        onEvent: options.onEvent,
        resolve: resolve as (result: TaskResult) => void,
        reject
      });
      this.dispatch();
    });
  }

  /** Stop every worker. Pending tasks reject; idempotent. */
  async close(): Promise<void> {
    this.signal?.removeEventListener('abort', this.onAbort);
    this.terminate(new Error('Worker pool is closed'));
    // Only once every worker has exited may the caller remove the
    // directories they were writing to.
    await Promise.allSettled(this.stopping);
  }

  private terminate(reason: Error): void {
    this.closed = true;
    for (const pending of this.queue.splice(0)) {
      pending.reject(reason);
    }
    for (const entry of this.workers.splice(0)) {
      entry.current?.reject(reason);
      entry.current = null;
      this.stopping.push(entry.worker.terminate());
    }
  }

  private dispatch(): void {
    while (this.queue.length > 0) {
      let entry = this.workers.find((w) => w.current === null);
      if (!entry) {
        if (this.workers.length >= Math.max(1, this.size)) {
          return;
        }
        entry = this.spawn();
      }
      const pending = this.queue.shift();
      if (!pending) {
        return;
      }
      const id = this.nextId++;
      entry.current = { ...pending, id };
      const request: WorkerRequest = { id, task: pending.task };
      entry.worker.postMessage(request, pending.transfer);
    }
  }

  private spawn(): PoolWorker {
    const worker = new Worker(
      new URL('./conversion-worker.js', import.meta.url),
      this.heapMb === undefined ? {} : { resourceLimits: { maxOldGenerationSizeMb: this.heapMb } }
    );
    const entry: PoolWorker = { worker, current: null };
    this.workers.push(entry);
    worker.on('message', (reply: WorkerReply) => {
      const current = entry.current;
      if (current?.id !== reply.id) {
        return;
      }
      if (reply.type === 'event') {
        try {
          current.onEvent?.(reply.event);
        } catch (err) {
          // A failing consumer (a full disk under the tile sink, say) fails
          // this task; it must not throw out of the listener, where it would
          // take the server down. The worker goes, mid-task.
          this.workers.splice(this.workers.indexOf(entry), 1);
          entry.current = null;
          current.reject(err instanceof Error ? err : new Error('Task event failed'));
          this.stopping.push(entry.worker.terminate());
          if (!this.closed) {
            this.dispatch();
          }
        }
        return;
      }
      entry.current = null;
      if (reply.type === 'done') {
        current.resolve(reply.result);
      } else {
        current.reject(new TaskFailedError(reply.message, reply.log));
      }
      this.dispatch();
    });
    // A crashed worker (an aborted WASM instance, an out-of-memory heap)
    // fails its task only, as a TaskFailedError like any other failed task,
    // so callers skip the one cell or chart; the next task gets a fresh
    // worker.
    const fail = (err: Error): void => {
      const index = this.workers.indexOf(entry);
      if (index < 0) {
        return;
      }
      this.workers.splice(index, 1);
      entry.current?.reject(new TaskFailedError(err.message, []));
      entry.current = null;
      if (!this.closed) {
        this.dispatch();
      }
    };
    worker.on('error', fail);
    worker.on('exit', (code) => {
      fail(new Error(`Conversion worker exited with code ${String(code)}`));
    });
    return entry;
  }
}

/**
 * Run `body` with a pool of `size` workers, closing it however `body` ends.
 * `size` may also carry each worker's old-generation limit.
 */
export async function withWorkerPool<T>(
  size: number | { workers: number; heapMb: number | undefined },
  signal: AbortSignal | undefined,
  body: (pool: WorkerPool) => Promise<T>
): Promise<T> {
  const pool =
    typeof size === 'number'
      ? new WorkerPool(size, signal)
      : new WorkerPool(size.workers, signal, size.heapMb);
  try {
    return await body(pool);
  } finally {
    await pool.close();
  }
}

/**
 * Run `items` through `fn` with at most `limit` in flight. Rejects with the
 * first failure once the in-flight items have settled.
 */
export async function forEachConcurrent<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<void>
): Promise<void> {
  let next = 0;
  // A holder, not a `let`: assignments inside the lanes are invisible to
  // the narrowing of a local.
  const state: { failure: Error | null } = { failure: null };
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (state.failure === null && next < items.length) {
      const index = next++;
      try {
        await fn(items[index], index);
      } catch (err) {
        state.failure ??= err instanceof Error ? err : new Error('Task failed', { cause: err });
      }
    }
  });
  await Promise.all(lanes);
  if (state.failure !== null) {
    throw state.failure;
  }
}
