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

/**
 * Local collection id → the key it is replicated under, where the two differ.
 * A Map, so a key such as `constructor` from a peer is only ever data.
 */
class KeyMap {
  private readonly map = new Map<string, string>();

  /** Loads the map from `file`, keeping only safe ids. */
  constructor(private readonly file: string) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as unknown;
      if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
        for (const [id, key] of Object.entries(raw)) {
          if (SAFE_ID.test(id) && typeof key === 'string' && SAFE_ID.test(key)) {
            this.map.set(id, key);
          }
        }
      }
    } catch {
      // No map yet.
    }
  }

  /** The key a local collection is replicated under. */
  keyOf(id: string): string {
    return this.map.get(id) ?? id;
  }

  /** The local collection id a replicated key stands for. */
  idOf(key: string): string {
    for (const [id, k] of this.map) {
      if (k === key) {
        return id;
      }
    }
    return key;
  }

  /** Records that `id` is replicated under `key`. */
  set(id: string, key: string): void {
    if (id === key) {
      this.delete(id);
      return;
    }
    this.map.set(id, key);
    this.save();
  }

  /** Forgets the key of `id`. */
  delete(id: string): void {
    if (this.map.delete(id)) {
      this.save();
    }
  }

  /** Forget ids for which `exists` says there is no collection, ready or not. */
  prune(exists: (id: string) => boolean): void {
    let changed = false;
    for (const id of [...this.map.keys()]) {
      if (!exists(id)) {
        this.map.delete(id);
        changed = true;
      }
    }
    if (changed) {
      this.save();
    }
  }

  private save(): void {
    const tmp = `${this.file}.${String(process.pid)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.map)));
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
 * The `enc` dataset: each ready ENC store collection, kept in step between
 * servers. `dataDir` holds the key map and, while a collection is stored,
 * its files under their names.
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
      // A collection being rewritten is not ready but keeps its key.
      keys.prune((id) => host.owner(id) !== null);
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
