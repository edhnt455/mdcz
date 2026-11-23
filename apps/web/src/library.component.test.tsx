import { defaultConfiguration } from "@mdcz/shared/config";
import type { DeletionJob } from "@mdcz/shared/deletions";
import type { LibraryDeletionResponse } from "@mdcz/shared/pending";
import type { LibraryEntryDto, LibraryListResponse } from "@mdcz/shared/serverDtos";
import { parseLibraryBrowseSearch } from "@mdcz/views/library";
import { useScrapeStore } from "@mdcz/views/state/scrapeStore";
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
import { userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { buildScrapeSnapshot } from "../../../tests/unit/renderer/scrapeTestSupport";
import { api } from "./client";
import { DeletionTasksPage } from "./deletionTasks";
import { LibraryPage, Route } from "./routes/library";

test("library rescrape stays on the list while a task is running and opens the submitted run on request", async () => {
  const entries: LibraryEntryDto[] = ["First", "Second"].map((id) => ({
    id,
    mediaIdentity: id,
    title: id,
    number: id,
    actors: [],
    size: 1,
    displayFileId: id,
    crawlerData: null,
    thumbnailPath: null,
    available: "unchecked",
    createdAt: "2026-11-16T00:00:00Z",
    lastRefreshedAt: null,
    hiddenFromRecentAt: null,
    fileRefs: [],
    assets: [],
  }));
  const client = new QueryClient();
  const success = vi.spyOn(toast, "success");
  const start = vi.spyOn(api.scrape, "start").mockResolvedValue({ runId: "rescrape" });
  const baseRun = buildScrapeSnapshot();
  const snapshot = vi
    .spyOn(api.scrape, "snapshot")
    .mockResolvedValue(
      buildScrapeSnapshot({ task: { ...baseRun.task, id: "rescrape", status: "queued", continuity: "live" } }),
    );
  useScrapeStore.getState().setSnapshot(
    buildScrapeSnapshot({
      task: { ...baseRun.task, id: "running", status: "running", continuity: "live" },
    }),
    true,
  );
  vi.spyOn(Route, "useSearch").mockReturnValue({});
  vi.spyOn(api.library, "list").mockResolvedValue({
    entries,
    page: 1,
    pageSize: 20,
    total: 2,
    fileCount: 2,
    totalBytes: 2,
  });
  vi.spyOn(api.library, "availability").mockResolvedValue({ entries: [] });
  vi.spyOn(api.libraries, "list").mockResolvedValue({ libraries: [] });
  const root = createRootRoute({ component: Outlet });
  const library = createRoute({ getParentRoute: () => root, path: "/library", component: LibraryPage });
  const workbench = createRoute({ getParentRoute: () => root, path: "/workbench", component: () => <p>任务进度</p> });
  const router = createRouter({
    routeTree: root.addChildren([library, workbench]),
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
    await screen.getByRole("checkbox", { name: "选择 Second" }).click();
    await screen.getByRole("checkbox", { name: "选择 First" }).click();
    await screen.getByRole("button", { name: "重新刮削" }).click();
    await expect.poll(() => success.mock.calls[0]?.[0]).toBe("已将 2 部影片加入刮削队列");
    expect(start).toHaveBeenCalledExactlyOnceWith({ refreshMovieIds: ["Second", "First"], libraryId: undefined });
    expect(router.state.location.pathname).toBe("/library");
    await expect.element(screen.getByRole("dialog")).not.toBeInTheDocument();

    const action = success.mock.calls[0]?.[1]?.action;
    if (!action || typeof action !== "object" || !("onClick" in action)) throw new Error("Missing rescrape action");
    expect(action.label).toBe("查看进度");
    action.onClick(new MouseEvent("click") as unknown as ReactMouseEvent<HTMLButtonElement>);
    await expect.element(screen.getByText("任务进度")).toBeVisible();
    expect(snapshot).toHaveBeenCalledExactlyOnceWith({ taskId: "rescrape" });
    expect(useScrapeStore.getState().snapshot?.task.id).toBe("rescrape");
  } finally {
    await screen.unmount();
    client.clear();
    useScrapeStore.getState().reset();
    vi.restoreAllMocks();
    if (previousView === null) localStorage.removeItem("mdcz.library.view");
    else localStorage.setItem("mdcz.library.view", previousView);
  }
});

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
    .mockResolvedValue({ entries: [entry], page: 1, pageSize: 20, total: 1, fileCount: 2, totalBytes: 20 });
  vi.spyOn(api.library, "matches").mockResolvedValue({ entries: [entry] });
  vi.spyOn(api.library, "availability").mockResolvedValue({
    entries: [{ id: entry.id, available: "available", fileRefs: entry.fileRefs }],
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
    await screen.getByRole("checkbox", { name: "选择当前页" }).click();
    await screen.getByRole("group", { name: "批量操作" }).getByRole("button", { name: "深度删除" }).click();
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
    actors: index === 118 ? ["Bob"] : index >= 119 ? ["Alice"] : [],
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
    const { actors, missingActors, query } = input ?? {};
    const source = (input?.issues?.missingSynopsis ? matches : movies).filter(
      (entry) =>
        (!query || entry.number === query) &&
        (!actors || actors.some((actor) => entry.actors.includes(actor))) &&
        (missingActors === undefined || (entry.actors.length === 0) === missingActors),
    );
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
  const facet = vi.spyOn(api.library, "facet").mockImplementation(async ({ kind, query }) => {
    if (kind !== "actors") return [];
    return [
      { name: "Alice", count: 511 },
      { name: "Bob", count: 1 },
    ].filter(({ name }) => name.toLowerCase().includes(query?.toLowerCase() ?? ""));
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
    await expect.element(screen.getByText("共 630 部 · 第 1 / 32 页")).toBeVisible();
    expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ page: 1, pageSize: 20 }));
    await screen.getByRole("button", { name: "第 32 页", exact: true }).click();
    const lastPage = screen.getByText("共 630 部 · 第 32 / 32 页");
    await expect.element(lastPage).toBeVisible();

    const apply = screen.getByRole("button", { name: "搜索", exact: true });
    await expect.element(screen.getByRole("button", { name: "刷新", exact: true })).not.toBeInTheDocument();
    await screen.getByRole("combobox", { name: "缺少简介" }).selectOptions("true");
    await screen.getByRole("combobox", { name: "番号重复" }).selectOptions("false");
    await expect.element(lastPage).toBeVisible();
    expect(router.state.location.search.issues).toBeUndefined();
    await apply.click();
    await expect.element(screen.getByText("共 120 部 · 第 1 / 6 页")).toBeVisible();
    const issues = { missingSynopsis: true, duplicate: false };
    expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ page: 1, pageSize: 20, issues }));

    await screen.getByRole("checkbox", { name: "选择当前页" }).click();
    await expect.element(screen.getByText("已选 20 部影片")).toBeVisible();
    expect(selectAll).not.toHaveBeenCalled();
    await screen.getByRole("button", { name: "选择全部 120 条匹配结果" }).click();
    await expect.element(screen.getByText("已选 120 部影片")).toBeVisible();
    expect(selectAll).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ issues }));

    matches.unshift({ ...movies[0], id: "new-match", number: "NEW-MATCH" });
    await screen.getByRole("button", { name: "下一页" }).click();
    await expect.element(screen.getByText("共 121 部 · 第 2 / 7 页")).toBeVisible();
    await screen.getByRole("checkbox", { name: "选择 MOVIE-21", exact: true }).click();
    await expect.element(screen.getByText("已选 119 部影片")).toBeVisible();
    const requestsBeforePageReset = list.mock.calls.length;
    await apply.click();
    await expect.element(screen.getByText("共 121 部 · 第 1 / 7 页")).toBeVisible();
    expect(list).toHaveBeenCalledTimes(requestsBeforePageReset + 1);
    expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ page: 1, issues }));
    await expect.element(screen.getByRole("checkbox", { name: "选择 NEW-MATCH" })).not.toBeChecked();
    const requestsBeforeRepeat = list.mock.calls.length;
    matches[0] = { ...matches[0], title: "Updated on repeat search" };
    await apply.click();
    await expect.element(screen.getByText("Updated on repeat search", { exact: true })).toBeVisible();
    expect(list).toHaveBeenCalledTimes(requestsBeforeRepeat + 1);
    expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ page: 1, issues }));
    await screen.getByRole("group", { name: "批量操作" }).getByRole("button", { name: "深度删除" }).click();
    await expect.element(screen.getByText(/将提交 119 部影片/u)).toBeVisible();
    await screen.getByRole("button", { name: "取消", exact: true }).click();

    const search = screen.getByRole("textbox", { name: "搜索媒体库" });
    await search.fill("MOVIE-50");
    await expect.element(screen.getByText("已选 119 部影片")).toBeVisible();
    await userEvent.keyboard("{Enter}");
    await expect.element(screen.getByText("共 1 部 · 第 1 / 1 页")).toBeVisible();
    await expect.element(screen.getByText("已选 0 部影片")).toBeVisible();
    await expect.element(search).toHaveFocus();

    await search.fill("");
    await screen.getByRole("combobox", { name: "存在无字幕文件" }).selectOptions("true");
    await screen.getByRole("combobox", { name: "缺少演员" }).selectOptions("false");
    const translation = screen.getByRole("combobox", { name: "有无译文" });
    await translation.selectOptions("false");
    const actors = screen.getByRole("button", { name: /^演员 /u });
    await actors.click();
    await screen.getByRole("checkbox", { name: "Alice", exact: true }).click();
    await screen.getByRole("textbox", { name: "搜索演员" }).fill("Bob");
    await screen.getByRole("checkbox", { name: "Bob", exact: true }).click();
    await expect.element(screen.getByRole("checkbox", { name: "Alice", exact: true })).toBeChecked();
    expect(facet).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "actors", query: "Bob" }));
    await userEvent.keyboard("{Escape}");
    await apply.click();

    await expect.element(screen.getByText("共 2 部 · 第 1 / 1 页")).toBeVisible();
    const combined = {
      issues,
      actors: ["Alice", "Bob"],
      missingActors: false,
      missingSubtitles: true,
      hasTranslation: false,
    };
    expect(router.state.location.search).toMatchObject(combined);
    expect(list).toHaveBeenLastCalledWith(expect.objectContaining(combined));

    vi.spyOn(api.library.edit, "status").mockResolvedValue(null);
    vi.spyOn(api.config, "read").mockResolvedValue(defaultConfiguration);
    await screen.getByRole("checkbox", { name: "选择当前页" }).click();
    await screen.getByRole("button", { name: "编辑", exact: true }).click();
    const edit = screen.getByRole("dialog", { name: "编辑 2 部影片" });
    await expect.element(edit).toBeVisible();
    expect(selectAll).toHaveBeenCalledOnce();
    await userEvent.keyboard("{Escape}");
    await expect.element(edit).not.toBeInTheDocument();

    const requestsBeforeReset = list.mock.calls.length;
    await screen.getByRole("button", { name: "重置" }).click();
    await expect.element(screen.getByRole("combobox", { name: "缺少简介" })).toHaveValue("");
    await expect.element(translation).toHaveValue("");
    await expect.element(actors).toHaveTextContent("全部");
    await expect.element(screen.getByText("共 2 部 · 第 1 / 1 页")).toBeVisible();
    await expect.element(screen.getByText("已选 2 部影片")).toBeVisible();
    expect(router.state.location.search).toMatchObject(combined);
    expect(list).toHaveBeenCalledTimes(requestsBeforeReset);

    await apply.click();
    await expect.element(screen.getByText("共 630 部 · 第 1 / 32 页")).toBeVisible();
    await expect.element(screen.getByText("已选 0 部影片")).toBeVisible();
    expect(router.state.location.search).toEqual({});
  } finally {
    await screen.unmount();
    client.clear();
    vi.restoreAllMocks();
    if (previousView === null) localStorage.removeItem("mdcz.library.view");
    else localStorage.setItem("mdcz.library.view", previousView);
  }
});
