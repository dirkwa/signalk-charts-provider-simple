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
  interface Window {
    // tabs.ts
    openTab(evt: MouseEvent | null, tabName: string): void;

    // emoji-utils.ts
    detectEmojiSupport(): boolean;
    getIcon(iconName: string, preferSvg?: boolean): string;

    // tab activation handlers (each file owns one)
    handleManageTabActive(): void;
    handleDownloadTabActive(): void;
    handleConvertTabActive(): void;
    handleCatalogTabActive(): void;

    // chart-catalog.js (still .js until PR-C)
    setCatalogFilter?(category: string): void;
    toggleCatalog?(catalogFile: string): Promise<void>;
    downloadCatalogChart?(
      chartNumber: string,
      catalogFile: string,
      url: string,
      zipfileDatetime: string
    ): Promise<void>;
    showConversionLog?(chartNumber: string): Promise<void>;
    closeConversionLog?(): void;
    dismissConversionError?(chartNumber: string): void;

    // chart-convert.js (still .js until PR-C)
    handleConvertFile?(input: HTMLInputElement, type: string): Promise<void>;
    showConvertLog?(chartNumber: string): void;

    // download-simple.ts
    startDownload(): Promise<void>;
    cancelDownload(jobId: string): Promise<void>;

    // manage-charts-enhanced.js (still .js until PR-D)
    triggerUpload?(): void;
    triggerUploadEmpty?(): void;
    handleFileUpload?(event: Event): Promise<void>;
    setViewMode?(mode: string): void;
    selectFolder?(folder: string): void;
    showCreateFolderDialog?(): void;
    closeCreateFolderModal?(event?: Event): void;
    confirmCreateFolder?(): void;
    deleteFolder?(folder: string): void;
    deleteSelectedFolder?(): void;
    closeDeleteModal?(event?: Event): void;
    confirmDelete?(): void;
    deleteChart?(relativePath: string, name: string): void;
    showRenameDialog?(chartPath: string, currentName: string, folder: string): void;
    closeRenameModal?(event?: Event): void;
    confirmRename?(): Promise<void>;
    closeDuplicateModal?(event?: Event): void;
    confirmDuplicate?(): void;
    toggleChart?(relativePath: string): Promise<void>;
    handleDragStart?(event: DragEvent, chartPath: string): void;
    handleDragOver?(event: DragEvent): void;
    handleFolderDragOver?(event: DragEvent): void;
    handleFolderDragLeave?(event: DragEvent): void;
    handleDrop?(event: DragEvent, targetFolder: string): void;
    handleDropOnFolder?(event: DragEvent, targetFolder: string): Promise<void>;
    showChartInfo?(chartPath: string): Promise<void>;
    closeChartInfoModal?(event?: Event): void;
    editChartMetadata?(): void;
    cancelEditMetadata?(): void;
    saveChartMetadata?(): Promise<void>;
    pendingDuplicateCancel?: (() => void) | null;
  }
}

export {};
