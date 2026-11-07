/**
 * Entry point of a chart conversion worker process (worker-pool.ts). It runs
 * conversion-worker.ts on a thread of its own and relays the messages both
 * ways, so this process's main thread stays free to pass a shard's tile
 * batches on while the thread is still tiling it: the shard is tiled in one
 * synchronous call, and batches sent from that call would wait in this
 * process until it returned.
 *
 * The process exits when its pool closes, which returns all of its memory
 * to the system. A worker thread's did not go back: gdal3.js's WebAssembly
 * memory and glibc's per-thread malloc arenas stayed with the server.
 *
 * argv[2] is the thread's old-generation limit in MB, or empty for V8's
 * default. A thread that fails (its heap limit reached, say) writes why to
 * stderr and the process exits, which fails the task it was running.
 */

import { Worker } from 'node:worker_threads';

if (process.send) {
  // Without this an IPC child outlives a server that was killed or crashed.
  process.once('disconnect', () => process.exit(1));
  const heapMb = Number(process.argv[2]);
  const worker = new Worker(
    new URL('./conversion-worker.js', import.meta.url),
    heapMb > 0 ? { resourceLimits: { maxOldGenerationSizeMb: heapMb } } : {}
  );
  process.on('message', (message) => {
    worker.postMessage(message);
  });
  worker.on('message', (message) => {
    process.send?.(message);
  });
  // 'exit' follows 'error'; the process waits for the reason to be written.
  let failed = false;
  worker.on('error', (err: Error) => {
    failed = true;
    process.stderr.write(`${err.message}\n`, () => process.exit(1));
  });
  worker.on('exit', (code) => {
    if (!failed) {
      process.exit(code === 0 ? 1 : code);
    }
  });
}
