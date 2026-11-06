/**
 * The part of signalk-multihelm's API this plugin uses
 * (https://github.com/dirkwa/signalk-multihelm, `src/api.ts`). Multihelm is
 * a peer plugin, found at runtime through the PropertyValue `multihelm`, so
 * its types are mirrored here rather than imported.
 */

export const MULTIHELM_PROPERTY = 'multihelm';
export const MULTIHELM_API_VERSION = 1;

export interface DatasetFile {
  name: string;
  path: string;
  size: number;
  mtimeMs: number;
}

export interface DatasetEntry {
  key: string;
  meta: unknown;
  files: DatasetFile[];
}

export interface IncomingEntry {
  key: string;
  meta: unknown;
  files: {
    name: string;
    /** In Multihelm's work folder for a changed file, the dataset's own copy for an unchanged one. */
    path: string;
    size: number;
    sha256: string;
    unchanged: boolean;
  }[];
}

export interface DatasetDefinition {
  id: string;
  list: () => Promise<DatasetEntry[]>;
  apply: (entry: IncomingEntry) => Promise<void>;
  /** False keeps the entry here; Multihelm then offers it back to the peers. */
  remove: (key: string) => Promise<boolean>;
  isValidKey?: (key: string) => boolean;
}

export interface DatasetHandle {
  changed: () => void;
  unregister: () => void;
}

export type Role = 'master' | 'member';

export interface MasterRouteHandle {
  unregister: () => void;
}

export interface MasterResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

export interface MultihelmProperty {
  apiVersion: number;
  registerDataset?: (definition: DatasetDefinition) => DatasetHandle;
  role?: () => Role;
  /** The peer that is the master; null when this server is it or there is none. */
  master?: () => unknown;
  onRoleChanged?: (cb: (role: Role) => void) => () => void;
  /** Serve the master's GET answers under `prefix` (ending in `/`) at `masterPath(...)`. */
  registerMasterRoute?: (prefix: string) => MasterRouteHandle;
  masterPath?: (path: string) => string;
  /** Rejects while no other server is the master. */
  fetchMaster?: (path: string) => Promise<MasterResponse>;
}

/** Whether a `multihelm` PropertyValue has the shape this plugin understands. */
export function isMultihelmProperty(value: unknown): value is MultihelmProperty {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { apiVersion?: unknown }).apiVersion === MULTIHELM_API_VERSION
  );
}
