// Simple download interface for charts from direct URLs

// Initialize the download interface
function initDownloadInterface() {
  const output = document.getElementById('chartLockerOutput');
  if (!output) return;

  output.innerHTML = `
    <div class="download-container">
      <div class="info-section">
        <h2>Download Charts from URL</h2>
        <p class="description">
          Download chart files directly from URLs. Supports .mbtiles files and .zip archives containing .mbtiles files.
        </p>

        <div class="form-group">
          <label for="downloadUrl">Chart URL</label>
          <input
            type="text"
            id="downloadUrl"
            placeholder="https://example.com/chart.mbtiles or chart.zip"
            class="input-field"
          />
        </div>

        <div class="form-group">
          <label for="downloadFolder">Target Folder</label>
          <select id="downloadFolder" class="input-field">
            <option value="/">/</option>
          </select>
        </div>

        <button onclick="startDownload()" class="btn btn-primary">
          Download Chart
        </button>

        <div id="downloadStatus" class="download-status"></div>
      </div>

      <div id="activeDownloads" class="active-downloads"></div>

      <div class="info-section">
        <h3>Where to Find Charts</h3>
        <ul>
          <li><a href="https://chartlocker.brucebalan.com/" target="_blank">Bruce's Chart Locker</a> - Community-maintained chart collection</li>
          <li><a href="https://distribution.charts.noaa.gov/ncds/index.html" target="_blank">NOAA Nautical Charts</a> - Official US nautical charts</li>
        </ul>
      </div>
    </div>
  `;

  // Load folders for the dropdown
  loadFoldersForDownload();

  // Load and display active downloads
  loadActiveDownloads();

  // Poll for download updates every 2 seconds
  setInterval(loadActiveDownloads, 2000);
}

// Load available folders
async function loadFoldersForDownload() {
  try {
    const response = await fetch('/signalk/chart-tiles/local-charts');
    const data = await response.json();

    const folderSelect = document.getElementById('downloadFolder');
    if (!folderSelect) return;

    folderSelect.innerHTML = '<option value="/">/</option>';

    if (data.folders) {
      data.folders.forEach(folder => {
        if (folder !== '/') {
          const option = document.createElement('option');
          option.value = folder;
          option.textContent = folder;
          folderSelect.appendChild(option);
        }
      });
    }
  } catch (error) {
    console.error('Error loading folders:', error);
  }
}

// Start a download
async function startDownload() {
  const url = document.getElementById('downloadUrl').value.trim();
  const folder = document.getElementById('downloadFolder').value;
  const statusDiv = document.getElementById('downloadStatus');

  if (!url) {
    statusDiv.innerHTML = '<div class="error-message">Please enter a URL</div>';
    return;
  }

  // Basic URL validation
  try {
    new URL(url);
  } catch (e) {
    statusDiv.innerHTML = '<div class="error-message">Invalid URL format</div>';
    return;
  }

  statusDiv.innerHTML = '<div class="info-message">Creating download job...</div>';

  try {
    const formData = new FormData();
    formData.append('url', url);
    formData.append('targetFolder', folder);

    const response = await fetch('/signalk/chart-tiles/download-chart-locker', {
      method: 'POST',
      body: formData
    });

    const result = await response.json();

    if (result.success) {
      statusDiv.innerHTML = `<div class="success-message">Download started! Job ID: ${result.jobId}</div>`;

      // Clear the form
      document.getElementById('downloadUrl').value = '';

      // Refresh active downloads
      setTimeout(loadActiveDownloads, 500);
    } else {
      statusDiv.innerHTML = `<div class="error-message">Error: ${result.error || 'Unknown error'}</div>`;
    }
  } catch (error) {
    console.error('Download error:', error);
    statusDiv.innerHTML = `<div class="error-message">Failed to start download: ${error.message}</div>`;
  }
}

// Load and display active downloads
async function loadActiveDownloads() {
  try {
    const response = await fetch('/signalk/chart-tiles/download-jobs');
    const jobs = await response.json();

    const container = document.getElementById('activeDownloads');
    if (!container) return;

    if (!jobs || jobs.length === 0) {
      container.innerHTML = '';
      return;
    }

    // Filter to show only active or recent jobs
    const recentJobs = jobs.filter(job =>
      job.status === 'queued' ||
      job.status === 'downloading' ||
      job.status === 'extracting' ||
      (job.completedAt && (Date.now() - job.completedAt) < 300000) // Last 5 minutes
    );

    if (recentJobs.length === 0) {
      container.innerHTML = '';
      return;
    }

    container.innerHTML = `
      <h3>Download Jobs</h3>
      ${recentJobs.map(job => renderDownloadJob(job)).join('')}
    `;
  } catch (error) {
    console.error('Error loading download jobs:', error);
  }
}

// Render a single download job
function renderDownloadJob(job) {
  const statusClass = {
    'queued': 'status-queued',
    'downloading': 'status-downloading',
    'extracting': 'status-extracting',
    'completed': 'status-completed',
    'failed': 'status-failed'
  }[job.status] || '';

  const statusText = {
    'queued': 'Queued',
    'downloading': 'Downloading',
    'extracting': 'Extracting',
    'completed': 'Completed',
    'failed': 'Failed'
  }[job.status] || job.status;

  const progressBar = (job.status === 'downloading' || job.status === 'extracting')
    ? `<div class="progress-bar">
         <div class="progress-fill" style="width: ${job.progress}%"></div>
       </div>
       <div class="progress-text">${job.progress}% - ${formatBytes(job.downloadedBytes)} / ${formatBytes(job.totalBytes)}</div>`
    : '';

  const errorMessage = job.error
    ? `<div class="error-text">Error: ${job.error}</div>`
    : '';

  const extractedFiles = (job.extractedFiles && job.extractedFiles.length > 0)
    ? `<div class="extracted-files">Files: ${job.extractedFiles.join(', ')}</div>`
    : '';

  // Show cancel button for active jobs
  const cancelButton = (job.status === 'queued' || job.status === 'downloading' || job.status === 'extracting')
    ? `<button class="btn btn-danger btn-sm" onclick="cancelDownload('${job.id}')">Cancel</button>`
    : '';

  // Extract filename from URL for display
  const urlFilename = job.url.split('/').pop().split('?')[0] || 'Download';

  return `
    <div class="download-job ${statusClass}">
      <div class="job-header">
        <span class="job-name">${urlFilename}</span>
        <div class="job-header-right">
          <span class="job-status">${statusText}</span>
          ${cancelButton}
        </div>
      </div>
      <div class="job-url">${truncateUrl(job.url)}</div>
      ${progressBar}
      ${errorMessage}
      ${extractedFiles}
    </div>
  `;
}

// Cancel a download job
async function cancelDownload(jobId) {
  try {
    const response = await fetch(`/signalk/chart-tiles/cancel-download/${jobId}`, {
      method: 'POST'
    });

    const result = await response.json();

    if (result.success) {
      console.log(`Download ${jobId} cancelled`);
      // Refresh the download list immediately
      loadActiveDownloads();
    } else {
      console.error(`Failed to cancel download: ${result.error}`);
      alert(`Failed to cancel download: ${result.error}`);
    }
  } catch (error) {
    console.error('Error cancelling download:', error);
    alert(`Error cancelling download: ${error.message}`);
  }
}

// Helper functions
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function truncateUrl(url, maxLength = 60) {
  if (url.length <= maxLength) return url;
  return url.substring(0, maxLength - 3) + '...';
}

// Initialize when the page loads
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initDownloadInterface);
} else {
  initDownloadInterface();
}
