import fs from 'fs';
import path from 'path';
import type { ChartStateMap } from '../types';

let chartState: ChartStateMap = {};
let stateFilePath = '';

function loadState(): void {
  try {
    if (fs.existsSync(stateFilePath)) {
      const data = fs.readFileSync(stateFilePath, 'utf-8');
      chartState = JSON.parse(data) as ChartStateMap;
    }
  } catch (error) {
    console.error('Error loading chart state:', error);
    chartState = {};
  }
}

function saveState(): void {
  try {
    fs.writeFileSync(stateFilePath, JSON.stringify(chartState, null, 2), 'utf-8');
  } catch (error) {
    console.error('Error saving chart state:', error);
  }
}

export function initChartState(configPath: string): void {
  stateFilePath = path.join(configPath, 'chart-state.json');
  loadState();
}

export function isChartEnabled(relativePath: string): boolean {
  if (chartState[relativePath]) {
    return chartState[relativePath].enabled;
  }
  return true;
}

export function setChartEnabled(relativePath: string, enabled: boolean): void {
  chartState[relativePath] = { enabled };
  saveState();
}

export function getAllChartStates(): ChartStateMap {
  return chartState;
}
