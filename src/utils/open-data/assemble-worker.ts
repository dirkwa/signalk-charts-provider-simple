import { parentPort, workerData } from 'worker_threads';
import { assembleChart, NotPatchableError, type AssemblyInput } from './assemble.js';

try {
  assembleChart(workerData as AssemblyInput);
  parentPort?.postMessage({ ok: true });
} catch (error) {
  parentPort?.postMessage({
    ok: false,
    notPatchable: error instanceof NotPatchableError,
    message: error instanceof Error ? error.message : String(error)
  });
}
