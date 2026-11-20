/**
 * The Open Data Charts tab on the server: the index, the sets, the unit
 * cache and the runs that build a set into its chart. Builds and downloads
 * run only when the user starts them; on their own the plugin only checks
 * the index, and only while the internet gate allows background work.
 */

import fs from 'fs';
import path from 'path';
import type { Request, Response } from 'express';
import { Type } from 'typebox';
import type { CatalogStatus, DebugFunction } from '../../types.js';
import { sanitizeChartFilename } from '../catalog-title.js';
import { freeDiskBytes } from '../chart-set-cache.js';
import { isWithinBase } from '../path-safety.js';
import { parseBody } from '../rest-validation.js';
import { NotPatchableError, runAssembly, TEMP_SUFFIX, type AssemblyInput } from './assemble.js';
import { QUALITY_CATEGORIES, type OpenDataIndex } from './index-schema.js';
import { OpenDataIndexManager } from './index-manager.js';
import {
  afterPlan,
  afterShading,
  OpenDataSetStore,
  planSet,
  planShading,
  setState,
  shadingHasWork,
  type OpenDataSet,
  type SetPlan,
  type SetState,
  type ShadingPlan
} from './sets.js';
import { parseUnitId, type UnitTile } from './tiles.js';
import { UnitCache, type CacheKind } from './unit-cache.js';

export type RunPhase = 'downloading' | 'building' | 'completed' | 'failed' | 'cancelled';

export interface RunProgress {
  phase: RunPhase;
  message: string;
  unitsDone: number;
  unitsTotal: number;
  bytesDone: number;
  bytesTotal: number;
}

interface Run {
  progress: RunProgress;
  controller: AbortController;
  finished: boolean;
}

export interface OpenDataDeps {
  dataDir: string;
  indexUrl: string;
  chartPath: () => string;
  debug: DebugFunction;
  error: (message: string) => void;
  mayRunBackground: () => boolean;
  /** A chart file was written or removed; paths are relative to the chart folder. */
  chartsChanged: (change: { written?: string; removed?: string }) => Promise<void>;
}

export interface DecoratedUnit {
  id: string;
  region: string | null;
  version: string | null;
  builtVersion: string | null;
  size: number | null;
  quality: string | null;
  changes: string | null;
  diskBytes: number;
}

export type DecoratedSet = OpenDataSet &
  SetState & {
    chartExists: boolean;
    shadingExists: boolean;
    selectedBytes: number;
    /** What the selected units' terrain shading adds, whether or not the set wants it. */
    shadingBytes: number;
    downloadBytes: number;
    freeBytes: number | null;
    units: DecoratedUnit[];
    busy: boolean;
    progress: RunProgress | null;
  };

// Runs outlive a plugin restart (a config save), like the ENC chart sets'.
const runs = new Map<string, Run>();
const FINISHED_RUN_LINGER_MS = 10_000;
// Sets being renamed; like a run, a rename holds its set until it is done.
const renaming = new Set<string>();
// Chart files being written, by absolute path, to the id of the set writing them:
// two sets of the same name must not build into one file.
const claimedTargets = new Map<string, string>();

function working(): boolean {
  return renaming.size > 0 || [...runs.values()].some((r) => !r.finished);
}

const NOT_FOR_NAVIGATION = '(not for navigation)';
const SHADING_SUFFIX = '_terrain_shading';
// sanitizeChartFilename's limit, so the suffix is never cut off.
const MAX_STEM = 100;

class UserError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

export class OpenDataCharts {
  readonly index: OpenDataIndexManager;
  readonly sets: OpenDataSetStore;
  readonly cache: UnitCache;

  constructor(private readonly deps: OpenDataDeps) {
    this.index = new OpenDataIndexManager(deps.dataDir, deps.indexUrl, deps.debug);
    this.sets = new OpenDataSetStore(deps.dataDir);
    this.cache = new UnitCache(deps.dataDir);
  }

