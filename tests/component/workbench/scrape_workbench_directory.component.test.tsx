import { ScrapeWorkbenchAdapter } from "@mdcz/views/adapters/ScrapeWorkbenchAdapter";
import { useScrapeStore } from "@mdcz/views/state/scrapeStore";
import { expect, test, vi } from "vitest";
import { render } from "vitest-browser-react";
import { buildScrapeSnapshot } from "../../unit/renderer/scrapeTestSupport";

test("shows library skips for completed directory runs with or without new files", async () => {
  const snapshot = buildScrapeSnapshot({
    directorySource: {
      kind: "directory",
      scanDir: "/media",
      targetDir: "/output",
      recursive: true,
      excludeDirPaths: [],
    },
    discovery: {
      directories: 1,
      candidates: 1,
      skipped: 0,
      inLibrary: 2,
      elapsedMs: 1,
      currentPath: null,
      warnings: [],
    },
  });
  const ports = {
    detail: {
      resolveImageCandidates: vi.fn(async () => []),
      readNfo: vi.fn(),
      writeNfo: vi.fn(),
      preparePosterCrop: vi.fn(),
      savePosterCrop: vi.fn(),
    },
    scrape: { rerunDirectory: vi.fn(), rescrape: vi.fn(), retryFailed: vi.fn(), openNfo: vi.fn() },
  };
  useScrapeStore.setState({ snapshot });
  try {
    const screen = await render(
      <ScrapeWorkbenchAdapter
        ports={ports}
        siteUrls={undefined}
        onPauseScrape={vi.fn()}
        onResumeScrape={vi.fn()}
        onStopScrape={vi.fn()}
        onRetryFailed={vi.fn()}
        failedCount={0}
      />,
    );
    await expect.element(screen.getByText(/成功 1.*已在库中 2/)).toBeVisible();

    useScrapeStore.getState().setSnapshot({
      ...snapshot,
      task: { ...snapshot.task, id: "rerun", previousTaskId: snapshot.task.id, totalItems: 0, successCount: 0 },
      discovery: snapshot.discovery && { ...snapshot.discovery, candidates: 0, inLibrary: 3 },
      progress: { percent: 0, completedItems: 0, totalItems: 0 },
      items: [],
    });
    const status = screen.getByRole("status").filter({ hasText: "没有待刮削的新视频" });
    await expect.element(status.getByText(/在“预览文件”中勾选/)).toBeVisible();
    await expect.element(status.getByText("已在库中", { exact: true })).toBeVisible();
    await expect.element(status.getByText("3", { exact: true })).toBeVisible();
  } finally {
    useScrapeStore.setState(useScrapeStore.getInitialState(), true);
  }
});
