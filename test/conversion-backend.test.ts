/**
 * The choice between the container toolchain and its WebAssembly fallback
 * (conversion-backend.ts), and the converters' dispatch on it, against a fake
 * signalk-container manager.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  backendBuildId,
  chooseConversionBackend,
  fallbackNote,
  setConversionEnginePreference
} from '../dist/utils/conversion-backend.js';
import {
  _resetContainerManagerForTests,
  waitForContainerManager,
  type ContainerJobConfig,
  type ContainerJobResult,
  type ContainerManagerApi
} from '../dist/utils/container-manager.js';
import { CHARTS_TOOLBOX_IMAGE } from '../dist/utils/container-images.js';
import { hasStartedJobs, holdJobsDuring, runJob } from '../dist/utils/container-jobs.js';
import { getConversionProgress, processS57Directory } from '../dist/utils/s57-converter.js';

declare global {
  var __signalk_containerManager: ContainerManagerApi | undefined;
}

interface FakeOptions {
  runtime?: boolean;
  imageExists?: boolean;
  pullFails?: boolean;
  unmountable?: (absPath: string) => boolean;
  runJob?: (config: ContainerJobConfig) => ContainerJobResult;
}

interface Fake {
  manager: ContainerManagerApi;
  jobs: ContainerJobConfig[];
  imageChecks: string[];
}

function fakeManager(opts: FakeOptions = {}): Fake {
  const jobs: ContainerJobConfig[] = [];
  const imageChecks: string[] = [];
  const manager: ContainerManagerApi = {
    getRuntime: () => (opts.runtime === false ? null : { runtime: 'podman', version: '5.0.0' }),
    imageExists: (image) => {
      imageChecks.push(image);
      return Promise.resolve(opts.imageExists !== false);
    },
    pullImage: () =>
      opts.pullFails ? Promise.reject(new Error('no route to ghcr.io')) : Promise.resolve(),
    runJob: (config) => {
      jobs.push(config);
      return Promise.resolve(
        opts.runJob?.(config) ?? { status: 'completed', exitCode: 0, log: [] }
      );
    },
    resolveSignalkDataMount: () => Promise.resolve(null),
    resolveHostPath: (absPath) =>
      Promise.resolve(opts.unmountable?.(absPath) ? null : { source: absPath, subPath: '' })
  };
  return { manager, jobs, imageChecks };
}

beforeEach(() => {
  _resetContainerManagerForTests();
  delete globalThis.__signalk_containerManager;
  setConversionEnginePreference('auto');
});

afterEach(() => {
  _resetContainerManagerForTests();
  delete globalThis.__signalk_containerManager;
  setConversionEnginePreference('auto');
});

describe('chooseConversionBackend', () => {
  it('falls back to WebAssembly without signalk-container, saying why', async () => {
    const choice = await chooseConversionBackend({ mountPaths: [os.tmpdir()] });
    assert.strictEqual(choice.backend, 'wasm');
    assert.match(choice.fallbackReason ?? '', /signalk-container/);
    assert.match(fallbackNote(choice) ?? '', /Container toolchain not used/);
  });

  it('falls back when signalk-container found no runtime', async () => {
    globalThis.__signalk_containerManager = fakeManager({ runtime: false }).manager;
    const choice = await chooseConversionBackend({ mountPaths: [os.tmpdir()] });
    assert.strictEqual(choice.backend, 'wasm');
  });

  it('uses the container toolchain when the runtime, image and mounts are there', async () => {
    const fake = fakeManager();
    globalThis.__signalk_containerManager = fake.manager;
    let checking = 0;
    const choice = await chooseConversionBackend({
      mountPaths: [os.tmpdir()],
      onCheckingImage: () => {
        checking++;
      }
    });
    assert.deepStrictEqual(choice, { backend: 'container' });
    assert.strictEqual(fallbackNote(choice), null);
    assert.deepStrictEqual(fake.imageChecks, [CHARTS_TOOLBOX_IMAGE]);
    assert.strictEqual(checking, 1);
  });

  it('falls back when the image is missing and cannot be pulled (offline)', async () => {
    globalThis.__signalk_containerManager = fakeManager({
      imageExists: false,
      pullFails: true
    }).manager;
    const choice = await chooseConversionBackend({ mountPaths: [os.tmpdir()] });
    assert.strictEqual(choice.backend, 'wasm');
    assert.match(choice.fallbackReason ?? '', /image is not available.*no route to ghcr\.io/);
  });

  it('falls back when a folder cannot be mounted into the helper container', async () => {
    globalThis.__signalk_containerManager = fakeManager({
      unmountable: (p) => p === '/media/usb/charts'
    }).manager;
    const choice = await chooseConversionBackend({
      mountPaths: [os.tmpdir(), '/media/usb/charts']
    });
    assert.strictEqual(choice.backend, 'wasm');
    assert.match(choice.fallbackReason ?? '', /\/media\/usb\/charts cannot be mounted/);
  });

  it('pinned to the container, fails instead of falling back', async () => {
    setConversionEnginePreference('container');
    await assert.rejects(
      chooseConversionBackend({ mountPaths: [os.tmpdir()] }),
      /set to use the container toolchain, but signalk-container/
    );
  });

  it('pinned to WebAssembly, never looks at the container', async () => {
    const fake = fakeManager();
    globalThis.__signalk_containerManager = fake.manager;
    setConversionEnginePreference('wasm');
    const choice = await chooseConversionBackend({ mountPaths: [os.tmpdir()] });
    assert.deepStrictEqual(choice, { backend: 'wasm' });
    assert.deepStrictEqual(fake.imageChecks, []);
  });

  it('treats an unknown setting as automatic', async () => {
    setConversionEnginePreference('docker');
    const choice = await chooseConversionBackend({ mountPaths: [os.tmpdir()] });
    assert.strictEqual(choice.backend, 'wasm');
    assert.ok(choice.fallbackReason);
  });

  it('waits for a startup discovery still running', async () => {
    const fake = fakeManager();
    const discovery = waitForContainerManager({ budgetMs: 2000, pollIntervalMs: 20 });
    setTimeout(() => {
      globalThis.__signalk_containerManager = fake.manager;
    }, 100);
    const choice = await chooseConversionBackend({ mountPaths: [os.tmpdir()] });
    assert.strictEqual(choice.backend, 'container');
    assert.strictEqual(await discovery, fake.manager);
  });

  it('takes up a manager published after the discovery gave up', async () => {
    assert.strictEqual(await waitForContainerManager({ budgetMs: 50, pollIntervalMs: 10 }), null);
    globalThis.__signalk_containerManager = fakeManager().manager;
    const choice = await chooseConversionBackend({ mountPaths: [os.tmpdir()] });
    assert.strictEqual(choice.backend, 'container');
  });
});

describe('runJob during an orphan reap', () => {
  it('starts no helper job until the reap is done', async () => {
    const fake = fakeManager();
    globalThis.__signalk_containerManager = fake.manager;
    assert.strictEqual(await waitForContainerManager({ budgetMs: 1000 }), fake.manager);
    let finishReap: () => void = () => {};
    const reap = holdJobsDuring(
      new Promise<void>((resolve) => {
        finishReap = resolve;
      })
    );
    const job = runJob({ image: CHARTS_TOOLBOX_IMAGE, command: ['true'] });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.strictEqual(fake.jobs.length, 0, 'the job must wait for the reap');
    assert.strictEqual(hasStartedJobs(), false);
    finishReap();
    await reap;
    assert.strictEqual((await job).exitCode, 0);
    assert.strictEqual(fake.jobs.length, 1);
    assert.strictEqual(hasStartedJobs(), true);
  });
});

describe('backendBuildId', () => {
  it('keys container output by the toolbox image and WebAssembly output by gdal3.js', () => {
    assert.strictEqual(backendBuildId('container'), CHARTS_TOOLBOX_IMAGE);
    assert.match(backendBuildId('wasm'), /^gdal3\.js /);
    assert.notStrictEqual(backendBuildId('container'), backendBuildId('wasm'));
  });
});

describe('processS57Directory dispatch', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-charts-dispatch-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function writeCells(): string {
    const encDir = path.join(tmp, 'enc', 'ENC_ROOT', 'US5MA1SK');
    fs.mkdirSync(encDir, { recursive: true });
    fs.writeFileSync(path.join(encDir, 'US5MA1SK.000'), 'not a real cell');
    fs.writeFileSync(path.join(encDir, 'US5MA1SK.001'), 'update');
    return path.join(tmp, 'enc');
  }

  it('runs the GDAL export in the helper container, on the staged cells', async () => {
    const encDir = writeCells();
    const charts = path.join(tmp, 'out');
    fs.mkdirSync(charts);
    let staged: string[] = [];
    const fake = fakeManager({
      runJob: (config) => {
        // Look at what the job's /input holds while it "runs".
        const input = config.inputs?.['/input'];
        staged = input ? fs.readdirSync(input).sort() : [];
        return { status: 'completed', exitCode: 1, log: ['ogr2ogr: boom'] };
      }
    });
    globalThis.__signalk_containerManager = fake.manager;

    await assert.rejects(
      processS57Directory(encDir, charts, 'dispatch-container', null, {}, tmp),
      /gdal-export-dispatch-container failed with exit code 1/
    );
    assert.strictEqual(fake.jobs.length, 1);
    assert.strictEqual(fake.jobs[0].image, CHARTS_TOOLBOX_IMAGE);
    assert.strictEqual(fake.jobs[0].label, 'gdal-export-dispatch-container');
    assert.deepStrictEqual(staged, ['US5MA1SK.000', 'US5MA1SK.001']);
    const log = getConversionProgress('dispatch-container')?.log ?? [];
    assert.ok(log.some((l) => l.startsWith('Conversion engine: container toolchain')));
    assert.ok(log.some((l) => l.includes('ogr2ogr: boom')));
    assert.deepStrictEqual(fs.readdirSync(charts), [], 'nothing may be left in the output');
  });

  it('falls back to WebAssembly when the image cannot be pulled, and says so', async () => {
    const encDir = writeCells();
    const charts = path.join(tmp, 'out');
    fs.mkdirSync(charts);
    const fake = fakeManager({ imageExists: false, pullFails: true });
    globalThis.__signalk_containerManager = fake.manager;

    // The cell is not a real S-57 file, so GDAL (WebAssembly) reads nothing.
    await assert.rejects(
      processS57Directory(encDir, charts, 'dispatch-fallback', null, {}, tmp),
      /No valid GeoJSON layers/
    );
    assert.strictEqual(fake.jobs.length, 0, 'no container job may run');
    const log = getConversionProgress('dispatch-fallback')?.log ?? [];
    assert.ok(log.some((l) => l.startsWith('Container toolchain not used: the ')));
    assert.ok(log.some((l) => l.startsWith('Conversion engine: built-in GDAL (WebAssembly')));
  });
});