  /** Leftovers of a build cut short, while nothing runs. */
  sweep(): void {
    if (working()) {
      return;
    }
    for (const set of this.sets.list()) {
      const dir = path.join(this.deps.chartPath(), set.folder);
      let names: string[];
      try {
        names = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        if (name.startsWith('.') && name.endsWith(TEMP_SUFFIX)) {
          try {
            fs.rmSync(path.join(dir, name), { force: true });
          } catch (error) {
            this.deps.error(
              `Open Data Charts: could not remove ${path.join(dir, name)}: ${
                error instanceof Error ? error.message : String(error)
              }`
            );
          }
        }
      }
    }
    this.pruneCache();
  }

  mayRunBackground(): boolean {
    return this.deps.mayRunBackground();
  }

  /** The index check the plugin makes on its own: only with sets, and only while allowed. */
  refreshIndexInBackground(): void {
    if (this.sets.list().length > 0 && this.deps.mayRunBackground() && this.index.isStale()) {
      void this.index.refresh();
    }
  }

  private chartTarget(set: OpenDataSet, name = set.name): string {
    const stem = sanitizeChartFilename(name) || set.id;
    return path.join(set.folder, `${stem}.mbtiles`);
  }

  private shadingTarget(set: OpenDataSet, name = set.name): string {
    const base = sanitizeChartFilename(name)
      .slice(0, MAX_STEM - SHADING_SUFFIX.length)
      .replace(/[-._]+$/g, '');
    const stem = base !== '' ? `${base}${SHADING_SUFFIX}` : '';
    // A long name ending in the suffix itself would otherwise name the set's own chart.
    const distinct = stem !== '' && stem !== sanitizeChartFilename(name);
    return path.join(set.folder, `${distinct ? stem : `${set.id}-terrain`}.mbtiles`);
  }

  private absolute(relative: string): string {
    const root = this.deps.chartPath();
    const file = path.join(root, relative);
    if (!isWithinBase(file, root)) {
      throw new UserError('The chart path of this set is outside the chart folder', 400);
    }
    return file;
  }

  private chartExists(set: OpenDataSet): boolean {
    return set.chartFile !== null && fs.existsSync(this.absolute(set.chartFile));
  }

  private shadingExists(set: OpenDataSet): boolean {
    return set.shadingFile !== null && fs.existsSync(this.absolute(set.shadingFile));
  }

  decorate(set: OpenDataSet): DecoratedSet {
    const index = this.index.index();
    const chartExists = this.chartExists(set);
    const shadingExists = this.shadingExists(set);
    const units = new Map((index?.units ?? []).map((u) => [u.id, u]));
    const ids = [...new Set([...set.unitIds, ...Object.keys(set.built)])];
    const decorated: DecoratedUnit[] = ids.map((id) => {
      const unit = units.get(id);
      const builtVersion = set.built[id] ?? null;
      const cachedVersion = unit?.version ?? builtVersion;
      return {
        id,
        region: unit?.region ?? null,
        version: unit?.version ?? null,
        builtVersion,
        size: unit?.size ?? null,
        quality: unit?.quality?.best ?? null,
        changes: unit?.changes ?? null,
        diskBytes: cachedVersion ? this.cache.bytes('units', id, cachedVersion) : 0
      };
    });
    const selected = set.unitIds.map((id) => units.get(id)).filter((u) => u !== undefined);
    const plan = index && set.unitIds.length > 0 ? planSet(set, index, chartExists) : null;
    const shading = index && set.unitIds.length > 0 ? planShading(set, index, shadingExists) : null;
    const run = runs.get(set.id);
    return {
      ...set,
      ...setState(set, index, chartExists, shadingExists),
      chartExists,
      shadingExists,
      selectedBytes: selected.reduce((sum, u) => sum + u.size, 0),
      shadingBytes: selected.reduce((sum, u) => sum + (u.hillshade?.size ?? 0), 0),
      downloadBytes:
        (plan?.add ?? [])
          .filter((u) => !this.cache.has('units', u.id, u.version))
          .reduce((sum, u) => sum + u.size, 0) +
        (shading?.add ?? [])
          .filter((s) => !this.cache.has('hillshade', s.id, s.version))
          .reduce((sum, s) => sum + s.size, 0),
      freeBytes: freeDiskBytes(this.existingFolder(set)),
      units: decorated,
      busy: this.isBusy(set.id),
      progress: run?.progress ?? null
    };
  }

