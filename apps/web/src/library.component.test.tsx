import type { LibraryDeletionResponse, PendingActionJob } from "@mdcz/shared/pending";
import type { LibraryEntryDto, LibraryListResponse } from "@mdcz/shared/serverDtos";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import type { MouseEvent as ReactMouseEvent } from "react";
import { toast } from "sonner";
import { expect, test, vi } from "vitest";
import { render } from "vitest-browser-react";
import { api } from "./client";
import { PendingTasksPage } from "./pendingTasks";
import { LibraryPage, Route } from "./routes/library";

test("library deletion closes after submission while jobs and library refresh continue in the background", async () => {
  const entry: LibraryEntryDto = {
    id: "movie",
    mediaIdentity: "movie",
    title: "Movie",
    number: "ABC-123",
    actors: [],
    size: 20,
    displayFileId: "cd1",
    crawlerData: null,
    thumbnailPath: null,
    createdAt: "2026-11-16T00:00:00Z",
    lastRefreshedAt: null,
    hiddenFromRecentAt: null,
    available: "available",
    fileRefs: [1, 2].map((part) => ({
      id: `cd${part}`,
      rootId: "root",
      rootDisplayName: "Media",
      relativePath: `CD${part}.strm`,
      fileName: `CD${part}.strm`,
      directory: "",
      size: 10,
      modifiedAt: null,
      lastKnownPath: null,
      partNumber: part,
      partSuffix: null,
      resolution: null,
      available: true,
      availabilityError: null,
    })),
    assets: [
      { id: "poster", fileId: null, kind: "poster", uri: "poster.jpg", rootId: "root", relativePath: "poster.jpg" },
    ],
  };
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false }, mutations: { retry: false } },
  });
  const success = vi.spyOn(toast, "success");
  vi.spyOn(Route, "useSearch").mockReturnValue({});
  const list = vi
    .spyOn(api.library, "list")
    .mockResolvedValue({ entries: [entry], hasMore: false, nextCursor: null, total: 1, fileCount: 2, totalBytes: 20 });
  vi.spyOn(api.library, "availability").mockResolvedValue({
    entries: [{ id: entry.id, available: "available", fileRefs: entry.fileRefs }],
  });
  vi.spyOn(api.library, "summary").mockResolvedValue({
    total: 1,
    issues: { missingPoster: 0, missingBackdrop: 0, missingSynopsis: 0, noNfo: 0, duplicate: 0 },
    ignored: 0,
    facets: { actors: [], studios: [], tags: [] },
  });
  vi.spyOn(api.libraries, "list").mockResolvedValue({ libraries: [] });
  let accept!: (result: LibraryDeletionResponse) => void;
  const submitted = new Promise<LibraryDeletionResponse>((resolve) => {
    accept = resolve;
  });
  const remove = vi.spyOn(api.library, "delete").mockReturnValue(submitted);
  const removeFile = vi.spyOn(api.library, "removeFile").mockResolvedValue({ taskIds: ["file-job"] });
  const job: PendingActionJob = {
    id: "file-job",
    itemId: "pending",
    action: "delete",
    canRetry: false,
    status: "running",
    progress: "正在删除 115 源文件",
    error: null,
    attempts: 1,
    nextAttemptAt: null,
    createdAt: 1,
    updatedAt: 1,
    completedAt: null,
    item: {
      id: "pending",
      kind: "failed",
      ref: { rootId: "root", relativePath: "CD1.strm" },
      path: "/media/CD1.strm",
      fileName: "CD1.strm",
      libraryId: null,
      libraryName: null,
      movieId: entry.id,
      number: entry.number,
      detail: null,
      candidates: [],
      createdAt: entry.createdAt,
      updatedAt: entry.createdAt,
    },
  };
  vi.spyOn(api.pending, "jobs").mockResolvedValue({ jobs: [job] });
  const root = createRootRoute({ component: Outlet });
  const library = createRoute({ getParentRoute: () => root, path: "/", component: LibraryPage });
  const workbench = createRoute({
    getParentRoute: () => root,
    path: "/workbench",
    component: () => <PendingTasksPage selectedId="file-job" onSelect={vi.fn()} />,
  });
  const router = createRouter({
    routeTree: root.addChildren([library, workbench]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const previousView = localStorage.getItem("mdcz.library.view");
  localStorage.removeItem("mdcz.library.view");
  const screen = await render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  try {
    await screen.getByRole("button", { name: "多选" }).click();
    await screen.getByRole("checkbox", { name: "全选已加载" }).click();
    await screen.getByRole("button", { name: "深度删除", exact: true }).last().click();
    await expect.element(screen.getByText(/将提交 1 部影片的 2 个媒体文件的深度删除任务/u)).toBeVisible();
    await screen.getByRole("button", { name: "提交深度删除" }).click();
    await expect.element(screen.getByRole("button", { name: "正在提交…" })).toBeDisabled();
    expect(remove).toHaveBeenCalledExactlyOnceWith({ ids: [entry.id] });
    list.mockReturnValue(new Promise<LibraryListResponse>(() => {}));
    accept({ taskIds: ["batch-job"] });
    await expect.element(screen.getByRole("dialog")).not.toBeInTheDocument();
    await expect.poll(() => success.mock.calls[0]?.[0]).toBe("已提交到工作台");
    await screen.getByRole("button", { name: "2 个分盘" }).click();
    await screen.getByRole("button", { name: "文件操作" }).first().click();
    await screen.getByRole("button", { name: "深度删除", exact: true }).last().click();
    await screen.getByRole("button", { name: "提交深度删除" }).click();
    await expect.element(screen.getByRole("dialog")).not.toBeInTheDocument();
    expect(removeFile).toHaveBeenCalledExactlyOnceWith({ fileId: "cd1" });
    const action = success.mock.calls.at(-1)?.[1]?.action;
    if (!action || typeof action !== "object" || !("onClick" in action)) throw new Error("Missing workbench action");
    action.onClick(new MouseEvent("click") as unknown as ReactMouseEvent<HTMLButtonElement>);
    await expect.element(screen.getByText("正在删除 115 源文件", { exact: true })).toBeVisible();
    expect(router.state.location.search).toMatchObject({ intent: "actions", jobId: "file-job" });
  } finally {
    accept({ taskIds: ["batch-job"] });
    await screen.unmount();
    client.clear();
    if (previousView === null) localStorage.removeItem("mdcz.library.view");
    else localStorage.setItem("mdcz.library.view", previousView);
    vi.restoreAllMocks();
  }
});
