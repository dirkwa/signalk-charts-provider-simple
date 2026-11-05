/**
 * The `enc` dataset: one entry per shared ENC store collection that is
 * ready, its files the cells' files, its meta the collection's name, chart,
 * source and cells with their versions.
 *
 * An entry keeps the key of the collection's id where it was first stored.
 * A received collection whose id is already another owner's here is stored
 * as `<id>-2`; the key it came under is kept in a small file, so it is not
 * offered back as a new collection.
 */

import fs from 'node:fs';
import path from 'node:path';

import type { EncCollection, StoreCollectionRequest, StoreResult } from '../enc-store.js';
import type { DatasetDefinition, DatasetEntry, IncomingEntry } from './api.js';

export const ENC_DATASET = 'signalk-charts-provider-simple/enc';

const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/;
const SAFE_CELL = /^[A-Za-z0-9_-]{1,64}$/;
const SAFE_FILE = /^([A-Za-z0-9_-]{1,64})\.[0-9]{3}$/;

/** The parts of the shared ENC store (`enc-store.ts`) the dataset uses. */
export interface EncHost {
  /** Collections whose write is done. */
  ready: () => EncCollection[];
  filePath: (id: string, cell: string, file: string) => string | null;
  owner: (id: string) => string | null;
  /** The owner a received collection gets: its chart's, or a detached one. */
  ownerFor: (id: string, chart: string | undefined) => string;
  store: (request: StoreCollectionRequest) => Promise<StoreResult>;
  remove: (id: string) => Promise<boolean>;
}

interface EncMeta {
  name: string;
  chart?: string;
  source: string;
  cells: { name: string; version?: string }[];
}

function isEncMeta(meta: unknown): meta is EncMeta {
  const m = meta as Partial<EncMeta> | null;
  return (
    typeof m?.name === 'string' &&
    typeof m.source === 'string' &&
    (m.chart === undefined || typeof m.chart === 'string') &&
    Array.isArray(m.cells) &&
    m.cells.every(
      (c: unknown) =>
        typeof (c as { name?: unknown }).name === 'string' &&
        SAFE_CELL.test((c as { name: string }).name) &&
        ((c as { version?: unknown }).version === undefined ||
          typeof (c as { version?: unknown }).version === 'string')
    )
  );
}

/** Local collection id → the key it is replicated under, where the two differ. */
class KeyMap {
  private map: Record<string, string>;