  private existingFolder(set: OpenDataSet): string {
    const root = this.deps.chartPath();
    const folder = path.join(root, set.folder);
    return fs.existsSync(folder) ? folder : root;
  }

  mapPayload(index: OpenDataIndex): unknown {
    return {
      generated: index.generated,
      disclaimer: index.disclaimer,
      attribution: index.attribution,
      qualities: QUALITY_CATEGORIES,
      regions: index.regions.map((r) => ({ id: r.id, name: r.name, bbox: r.bbox })),
      units: index.units.map((u) => ({
        id: u.id,
        region: u.region,
        x: u.x,
        y: u.y,
        bbox: u.bbox,
        version: u.version,
        size: u.size,
        built: u.built ?? null,
        quality: u.quality ?? null,
        surveys: u.surveys ?? null,
        changes: u.changes ?? null
      }))
    };
  }

  isBusy(id: string): boolean {
    const run = runs.get(id);
    return renaming.has(id) || (run !== undefined && !run.finished);
  }

  /** Reserves `target` for the set until `release` is called. */
  private claim(target: string, setId: string): () => void {
    const owner = claimedTargets.get(target);
    if (owner !== undefined && owner !== setId) {
      throw new UserError(
        `Another chart set is writing ${path.basename(target)}. Rename one of the sets, then try again.`,
        409
      );
    }
    claimedTargets.set(target, setId);
    return () => {
      if (claimedTargets.get(target) === setId) {
        claimedTargets.delete(target);
      }
    };
  }

  /** Starts building the set's chart; the run reports through `decorate`. */
  startBuild(set: OpenDataSet): void {
    if (!this.sets.acknowledged()) {
      throw new UserError('Acknowledge that these charts are not for navigation first', 403);
    }
    if (this.isBusy(set.id)) {
      throw new UserError('This set is being built already', 409);
    }
    const run: Run = {
      progress: {
        phase: 'downloading',
        message: 'Checking the index…',
        unitsDone: 0,
        unitsTotal: 0,
        bytesDone: 0,
        bytesTotal: 0
      },
      controller: new AbortController(),
      finished: false
    };
    runs.set(set.id, run);
    void this.build(set.id, run)
      .then((message) => {
        run.progress = { ...run.progress, phase: 'completed', message };
      })
      .catch((error: unknown) => {
        const cancelled = run.controller.signal.aborted;
        const message = cancelled
          ? 'Cancelled'
          : error instanceof Error
            ? error.message
            : String(error);
        if (!cancelled) {
          this.deps.error(`Open Data Charts set ${set.id}: ${message}`);
        }
        run.progress = { ...run.progress, phase: cancelled ? 'cancelled' : 'failed', message };
      })
      .finally(() => {
        run.finished = true;
        this.pruneCache();
        setTimeout(() => {
          if (runs.get(set.id) === run) {
            runs.delete(set.id);
          }
        }, FINISHED_RUN_LINGER_MS).unref();
      });
  }

  cancel(id: string): boolean {
    const run = runs.get(id);
    if (!run || run.finished) {
      return false;
    }
    run.controller.abort(new Error('Cancelled'));
    return true;
  }

