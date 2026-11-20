export const library = {
  edit: {
    action: "Edit",
    all: (count: number) => `Edit all ${count}`,
    title: (count: number) => `Edit ${count} movies`,
    description:
      "Review the library estimate below. The operation will be applied to each NFO's current values. There is no undo.",
    field: "Field",
    operation: "Change",
    operations: { set: "Set", clear: "Clear", add: "Add", remove: "Remove", rename: "Rename" },
    genres: "Genres",
    from: "From",
    to: "To",
    value: "Value",
    excluded: "Excluded by download.nfoIgnoreFields",
    estimate: (changed: number, unchanged: number) =>
      `From the library: ${changed} will change · ${unchanged} unchanged`,
    noChange: "No change",
    oldValue: "Old value",
    newValue: "New value",
    confirm: (count: number) => `Change ${count} movies`,
    loading: "Collecting movies…",
    running: (current: number, total: number) => `Editing ${current} / ${total} movies…`,
    completed: "Edit completed",
    failed: "Edit failed",
    result: (changed: number, unchanged: number, skipped: number, failed: number) =>
      `${changed} changed · ${unchanged} unchanged · ${skipped} skipped (no NFO) · ${failed} failed`,
    newEdit: "New edit",
    close: "Close",
  },
  all: "All",
  pagination: {
    label: "Media library pagination",
    pageSize: "Per page",
    previous: "Previous",
    next: "Next",
    jump: "Go to page",
    goTo: (page: number) => `Page ${page}`,
    summary: (total: number, page: number, pages: number) => `${total} movies · Page ${page} of ${pages}`,
  },
  metrics: {
    movies: "Movies",
    files: "Files",
  },
  allLibraries: "All libraries",
  libraryAriaLabel: "Library",
  view: { list: "List", wall: "Poster wall" },
  subtitles: { label: "Subtitle filter", all: "All subtitle statuses", missing: "Has files without subtitles" },
  health: {
    title: "Health",
    issues: {
      missingPoster: "Missing poster",
      missingBackdrop: "Missing backdrop",
      missingSynopsis: "Missing synopsis",
      noNfo: "No NFO",
      duplicate: "Duplicate numbers",
    },
    fix: (count: number) => `Refresh ${count} from sites`,
    fixHint: "Opens a preview of the refreshed metadata. Nothing is written until you apply it.",
    ignored: "Ignored",
    ignore: (count: number) => `Ignore these ${count}`,
    ignoreHint: "Ignored movies no longer count toward health. Restore them from “Ignored”.",
    restore: (count: number) => `Stop ignoring ${count}`,
    fixStarted: (count: number) => `Previewing a refresh of ${count} movies`,
    mixedRoots: "These movies span several media directories. Please filter by a single library before fixing.",
    clear: "Clear filters",
  },
  facets: {
    title: "Browse by",
    actors: "Actors",
    studios: "Studios",
    tags: "Tags",
    none: "Nothing to browse yet",
  },
  searchAriaLabel: "Search media library",
  searchPlaceholder: "Search title, number, actor, or relative path…",
  refresh: "Refresh",
  listAriaLabel: "Media library movie list",
  noMatchingEntries: "No matching entries",
  nothingIndexed: "Nothing indexed yet. Scraped and imported movies appear here.",

  // Entry card
  parts: (count: number) => `${count} parts`,
  partsMissing: (missing: number, total: number) => `${missing} of ${total} parts missing`,
  fileActions: "File actions",
  scrapeInfo: "Scrape Info",
  openFolder: "Open folder",
  removeFromLibrary: "Deep delete",
  multiSelect: "Multi-select",
  selectEntry: (id: string) => `Select ${id}`,
  selectAllMatches: "Select all matching movies",
  selectingAll: "Selecting all matching movies…",
  selectedCount: (count: number) => `${count} movie(s) selected`,
  availabilityNotChecked: "Availability not yet checked",

  // Availability labels
  availability: {
    partial: "Partially available",
    unavailable: "All unavailable",
  },

  // Delete dialog
  removeDialogTitle: "Deep delete",
  removeDialogDescription: (movieCount: number, fileCount: number, assetCount: number) =>
    `Will queue deep deletion of ${fileCount} media file(s) for ${movieCount} movie(s). The background queue deletes files one by one and removes ${assetCount} asset record(s). STRM deletion also deletes the 115 source and local STRM files; other media deletion removes the disk media files and recorded retained sources. You can leave after submitting. This cannot be undone.`,
  deletionQueued: "Files will be deleted in the background. View progress and retry failed tasks in the workbench.",
  confirmRemove: "Queue deep deletion",

  // File rows
  fileStatus: {
    available: "Available",
    unavailable: "Unavailable",
    unchecked: "Unchecked",
  },
  copyPath: "Copy path",
  openLocation: "Open location",
  relink: "Relink",
  removeFile: "Deep delete",

  // Relink / remove file dialog
  relinkFileTitle: "Relink File",
  removeFileDescription:
    "Queue deep deletion of this file in the background: STRM deletion also deletes the 115 source and local STRM files; other media deletion removes the disk media file and its recorded retained source. Other disc parts will be kept. You can leave after submitting. This cannot be undone.",
  mediaFolderLabel: (name: string) => `Media root: ${name}`,
  newRelativePath: "New relative path",
  confirm: "Confirm",
};