  constructor(private readonly file: string) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as unknown;
      this.map =
        typeof raw === 'object' && raw !== null && !Array.isArray(raw)
          ? Object.fromEntries(
              Object.entries(raw).filter(
                (e): e is [string, string] => SAFE_ID.test(e[0]) && typeof e[1] === 'string'
              )
            )
          : {};
    } catch {
      this.map = {};
    }
  }

  keyOf(id: string): string {
    return this.map[id] ?? id;
  }

  idOf(key: string): string {
    return Object.entries(this.map).find(([, k]) => k === key)?.[0] ?? key;
  }

  set(id: string, key: string): void {
    if (id === key) {
      this.delete(id);
      return;
    }
    this.map[id] = key;
    this.save();
  }

  delete(id: string): void {
    if (id in this.map) {
      Reflect.deleteProperty(this.map, id);
      this.save();
    }
  }

  /** Forget ids whose collection is gone. */
  prune(ids: ReadonlySet<string>): void {
    const gone = Object.keys(this.map).filter((id) => !ids.has(id));
    for (const id of gone) {
      Reflect.deleteProperty(this.map, id);
    }
    if (gone.length > 0) {
      this.save();
    }
  }

  private save(): void {
    const tmp = `${this.file}.${String(process.pid)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.map));
    fs.renameSync(tmp, this.file);
  }
}

/** A hard link, or a copy with the same modification time on another file system. */
async function linkOrCopy(from: string, to: string): Promise<void> {
  try {
    await fs.promises.link(from, to);
    return;
  } catch {
    // Another file system.
  }
  await fs.promises.copyFile(from, to);
  const stat = await fs.promises.stat(from);
  await fs.promises.utimes(to, stat.atime, stat.mtime);
}

/**
 * `dataDir` holds the key map and, while a collection is stored, its
 * files under their names.
 */
export function encDataset(host: EncHost, dataDir: string): DatasetDefinition {
  const keyMapFile = path.join(dataDir, 'multihelm-enc-keys.json');
  const stagingDir = path.join(dataDir, 'multihelm-enc-staging');
  const keys = new KeyMap(keyMapFile);
  return {
    id: ENC_DATASET,
    isValidKey: (key) => SAFE_ID.test(key),

    list: async (): Promise<DatasetEntry[]> => {
      const collections = host.ready();
      keys.prune(new Set(collections.map((c) => c.id)));
      const entries: DatasetEntry[] = [];
      for (const collection of collections) {
        const meta: EncMeta = { name: collection.name, source: collection.source, cells: [] };
        if (collection.chart !== undefined) {
          meta.chart = collection.chart;
        }
        const files: DatasetEntry['files'] = [];
        for (const cell of [...collection.cells].sort((a, b) => a.name.localeCompare(b.name))) {
          meta.cells.push(
            cell.version === undefined
              ? { name: cell.name }
              : { name: cell.name, version: cell.version }
          );
          for (const file of cell.files) {
            const full = host.filePath(collection.id, cell.name, file.name);
            if (full === null) {
              continue;
            }
            try {
              const stat = await fs.promises.stat(full);
              files.push({ name: file.name, path: full, size: stat.size, mtimeMs: stat.mtimeMs });
            } catch {
              // Replaced while listing; the next round lists it again.
            }
          }
        }
        let key = keys.keyOf(collection.id);
        if (key === collection.id && keys.idOf(key) !== collection.id) {
          // A peer's collection of the same id was stored here under another: this one gets its own key.
          key = `${collection.id.slice(0, 74)}-local`;
          keys.set(collection.id, key);
        }
        entries.push({ key, meta, files });
      }
      return entries;
    },

    apply: async (entry: IncomingEntry): Promise<void> => {
      if (!isEncMeta(entry.meta)) {
        throw new Error(`ENC collection ${entry.key} has no usable description`);
      }
      const meta = entry.meta;
      // The store names a cell's files by their paths: give them their names first.
      const staging = path.join(stagingDir, entry.key);
      await fs.promises.rm(staging, { recursive: true, force: true });
      try {
        const cells = [];
        for (const cell of meta.cells) {
          const dir = path.join(staging, cell.name);
          await fs.promises.mkdir(dir, { recursive: true });
          const files: string[] = [];
          for (const file of entry.files
            .filter((f) => SAFE_FILE.exec(f.name)?.[1] === cell.name)
            .sort((a, b) => a.name.localeCompare(b.name))) {
            const to = path.join(dir, file.name);
            await linkOrCopy(file.path, to);
            files.push(to);
          }
          if (files.length > 0) {
            cells.push(
              cell.version === undefined
                ? { base: files[0], files }
                : { base: files[0], files, version: cell.version }
            );
          }
        }
        const request: StoreCollectionRequest = {
          owner: host.ownerFor(entry.key, meta.chart),
          preferredId: keys.idOf(entry.key),
          name: meta.name,
          kind: 'conversion',
          source: meta.source,
          cells,
          mode: 'link'
        };
        if (meta.chart !== undefined) {
          request.chart = meta.chart;
        }
        const result = await host.store(request);
        keys.set(result.id, entry.key);
      } finally {
        await fs.promises.rm(staging, { recursive: true, force: true });
      }
    },

    remove: async (key: string): Promise<boolean> => {
      const id = keys.idOf(key);
      const owner = host.owner(id);
      if (owner?.startsWith('chart-set:')) {
        // A chart set here keeps its cells, and offers them back to the peers.
        return false;
      }
      if (owner !== null) {
        await host.remove(id);
      }
      keys.delete(id);
      return true;
    }
  };
}
