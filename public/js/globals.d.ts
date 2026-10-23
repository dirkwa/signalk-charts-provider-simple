/// <reference types="leaflet" />
/**
 * Ambient declarations for cross-script globals.
 *
 * The frontend is loaded as separate `<script>` tags (no bundler), so
 * cross-file references go through `window.X = X`. TypeScript needs
 * these declarations to know about identifiers that are defined in
 * one file and used in another (or referenced via inline HTML
 * `onclick="X()"`).
 *
 * When converting a JS file to TS, add the function to the matching
 * section here so other files (and the HTML) can keep calling it.
 */

declare global {
  /** What an online chart's provider allows an area download to fetch, and how fast. */
  interface AreaDownloadLimits {
    maxTiles?: number;
    requestsPerSecond?: number;
  }

  interface Window {
    // tabs.ts
    openTab(evt: MouseEvent | null, tabName: string): void;

    // near-position.ts
    isBoundingBox(v: unknown): v is number[];
    isNearPosition(
      bbox: number[] | undefined,
      position: { latitude: number; longitude: number } | null
    ): boolean;

    // emoji-utils.ts
    detectEmojiSupport(): boolean;
    getIcon(iconName: string, preferSvg?: boolean): string;

    // tab activation handlers (each file owns one)
    handleManageTabActive(): void;
    handleDownloadTabActive(): void;
    handleConvertTabActive(): void;
    handleCatalogTabActive(): void;
    handleOnlineChartsTabActive(): void;
    handleSatelliteTabActive(): void;
    handleCustomCatalogsTabActive(): void;

    // chart-catalog.ts
    toggleCatalog(catalogFile: string): Promise<void>;
    downloadCatalogChart(
      chartNumber: string,
      catalogFile: string,
      url: string,
      zipfileDatetime: string
    ): Promise<void>;
    showConversionLog(chartNumber: string): Promise<void>;
    closeConversionLog(): void;
    dismissConversionError(chartNumber: string): void;

    // chart-convert.ts
    handleConvertFile(input: HTMLInputElement, type: string): Promise<void>;
    showConvertLog(chartNumber: string): void;

    // download-simple.ts
    startDownload(): Promise<void>;
    cancelDownload(jobId: string): Promise<void>;

    // online-charts.ts
    addOnlineChartByUrl(): Promise<void>;
    onlineChartTypeChanged(): void;

    // manage-charts-enhanced.ts
    triggerUpload(): void;
    triggerUploadEmpty(): void;
    handleFileUpload(event: Event): void;
    triggerZipUpload(): void;
    triggerZipUploadEmpty(): void;
    handleZipUpload(event: Event): void;
    setViewMode(mode: 'grid' | 'list'): void;
    selectFolder(folder: string | null): void;
    showCreateFolderDialog(): void;
    closeCreateFolderModal(event?: Event): void;
    confirmCreateFolder(): void;
    deleteFolder(folder: string): void;
    deleteSelectedFolder(): void;
    closeDeleteModal(event?: Event): void;
    confirmDelete(): void;
    deleteChart(relativePath: string, name: string): void;
    showRenameDialog(chartPath: string, currentName: string, folder: string): void;
    closeRenameModal(event?: Event): void;
    confirmRename(): Promise<void>;
    showRepairDialog(chartPath: string, name: string): void;
    closeRepairModal(event?: Event): void;
    confirmRepair(): Promise<void>;
    closeDuplicateModal(event?: Event): void;
    confirmDuplicate(): void;
    toggleChart(relativePath: string): Promise<void>;
    toggleFolderEnabled(event: Event, folder: string): Promise<void>;
    toggleFolderKeydown(event: KeyboardEvent, folder: string): void;
    handleDragStart(event: DragEvent, chartPath: string): void;
    handleDragOver(event: DragEvent): void;
    handleFolderDragOver(event: DragEvent): void;
    handleFolderDragLeave(event: DragEvent): void;
    handleDrop(event: DragEvent, targetFolder: string): void;
    handleDropOnFolder(event: DragEvent, targetFolder: string): Promise<void>;
    showChartInfo(chartPath: string): Promise<void>;
    renameOnlineChart(chartPath: string): Promise<void>;
    openOfflineArea(chartPath: string): void;
    closeChartInfoModal(event?: Event): void;
    editChartMetadata(): void;
    cancelEditMetadata(): void;
    saveChartMetadata(): Promise<void>;

    reloadManageCharts(): void;
    renderManageCharts(): void;
    showManageError(message: string): void;

    // chart-masks.ts
    maskOptionChanged(input: HTMLInputElement): Promise<void>;
    shorelineChoice(agreed: boolean): void;
    askShorelineDownload(): Promise<void>;
    startShorelineDownload(): Promise<void>;
    deleteShorelineData(): Promise<void>;
    cancelShorelineDownload(): Promise<void>;
    renderMaskRows(masks: Record<string, boolean> | undefined, editing: boolean): string;
    resetMaskEdit(): void;
    saveMaskOptions(
      chartPath: string,
      masks: Record<string, boolean>
    ): Promise<Record<string, boolean> | null>;
    maskWaitingState(): { badge: string; action: string };
    watchLandIndex(charts: { online?: { mask?: string; maskReady?: boolean } }[]): void;
    fetchLandIndexInfo(): Promise<unknown>;

    // online-area-download.ts
    showOfflineArea(
      chartId: string,
      name: string,
      minzoom: number | null,
      maxzoom: number | null,
      areaDownload: boolean,
      limits: AreaDownloadLimits,
      versions?: boolean
    ): Promise<void>;
    closeAreaDialog(event?: Event): void;
    startAreaDownload(): Promise<void>;
    cancelAreaDownload(): Promise<void>;
    clearKeptTiles(): Promise<void>;
  }
}

export {};
