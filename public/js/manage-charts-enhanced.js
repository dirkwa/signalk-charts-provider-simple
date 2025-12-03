// Enhanced Manage Charts functionality with folders, dates, enable/disable, drag-drop, upload

// State management
let chartsData = [];
let foldersData = [];
let basePath = '';
let selectedFolder = null; // null means show all folders
let viewMode = 'grid'; // 'grid' or 'list'
let refreshInterval = null; // Auto-refresh timer for downloading charts
let isUploadInProgress = false; // Track upload state to prevent UI refresh during upload

window.handleManageTabActive = function() {
    loadCharts();
}

async function loadCharts(silent = false) {
    const manageOutput = document.getElementById('manageOutput');

    // Only show loading spinner on initial load, not on auto-refresh
    if (!silent) {
        manageOutput.innerHTML = '<div class="empty-state"><div class="spinner"></div><div class="empty-state-text">Loading charts...</div></div>';
    }

    try {
        const response = await fetch('/signalk/chart-tiles/local-charts');
        const data = await response.json();

        chartsData = data.charts || [];
        foldersData = data.folders || [];
        basePath = data.basePath || '';

        renderChartsUI();

        // Set up auto-refresh if there are downloading charts
        setupAutoRefresh();
    } catch (error) {
        console.error('Error fetching local charts:', error);
        if (!silent) {
            manageOutput.innerHTML = `
                <div class="empty-state">
                    <div class="empty-state-icon" style="font-size: 4rem;">${window.getIcon('warning')}</div>
                    <div class="empty-state-text">Error loading charts</div>
                    <div class="empty-state-subtext">${error.message}</div>
                </div>
            `;
        }
    }
}

function setupAutoRefresh() {
    // Clear existing interval
    if (refreshInterval) {
        clearInterval(refreshInterval);
        refreshInterval = null;
    }

    // Check if any charts are downloading
    const hasDownloading = chartsData.some(chart => chart.downloading);

    if (hasDownloading) {
        // Refresh every 2 seconds while charts are downloading (silent mode to avoid flickering)
        refreshInterval = setInterval(() => {
            loadCharts(true);
        }, 2000);
    }
}

