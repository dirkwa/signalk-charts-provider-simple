import { parentPort, workerData } from 'node:worker_threads';
import { buildLandIndex, type LandBuildProgress, type LandSource } from './land-index.js';

export interface LandBuildRequest {
  file: string;
  userAgent: string;
  /** Tests point the build at local sources. */
  sources?: LandSource[];
}

export type LandBuildMessage =
  | { type: 'progress'; progress: LandBuildProgress }
  | { type: 'done'; version: string }
  | { type: 'error'; message: string };

const request = workerData as LandBuildRequest;
const post = (message: LandBuildMessage): void => {
  parentPort?.postMessage(message);
};

// A worker of its own, because parsing a gigabyte of shapefile and writing
// the index would otherwise hold up tile serving for minutes on a Pi.
buildLandIndex(request.file, {
  userAgent: request.userAgent,
  ...(request.sources ? { sources: request.sources } : {}),
  onProgress: (progress) => {
    post({ type: 'progress', progress });
  }
}).then(
  ({ version }) => {
    post({ type: 'done', version });
  },
  (err: unknown) => {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
);
