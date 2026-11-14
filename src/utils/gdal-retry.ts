import fs from 'fs';
import { setTimeout as sleep } from 'timers/promises';

// On Windows a virus scanner can hold a file GDAL has just created, and
// SQLite then reports the MBTiles database as locked. Waiting a moment and
// writing the file again gets past it.
export const LOCKED_RETRY_DELAY_MS = 1000;

export async function retryWhenLocked<T>(
  dst: string,
  write: () => T,
  delayMs = LOCKED_RETRY_DELAY_MS
): Promise<T> {
  try {
    return write();
  } catch (err) {
    if (!(err instanceof Error) || !err.message.includes('database is locked')) {
      throw err;
    }
    await sleep(delayMs);
    fs.rmSync(dst, { force: true });
    return write();
  }
}