  private async build(id: string, run: Run): Promise<string> {
    const signal = run.controller.signal;
    await this.index.refresh();
    signal.throwIfAborted();
    const index = this.index.index();
    if (!index) {
      throw new Error(
        this.index.getStatus().message ?? 'The Open Data Charts index has not been downloaded yet'
      );
    }
    const set = this.sets.get(id);
    if (!set) {
      throw new Error('The set was deleted');
    }
    if (set.unitIds.length === 0) {
      return this.removeChart(set);
    }
    const relative = set.chartFile ?? this.chartTarget(set);
    const target = this.absolute(relative);
    if (set.chartFile === null && fs.existsSync(target)) {
      throw new UserError(
        `A chart named ${path.basename(target)} already exists in ${set.folder}. Rename the set, then try again.`,
        409
      );
    }
    const shadingRelative = set.shadingFile ?? this.shadingTarget(set);
    const shadingTarget = this.absolute(shadingRelative);
    // Only the file this set recorded is its own to patch or remove.
    const shading = planShading(
      set,
      index,
      set.shadingFile !== null && fs.existsSync(shadingTarget)
    );
    const shadingWork = shadingHasWork(shading);
    if (shadingWork && shadingTarget === target) {
      throw new UserError(
        `The terrain shading of this set would replace its chart ${path.basename(target)}. Rename the set, then try again.`,
        409
      );
    }
    const release = this.claim(target, set.id);
    try {
      const releaseShading = shadingWork ? this.claim(shadingTarget, set.id) : () => undefined;
      try {
        return await this.buildInto(
          set,
          index,
          { relative, target },
          { relative: shadingRelative, target: shadingTarget },
          shading,
          run
        );
      } finally {
        releaseShading();
      }
    } finally {
      release();
    }
  }

  private async buildInto(
    set: OpenDataSet,
    index: OpenDataIndex,
    { relative, target }: { relative: string; target: string },
    { relative: shadingRelative, target: shadingTarget }: { relative: string; target: string },
    plannedShading: ShadingPlan,
    run: Run
  ): Promise<string> {
    let plan = planSet(set, index, fs.existsSync(target));
    let shading = plannedShading;
    const chartWork = plan.add.length > 0 || plan.remove.length > 0 || plan.overviews !== null;
    if (!chartWork && !shadingHasWork(shading)) {
      return 'Nothing changed; the chart is up to date';
    }
    if (set.shadingFile === null && shading.add.length > 0 && fs.existsSync(shadingTarget)) {
      throw new UserError(
        `A chart named ${path.basename(shadingTarget)} already exists in ${set.folder}. Rename the set, then try again.`,
        409
      );
    }
    const shadingAssembles = Object.keys(afterShading(set, shading)).length > 0;
    this.checkFreeSpace(
      set,
      plan,
      chartWork ? target : null,
      shading,
      shadingHasWork(shading) && shadingAssembles ? shadingTarget : null
    );
    await this.download(plan, shading, run);
    if (chartWork) {
      try {
        await runAssembly(this.assemblyInput(set, index, plan, target));
      } catch (error) {
        if (!(error instanceof NotPatchableError)) {
          throw error;
        }
        this.deps.debug(`Open Data Charts: ${error.message}; building it anew`);
        plan = planSet(set, index, false);
        await this.download(plan, shading, run);
        await runAssembly(this.assemblyInput(set, index, plan, target));
      }
      // Recorded before the shading runs, so a failure there leaves the new chart known.
      this.saveBuilt(set, { ...afterPlan(set, plan), chartFile: relative });
      await this.deps.chartsChanged({ written: relative });
    }
    if (shadingHasWork(shading)) {
      let shadingFile: string | null = shadingRelative;
      let shaded = afterShading(set, shading);
      if (Object.keys(shaded).length === 0) {
        fs.rmSync(shadingTarget, { force: true });
        shadingFile = null;
      } else {
        try {
          await runAssembly(this.shadingInput(set, index, shading, shadingTarget, shaded));
        } catch (error) {
          if (!(error instanceof NotPatchableError)) {
            throw error;
          }
          shading = planShading(set, index, false);
          shaded = afterShading(set, shading);
          await this.download(plan, shading, run);
          await runAssembly(this.shadingInput(set, index, shading, shadingTarget, shaded));
        }
      }
      this.saveBuilt(set, { shaded, shadingFile });
      await this.deps.chartsChanged(
        shadingFile !== null ? { written: shadingFile } : { removed: shadingRelative }
      );
    }
    const missing = plan.missing.length > 0 ? `; not published: ${plan.missing.join(', ')}` : '';
    return `Chart ${path.basename(relative)} is ready${missing}`;
  }

