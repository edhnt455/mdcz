export const library = {
  edit: {
    action: "Edit",
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
  updatedAt: "Last updated",
  sort: {
    field: "Sort by",
    order: "Sort order",
    fields: { createdAt: "Date added", number: "Number", title: "Title" },
    orders: { asc: "Ascending", desc: "Descending" },
  },
  filters: {
    label: "Media library filters",
    keyword: "Keyword",
    entries: "Movies",
    missingActors: "Missing actors",
    missingSubtitles: "Has files without subtitles",
    hasTranslation: "Translation",
    withTranslation: "Has translation",
    withoutTranslation: "No translation",
    yes: "Yes",
    no: "No",
    reset: "Reset",
    apply: "Search",
  },
  health: {
    issues: {
      missingPoster: "Missing poster",
      missingBackdrop: "Missing backdrop",
      missingSynopsis: "Missing synopsis",
      noNfo: "No NFO",
      duplicate: "Duplicate numbers",
    },
  },
  facets: {
    actors: "Actors",
    studios: "Studios",
    tags: "Tags",
    search: (label: string) => `Search ${label.toLowerCase()}`,
    none: "No matching options",
  },
  bulk: {
    label: "Bulk actions",
    rescrape: "Rescrape",
    rescrapeQueued: (count: number) => `Queued ${count} ${count === 1 ? "movie" : "movies"} for rescraping`,
    viewRescrapeProgress: "View progress",
    selectPage: "Select current page",
    clear: "Clear selection",
    mixedRoots: "Select movies from a single media directory to rescrape them.",
  },
  searchAriaLabel: "Search media library",
  searchPlaceholder: "Search title, number, actor, or relative path…",
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
  selectEntry: (id: string) => `Select ${id}`,
  selectAllMatches: (count: number) => `Select all ${count} matching movies`,
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
