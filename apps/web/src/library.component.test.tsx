import type { DeletionJob } from "@mdcz/shared/deletions";
import type { LibraryDeletionResponse } from "@mdcz/shared/pending";
import type { LibraryEntryDto, LibraryListResponse } from "@mdcz/shared/serverDtos";
import { parseLibraryBrowseSearch } from "@mdcz/views/library";
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
import { DeletionTasksPage } from "./deletionTasks";
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
    .mockResolvedValue({ entries: [entry], page: 1, pageSize: 10, total: 1, fileCount: 2, totalBytes: 20 });
  vi.spyOn(api.library, "matches").mockResolvedValue({ entries: [entry] });
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
  const job: DeletionJob = {
    id: "action/file-job",
    source: "library",
    status: "running",
    step: "validating",
    name: "CD1.strm",
    libraryName: "Media",
    linkPath: "/media/CD1.strm",
    sourcePaths: [],
    cloudPath: null,
    cloudFileId: null,
    cloudSize: null,
    cloudDeleted: false,
    cloudPlanned: false,
    sharedResource: false,
    error: null,
    result: null,
    attempts: 1,
    nextAttemptAt: null,
    createdAt: 1,
    updatedAt: 1,
    completedAt: null,
    canRetry: false,
    retryRunId: null,
    retryPlanned: false,
    progress: "正在删除 115 源文件",
  };
  vi.spyOn(api.deletions, "list").mockResolvedValue({ jobs: [job] });
  vi.spyOn(api.deletions, "detail").mockResolvedValue(job);
  const root = createRootRoute({ component: Outlet });
  const library = createRoute({ getParentRoute: () => root, path: "/", component: LibraryPage });
  const workbench = createRoute({
    getParentRoute: () => root,
    path: "/workbench",
    component: () => <DeletionTasksPage selectedId="action/file-job" onSelect={vi.fn()} />,
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
    await screen.getByRole("checkbox", { name: "全选筛选结果" }).click();
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
    expect(router.state.location.search).toMatchObject({ intent: "deletion", jobId: "action/file-job" });
  } finally {
    accept({ taskIds: ["batch-job"] });
    await screen.unmount();
    client.clear();
    if (previousView === null) localStorage.removeItem("mdcz.library.view");
    else localStorage.setItem("mdcz.library.view", previousView);
    vi.restoreAllMocks();
  }
});