  private saveBuilt(set: OpenDataSet, changes: Partial<OpenDataSet>): void {
    const now = new Date().toISOString();
    this.sets.save({
      ...(this.sets.get(set.id) ?? set),
      ...changes,
      lastBuiltAt: now,
      updatedAt: now
    });
  }

  private async removeChart(set: OpenDataSet): Promise<string> {
    for (const file of [set.chartFile, set.shadingFile]) {
      if (file !== null) {
        fs.rmSync(this.absolute(file), { force: true });
        await this.deps.chartsChanged({ removed: file });
      }
    }
    this.sets.save({
      ...set,
      built: {},
      overviews: {},
      chartFile: null,
      shaded: {},
      shadingFile: null
    });
    return 'The set is empty; its chart was removed';
  }

  private checkFreeSpace(
    set: OpenDataSet,
    plan: SetPlan,
    target: string | null,
    shading: ShadingPlan,
    shadingTarget: string | null
  ): void {
    const adding =
      plan.add.reduce((sum, u) => sum + u.size, 0) +
      shading.add.reduce((sum, s) => sum + s.size, 0);
    // An update is written beside the current chart before it replaces it; a
    // chart that is not assembled again, or only removed, needs no copy.
    const size = (file: string | null): number =>
      file !== null && fs.existsSync(file) ? fs.statSync(file).size : 0;
    const needed = Math.max(size(target), size(shadingTarget)) + adding;
    const free = freeDiskBytes(this.existingFolder(set));
    if (free !== null && free < needed) {
      throw new UserError(
        `The chart folder has ${formatBytes(free)} free; this set needs about ${formatBytes(needed)}.`,
        507
      );
    }
  }

  private async download(plan: SetPlan, shading: ShadingPlan, run: Run): Promise<void> {
    const jobs = [
      ...(plan.overviews ?? []).map((o) => ({
        kind: 'overviews' as const,
        id: o.region,
        version: o.version,
        target: o
      })),
      ...plan.add.map((u) => ({ kind: 'units' as const, id: u.id, version: u.version, target: u })),
      ...shading.add.map((s) => ({
        kind: 'hillshade' as const,
        id: s.id,
        version: s.version,
        target: s
      }))
    ];
    const missing = jobs.filter((j) => !this.cache.has(j.kind, j.id, j.version));
    run.progress = {
      phase: 'downloading',
      message: missing.length > 0 ? `Downloading ${String(missing.length)} file(s)` : 'Downloaded',
      unitsDone: 0,
      unitsTotal: missing.length,
      bytesDone: 0,
      bytesTotal: missing.reduce((sum, j) => sum + j.target.size, 0)
    };
    let finished = 0;
    for (const job of missing) {
      const base = run.progress.bytesDone;
      run.progress.message = `Downloading ${job.id} (${String(finished + 1)} of ${String(missing.length)})`;
      await this.cache.ensure(job.kind, job.id, job.version, job.target, {
        signal: run.controller.signal,
        onBytes: (bytes) => {
          run.progress.bytesDone = base + bytes;
        }
      });
      finished++;
      run.progress.unitsDone = finished;
      run.progress.bytesDone = base + job.target.size;
    }
    run.progress = { ...run.progress, phase: 'building', message: 'Building the chart…' };
  }

  private assemblyInput(
    set: OpenDataSet,
    index: OpenDataIndex,
    plan: SetPlan,
    target: string
  ): AssemblyInput {
    const after = afterPlan(set, plan);
    return {
      kind: 'chart',
      target,
      base: plan.fresh ? null : target,
      remove: plan.remove.map(unitTile),
      add: plan.add.map((u) => ({
        tile: unitTile(u.id),
        file: this.cache.file('units', u.id, u.version)
      })),
      overviews:
        plan.overviews?.map((o) => this.cache.file('overviews', o.region, o.version)) ?? null,
      units: Object.keys(after.built).map(unitTile),
      ...this.chartLabels(set.name, index),
      setId: set.id
    };
  }

