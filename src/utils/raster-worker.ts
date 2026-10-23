import { parentPort } from 'node:worker_threads';
import { composeRasterTile, type RasterJob, type RasterTile } from './raster-compose.js';
import { maskRasterTile, type MaskJob, type MaskResult } from './raster-mask.js';

export type RasterWorkerJob = { kind: 'compose'; job: RasterJob } | { kind: 'mask'; job: MaskJob };

export interface RasterRequest {
  id: number;
  work: RasterWorkerJob;
}

export type RasterReply =
  | { id: number; kind: 'compose'; tile: RasterTile | null }
  | { id: number; kind: 'mask'; result: MaskResult };

parentPort?.on('message', ({ id, work }: RasterRequest) => {
  let reply: RasterReply;
  if (work.kind === 'compose') {
    let tile: RasterTile | null = null;
    try {
      tile = composeRasterTile(work.job);
    } catch (err) {
      // Corrupt stored tiles degrade to a 404 for the one tile they feed.
      console.error('Error composing raster tile:', err);
    }
    reply = { id, kind: 'compose', tile };
  } else {
    let result: MaskResult = { kind: 'failed' };
    try {
      result = maskRasterTile(work.job);
    } catch (err) {
      console.error('Error masking raster tile:', err);
    }
    reply = { id, kind: 'mask', result };
  }
  parentPort?.postMessage(reply);
});
