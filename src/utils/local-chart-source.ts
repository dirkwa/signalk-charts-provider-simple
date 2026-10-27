/**
 * Charts already on the Signal K server's disk, converted in place of an
 * upload: a folder holding chart files and/or ZIP archives of them, or one
 * ZIP. The source is only read. Archives are extracted into the conversion's
 * own work directory, and loose chart files are read where they lie.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import unzipper from 'unzipper';
import { extractZipSafely } from './zip-extract.js';

/** The chart files a conversion reads, by file name. */
export type ChartFileTest = (name: string) => boolean;

// macOS archives and copies carry AppleDouble `._<name>` companions beside
// each file; they share the extension but are not charts.
const notAppleDouble = (name: string): boolean => !path.basename(name).startsWith('._');

/** An S-57 cell: its base file, `.000`. Updates beside it are read by GDAL. */
export const isS57Cell: ChartFileTest = (name) =>
  name.toLowerCase().endsWith('.000') && notAppleDouble(name);

/**
 * An S-57 update file (`.001`, `.002`, …). A source can hold updates apart
 * from their base cell, in another folder or ZIP file.
 */
export const isS57Update: ChartFileTest = (name) =>
  /\.\d{3}$/.test(name) && !name.endsWith('.000') && notAppleDouble(name);

/** A BSB raster chart. */
export const isBsbChart: ChartFileTest = (name) =>
  ['.kap', '.bsb'].includes(path.extname(name).toLowerCase()) && notAppleDouble(name);

/**
 * Stop walking a folder after this many entries: pointing at a disk's root
 * would otherwise walk the whole disk before the conversion could start.
 */
export const MAX_SCAN_ENTRIES = 200_000;

/** A request the user can fix: the message says what is wrong. */
export class LocalSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LocalSourceError';
  }
}

export interface LocalChartSource {
  /** The folder or ZIP, resolved. */
  root: string;
  /** Its name, without `.zip`: what the converted chart is named after. */
  name: string;
  /** Chart files outside any archive. */
  looseFiles: string[];
  /** Companion files (S-57 updates) outside any archive. */
  looseCompanions: string[];
  /** Archives that hold at least one chart file or companion file. */
  zips: string[];
  /** Archives that could not be read, with the reason. */
  unreadableZips: string[];
}

/** `~` and `~/…` name the server's home folder; anything else must be absolute. */
export function resolveLocalPath(input: string): string {
  const trimmed = input.trim();
  if (trimmed === '') {
    throw new LocalSourceError('Enter the path of a folder or ZIP file on the Signal K server');
  }
  const expanded =
    trimmed === '~' || trimmed.startsWith('~/') || trimmed.startsWith('~\\')
      ? path.join(os.homedir(), trimmed.slice(1))
      : trimmed;
  if (!path.isAbsolute(expanded)) {
    throw new LocalSourceError(
      `Use a full path, such as /srv/charts or ~/charts (got "${trimmed}")`
    );
  }
  return path.resolve(expanded);
}

/** What an archive holds that a conversion reads: chart files, only companions, or neither. */
async function zipContents(
  zipPath: string,
  isChartFile: ChartFileTest,
  isCompanion: ChartFileTest | undefined
): Promise<'charts' | 'companions' | null> {
  const directory = await unzipper.Open.file(zipPath);
  const files = directory.files.filter((f) => f.type === 'File');
  if (files.some((f) => isChartFile(f.path))) {
    return 'charts';
  }
  return isCompanion && files.some((f) => isCompanion(f.path)) ? 'companions' : null;
}

/**
 * Find what a conversion of `input` would read. A folder is walked
 * recursively, without following links or entering hidden folders; an
 * archive is looked into without extracting it, and kept only if it holds a
 * chart file. Throws a {@link LocalSourceError} when there is nothing to
 * convert.
 */