  private shadingInput(
    set: OpenDataSet,
    index: OpenDataIndex | null,
    plan: ShadingPlan,
    target: string,
    shaded: Record<string, string>
  ): AssemblyInput {
    return {
      kind: 'shading',
      target,
      base: plan.fresh ? null : target,
      remove: plan.remove.map(unitTile),
      add: plan.add.map((s) => ({
        tile: unitTile(s.id),
        file: this.cache.file('hillshade', s.id, s.version)
      })),
      overviews: null,
      units: Object.keys(shaded).map(unitTile),
      ...this.shadingLabels(set.name, index),
      setId: set.id
    };
  }

  private shadingLabels(
    name: string,
    index: OpenDataIndex | null
  ): Pick<AssemblyInput, 'name' | 'description' | 'attribution'> {
    const labels = this.chartLabels(name, index);
    return {
      ...labels,
      name: `${name} terrain shading ${NOT_FOR_NAVIGATION}`,
      description: `Terrain shading of ${labels.description}`
    };
  }

  private chartLabels(
    name: string,
    index: OpenDataIndex | null
  ): Pick<AssemblyInput, 'name' | 'description' | 'attribution'> {
    return {
      name: `${name} ${NOT_FOR_NAVIGATION}`,
      description: `Open Data Charts set “${name}”, built from open data. ${
        index?.disclaimer && /not for navigation/i.test(index.disclaimer)
          ? index.disclaimer
          : `NOT FOR NAVIGATION.${index?.disclaimer ? ` ${index.disclaimer}` : ''}`
      }`,
      attribution: index?.attribution ?? null
    };
  }

  /** Gives the set a new name, and its chart the matching file name and title. */
  async rename(set: OpenDataSet, name: string): Promise<OpenDataSet> {
    if (this.isBusy(set.id)) {
      throw new UserError('The set is busy; try again when it is done', 409);
    }
    renaming.add(set.id);
    try {
      return await this.renameChart(set, name);
    } finally {
      renaming.delete(set.id);
    }
  }

  private async renameChart(set: OpenDataSet, name: string): Promise<OpenDataSet> {
    const renamed = { ...set, name, updatedAt: new Date().toISOString() };
    if (set.chartFile === null || !this.chartExists(set)) {
      this.sets.save(renamed);
      return renamed;
    }
    const relative = this.chartTarget(set, name);
    const from = this.absolute(set.chartFile);
    const to = this.absolute(relative);
    const shading =
      set.shadingFile !== null && this.shadingExists(set)
        ? {
            previous: set.shadingFile,
            relative: this.shadingTarget(set, name),
            from: this.absolute(set.shadingFile),
            to: this.absolute(this.shadingTarget(set, name))
          }
        : null;
    for (const move of [{ from, to }, ...(shading ? [shading] : [])]) {
      if (move.to !== move.from && fs.existsSync(move.to)) {
        throw new UserError(`A chart named ${path.basename(move.to)} already exists`, 409);
      }
    }
    const index = this.index.index();
    const releaseChart = this.claim(to, set.id);
    try {
      const releaseShading = shading ? this.claim(shading.to, set.id) : () => undefined;
      try {
        await runAssembly({
          kind: 'chart',
          target: to,
          base: from,
          remove: [],
          add: [],
          overviews: null,
          units: Object.keys(set.built)
            .map(parseUnitId)
            .filter((t) => t !== null),
          ...this.chartLabels(name, index),
          setId: set.id
        });
        if (shading) {
          try {
            await runAssembly({
              kind: 'shading',
              target: shading.to,
              base: shading.from,
              remove: [],
              add: [],
              overviews: null,
              units: Object.keys(set.shaded).map(unitTile),
              ...this.shadingLabels(name, index),
              setId: set.id
            });
          } catch (error) {
            // The originals stay until both copies exist, so the set keeps its charts.
            if (to !== from) {
              fs.rmSync(to, { force: true });
            }
            throw error;
          }
        }
      } finally {
        releaseShading();
      }
    } finally {
      releaseChart();
    }
    const shadingFile = shading ? shading.relative : null;
    const saved = { ...renamed, chartFile: relative, shadingFile };
    this.sets.save(saved);
    for (const move of [{ from, to }, ...(shading ? [shading] : [])]) {
      if (move.to !== move.from) {
        fs.rmSync(move.from, { force: true });
      }
    }
    await this.deps.chartsChanged({
      written: relative,
      ...(to !== from ? { removed: set.chartFile } : {})
    });
    if (shading) {
      await this.deps.chartsChanged({
        written: shading.relative,
        ...(shading.to !== shading.from ? { removed: shading.previous } : {})
      });
    }
    return saved;
  }

