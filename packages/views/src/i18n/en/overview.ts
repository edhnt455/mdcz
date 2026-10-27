export const overview = {
  hero: {
    startAction: "Go to workbench",
    setupAction: "Go to settings",
    title: "Start scraping",
    description:
      "Open the workbench to extract metadata. Current output overview will stay updated once scraping finishes.",
    loadFailed: "Failed to load",
    notConfigured: "Not configured",
    files: "Files",
    size: "Size",
  },
  activity: {
    title: "Recent activity",
    kinds: { scan: "Scan", scrape: "Scrape", maintenance: "Maintenance" },
    statuses: {
      queued: "Queued",
      discovering: "Looking for videos",
      running: "Running",
      paused: "Paused",
      stopping: "Stopping",
      completed: "Completed",
      failed: "Failed",
      stopped: "Stopped",
      interrupted: "Interrupted",
    },
    counts: (succeeded: number, failed: number, skipped: number) =>
      [`${succeeded} succeeded`, failed ? `${failed} failed` : "", skipped ? `${skipped} skipped` : ""]
        .filter(Boolean)
        .join(", "),
  },
  maintenance: {
    title: "Maintenance",
    description:
      "Preview directory changes, repair metadata, and handle batch reorganizations to keep the output directory clean and consistent.",
    action: "Go to workbench",
  },
};