test("library browsing pages on the server and selects a fixed snapshot of every filtered movie", async () => {
  const movies: LibraryEntryDto[] = Array.from({ length: 630 }, (_, index) => ({
    id: `movie-${index + 1}`,
    mediaIdentity: `movie-${index + 1}`,
    displayFileId: `file-${index + 1}`,
    number: `MOVIE-${index + 1}`,
    title: `Movie ${index + 1}`,
    actors: [],
    size: 1,
    fileRefs: [],
    assets: [],
    available: "unchecked",
    crawlerData: null,
    thumbnailPath: null,
    createdAt: "2026-11-17T00:00:00Z",
    lastRefreshedAt: null,
    hiddenFromRecentAt: null,
  }));
  const matches = movies.slice(0, 120);
  const list = vi.spyOn(api.library, "list").mockImplementation(async (input) => {
    const source = input?.query
      ? movies.filter((entry) => entry.number === input.query)
      : input?.health
        ? matches
        : movies;
    const page = input?.page ?? 1;
    const pageSize = input?.pageSize ?? 10;
    return {
      entries: source.slice((page - 1) * pageSize, page * pageSize),
      page,
      pageSize,
      total: source.length,
      fileCount: source.length,
      totalBytes: source.length,
    };
  });
  const selectAll = vi.spyOn(api.library, "matches").mockResolvedValue({ entries: [...matches] });
  vi.spyOn(api.library, "availability").mockResolvedValue({ entries: [] });
  vi.spyOn(api.libraries, "list").mockResolvedValue({ libraries: [] });
  vi.spyOn(api.library, "summary").mockResolvedValue({
    total: 630,
    issues: { missingSynopsis: 120, missingPoster: 0, missingBackdrop: 0, noNfo: 0, duplicate: 0 },
    ignored: 0,
    facets: { actors: [], studios: [], tags: [] },
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
  const root = createRootRoute({ component: Outlet });
  const library = createRoute({
    getParentRoute: () => root,
    path: "/library",
    validateSearch: parseLibraryBrowseSearch,
    component: LibraryPage,
  });
  vi.spyOn(Route, "useSearch").mockImplementation(() => library.useSearch());
  const router = createRouter({
    routeTree: root.addChildren([library]),
    history: createMemoryHistory({ initialEntries: ["/library"] }),
  });
  const previousView = localStorage.getItem("mdcz.library.view");
  localStorage.setItem("mdcz.library.view", "list");
  const screen = await render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  try {
    await expect.element(screen.getByText("共 630 部 · 第 1 / 63 页")).toBeVisible();
    expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ page: 1, pageSize: 10 }));
    expect(selectAll).not.toHaveBeenCalled();
    await screen.getByRole("button", { name: "第 63 页", exact: true }).click();
    await expect.element(screen.getByText("共 630 部 · 第 63 / 63 页")).toBeVisible();
    await screen.getByRole("button", { name: /^缺少简介\s*120$/u }).click();
    await expect.element(screen.getByText("共 120 部 · 第 1 / 12 页")).toBeVisible();
    expect(list).toHaveBeenLastCalledWith(
      expect.objectContaining({ page: 1, pageSize: 10, health: "missingSynopsis" }),
    );
    await screen.getByRole("button", { name: "多选" }).click();
    await screen.getByRole("checkbox", { name: "全选筛选结果" }).click();
    await expect.element(screen.getByText("已选 120 部影片")).toBeVisible();
    expect(selectAll).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ query: "", health: "missingSynopsis" }),
    );
    matches.unshift({ ...movies[120], id: "new-match", number: "NEW-MATCH" });
    await screen.getByRole("button", { name: "下一页" }).click();
    await expect.element(screen.getByText("共 121 部 · 第 2 / 13 页")).toBeVisible();
    await expect.element(screen.getByText("已选 120 部影片")).toBeVisible();
    await screen.getByRole("checkbox", { name: "选择 MOVIE-11", exact: true }).click();
    await expect.element(screen.getByText("已选 119 部影片")).toBeVisible();
    await screen.getByRole("combobox", { name: "每页条数" }).selectOptions("20");
    await expect.element(screen.getByText("共 121 部 · 第 1 / 7 页")).toBeVisible();
    await expect.element(screen.getByRole("checkbox", { name: "选择 NEW-MATCH", exact: true })).not.toBeChecked();
    await expect.element(screen.getByRole("checkbox", { name: "选择 MOVIE-11", exact: true })).not.toBeChecked();
    await screen.getByRole("button", { name: "深度删除", exact: true }).last().click();
    await expect.element(screen.getByText(/将提交 119 部影片/u)).toBeVisible();
    await screen.getByRole("button", { name: "取消", exact: true }).click();
    const search = screen.getByRole("textbox", { name: "搜索媒体库" });
    await search.fill("MOVIE-50");
    await expect.element(screen.getByText("共 1 部 · 第 1 / 1 页")).toBeVisible();
    await expect.element(screen.getByText(/^已选/u)).not.toBeInTheDocument();
    await search.fill("MOVIE-51");
    await expect.element(search).toHaveFocus();
    await expect.element(screen.getByText("Movie 51", { exact: true })).toBeVisible();
    expect(selectAll).toHaveBeenCalledOnce();
  } finally {
    await screen.unmount();
    client.clear();
    vi.restoreAllMocks();
    if (previousView === null) localStorage.removeItem("mdcz.library.view");
    else localStorage.setItem("mdcz.library.view", previousView);
  }
});
