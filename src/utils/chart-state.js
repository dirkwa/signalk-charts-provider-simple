const fs = require('fs');
const path = require('path');

let chartState = {};
let stateFilePath = '';

/**
 * Initialize the chart state manager
 * @param {string} configPath - Path to the SignalK config directory
 */
function initChartState(configPath) {
  stateFilePath = path.join(configPath, 'chart-state.json');
  loadState();
}

/**
 * Load chart state from file
 */
function loadState() {
  try {
    if (fs.existsSync(stateFilePath)) {
      const data = fs.readFileSync(stateFilePath, 'utf-8');
      chartState = JSON.parse(data);
    }
  } catch (error) {
    console.error('Error loading chart state:', error);
    chartState = {};
  }
}

/**
 * Save chart state to file
 */
function saveState() {
  try {
    fs.writeFileSync(stateFilePath, JSON.stringify(chartState, null, 2), 'utf-8');
  } catch (error) {
    console.error('Error saving chart state:', error);
  }
}

/**
 * Check if a chart is enabled (default: true)
 * @param {string} relativePath - Relative path of the chart
 * @returns {boolean}
 */
function isChartEnabled(relativePath) {
  if (chartState[relativePath]) {
    return chartState[relativePath].enabled;
  }
  return true; // Default to enabled
}

/**
 * Set chart enabled state
 * @param {string} relativePath - Relative path of the chart
 * @param {boolean} enabled - Whether the chart should be enabled
 */
function setChartEnabled(relativePath, enabled) {
  chartState[relativePath] = { enabled };
  saveState();
}

/**
 * Get all chart states
 * @returns {Object}
 */
function getAllChartStates() {
  return chartState;
}

module.exports = {
  initChartState,
  isChartEnabled,
  setChartEnabled,
  getAllChartStates
};