  /** Removes cached files no set uses: neither in its chart nor at the index's version. */
  pruneCache(): void {
    if (working()) {
      return;
    }
    const index = this.index.index();
    const units = new Map((index?.units ?? []).map((u) => [u.id, u]));
    const keep = new Set<string>();
    // A partial download of a version still in use is resumed by the next build.
    const keepFile = (kind: CacheKind, id: string, version: string): void => {
      keep.add(UnitCache.key(kind, id, version));
      keep.add(UnitCache.partKey(kind, id, version));
    };
    for (const set of this.sets.list()) {
      for (const [id, version] of Object.entries(set.built)) {
        keepFile('units', id, version);
      }
      for (const [region, version] of Object.entries(set.overviews)) {
        keepFile('overviews', region, version);
      }
      for (const [id, version] of Object.entries(set.shaded)) {
        keepFile('hillshade', id, version);
      }
      for (const id of set.unitIds) {
        const unit = units.get(id);
        if (unit) {
          keepFile('units', id, unit.version);
          if (unit.hillshade && set.terrain) {
            keepFile('hillshade', id, unit.version);
          }
          const overview = index?.regions.find((r) => r.id === unit.region)?.overview;
          if (overview) {
            keepFile('overviews', unit.region, overview.version);
          }
        }
      }
    }
    for (const name of this.cache.prune(keep)) {
      this.deps.debug(`Open Data Charts: removed unused download ${name}`);
    }
  }
}

function unitTile(id: string): UnitTile {
  const tile = parseUnitId(id);
  if (!tile) {
    throw new Error(`Not a unit id: ${id}`);
  }
  return tile;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) {
    return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  }
  return `${String(Math.max(1, Math.round(bytes / 1024 ** 2)))} MB`;
}

/** What the routes are registered on; the plugin root router serves the admin-only ones. */
export interface RouteRegistrar {
  get(path: string, handler: (req: Request, res: Response) => void): unknown;
  post(path: string, handler: (req: Request, res: Response) => void): unknown;
  put(path: string, handler: (req: Request, res: Response) => void): unknown;
  delete(path: string, handler: (req: Request, res: Response) => void): unknown;
}

const NameBody = Type.Object({ name: Type.String({ minLength: 1, maxLength: 120 }) });
const UpdateBody = Type.Object({
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
  terrain: Type.Optional(Type.Boolean()),
  unitIds: Type.Optional(
    Type.Array(Type.String({ pattern: '^z9-[0-9]{1,3}-[0-9]{1,3}$' }), { maxItems: 20000 })
  )
});

/**
 * Routes are registered once, before the plugin starts; they reach the
 * service of the current start through `current`.
 */
