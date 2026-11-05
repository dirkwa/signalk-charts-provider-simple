/**
 * The `charts` dataset: one entry per chart file (`.mbtiles`, `.pmtiles`,
 * `.onlinechart.json`) under the chart folder, keyed by its `/`-separated
 * path, with `{ enabled }` as meta and the file itself as its one file.
 */

import fs from 'node:fs';
import path from 'node:path';

import type { DatasetDefinition, DatasetEntry, IncomingEntry } from './api.js';

export const CHARTS_DATASET = 'signalk-charts-provider-simple/charts';
/** Inside the chart folder, so the final rename stays on one file system. Hidden: never scanned. */
export const INCOMING_DIR = '.multihelm-incoming';
const FILE = 'chart';
const MAX_KEY_LENGTH = 512;
const CHART_FILE = /\.(mbtiles|pmtiles)$|\.onlinechart\.json$/i;

export interface ChartsHost {
  chartPath: () => string;
  /** Keyed by the platform's own relative path. */
  isEnabled: (relPath: string) => boolean;
  setEnabled: (relPath: string, enabled: boolean) => void;
  /** Charts were added, replaced, enabled or disabled from a peer: serve them. */
  chartsChanged: (relPaths: string[]) => Promise<void>;
  /** A chart was deleted from a peer: drop what the plugin keeps about it. */
  chartDeleted: (relPath: string) => Promise<void>;
}

/** A relative chart file path inside the folder, with no hidden part. */
export function isChartKey(key: string): boolean {
  if (key === '' || key.length > MAX_KEY_LENGTH) {
    return false;
  }
  if (key.includes('\\') || key.includes('\0') || key.startsWith('/') || /^[A-Za-z]:/.test(key)) {
    return false;
  }
  const segments = key.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..' || s.startsWith('.'))) {
    return false;
  }
  return CHART_FILE.test(segments[segments.length - 1]);
}

function nativeRelPath(key: string): string {
  return key.split('/').join(path.sep);
}

function isEnabledMeta(meta: unknown): boolean {
  return (meta as { enabled?: unknown } | null)?.enabled !== false;
}

async function scan(chartPath: string): Promise<{ key: string; full: string; stat: fs.Stats }[]> {
  const found: { key: string; full: string; stat: fs.Stats }[] = [];
  const walk = async (dir: string, rel: string): Promise<void> => {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) {
        continue;
      }
      const full = path.join(dir, entry.name);
      const key = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(full, key);
      } else if (entry.isFile() && isChartKey(key)) {
        try {
          found.push({ key, full, stat: await fs.promises.stat(full) });
        } catch {
          // Removed while scanning.
        }
      }
    }
  };
  await walk(chartPath, '');
  return found;
}

/** Move `from` to `to`, copying through a hidden file beside it when they are on different file systems. */
async function moveInto(from: string, to: string): Promise<void> {
  try {
    await fs.promises.rename(from, to);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') {
      throw error;
    }
  }
  const tmp = path.join(path.dirname(to), `.${path.basename(to)}.multihelm-part`);
  try {
    await fs.promises.copyFile(from, tmp);
    await fs.promises.rename(tmp, to);
  } finally {
    await fs.promises.rm(tmp, { force: true });
  }
}

export function chartsDataset(host: ChartsHost): DatasetDefinition {
  const target = (key: string): string => path.join(host.chartPath(), ...key.split('/'));
  return {
    id: CHARTS_DATASET,
    isValidKey: isChartKey,

    list: async (): Promise<DatasetEntry[]> =>
      (await scan(host.chartPath())).map(({ key, full, stat }) => ({
        key,
        meta: { enabled: host.isEnabled(nativeRelPath(key)) },
        files: [{ name: FILE, path: full, size: stat.size, mtimeMs: stat.mtimeMs }]
      })),

    apply: async (entry: IncomingEntry): Promise<void> => {
      const file = entry.files.find((f) => f.name === FILE);
      if (!file || entry.files.length !== 1) {
        throw new Error(
          `a chart has exactly one file, ${entry.key} has ${String(entry.files.length)}`
        );
      }
      if (!file.unchanged) {
        const to = target(entry.key);
        await fs.promises.mkdir(path.dirname(to), { recursive: true });
        await moveInto(file.path, to);
      }
      host.setEnabled(nativeRelPath(entry.key), isEnabledMeta(entry.meta));
      await host.chartsChanged([entry.key]);
    },

    remove: async (key: string): Promise<boolean> => {
      await fs.promises.rm(target(key), { force: true });
      await host.chartDeleted(key);
      return true;
    }
  };
}
