import fs from 'fs';
import path from 'path';
import type { FolderStateMap } from '../types.js';

let folderState: FolderStateMap = {};
let stateFilePath = '';

// Keys are stored with forward slashes and no leading/trailing separators so
// they are stable across platforms and match ScannedChart.folder semantics
// ('.' and '' both mean the chart root, represented as '/').
function normalizeFolder(folderPath: string): string {
  const normalized = folderPath
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/^\/+|\/+$/g, '');
  return normalized === '' || normalized === '.' ? '/' : normalized;
}

function loadState(): void {
  try {
    if (fs.existsSync(stateFilePath)) {
      const data = fs.readFileSync(stateFilePath, 'utf-8');
      folderState = JSON.parse(data) as FolderStateMap;
    }
  } catch (error) {
    console.error('Error loading folder state:', error);
    folderState = {};
  }
}

function saveState(): void {
  try {
    fs.writeFileSync(stateFilePath, JSON.stringify(folderState, null, 2), 'utf-8');
  } catch (error) {
    console.error('Error saving folder state:', error);
  }
}

export function initFolderState(configPath: string): void {
  stateFilePath = path.join(configPath, 'folder-state.json');
  folderState = {};
  loadState();
}

// Raw flag for this folder only; ancestors are not consulted.
export function isFolderEnabled(folderPath: string): boolean {
  const key = normalizeFolder(folderPath);
  if (key === '/') {
    return true;
  }
  if (folderState[key]) {
    return folderState[key].enabled;
  }
  return true;
}

// Effective state: false if the folder or any ancestor folder is disabled.
export function isFolderPathEnabled(folderPath: string): boolean {
  const key = normalizeFolder(folderPath);
  if (key === '/') {
    return true;
  }
  const segments = key.split('/');
  let prefix = '';
  for (const segment of segments) {
    prefix = prefix === '' ? segment : `${prefix}/${segment}`;
    if (folderState[prefix] && !folderState[prefix].enabled) {
      return false;
    }
  }
  return true;
}

export function setFolderEnabled(folderPath: string, enabled: boolean): void {
  const key = normalizeFolder(folderPath);
  if (key === '/') {
    return;
  }
  folderState[key] = { enabled };
  saveState();
}

// Remove state for a folder and all of its descendants (used when a folder
// is deleted, so recreating it later starts enabled again).
export function removeFolderState(folderPath: string): void {
  const key = normalizeFolder(folderPath);
  if (key === '/') {
    return;
  }
  let changed = false;
  for (const stored of Object.keys(folderState)) {
    if (stored === key || stored.startsWith(`${key}/`)) {
      delete folderState[stored];
      changed = true;
    }
  }
  if (changed) {
    saveState();
  }
}

export function getAllFolderStates(): FolderStateMap {
  return folderState;
}
