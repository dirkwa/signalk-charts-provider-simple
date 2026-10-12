import { parentPort } from 'node:worker_threads';
import { composeRasterTile, type RasterJob, type RasterTile } from './raster-compose.js';

export interface RasterRequest {
  id: number;
  job: RasterJob;
}

export interface RasterReply {
  id: number;
  tile: RasterTile | null;
}

parentPort?.on('message', ({ id, job }: RasterRequest) => {
  let tile: RasterTile | null = null;
  try {
    tile = composeRasterTile(job);
  } catch (err) {
    // Corrupt stored tiles degrade to a 404 for the one tile they feed.
    console.error('Error composing raster tile:', err);
  }
  const reply: RasterReply = { id, tile };
  parentPort?.postMessage(reply);
});
