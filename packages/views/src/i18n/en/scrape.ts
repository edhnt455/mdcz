import type { ScrapeRunStage } from "@mdcz/shared/serverDtos";

export const scrape = {
  conflict: {
    setupErrors: {
      moviePilotRequired:
        "Save and verify the MoviePilot address, API token and allowed 115 root under Settings → Media servers → Emby → MoviePilot · 115 STRM sync.",
      copyLibraryRequired: "This action requires a copy library. Select Copy as this library's placement first.",
      libraryBindingRequired:
        "Select this copy library under Settings → Media servers → Emby, save sync settings, then verify STRM source associations. Automatic sync can remain Off; no Emby Server ID or webhook is required for manual duplicate resolution.",
      libraryPathsChanged:
        "This library's source or output directory has changed. Save its STRM sync settings again and verify source associations.",
    },
    openSettings: "Open STRM sync settings in a new tab",
    open: "Resolve duplicate",
    title: "Choose the version to keep",
    description:
      "Compare the actual 115 video sizes, then select a version to keep. The other version will be deleted.",
    keepExisting: "Keep library version",
    keepIncoming: "Keep new version",
    cloud: "115 source video",
    loading: "Verifying both 115 source files…",
    deleting: "Deleting the selected version and verifying the result…",
    sameResource:
      "Both STRMs point to the same 115 video. The cloud video will be kept; only redundant local STRMs will be removed.",
    willDelete: "Version to delete:",
    deleteIncoming: "Remove its Normal STRM. Keep the existing Link STRM.",
    deleteExisting: "Remove its Normal and Link STRMs, then retry scraping the new version.",
    deleteCloud: "Also delete this version's source video from 115.",
    confirm: "Delete the other version and continue",
    completed: "Duplicate resolved.",
  },
  stages: {
    discovering: "Scanning video files",
    prepare: "Fetching metadata",
    "check-output": "Checking conflicts",
    execute: "Organizing and archiving",
    search: "Searching",
    download: "Downloading assets",
    completed: "No processable videos found",
  } as Record<ScrapeRunStage, string>,
  launch: {
    selection: "Selected file scraping started",
    singleFile: "Single file scrape task started",
    retry: "Retry started",
    manualUrl: "Manual URL scrape started",
  },

  // ScrapeStartErrorDialog
  incompleteTitle: "Scrape Task Incomplete",
  incompleteDesc: "Please review task results and resolve the following issues before retrying:",
  understood: "Got it",

  // UncensoredConfirmDialog
  uncensored: {
    title: "Confirm Uncensored Type",
    description: "Please manually confirm the movie type below",
    batchSetTo: "Batch set to:",
    skip: "Skip",
    confirm: "Confirm",
    noItemsToSubmit: "No items to submit",
    options: {
      umr: "Decensored",
      leak: "Leaked",
      uncensored: "Uncensored",
    },
  },

  // ScrapeWorkbenchAdapter
  taskQueued: "Task queued",
  scanningVideoFiles: "Scanning video files",
  stoppingWaitingCurrent: "Stopping, waiting for current file to complete",
  noVideosFound: "No processable videos found",
  taskStopped: "Task stopped",
  taskInterrupted: "Task interrupted",
  preparingTask: "Preparing task",
  taskInterruptedHint: "The task was interrupted before it finished. Rescrape this directory to run it again.",

  // ResultTreeAdapter
  numberEmpty: "Movie code is empty",
  numberCopied: "Code copied",
  copyNumberFailed: "Failed to copy code",
  rescrapeFailed: "Failed to rescrape",
  confirmRemoveGroup: (count: number, number: string) => `Remove ${count} records from the library?\n${number}`,
  confirmRemoveSingle: (path: string) => `Remove this record from the library?\n${path}`,
  removedSuccess: "Removed from the library",
  operationFailed: "Operation failed",
  noOpenablePath: "No openable file path",
  openFolderFailed: (error: string) => `Failed to open directory: ${error}`,
  unrecognizedNumber: "Unrecognized code",
  copyNumber: "Copy code",
  pathCopied: "Path copied",
  copyPathFailed: "Failed to copy path",
  copyPath: "Copy path",
  rescrape: "Rescrape",
  rescrapeByUrl: "Rescrape by URL",
  rescrapeByNumber: "Rescrape by number (drop pinned page)",
  removeFromLibrary: "Remove from library",
  openSourceFolder: "Open source directory",
  openMetadataFolder: "Open metadata directory",
  editNfo: "Edit NFO",
  play: "Play",
  metrics: {
    total: "Total",
    success: "Success",
    failed: "Failed",
  },
  rescrapeByUrlFailed: "Failed to rescrape by URL",

  // DetailPanelAdapter
  emptyMessage: "Select an item to view details",
  selectItemFirst: "Please select an item first",
  loadNfoFailed: (error: string) => `Failed to load NFO: ${error}`,
  checkFormContent: "Please check form content",
  nfoSaved: "NFO saved",
  saveNfoFailed: (error: string) => `Failed to save NFO: ${error}`,
  discardNfoChanges: "Discard unsaved NFO changes?",
  discardPosterChanges: "Discard unsaved thumbnail changes?",
  coverSaved: "Thumbnail saved",
  saveCoverFailed: (error: string) => `Failed to save thumbnail: ${error}`,
};
