/**
 * GDAL compiled to WebAssembly (the `gdal3.js` package), driven through its
 * C API rather than gdal3.js's high-level helpers.
 *
 * The helpers fix every input under `/input` and every output under one
 * `/output` directory chosen at load time, and they open each dataset
 * without open options. The converters need neither restriction: they read
 * from and write to arbitrary host directories, and the S-57 sounding layer
 * must be opened with `SPLIT_MULTIPOINT` / `ADD_SOUNDG_DEPTH`. So this module
 * calls `GDALOpenEx` / `GDALVectorTranslate` / `GDALTranslate` /
 * `GDALRasterize` itself and mounts each host directory it touches into the
 * Emscripten file system with NODEFS, which reads and writes the real files in
 * place: nothing is copied into WASM memory, so a chart larger than the WASM
 * heap still converts.
 *
 * One instance is single-threaded and owns its heap. The converters run one
 * per worker thread (see conversion-worker.ts), never on the server's event
 * loop.
 */

import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);

// GDALOpenEx flags (gdal.h).
const GDAL_OF_RASTER = 0x02;
const GDAL_OF_VECTOR = 0x04;
const GDAL_OF_VERBOSE_ERROR = 0x40;
// CPLErr: CE_Failure and CE_Fatal are errors; CE_Warning is not.
const CE_FAILURE = 3;

// GDAL's block cache lives in the WASM heap, which never shrinks. GDAL's
// default (5% of RAM, as WASM reports it) would let one conversion pin
// hundreds of MB per worker; 64 MB is ample for the sequential reads and
// writes the converters do.
const GDAL_CACHE_BYTES = 64 * 1024 * 1024;

type Cwrap = (name: string, ret: string | null, args: string[]) => (...a: unknown[]) => unknown;

interface EmscriptenFs {
  mkdir(p: string): void;
  rmdir(p: string): void;
  mount(type: unknown, opts: { root: string }, mountpoint: string): void;
  unmount(mountpoint: string): void;
}

interface GdalModule {
  cwrap: Cwrap;
  FS: EmscriptenFs;
  NODEFS: unknown;
  _malloc(size: number): number;
  _free(ptr: number): void;
  setValue(ptr: number, value: number, type: string): void;
  lengthBytesUTF8(s: string): number;
  stringToUTF8(s: string, ptr: number, max: number): void;
}

interface Gdal3Instance {
  Module: GdalModule;
  drivers: { raster: Record<string, unknown>; vector: Record<string, unknown> };
}

type InitGdalJs = (config: {
  path?: string;
  useWorker?: boolean;
  logHandler?: (message: string, type: string) => void;
  errorHandler?: (message: string, type: string) => void;
}) => Promise<Gdal3Instance>;

export class GdalError extends Error {
  constructor(
    message: string,
    /** GDAL's own messages leading up to the failure, oldest first. */
    readonly gdalLog: string[]
  ) {
    super(message);
    this.name = 'GdalError';
  }
}

/** A dataset to read: a host path, plus GDAL open options (`NAME=VALUE`). */
export interface GdalSource {
  path: string;
  openOptions?: string[];
}

export interface GdalWasm {
  /** The GDAL build, as `gdal3.js <package version>`. */
  readonly version: string;
  hasDriver(kind: 'raster' | 'vector', name: string): boolean;
  /** Names of the vector layers of a dataset. */
  layerNames(source: GdalSource): string[];
  /** `ogr2ogr <args> <dst> <src>`; `dst` is a host path. */
  vectorTranslate(dst: string, source: GdalSource, args: string[]): void;
  /** `gdal_translate <args> <src> <dst>`. */
  translate(dst: string, source: GdalSource, args: string[]): void;
  /** `gdal_rasterize <args> <src> <dst>`; `dst` must not exist. */
  rasterize(dst: string, source: GdalSource, args: string[]): void;
  /** Messages GDAL printed since the last call, oldest first. */
  drainLog(): string[];
}

let distDir: string | null = null;

/** Directory holding gdal3.js's `.wasm` and `.data` files. */
function gdalDistDir(): string {
  distDir ??= path.dirname(require.resolve('gdal3.js/dist/package/gdal3.node.js'));
  return distDir;
}