function renderChartsUI() {
    // Skip re-rendering if an upload is in progress (prevents upload overlay from being removed)
    if (isUploadInProgress) {
        return;
    }

    const manageOutput = document.getElementById('manageOutput');

    if (chartsData.length === 0) {
        // Set selectedFolder to root when there are no charts
        selectedFolder = '/';
        manageOutput.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon">
                    <svg viewBox="0 0 24 24" width="80" height="80" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M3 7v13a2 2 0 002 2h14a2 2 0 002-2V7M3 7l3-4h12l3 4M3 7h18"/>
                        <path d="M9 11h6M9 15h6"/>
                    </svg>
                </div>
                <div class="empty-state-text">Welcome to Charts Provider Simple!</div>
                <div class="empty-state-subtext">
                    <p style="margin-bottom: 16px;">Get started by downloading nautical charts:</p>
                    <ol style="text-align: left; display: inline-block; margin: 0 auto 20px; line-height: 1.8;">
                        <li>Go to the <strong>"Download from URL"</strong> tab</li>
                        <li>Enter a chart URL (or find free charts from the links provided)</li>
                        <li>Optionally create folders to organize your charts</li>
                        <li>Download charts and they'll appear here</li>
                    </ol>
                    <p style="margin-top: 16px; font-size: 0.9em; opacity: 0.8;">
                        You can also manually upload .mbtiles files from your computer or add them to:<br>
                        <code style="background: rgba(0,0,0,0.2); padding: 4px 8px; border-radius: 4px; font-size: 0.85em;">${basePath}</code>
                    </p>
                </div>
                <div style="display: flex; gap: 12px; justify-content: center; margin-top: 24px;">
                    <button class="btn btn-primary" onclick="openTab(event, 'download')" style="padding: 12px 24px;">
                        Download Charts
                    </button>
                    <button class="btn btn-secondary" onclick="triggerUploadEmpty()" style="padding: 12px 24px;">
                        Upload from Computer
                    </button>
                </div>
            </div>
            <input type="file" id="chartUploadInputEmpty" accept=".mbtiles" multiple style="display: none;" onchange="handleFileUpload(event)">
        `;
        return;
    }

    let html = '';

    // Toolbar
    html += `
        <div class="charts-toolbar">
            <div class="toolbar-left">
                <h3>Chart Manager</h3>
                <span class="chart-count">${chartsData.length} chart${chartsData.length !== 1 ? 's' : ''}</span>
            </div>
            <div class="toolbar-right">
                <button class="btn btn-secondary" onclick="showCreateFolderDialog()" title="Create New Folder">
                    + New Folder
                </button>
                ${selectedFolder && selectedFolder !== '/' ? `<button class="btn btn-danger" onclick="deleteSelectedFolder()" title="Delete Selected Folder">Delete Folder</button>` : ''}
                ${selectedFolder !== null ? `<button class="btn btn-primary" onclick="triggerUpload()" title="Upload charts to ${selectedFolder}">Upload</button>` : ''}
                <button class="btn btn-icon ${viewMode === 'grid' ? 'active' : ''}" onclick="setViewMode('grid')" title="Grid View">
                    <svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M3 3h8v8H3zm10 0h8v8h-8zM3 13h8v8H3zm10 0h8v8h-8z"/></svg>
                </button>
                <button class="btn btn-icon ${viewMode === 'list' ? 'active' : ''}" onclick="setViewMode('list')" title="List View">
                    <svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M3 4h18v2H3zm0 7h18v2H3zm0 7h18v2H3z"/></svg>
                </button>
            </div>
        </div>
    `;

    // Folder navigation
    if (foldersData.length > 1) {
        const folderIcon = window.getIcon('folder', true); // Prefer SVG for folder icons
        html += `<div class="folder-nav">`;
        html += `<button class="folder-btn ${selectedFolder === null ? 'active' : ''}" onclick="selectFolder(null)">All Folders</button>`;
        foldersData.forEach(folder => {
            const folderName = folder;
            const isActive = selectedFolder === folder;
            html += `<button class="folder-btn ${isActive ? 'active' : ''}" onclick="selectFolder('${folder}')" ondragover="handleFolderDragOver(event)" ondrop="handleDropOnFolder(event, '${folder}')" ondragleave="handleFolderDragLeave(event)">
                ${folderIcon} ${folderName}
            </button>`;
        });
        html += `</div>`;
    }

    // Filter charts by selected folder
    const filteredCharts = selectedFolder === null
        ? chartsData
        : chartsData.filter(c => c.folder === selectedFolder);

    // Charts display
    if (filteredCharts.length === 0) {
        html += `
            <div class="empty-state">
                <div class="empty-state-icon">
                    <svg viewBox="0 0 24 24" width="60" height="60" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/>
                    </svg>
                </div>
                <div class="empty-state-text">No charts in this folder</div>
            </div>
        `;
    } else {
        html += `<div class="chart-${viewMode}">`;
        filteredCharts.forEach(chart => {
            html += renderChartCard(chart);
        });
        html += `</div>`;
    }

    // Hidden file upload input
    html += `<input type="file" id="chartUploadInput" accept=".mbtiles" multiple style="display: none;" onchange="handleFileUpload(event)">`;

    manageOutput.innerHTML = html;

    // Initialize touch drag and drop after rendering
    initTouchDragDrop();
}

function renderChartCard(chart) {
    const sizeInMB = (chart.size / (1024 * 1024)).toFixed(2);
    const sizeInGB = (chart.size / (1024 * 1024 * 1024)).toFixed(2);
    const displaySize = sizeInGB >= 1 ? `${sizeInGB} GB` : `${sizeInMB} MB`;

    const dateCreated = new Date(chart.dateCreated).toLocaleDateString();
    const dateModified = new Date(chart.dateModified).toLocaleDateString();

    const folderDisplay = chart.folder;

    const downloadingBadge = chart.downloading
        ? `<span class="downloading-badge"><span class="spinner-small"></span> Downloading</span>`
        : '';

    if (viewMode === 'grid') {
        return `
            <div class="chart-card ${chart.enabled ? '' : 'disabled'} ${chart.downloading ? 'downloading' : ''}" draggable="true" ondragstart="handleDragStart(event, '${chart.relativePath}')" ondragover="handleDragOver(event)" ondrop="handleDrop(event, '${chart.folder}')" data-chart-path="${chart.relativePath}">
                <div class="chart-card-header">
                    <div class="chart-status">
                        <button class="btn-toggle ${chart.enabled ? 'enabled' : 'disabled'}" onclick="toggleChart('${chart.relativePath}')" title="${chart.enabled ? 'Disable' : 'Enable'} chart">
                            ${chart.enabled ? window.getIcon('checkmark') : window.getIcon('cross')}
                        </button>
                    </div>
                    <h4>${chart.name} ${downloadingBadge}</h4>
                </div>
                <div class="chart-card-body">
                    <div class="chart-meta-row">
                        <span class="meta-label">${window.getIcon('size')} Size:</span>
                        <span class="meta-value">${displaySize}</span>
                    </div>
                    ${chart.chartName ? `
                    <div class="chart-meta-row">
                        <span class="meta-label">📊 Chart:</span>
                        <span class="meta-value" style="font-weight: 500; color: var(--accent-primary);">${chart.chartName}</span>
                    </div>
                    ` : ''}
                    <div class="chart-meta-row">
                        <span class="meta-label">${window.getIcon('folder')} Folder:</span>
                        <span class="meta-value">${folderDisplay}</span>
                    </div>
                    <div class="chart-meta-row">
                        <span class="meta-label">${window.getIcon('calendar')} Created:</span>
                        <span class="meta-value">${dateCreated}</span>
                    </div>
                    <div class="chart-meta-row">
                        <span class="meta-label">${window.getIcon('clock')} Modified:</span>
                        <span class="meta-value">${dateModified}</span>
                    </div>
                </div>
                <div class="chart-card-footer">
                    <button class="btn btn-sm btn-info" onclick="showChartInfo('${chart.relativePath}')" title="View chart metadata">
                        Meta
                    </button>
                    <button class="btn btn-sm btn-secondary" onclick="showRenameDialog('${chart.relativePath}', '${chart.name}', '${chart.folder}')" title="Rename chart">
                        Rename
                    </button>
                    <button class="btn btn-sm btn-danger" onclick="deleteChart('${chart.relativePath}', '${chart.name}')">
                        Delete
                    </button>
                </div>
            </div>
        `;
    } else {
        // List view
        return `
            <div class="chart-list-item ${chart.enabled ? '' : 'disabled'} ${chart.downloading ? 'downloading' : ''}" draggable="true" ondragstart="handleDragStart(event, '${chart.relativePath}')" data-chart-path="${chart.relativePath}">
                <div class="chart-list-status">
                    <button class="btn-toggle ${chart.enabled ? 'enabled' : 'disabled'}" onclick="toggleChart('${chart.relativePath}')" title="${chart.enabled ? 'Disable' : 'Enable'} chart">
                        ${chart.enabled ? window.getIcon('checkmark') : window.getIcon('cross')}
                    </button>
                </div>
                <div class="chart-list-info">
                    <div class="chart-list-name">${chart.name} ${downloadingBadge}</div>
                    <div class="chart-list-meta">
                        <span>${displaySize}</span>
                        <span>${folderDisplay}</span>
                        <span>${dateCreated}</span>
                        <span>${dateModified}</span>
                    </div>
                </div>
                <div class="chart-list-actions">
                    <button class="btn btn-sm btn-info" onclick="showChartInfo('${chart.relativePath}')" title="View chart metadata">
                        Meta
                    </button>
                    <button class="btn btn-sm btn-secondary" onclick="showRenameDialog('${chart.relativePath}', '${chart.name}', '${chart.folder}')" title="Rename chart">
                        Rename
                    </button>
                    <button class="btn btn-sm btn-danger" onclick="deleteChart('${chart.relativePath}', '${chart.name}')">
                        Delete
                    </button>
                </div>
            </div>
        `;
    }
}

window.setViewMode = function(mode) {
    viewMode = mode;
    renderChartsUI();
}

window.selectFolder = function(folder) {
    selectedFolder = folder;
    renderChartsUI();
}

window.toggleChart = async function(relativePath) {
    const chart = chartsData.find(c => c.relativePath === relativePath);
    if (!chart) return;

    const newEnabledState = !chart.enabled;

    try {
        const response = await fetch(`/signalk/chart-tiles/charts/${encodeURIComponent(relativePath)}/toggle`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ enabled: newEnabledState })
        });

        if (response.ok) {
            chart.enabled = newEnabledState;
            renderChartsUI();

            // Show nice notification
            showToggleNotification(chart.name, newEnabledState);
        } else {
            const errorText = await response.text();
            showErrorNotification(`Failed to toggle chart: ${errorText}`);
        }
    } catch (error) {
        console.error('Error toggling chart:', error);
        alert('Error toggling chart: ' + error.message);
    }
}

window.deleteChart = function(relativePath, name) {
    showDeleteConfirmation({
        type: 'chart',
        name: name,
        onConfirm: async () => {
            try {
                const response = await fetch(`/signalk/chart-tiles/local-charts/${encodeURIComponent(relativePath)}`, {
                    method: 'DELETE'
                });

                if (response.ok) {
                    loadCharts(); // Refresh the list
                } else {
                    const errorText = await response.text();
                    alert(`Failed to delete chart: ${errorText}`);
                }
            } catch (error) {
                console.error('Error deleting chart:', error);
                alert('Error deleting chart: ' + error.message);
            }
        }
    });
}

window.triggerUpload = function() {
    document.getElementById('chartUploadInput').click();
}

window.triggerUploadEmpty = function() {
    const input = document.getElementById('chartUploadInputEmpty');
    if (input) {
        input.click();
    }
}

window.handleFileUpload = async function(event) {
    const files = event.target.files;
    if (!files || files.length === 0) return;

    const formData = new FormData();
    let validFileCount = 0;

    // Add target folder FIRST (before files) so busboy processes it first
    if (selectedFolder) {
        formData.append('targetFolder', selectedFolder);
    }

    // Check for existing files in target folder
    const targetFolderCharts = chartsData.filter(c => c.folder === selectedFolder);
    const duplicates = [];

    // Add all files to form data
    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        if (!file.name.endsWith('.mbtiles')) {
            alert(`File "${file.name}" is not an .mbtiles file and will be skipped.`);
            continue;
        }

        // Check if chart with same name exists in target folder
        const existingChart = targetFolderCharts.find(c => c.name === file.name || c.name === file.name.replace('.mbtiles', ''));
        if (existingChart) {
            duplicates.push(file.name);
        }

        formData.append('charts', file);
        validFileCount++;
    }

    if (validFileCount === 0) {
        event.target.value = '';
        return;
    }

    // Warn about duplicates
    if (duplicates.length > 0) {
        const folderName = selectedFolder;

        showDuplicateWarning({
            duplicates: duplicates,
            folderName: folderName,
            onConfirm: () => {
                // Continue with upload
                performUpload(formData, validFileCount, files);
            },
            onCancel: () => {
                event.target.value = '';
            }
        });
        return;
    }

    // If no duplicates, proceed with upload directly
    performUpload(formData, validFileCount, files);
    event.target.value = '';
}

// Extracted upload logic to be reusable
function performUpload(formData, validFileCount, files) {
    // Set flag to prevent UI refresh during upload
    isUploadInProgress = true;

    const manageOutput = document.getElementById('manageOutput');

    const fileList = Array.from(files)
        .filter(f => f.name.endsWith('.mbtiles'))
        .map(f => `<li>${f.name} (${(f.size / (1024 * 1024)).toFixed(2)} MB)</li>`)
        .join('');

    manageOutput.innerHTML = `
        <div class="upload-progress-overlay">
            <div class="upload-progress-card">
                <div class="upload-progress-header">
                    <div class="spinner"></div>
                    <h3>Uploading Charts...</h3>
                </div>
                <div class="upload-progress-body">
                    <p>Uploading ${validFileCount} file${validFileCount !== 1 ? 's' : ''} to ${window.getIcon('folder', true)} <strong>${selectedFolder}</strong></p>
                    <ul class="upload-file-list">
                        ${fileList}
                    </ul>
                    <div class="progress-bar-container">
                        <div class="progress-bar" id="uploadProgressBar"></div>
                    </div>
                    <p class="upload-status" id="uploadStatus">Starting upload...</p>
                </div>
            </div>
        </div>
    `;

    // Use XMLHttpRequest for upload progress
    const xhr = new XMLHttpRequest();

    xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) {
            const percentComplete = Math.round((e.loaded / e.total) * 100);
            const progressBar = document.getElementById('uploadProgressBar');
            const statusText = document.getElementById('uploadStatus');

            if (progressBar) {
                progressBar.style.width = percentComplete + '%';
            }
            if (statusText) {
                const uploadedMB = (e.loaded / (1024 * 1024)).toFixed(2);
                const totalMB = (e.total / (1024 * 1024)).toFixed(2);
                statusText.textContent = `Uploading... ${percentComplete}% (${uploadedMB} / ${totalMB} MB)`;
            }
        }
    });

    xhr.addEventListener('load', () => {
        // Reset upload flag before refreshing UI
        isUploadInProgress = false;

        if (xhr.status === 200) {
            // Refresh the charts list immediately
            loadCharts();

            // Show success notification
            showUploadNotification(validFileCount);
        } else {
            loadCharts();
            showErrorNotification(`Upload failed: ${xhr.responseText}`);
        }
    });

    xhr.addEventListener('error', () => {
        // Reset upload flag before refreshing UI
        isUploadInProgress = false;

        console.error('Error uploading files');
        loadCharts();
        showErrorNotification('Error uploading files. Please try again.');
    });

    xhr.open('POST', '/signalk/chart-tiles/upload');
    xhr.send(formData);
}

// Drag and drop handlers
let draggedChartPath = null;

window.handleDragStart = function(event, chartPath) {
    draggedChartPath = chartPath;
    event.dataTransfer.effectAllowed = 'move';
}

window.handleDragOver = function(event) {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
}

window.handleDrop = function(event, targetFolder) {
    event.preventDefault();
    if (!draggedChartPath) return;

    // This is for dropping on chart cards (not used for folder drop)
    draggedChartPath = null;
}

// New drag handlers for folders
window.handleFolderDragOver = function(event) {
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'move';
    event.currentTarget.classList.add('drag-over');
}

window.handleFolderDragLeave = function(event) {
    event.currentTarget.classList.remove('drag-over');
}

window.handleDropOnFolder = async function(event, targetFolder) {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.classList.remove('drag-over');

    if (!draggedChartPath) return;

    const chart = chartsData.find(c => c.relativePath === draggedChartPath);
    if (!chart) {
        draggedChartPath = null;
        return;
    }

    // Don't move if already in target folder
    if (chart.folder === targetFolder) {
        draggedChartPath = null;
        return;
    }

    // Check if a chart with the same name exists in target folder
    const targetFolderCharts = chartsData.filter(c => c.folder === targetFolder);
    const duplicate = targetFolderCharts.find(c => c.name === chart.name);

    if (duplicate) {
        const folderName = targetFolder;
        showDuplicateWarning({
            duplicates: [chart.name + '.mbtiles'],
            folderName: folderName,
            onConfirm: async () => {
                // Continue with move
                await performChartMove(draggedChartPath, targetFolder);
                draggedChartPath = null;
            },
            onCancel: () => {
                draggedChartPath = null;
            }
        });
        return;
    }

    // No duplicate, proceed with move
    await performChartMove(draggedChartPath, targetFolder);
    draggedChartPath = null;
}

// Touch drag and drop support for mobile devices (iOS Safari)
let touchDragElement = null;
let touchDragChartPath = null;
let touchStartY = 0;
let touchStartX = 0;
let isDragging = false;
let dragThreshold = 15; // pixels to move before initiating drag
let touchStartTime = 0;
let longPressTimer = null;
let longPressTriggered = false;
let touchHandlersInitialized = false;

// Initialize touch event listeners with event delegation
function initTouchDragDrop() {
    if (touchHandlersInitialized) return; // Prevent duplicate initialization

    const chartsContainer = document.getElementById('manageOutput');
    if (!chartsContainer) return;

    touchHandlersInitialized = true;

    chartsContainer.addEventListener('touchstart', function(event) {
        // Only initiate drag from chart cards/items, not buttons
        const target = event.target;
        if (target.tagName === 'BUTTON' || target.closest('button') ||
            target.tagName === 'INPUT' || target.closest('input')) {
            return; // Let buttons and inputs work normally
        }

        const chartCard = target.closest('.chart-card, .chart-list-item');
        if (!chartCard) return;

        const chartPath = chartCard.getAttribute('data-chart-path');
        if (!chartPath) return;

        const touch = event.touches[0];
        touchStartX = touch.clientX;
        touchStartY = touch.clientY;
        touchStartTime = Date.now();
        touchDragChartPath = chartPath;
        touchDragElement = chartCard;
        isDragging = false;
        longPressTriggered = false;

        // Start long-press timer for immediate visual feedback
        longPressTimer = setTimeout(() => {
            longPressTriggered = true;
            if (touchDragElement) {
                touchDragElement.style.opacity = '0.6';
                touchDragElement.style.transform = 'scale(0.98)';
                // Add a visual indicator that drag is ready
                touchDragElement.style.boxShadow = '0 8px 16px rgba(0,0,0,0.3)';
            }
        }, 300); // 300ms long press
    }, { passive: false });

    chartsContainer.addEventListener('touchmove', function(event) {
        if (!touchDragChartPath) return;

        const touch = event.touches[0];
        const deltaX = Math.abs(touch.clientX - touchStartX);
        const deltaY = Math.abs(touch.clientY - touchStartY);

        // Cancel long press if moved too much before it triggered
        if (!longPressTriggered && (deltaX > dragThreshold || deltaY > dragThreshold)) {
            clearTimeout(longPressTimer);
            touchDragChartPath = null;
            touchDragElement = null;
            return;
        }

        // If long press was triggered, prevent all default behavior
        if (longPressTriggered) {
            event.preventDefault(); // Always prevent scrolling after long press
            event.stopPropagation();

            // Check if user has moved enough to start dragging (after long press)
            if (!isDragging && (deltaX > dragThreshold || deltaY > dragThreshold)) {
                isDragging = true;
            }

            // Highlight folder under touch point (even before drag threshold)
            const elementUnderTouch = document.elementFromPoint(touch.clientX, touch.clientY);
            document.querySelectorAll('.folder-btn').forEach(btn => {
                btn.classList.remove('drag-over');
            });

            if (elementUnderTouch && elementUnderTouch.classList.contains('folder-btn')) {
                elementUnderTouch.classList.add('drag-over');
            }
        }
    }, { passive: false });

    chartsContainer.addEventListener('touchend', async function(event) {
        clearTimeout(longPressTimer);

        if (!touchDragChartPath) return;

        // Reset styles
        if (touchDragElement) {
            touchDragElement.style.opacity = '1';
            touchDragElement.style.transform = 'scale(1)';
            touchDragElement.style.boxShadow = '';
        }

        if (isDragging && longPressTriggered) {
            const touch = event.changedTouches[0];
            const elementUnderTouch = document.elementFromPoint(touch.clientX, touch.clientY);

            // Remove drag-over highlighting
            document.querySelectorAll('.folder-btn').forEach(btn => {
                btn.classList.remove('drag-over');
            });

            // Check if dropped on a folder button
            if (elementUnderTouch && elementUnderTouch.classList.contains('folder-btn')) {
                // Extract folder from button onclick attribute
                const onclickAttr = elementUnderTouch.getAttribute('onclick');
                const folderMatch = onclickAttr.match(/selectFolder\('([^']*)'\)/);

                if (folderMatch) {
                    const targetFolder = folderMatch[1];
                    const chart = chartsData.find(c => c.relativePath === touchDragChartPath);

                    if (chart && chart.folder !== targetFolder) {
                        // Check for duplicates
                        const targetFolderCharts = chartsData.filter(c => c.folder === targetFolder);
                        const duplicate = targetFolderCharts.find(c => c.name === chart.name);

                        if (duplicate) {
                            showDuplicateWarning({
                                duplicates: [chart.name + '.mbtiles'],
                                folderName: targetFolder,
                                onConfirm: async () => {
                                    await performChartMove(touchDragChartPath, targetFolder);
                                },
                                onCancel: () => {}
                            });
                        } else {
                            await performChartMove(touchDragChartPath, targetFolder);
                        }
                    }
                }
            }
        }

        // Reset state
        touchDragChartPath = null;
        touchDragElement = null;
        isDragging = false;
        longPressTriggered = false;
    }, { passive: true });

    chartsContainer.addEventListener('touchcancel', function() {
        clearTimeout(longPressTimer);
        if (touchDragElement) {
            touchDragElement.style.opacity = '1';
            touchDragElement.style.transform = 'scale(1)';
            touchDragElement.style.boxShadow = '';
        }
        touchDragChartPath = null;
        touchDragElement = null;
        isDragging = false;
        longPressTriggered = false;
    }, { passive: true });
}

// Extracted move logic to be reusable
async function performChartMove(chartPath, targetFolder) {
    try {
        const response = await fetch('/signalk/chart-tiles/move-chart', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                chartPath: chartPath,
                targetFolder: targetFolder
            })
        });

        if (response.ok) {
            loadCharts(); // Refresh the list
        } else {
            const errorText = await response.text();
            alert(`Failed to move chart: ${errorText}`);
        }
    } catch (error) {
        console.error('Error moving chart:', error);
        alert('Error moving chart: ' + error.message);
    }
}

// Folder management functions
window.deleteSelectedFolder = function() {
    if (!selectedFolder || selectedFolder === '/') {
        alert('Please select a folder to delete (cannot delete /).');
        return;
    }
    deleteFolder(selectedFolder);
}

window.showCreateFolderDialog = function() {
    const folderIcon = window.getIcon('folder', true); // Prefer SVG for folder icon

    const modalHTML = `
        <div class="delete-modal-overlay" id="createFolderModal" onclick="closeCreateFolderModal(event)">
            <div class="delete-modal" onclick="event.stopPropagation()">
                <div class="delete-modal-header">
                    <div class="delete-modal-icon" style="color: var(--accent-primary);">${folderIcon}</div>
                    <h3>Create New Folder</h3>
                </div>
                <div class="delete-modal-body">
                    <label for="newFolderName" style="display: block; margin-bottom: 8px; color: var(--text-primary); font-weight: 500;">Folder Name:</label>
                    <input
                        type="text"
                        id="newFolderName"
                        class="text-input"
                        placeholder="e.g., North Atlantic Charts"
                        style="width: 100%; padding: 12px; margin-bottom: 12px; background: var(--bg-secondary); border: 2px solid var(--border-color); border-radius: 8px; color: var(--text-primary); font-size: 1rem;"
                        onkeypress="if(event.key==='Enter') confirmCreateFolder()"
                    />
                    <p style="font-size: 0.9rem; color: var(--text-secondary); margin: 0;">Use only letters, numbers, spaces, and dashes.</p>
                </div>
                <div class="delete-modal-actions">
                    <button class="btn btn-secondary" onclick="closeCreateFolderModal()">Cancel</button>
                    <button class="btn btn-primary" onclick="confirmCreateFolder()">Create Folder</button>
                </div>
            </div>
        </div>
    `;

    document.body.insertAdjacentHTML('beforeend', modalHTML);

    // Focus the input field
    setTimeout(() => {
        document.getElementById('newFolderName')?.focus();
    }, 100);
}

window.closeCreateFolderModal = function(event) {
    if (event && event.target.id !== 'createFolderModal') return;

    const modal = document.getElementById('createFolderModal');
    if (modal) {
        modal.remove();
    }
}

window.confirmCreateFolder = function() {
    const input = document.getElementById('newFolderName');
    const folderName = input?.value.trim();

    if (!folderName) {
        input?.focus();
        return;
    }

    // Validate folder name
    if (folderName.includes('..') || folderName.includes('/') || folderName.includes('\\')) {
        alert('Invalid folder name. Please use only letters, numbers, spaces, and dashes.');
        input?.focus();
        return;
    }

    closeCreateFolderModal();
    createFolder(folderName);
}

async function createFolder(folderName) {
    console.log('Creating folder:', folderName);
    try {
        const requestBody = { folderPath: folderName };
        console.log('Request body:', requestBody);

        const response = await fetch('/signalk/chart-tiles/folders', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(requestBody)
        });

        console.log('Response status:', response.status);

        if (response.ok) {
            const result = await response.json();
            console.log('Folder created successfully:', result);
            loadCharts(); // Refresh the list
        } else {
            const errorText = await response.text();
            console.error('Failed to create folder:', errorText);
            alert(`Failed to create folder: ${errorText}`);
        }
    } catch (error) {
        console.error('Error creating folder:', error);
        alert('Error creating folder: ' + error.message);
    }
}

// Rename chart dialog
window.showRenameDialog = function(chartPath, currentName, folder) {
    // Remove .mbtiles extension for editing
    const nameWithoutExtension = currentName.replace(/\.mbtiles$/, '');

    const modalHTML = `
        <div class="delete-modal-overlay" id="renameModal" onclick="closeRenameModal(event)">
            <div class="delete-modal" onclick="event.stopPropagation()">
                <div class="delete-modal-header">
                    <div class="delete-modal-icon" style="color: var(--accent-primary);">
                        <svg viewBox="0 0 24 24" width="48" height="48" fill="currentColor">
                            <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/>
                        </svg>
                    </div>
                    <h3>Rename Chart</h3>
                </div>
                <div class="delete-modal-body">
                    <p style="margin-bottom: 16px;">Enter a new name for the chart:</p>
                    <div style="margin-bottom: 12px;">
                        <label for="newChartName" style="display: block; margin-bottom: 8px; color: var(--text-primary); font-weight: 500;">Chart Name:</label>
                        <div style="display: flex; align-items: center; gap: 8px;">
                            <input
                                type="text"
                                id="newChartName"
                                class="text-input"
                                value="${nameWithoutExtension}"
                                style="flex: 1; padding: 12px; background: var(--bg-secondary); border: 2px solid var(--border-color); border-radius: 8px; color: var(--text-primary); font-size: 1rem;"
                                onkeypress="if(event.key==='Enter') confirmRename()"
                            />
                            <span style="color: var(--text-secondary); font-weight: 500; white-space: nowrap;">.mbtiles</span>
                        </div>
                    </div>
                    <p style="font-size: 0.9rem; color: var(--text-secondary); margin: 0;">Use only letters, numbers, spaces, underscores, and dashes.</p>
                </div>
                <div class="delete-modal-actions">
                    <button class="btn btn-secondary" onclick="closeRenameModal()">Cancel</button>
                    <button class="btn btn-primary" onclick="confirmRename()">Rename</button>
                </div>
            </div>
        </div>
    `;

    // Store the chart info
    window.pendingRename = { chartPath, currentName, folder };

    document.body.insertAdjacentHTML('beforeend', modalHTML);

    // Focus and select the input field
    setTimeout(() => {
        const input = document.getElementById('newChartName');
        if (input) {
            input.focus();
            input.select();
        }
    }, 100);
}

window.closeRenameModal = function(event) {
    if (event && event.target.id !== 'renameModal') return;

    const modal = document.getElementById('renameModal');
    if (modal) {
        modal.remove();
    }
    delete window.pendingRename;
}

window.confirmRename = async function() {
    const input = document.getElementById('newChartName');
    const newName = input?.value.trim();

    if (!newName) {
        input?.focus();
        return;
    }

    // Validate filename
    if (newName.includes('..') || newName.includes('/') || newName.includes('\\')) {
        alert('Invalid chart name. Please use only letters, numbers, spaces, underscores, and dashes.');
        input?.focus();
        return;
    }

    const { chartPath, currentName, folder } = window.pendingRename;
    const newNameWithExtension = newName + '.mbtiles';
    const currentNameWithExtension = currentName.endsWith('.mbtiles') ? currentName : currentName + '.mbtiles';

    // Check if name hasn't changed
    if (newNameWithExtension === currentNameWithExtension) {
        closeRenameModal();
        return;
    }

    // Check if a chart with the new name already exists in the same folder
    const folderCharts = chartsData.filter(c => c.folder === folder);
    const duplicate = folderCharts.find(c =>
        (c.name === newNameWithExtension || c.name === newName) && c.relativePath !== chartPath
    );

    if (duplicate) {
        showErrorNotification(`A chart named "${newNameWithExtension}" already exists in folder "${folder}". Please choose a different name.`);
        input?.focus();
        return;
    }

    closeRenameModal();

    // Perform the rename
    try {
        const response = await fetch('/signalk/chart-tiles/rename-chart', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                chartPath: chartPath,
                newName: newNameWithExtension
            })
        });

        if (response.ok) {
            loadCharts(); // Refresh the list

            // Show success notification
            showRenameNotification(currentNameWithExtension, newNameWithExtension);
        } else {
            const errorText = await response.text();
            alert(`Failed to rename chart: ${errorText}`);
        }
    } catch (error) {
        console.error('Error renaming chart:', error);
        alert('Error renaming chart: ' + error.message);
    }
}

window.deleteFolder = function(folder) {
    // Check if folder has charts
    const folderHasCharts = chartsData.some(chart => chart.folder === folder);

    showDeleteConfirmation({
        type: 'folder',
        name: folder,
        hasCharts: folderHasCharts,
        onConfirm: async () => {
            try {
                const response = await fetch(`/signalk/chart-tiles/folders/${encodeURIComponent(folder)}`, {
                    method: 'DELETE'
                });

                if (response.ok) {
                    // If we were viewing this folder, switch to all folders
                    if (selectedFolder === folder) {
                        selectedFolder = null;
                    }
                    loadCharts(); // Refresh the list
                } else {
                    const errorText = await response.text();
                    alert(`Failed to delete folder: ${errorText}`);
                }
            } catch (error) {
                console.error('Error deleting folder:', error);
                alert('Error deleting folder: ' + error.message);
            }
        }
    });
}

// Delete confirmation modal
function showDeleteConfirmation({ type, name, hasCharts, onConfirm }) {
    const isChart = type === 'chart';
    const isFolder = type === 'folder';
    const icon = window.getIcon('trash');
    const title = isChart ? 'Delete Chart' : 'Delete Folder';

    let warningText;
    if (isChart) {
        warningText = window.getIcon('warning') + ' This action cannot be undone. The chart file will be permanently deleted.';
    } else if (isFolder && hasCharts) {
        warningText = window.getIcon('warning') + ' This folder contains charts and cannot be deleted. Please move or delete all charts from this folder first.';
    } else {
        warningText = window.getIcon('warning') + ' This will delete the empty folder.';
    }

    const modalHTML = `
        <div class="delete-modal-overlay" id="deleteModal" onclick="closeDeleteModal(event)">
            <div class="delete-modal" onclick="event.stopPropagation()">
                <div class="delete-modal-header">
                    <div class="delete-modal-icon">${icon}</div>
                    <h3>${title}</h3>
                </div>
                <div class="delete-modal-body">
                    <p>Are you sure you want to delete this ${type}?</p>
                    <div class="delete-modal-item">
                        <div class="delete-modal-item-name">${name}</div>
                    </div>
                    <div class="delete-modal-warning">${warningText}</div>
                </div>
                <div class="delete-modal-actions">
                    <button class="btn btn-secondary" onclick="closeDeleteModal()">Cancel</button>
                    ${!(isFolder && hasCharts) ? '<button class="btn btn-danger" onclick="confirmDelete()">Delete</button>' : ''}
                </div>
            </div>
        </div>
    `;

    // Store the callback
    window.pendingDeleteConfirm = onConfirm;

    // Add modal to body
    document.body.insertAdjacentHTML('beforeend', modalHTML);
}

window.closeDeleteModal = function(event) {
    // Only close if clicking overlay, not the modal itself
    if (event && event.target.id !== 'deleteModal') return;

    const modal = document.getElementById('deleteModal');
    if (modal) {
        modal.remove();
    }
    delete window.pendingDeleteConfirm;
}

window.confirmDelete = function() {
    const callback = window.pendingDeleteConfirm;
    closeDeleteModal();

    if (callback) {
        callback();
    }
}

// Duplicate warning modal
function showDuplicateWarning({ duplicates, folderName, onConfirm, onCancel }) {
    const icon = window.getIcon('warning');
    const duplicateList = duplicates.map(d => `<li>${d}</li>`).join('');

    const modalHTML = `
        <div class="delete-modal-overlay" id="duplicateModal" onclick="closeDuplicateModal(event)">
            <div class="delete-modal" onclick="event.stopPropagation()">
                <div class="delete-modal-header">
                    <div class="delete-modal-icon">${icon}</div>
                    <h3>Overwrite Existing Chart${duplicates.length > 1 ? 's' : ''}?</h3>
                </div>
                <div class="delete-modal-body">
                    <p>The following chart${duplicates.length > 1 ? 's' : ''} already exist${duplicates.length === 1 ? 's' : ''} in <strong>${folderName}</strong>:</p>
                    <ul class="upload-file-list" style="margin: 12px 0;">
                        ${duplicateList}
                    </ul>
                    <div class="delete-modal-warning">${window.getIcon('warning')} Continuing will overwrite the existing file${duplicates.length > 1 ? 's' : ''}.</div>
                </div>
                <div class="delete-modal-actions">
                    <button class="btn btn-secondary" onclick="closeDuplicateModal()">Cancel</button>
                    <button class="btn btn-primary" onclick="confirmDuplicate()">Continue Upload</button>
                </div>
            </div>
        </div>
    `;

    // Store the callbacks
    window.pendingDuplicateConfirm = onConfirm;
    window.pendingDuplicateCancel = onCancel;

    // Add modal to body
    document.body.insertAdjacentHTML('beforeend', modalHTML);
}

window.closeDuplicateModal = function(event) {
    // Only close if clicking overlay, not the modal itself
    if (event && event.target.id !== 'duplicateModal') return;

    const modal = document.getElementById('duplicateModal');
    if (modal) {
        modal.remove();
    }

    // Call cancel callback if set
    if (window.pendingDuplicateCancel) {
        window.pendingDuplicateCancel();
    }

    delete window.pendingDuplicateConfirm;
    delete window.pendingDuplicateCancel;
}

window.confirmDuplicate = function() {
    const callback = window.pendingDuplicateConfirm;
    const modal = document.getElementById('duplicateModal');
    if (modal) {
        modal.remove();
    }
    delete window.pendingDuplicateConfirm;
    delete window.pendingDuplicateCancel;

    if (callback) {
        callback();
    }
}

// Notification functions
function showToggleNotification(chartName, enabled) {
    const notificationHTML = `
        <div class="notification-toast" id="toggleNotification">
            <div class="notification-content">
                <div class="notification-icon ${enabled ? 'success' : 'warning'}">
                    ${enabled ? window.getIcon('checkmark') : window.getIcon('circle')}
                </div>
                <div class="notification-text">
                    <div class="notification-title">${enabled ? 'Chart Enabled' : 'Chart Disabled'}</div>
                    <div class="notification-message">${chartName}</div>
                </div>
            </div>
        </div>
    `;

    // Remove any existing notification
    const existing = document.getElementById('toggleNotification');
    if (existing) {
        existing.remove();
    }

    // Add notification to body
    document.body.insertAdjacentHTML('beforeend', notificationHTML);

    // Auto-remove after 5 seconds
    setTimeout(() => {
        const notification = document.getElementById('toggleNotification');
        if (notification) {
            notification.classList.add('fade-out');
            setTimeout(() => notification.remove(), 300);
        }
    }, 5000);
}

function showErrorNotification(message) {
    const notificationHTML = `
        <div class="notification-toast error" id="errorNotification">
            <div class="notification-content">
                <div class="notification-icon error">${window.getIcon('cross')}</div>
                <div class="notification-text">
                    <div class="notification-title">Error</div>
                    <div class="notification-message">${message}</div>
                </div>
            </div>
        </div>
    `;

    // Remove any existing notification
    const existing = document.getElementById('errorNotification');
    if (existing) {
        existing.remove();
    }

    // Add notification to body
    document.body.insertAdjacentHTML('beforeend', notificationHTML);

    // Auto-remove after 5 seconds
    setTimeout(() => {
        const notification = document.getElementById('errorNotification');
        if (notification) {
            notification.classList.add('fade-out');
            setTimeout(() => notification.remove(), 300);
        }
    }, 5000);
}

function showRenameNotification(oldName, newName) {
    const notificationHTML = `
        <div class="notification-toast" id="renameNotification">
            <div class="notification-content">
                <div class="notification-icon success">
                    <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor">
                        <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/>
                    </svg>
                </div>
                <div class="notification-text">
                    <div class="notification-title">Chart Renamed</div>
                    <div class="notification-message">${oldName} → ${newName}</div>
                </div>
            </div>
        </div>
    `;

    // Remove any existing notification
    const existing = document.getElementById('renameNotification');
    if (existing) {
        existing.remove();
    }

    // Add notification to body
    document.body.insertAdjacentHTML('beforeend', notificationHTML);

    // Auto-remove after 5 seconds
    setTimeout(() => {
        const notification = document.getElementById('renameNotification');
        if (notification) {
            notification.classList.add('fade-out');
            setTimeout(() => notification.remove(), 300);
        }
    }, 5000);
}

function showUploadNotification(fileCount) {
    const notificationHTML = `
        <div class="notification-toast" id="uploadNotification">
            <div class="notification-content">
                <div class="notification-icon success">
                    ${window.getIcon('checkmark')}
                </div>
                <div class="notification-text">
                    <div class="notification-title">Upload Complete</div>
                    <div class="notification-message">${fileCount} chart${fileCount !== 1 ? 's' : ''} uploaded successfully</div>
                </div>
            </div>
        </div>
    `;

    // Remove any existing notification
    const existing = document.getElementById('uploadNotification');
    if (existing) {
        existing.remove();
    }

    // Add notification to body
    document.body.insertAdjacentHTML('beforeend', notificationHTML);

    // Auto-remove after 5 seconds
    setTimeout(() => {
        const notification = document.getElementById('uploadNotification');
        if (notification) {
            notification.classList.add('fade-out');
            setTimeout(() => notification.remove(), 300);
        }
    }, 5000);
}

// Chart info modal
let currentChartPath = null;
let currentMetadata = null;
let isEditMode = false;

window.showChartInfo = async function(chartPath) {
    try {
        currentChartPath = chartPath;
        isEditMode = false;

        const response = await fetch(`/signalk/chart-tiles/chart-metadata/${encodeURIComponent(chartPath)}`);

        if (!response.ok) {
            const errorText = await response.text();
            showErrorNotification(`Failed to load chart information: ${errorText}`);
            return;
        }

        const metadata = await response.json();
        currentMetadata = metadata;

        renderMetadataModal(metadata);

    } catch (error) {
        console.error('Error fetching chart info:', error);
        showErrorNotification('Error loading chart information: ' + error.message);
    }
}

function renderMetadataModal(metadata) {
    const formatValue = (key, value, isEditable = false) => {
        if (value === null || value === undefined || value === '') {
            return '<span style="color: var(--text-secondary); font-style: italic;">Not specified</span>';
        }

        // In edit mode, make Chart Name editable
        if (isEditMode && isEditable && key === 'name') {
            return `<input type="text" id="editChartName" class="text-input" value="${value}" style="width: 100%; padding: 8px;" />`;
        }

        switch(key) {
            case 'bounds':
                try {
                    const bounds = typeof value === 'string' ? value.split(',').map(v => parseFloat(v.trim())) : value;
                    return `
                        <div style="font-family: monospace; font-size: 0.9em;">
                            SW: ${bounds[0].toFixed(4)}°, ${bounds[1].toFixed(4)}°<br>
                            NE: ${bounds[2].toFixed(4)}°, ${bounds[3].toFixed(4)}°
                        </div>
                    `;
                } catch {
                    return value;
                }
            case 'tileCount':
                return parseInt(value).toLocaleString();
            case 'minzoom':
            case 'maxzoom':
                return `Level ${value}`;
            case 'legend':
                return '<span style="color: var(--text-secondary); font-style: italic;">Available (not displayed)</span>';
            default:
                return value;
        }
    };

    const metadataRows = [
        { label: 'Chart Name', key: 'name', editable: true },
        { label: 'Description', key: 'description' },
        { label: 'Version', key: 'version' },
        { label: 'Type', key: 'type' },
        { label: 'Format', key: 'format' },
        { label: 'Bounds', key: 'bounds' },
        { label: 'Min Zoom', key: 'minzoom' },
        { label: 'Max Zoom', key: 'maxzoom' },
        { label: 'Center', key: 'center' },
        { label: 'Tile Count', key: 'tileCount' },
        { label: 'Attribution', key: 'attribution' },
        { label: 'Credits', key: 'credits' },
        { label: 'Tags', key: 'tags' },
        { label: 'Legend', key: 'legend' }
    ];

    const metadataHTML = metadataRows
        .filter(row => metadata[row.key] !== undefined)
        .map(row => `
            <div class="chart-info-row">
                <div class="chart-info-label">${row.label}:</div>
                <div class="chart-info-value">${formatValue(row.key, metadata[row.key], row.editable)}</div>
            </div>
        `).join('');

    const infoIcon = window.getIcon('info', true);

    // Warning message for edit mode
    const warningHTML = isEditMode ? `
        <div class="delete-modal-warning" style="margin-bottom: 16px;">
            ${window.getIcon('warning')} <strong>Legal Notice:</strong> You are about to modify chart metadata. The Signal K community is not responsible for any illegal use of this feature. Charts must only be modified for personal use. Distribution of modified charts may violate copyright laws.
        </div>
    ` : '';

    const modalHTML = `
        <div class="delete-modal-overlay" id="chartInfoModal" onclick="closeChartInfoModal(event)">
            <div class="delete-modal chart-info-modal" onclick="event.stopPropagation()">
                <div class="delete-modal-header">
                    <div class="delete-modal-icon" style="color: var(--accent-primary);">${infoIcon}</div>
                    <h3>Chart Metadata ${isEditMode ? '(Edit Mode)' : ''}</h3>
                </div>
                <div class="delete-modal-body">
                    ${warningHTML}
                    <div class="chart-info-container">
                        ${metadataHTML}
                    </div>
                </div>
                <div class="delete-modal-actions">
                    ${isEditMode ?
                        '<button class="btn btn-secondary" onclick="cancelEditMetadata()">Cancel</button><button class="btn btn-primary" onclick="saveChartMetadata()">Save</button>' :
                        '<button class="btn btn-secondary" onclick="editChartMetadata()">Edit</button><button class="btn btn-primary" onclick="closeChartInfoModal()">Close</button>'
                    }
                </div>
            </div>
        </div>
    `;

    // Remove existing modal if present
    const existingModal = document.getElementById('chartInfoModal');
    if (existingModal) {
        existingModal.remove();
    }

    document.body.insertAdjacentHTML('beforeend', modalHTML);
}

window.editChartMetadata = function() {
    isEditMode = true;
    renderMetadataModal(currentMetadata);
}

window.cancelEditMetadata = function() {
    isEditMode = false;
    renderMetadataModal(currentMetadata);
}

window.saveChartMetadata = async function() {
    const newChartName = document.getElementById('editChartName')?.value.trim();

    if (!newChartName) {
        showErrorNotification('Chart name cannot be empty');
        return;
    }

    try {
        const response = await fetch(`/signalk/chart-tiles/chart-metadata/${encodeURIComponent(currentChartPath)}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                name: newChartName
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            showErrorNotification(`Failed to save metadata: ${errorText}`);
            return;
        }

        // Update current metadata
        currentMetadata.name = newChartName;
        currentMetadata.description = 'USER MODIFIED - DO NOT DISTRIBUTE - PERSONAL USE ONLY';

        // Close edit mode and show success
        isEditMode = false;
        renderMetadataModal(currentMetadata);

        showSuccessNotification('Chart metadata updated successfully');

    } catch (error) {
        console.error('Error saving chart metadata:', error);
        showErrorNotification('Error saving chart metadata: ' + error.message);
    }
}

function showSuccessNotification(message) {
    const notificationHTML = `
        <div class="notification-toast" id="successNotification">
            <div class="notification-content">
                <div class="notification-icon success">
                    ${window.getIcon('checkmark')}
                </div>
                <div class="notification-text">
                    <div class="notification-title">Success</div>
                    <div class="notification-message">${message}</div>
                </div>
            </div>
        </div>
    `;

    const existing = document.getElementById('successNotification');
    if (existing) {
        existing.remove();
    }

    document.body.insertAdjacentHTML('beforeend', notificationHTML);

    setTimeout(() => {
        const notification = document.getElementById('successNotification');
        if (notification) {
            notification.classList.add('fade-out');
            setTimeout(() => notification.remove(), 300);
        }
    }, 5000);
}

window.closeChartInfoModal = function(event) {
    if (event && event.target.id !== 'chartInfoModal') return;

    const modal = document.getElementById('chartInfoModal');
    if (modal) {
        modal.remove();
    }
}
