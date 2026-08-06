/**
 * Tests for the folder-state module: default-enabled semantics, persistence
 * round-trips, ancestor-aware (descendant-disabling) matching, key
 * normalization across platforms, and prefix-safe pruning.
 */

import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  getAllFolderStates,
  initFolderState,
  isFolderEnabled,
  isFolderPathEnabled,
  removeFolderState,
  setFolderEnabled
} from '../dist/utils/folder-state.js';

const tempDirs: string[] = [];

function freshDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'folder-state-'));
  tempDirs.push(dir);
  return dir;
}

beforeEach(() => {
  initFolderState(freshDataDir());
});

after(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('defaults', () => {
  it('treats unknown folders as enabled', () => {
    assert.strictEqual(isFolderEnabled('Netherlands'), true);
    assert.strictEqual(isFolderPathEnabled('Netherlands/Waddenzee'), true);
  });

  it('treats the root as always enabled', () => {
    assert.strictEqual(isFolderEnabled('/'), true);
    assert.strictEqual(isFolderPathEnabled('/'), true);
    assert.strictEqual(isFolderPathEnabled('.'), true);
    assert.strictEqual(isFolderPathEnabled(''), true);
  });

  it('ignores attempts to toggle the root', () => {
    setFolderEnabled('/', false);
    setFolderEnabled('.', false);
    assert.strictEqual(isFolderPathEnabled('/'), true);
    assert.deepStrictEqual(getAllFolderStates(), {});
  });
});

describe('persistence', () => {
  it('round-trips state through folder-state.json', () => {
    const dir = freshDataDir();
    initFolderState(dir);
    setFolderEnabled('Netherlands', false);

    const stateFile = path.join(dir, 'folder-state.json');
    assert.ok(fs.existsSync(stateFile));

    initFolderState(dir);
    assert.strictEqual(isFolderEnabled('Netherlands'), false);
    assert.strictEqual(isFolderEnabled('Germany'), true);
  });

  it('falls back to all-enabled on corrupt JSON', () => {
    const dir = freshDataDir();
    fs.writeFileSync(path.join(dir, 'folder-state.json'), 'not json{', 'utf-8');
    initFolderState(dir);
    assert.strictEqual(isFolderEnabled('Netherlands'), true);
  });

  it('does not leak state from a previously initialized directory', () => {
    setFolderEnabled('Netherlands', false);
    initFolderState(freshDataDir());
    assert.strictEqual(isFolderEnabled('Netherlands'), true);
  });
});

describe('descendant semantics', () => {
  it('disabling a folder disables all descendants', () => {
    setFolderEnabled('a', false);
    assert.strictEqual(isFolderPathEnabled('a'), false);
    assert.strictEqual(isFolderPathEnabled('a/b'), false);
    assert.strictEqual(isFolderPathEnabled('a/b/c'), false);
  });

  it('leaves descendant raw flags and siblings untouched', () => {
    setFolderEnabled('a', false);
    assert.strictEqual(isFolderEnabled('a/b'), true);
    assert.strictEqual(isFolderPathEnabled('b'), true);
    assert.strictEqual(isFolderPathEnabled('ab'), true);
  });

  it('re-enabling a parent preserves a disabled child', () => {
    setFolderEnabled('a', false);
    setFolderEnabled('a/b', false);
    setFolderEnabled('a', true);
    assert.strictEqual(isFolderPathEnabled('a'), true);
    assert.strictEqual(isFolderPathEnabled('a/b'), false);
    assert.strictEqual(isFolderPathEnabled('a/b/c'), false);
  });
});

describe('normalization', () => {
  it('maps backslashes, ./ prefixes and stray slashes to one key', () => {
    setFolderEnabled('a\\b', false);
    assert.strictEqual(isFolderEnabled('a/b'), false);
    assert.strictEqual(isFolderEnabled('./a/b'), false);
    assert.strictEqual(isFolderEnabled('a/b/'), false);
    assert.strictEqual(isFolderEnabled('/a/b'), false);
    assert.strictEqual(isFolderEnabled('a/./b'), false);
    assert.strictEqual(isFolderEnabled('a//b'), false);
    assert.strictEqual(Object.keys(getAllFolderStates()).length, 1);
  });
});

describe('removeFolderState', () => {
  it('removes the folder and its descendants but not lookalike siblings', () => {
    setFolderEnabled('a', false);
    setFolderEnabled('a/b', false);
    setFolderEnabled('ab', false);
    removeFolderState('a');
    assert.strictEqual(isFolderEnabled('a'), true);
    assert.strictEqual(isFolderEnabled('a/b'), true);
    assert.strictEqual(isFolderEnabled('ab'), false);
  });

  it('persists the pruned state', () => {
    const dir = freshDataDir();
    initFolderState(dir);
    setFolderEnabled('a', false);
    removeFolderState('a');
    initFolderState(dir);
    assert.strictEqual(isFolderEnabled('a'), true);
  });
});