export async function loadGdalWasm(): Promise<GdalWasm> {
  const initGdalJs = require('gdal3.js/node.js') as InitGdalJs;
  const log: string[] = [];
  const record = (message: string): void => {
    const text = message.trim();
    if (text) {
      log.push(text);
      // A runaway driver warning must not grow the log without bound.
      if (log.length > 500) {
        log.splice(0, log.length - 500);
      }
    }
  };
  // gdal3.js reads its `.data` package relative to the working directory
  // (`./<path>`), so an absolute path would resolve under it. Hand it the
  // package directory relative to the working directory instead.
  const gdal = await initGdalJs({
    path: path.relative(process.cwd(), gdalDistDir()) || '.',
    useWorker: false,
    logHandler: record,
    errorHandler: record
  });
  const M = gdal.Module;
  const fn = {
    openEx: M.cwrap('GDALOpenEx', 'number', ['string', 'number', 'number', 'number', 'number']),
    close: M.cwrap('GDALClose', null, ['number']),
    layerCount: M.cwrap('GDALDatasetGetLayerCount', 'number', ['number']),
    getLayer: M.cwrap('GDALDatasetGetLayer', 'number', ['number', 'number']),
    layerName: M.cwrap('OGR_L_GetName', 'string', ['number']),
    vtOptionsNew: M.cwrap('GDALVectorTranslateOptionsNew', 'number', ['number', 'number']),
    vtOptionsFree: M.cwrap('GDALVectorTranslateOptionsFree', null, ['number']),
    vectorTranslate: M.cwrap('GDALVectorTranslate', 'number', [
      'string',
      'number',
      'number',
      'number',
      'number',
      'number'
    ]),
    trOptionsNew: M.cwrap('GDALTranslateOptionsNew', 'number', ['number', 'number']),
    trOptionsFree: M.cwrap('GDALTranslateOptionsFree', null, ['number']),
    translate: M.cwrap('GDALTranslate', 'number', ['string', 'number', 'number', 'number']),
    rzOptionsNew: M.cwrap('GDALRasterizeOptionsNew', 'number', ['number', 'number']),
    rzOptionsFree: M.cwrap('GDALRasterizeOptionsFree', null, ['number']),
    rasterize: M.cwrap('GDALRasterize', 'number', [
      'string',
      'number',
      'number',
      'number',
      'number'
    ]),
    errorReset: M.cwrap('CPLErrorReset', null, []),
    lastErrorType: M.cwrap('CPLGetLastErrorType', 'number', []),
    lastErrorMsg: M.cwrap('CPLGetLastErrorMsg', 'string', []),
    setCacheMax: M.cwrap('GDALSetCacheMax', null, ['number'])
  };
  fn.setCacheMax(GDAL_CACHE_BYTES);

  // NULL-terminated `char **`, freed by the returned callback.
  const stringList = (items: readonly string[] | undefined): { ptr: number; free: () => void } => {
    if (!items || items.length === 0) {
      return { ptr: 0, free: () => undefined };
    }
    const ptrs = items.map((s) => {
      const size = M.lengthBytesUTF8(s) + 1;
      const p = M._malloc(size);
      M.stringToUTF8(s, p, size);
      return p;
    });
    const list = M._malloc((ptrs.length + 1) * 4);
    ptrs.forEach((p, i) => {
      M.setValue(list + i * 4, p, '*');
    });
    M.setValue(list + ptrs.length * 4, 0, '*');
    return {
      ptr: list,
      free: () => {
        ptrs.forEach((p) => {
          M._free(p);
        });
        M._free(list);
      }
    };
  };

  // Host directory → mount point. A mount lives for the duration of one
  // call: the caller's next call may name a different directory, and a
  // stale NODEFS mount would keep its directory's metadata cached.
  let mountSeq = 0;
  const withMounts = <T>(
    hostPaths: readonly string[],
    body: (map: (p: string) => string) => T
  ): T => {
    const mounts = new Map<string, string>();
    for (const hostPath of hostPaths) {
      const dir = path.dirname(path.resolve(hostPath));
      if (!mounts.has(dir)) {
        const mountPoint = `/host${String(mountSeq++)}`;
        M.FS.mkdir(mountPoint);
        M.FS.mount(M.NODEFS, { root: dir }, mountPoint);
        mounts.set(dir, mountPoint);
      }
    }
    const map = (hostPath: string): string => {
      const abs = path.resolve(hostPath);
      const mountPoint = mounts.get(path.dirname(abs));
      if (!mountPoint) {
        throw new Error(`gdal-wasm: ${hostPath} was not mounted`);
      }
      return `${mountPoint}/${path.basename(abs)}`;
    };
    try {
      return body(map);
    } finally {
      for (const mountPoint of mounts.values()) {
        try {
          M.FS.unmount(mountPoint);
          M.FS.rmdir(mountPoint);
        } catch {
          // A failed unmount leaves an unused mount point behind; harmless.
        }
      }
    }
  };

  const failure = (what: string): GdalError => {
    const message = fn.lastErrorMsg() as string;
    return new GdalError(message ? `${what}: ${message}` : `${what} failed`, [...log]);
  };

  const open = (virtualPath: string, flags: number, openOptions?: string[]): number => {
    const options = stringList(openOptions);
    fn.errorReset();
    const ds = fn.openEx(virtualPath, flags | GDAL_OF_VERBOSE_ERROR, 0, options.ptr, 0) as number;
    options.free();
    if (!ds) {
      throw failure(`Cannot open ${path.basename(virtualPath)}`);
    }
    return ds;
  };

  // Run one GDAL utility (create options → call → free options), turning a
  // NULL result or a CE_Failure into a GdalError.
  const runUtility = (
    what: string,
    args: string[],
    newOptions: (...a: unknown[]) => unknown,
    freeOptions: (...a: unknown[]) => unknown,
    call: (options: number) => number
  ): void => {
    const argv = stringList(args);
    fn.errorReset();
    const options = newOptions(argv.ptr, 0) as number;
    argv.free();
    if (!options) {
      throw failure(`${what}: invalid options`);
    }
    let out = 0;
    try {
      out = call(options);
      if (!out || (fn.lastErrorType() as number) >= CE_FAILURE) {
        throw failure(what);
      }
      // Closing flushes the output (the GeoJSON writer's closing bracket,
      // the MBTiles commit); a failure there is a failed write.
      const written = out;
      out = 0;
      fn.errorReset();
      fn.close(written);
      if ((fn.lastErrorType() as number) >= CE_FAILURE) {
        throw failure(`${what} (closing the output)`);
      }
    } finally {
      freeOptions(options);
      if (out) {
        fn.close(out);
      }
    }
  };

  const version = readGdalVersion();

  return {
    version,
    hasDriver: (kind, name) => name in gdal.drivers[kind],
    layerNames: (source) =>
      withMounts([source.path], (map) => {
        const ds = open(map(source.path), GDAL_OF_VECTOR, source.openOptions);
        try {
          const names: string[] = [];
          const count = fn.layerCount(ds) as number;
          for (let i = 0; i < count; i++) {
            names.push(fn.layerName(fn.getLayer(ds, i)) as string);
          }
          return names;
        } finally {
          fn.close(ds);
        }
      }),
    vectorTranslate: (dst, source, args) => {
      withMounts([source.path, dst], (map) => {
        const ds = open(map(source.path), GDAL_OF_VECTOR, source.openOptions);
        const list = M._malloc(4);
        M.setValue(list, ds, '*');
        try {
          runUtility(
            `ogr2ogr ${path.basename(dst)}`,
            args,
            fn.vtOptionsNew,
            fn.vtOptionsFree,
            (options) => fn.vectorTranslate(map(dst), 0, 1, list, options, 0) as number
          );
        } finally {
          M._free(list);
          fn.close(ds);
        }
      });
    },
    translate: (dst, source, args) => {
      withMounts([source.path, dst], (map) => {
        const ds = open(map(source.path), GDAL_OF_RASTER, source.openOptions);
        try {
          runUtility(
            `gdal_translate ${path.basename(dst)}`,
            args,
            fn.trOptionsNew,
            fn.trOptionsFree,
            (options) => fn.translate(map(dst), ds, options, 0) as number
          );
        } finally {
          fn.close(ds);
        }
      });
    },
    rasterize: (dst, source, args) => {
      withMounts([source.path, dst], (map) => {
        const ds = open(map(source.path), GDAL_OF_VECTOR, source.openOptions);
        try {
          runUtility(
            `gdal_rasterize ${path.basename(dst)}`,
            args,
            fn.rzOptionsNew,
            fn.rzOptionsFree,
            (options) => fn.rasterize(map(dst), 0, ds, options, 0) as number
          );
        } finally {
          fn.close(ds);
        }
      });
    },
    drainLog: () => log.splice(0, log.length)
  };
}

/**
 * gdal3.js does not export `GDALVersionInfo`; its package version pins one
 * GDAL build, so the package version identifies the GDAL that ran.
 */
function readGdalVersion(): string {
  try {
    const pkg = require('gdal3.js/package.json') as { version?: string };
    return `gdal3.js ${pkg.version ?? 'unknown'}`;
  } catch {
    return 'gdal3.js';
  }
}

/**
 * Identifies the GDAL build the converters run, for caches whose content
 * depends on GDAL's output (chart-set-cache.ts): the gdal3.js package
 * version, which pins one GDAL build. Readable without loading the WASM.
 */
export function gdalBuildId(): string {
  return readGdalVersion();
}