export function registerOpenDataRoutes(
  current: () => OpenDataCharts | null,
  readonly: RouteRegistrar,
  readwrite: RouteRegistrar,
  admin: RouteRegistrar
): void {
  const fail = (res: Response, error: unknown): void => {
    const status = error instanceof UserError ? error.status : 500;
    res.status(status).json({
      success: false,
      error: error instanceof Error ? error.message : String(error)
    });
  };
  const handle =
    (handler: (odc: OpenDataCharts, req: Request, res: Response) => void | Promise<void>) =>
    (req: Request, res: Response): void => {
      const odc = current();
      if (!odc) {
        res.status(503).json({ success: false, error: 'The plugin is not running' });
        return;
      }
      void (async () => {
        try {
          await handler(odc, req, res);
        } catch (error) {
          fail(res, error);
        }
      })();
    };
  const withSet = (
    handler: (
      odc: OpenDataCharts,
      set: OpenDataSet,
      req: Request,
      res: Response
    ) => void | Promise<void>
  ) =>
    handle(async (odc, req, res) => {
      const set = odc.sets.get((req.params as Record<string, string>).id);
      if (!set) {
        res.status(404).json({ success: false, error: 'No such set' });
        return;
      }
      await handler(odc, set, req, res);
    });

  readonly.get(
    '/open-data/index',
    handle(async (odc, req, res) => {
      if (req.query.refresh === '1' || !odc.index.index()) {
        await odc.index.refresh();
      } else if (odc.index.isStale() && odc.mayRunBackground()) {
        void odc.index.refresh();
      }
      const index = odc.index.index();
      const status: CatalogStatus = odc.index.getStatus();
      res.json({
        status,
        fetchedAt: index?.fetchedAt ?? null,
        acknowledged: odc.sets.acknowledged(),
        index: index ? odc.mapPayload(index) : null
      });
    })
  );

  readwrite.post(
    '/open-data/acknowledge',
    handle((odc, _req, res) => {
      odc.sets.acknowledge();
      res.json({ success: true });
    })
  );

  readonly.get(
    '/open-data/sets',
    handle((odc, _req, res) => {
      res.json(odc.sets.list().map((s) => odc.decorate(s)));
    })
  );

  readwrite.post(
    '/open-data/sets',
    handle((odc, req, res) => {
      const body = parseBody(NameBody, req, res);
      if (body) {
        res.status(201).json(odc.decorate(odc.sets.create(body.name)));
      }
    })
  );

  readonly.get(
    '/open-data/sets/:id',
    withSet((odc, set, _req, res) => {
      res.json(odc.decorate(set));
    })
  );

  readwrite.put(
    '/open-data/sets/:id',
    withSet(async (odc, set, req, res) => {
      if (odc.isBusy(set.id)) {
        throw new UserError('The set is being built; try again when it is done', 409);
      }
      const body = parseBody(UpdateBody, req, res);
      if (!body) {
        return;
      }
      let next = set;
      if (body.terrain !== undefined && body.terrain !== next.terrain) {
        next = { ...next, terrain: body.terrain, updatedAt: new Date().toISOString() };
        odc.sets.save(next);
      }
      if (body.unitIds !== undefined) {
        next = {
          ...next,
          unitIds: [...new Set(body.unitIds)],
          updatedAt: new Date().toISOString()
        };
        odc.sets.save(next);
      }
      const name = body.name?.trim();
      if (name && name !== next.name) {
        next = await odc.rename(next, name);
      }
      res.json(odc.decorate(next));
    })
  );

  admin.delete(
    '/open-data/sets/:id',
    withSet((odc, set, _req, res) => {
      if (odc.isBusy(set.id)) {
        throw new UserError('The set is being built; cancel it first', 409);
      }
      // Like the ENC chart sets, the chart stays; Manage Charts removes it.
      odc.sets.delete(set.id);
      odc.pruneCache();
      res.json({ success: true });
    })
  );

  readwrite.post(
    '/open-data/sets/:id/build',
    withSet((odc, set, _req, res) => {
      odc.startBuild(set);
      res.status(202).json(odc.decorate(set));
    })
  );

  readwrite.post(
    '/open-data/sets/:id/cancel',
    withSet((odc, set, _req, res) => {
      res.json({ success: true, cancelled: odc.cancel(set.id) });
    })
  );
}