export async function inspectLocalChartSource(
  input: string,
  isChartFile: ChartFileTest,
  kind: string,
  // Files read with the charts though not charts themselves (S-57 updates);
  // archives holding only these are kept too.
  isCompanion?: ChartFileTest
): Promise<LocalChartSource> {
  const root = resolveLocalPath(input);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(root);
  } catch {
    throw new LocalSourceError(`${root} does not exist on the Signal K server`);
  }

  const looseFiles: string[] = [];
  const looseCompanions: string[] = [];
  const candidateZips: string[] = [];
  if (stat.isFile()) {
    if (!root.toLowerCase().endsWith('.zip')) {
      throw new LocalSourceError(`${root} is not a folder or a ZIP file`);
    }
    candidateZips.push(root);
  } else if (stat.isDirectory()) {
    let visited = 0;
    // Asynchronous, so a large folder never holds up the server's event loop.
    const walk = async (dir: string): Promise<void> => {
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch {
        // An unreadable subfolder holds nothing this conversion can use.
        return;
      }
      for (const entry of entries) {
        visited++;
        if (visited > MAX_SCAN_ENTRIES) {
          throw new LocalSourceError(
            `${root} holds too many files to search; choose the folder that holds the charts`
          );
        }
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (
            !entry.name.startsWith('.') &&
            entry.name !== 'node_modules' &&
            (await isRealDirectory(full))
          ) {
            await walk(full);
          }
        } else if (entry.isFile()) {
          if (isChartFile(entry.name)) {
            looseFiles.push(full);
          } else if (isCompanion?.(entry.name)) {
            looseCompanions.push(full);
          } else if (entry.name.toLowerCase().endsWith('.zip') && notAppleDouble(entry.name)) {
            candidateZips.push(full);
          }
        }
      }
    };
    await walk(root);
  } else {
    throw new LocalSourceError(`${root} is not a folder or a ZIP file`);
  }

  const zips: string[] = [];
  const unreadableZips: string[] = [];
  let chartZips = 0;
  for (const zip of candidateZips) {
    try {
      const contents = await zipContents(zip, isChartFile, isCompanion);
      if (contents !== null) {
        zips.push(zip);
      }
      if (contents === 'charts') {
        chartZips++;
      }
    } catch (err) {
      unreadableZips.push(`${zip}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (looseFiles.length === 0 && chartZips === 0) {
    const what = stat.isFile() ? 'This ZIP file' : 'This folder';
    throw new LocalSourceError(`${what} holds no ${kind}, loose or in ZIP files: ${root}`);
  }

  const name = path.basename(root).replace(/\.zip$/i, '') || 'charts';
  return {
    root,
    name,
    looseFiles: looseFiles.sort(),
    looseCompanions: looseCompanions.sort(),
    zips: zips.sort(),
    unreadableZips
  };
}

/**
 * Whether `dir` is still a directory, not a link to one: the walk lists a
 * folder and then descends into it, and in between a folder could be
 * replaced by a link that would take the walk outside the chosen root.
 */
async function isRealDirectory(dir: string): Promise<boolean> {
  try {
    return (await fs.promises.lstat(dir)).isDirectory();
  } catch {
    return false;
  }
}

async function findChartFiles(dir: string, isChartFile: ChartFileTest): Promise<string[]> {
  const found: string[] = [];
  const walk = async (d: string): Promise<void> => {
    for (const entry of await fs.promises.readdir(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        if (await isRealDirectory(full)) {
          await walk(full);
        }
      } else if (entry.isFile() && isChartFile(entry.name)) {
        found.push(full);
      }
    }
  };
  await walk(dir);
  return found.sort();
}

/**
 * Extract each of `source`'s archives into its own folder under `workDir`
 * and return every chart file a conversion reads (the loose ones, where they
 * lie, then those from the archives) and, with `isCompanion`, every
 * companion file the same way.
 */
export async function extractLocalChartSource(
  source: LocalChartSource,
  isChartFile: ChartFileTest,
  workDir: string,
  onArchive?: (zip: string, index: number, count: number) => void,
  isCompanion?: ChartFileTest,
  signal?: AbortSignal
): Promise<{ files: string[]; companions: string[] }> {
  const files = [...source.looseFiles];
  const companions = isCompanion ? [...source.looseCompanions] : [];
  for (const [index, zip] of source.zips.entries()) {
    onArchive?.(zip, index + 1, source.zips.length);
    const dest = path.join(workDir, `archive-${String(index + 1)}`);
    fs.mkdirSync(dest, { recursive: true });
    await extractZipSafely(zip, dest, {}, signal);
    files.push(...(await findChartFiles(dest, isChartFile)));
    if (isCompanion) {
      companions.push(...(await findChartFiles(dest, isCompanion)));
    }
  }
  return { files, companions };
}
