import type { PendingActionJob, PendingDetailResponse, PendingItemDto } from "@mdcz/shared/pending";
import type { FailedSubtitleJob, SubtitleJob } from "@mdcz/shared/subtitleJobs";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { expect, test, vi } from "vitest";
import { render } from "vitest-browser-react";
import { api } from "./client";
import { queryKeys } from "./lib/queryKeys";
import { PendingTasksPage } from "./pendingTasks";
import { PendingPage } from "./routes/pending";
import { SubtitleTasksPage } from "./subtitleTasks";

test("batch retry combines keyword and error filters with selection across pages", async () => {
  const failures: FailedSubtitleJob[] = Array.from({ length: 53 }, (_, index) => ({
    taskId: `subtitle-update-${index}`,
    attempts: index,
    mediaPath: index === 50 ? "/media/Archive/CAWD-741-破解.strm" : `/media/ABC-${index}.strm`,
    errorType: index < 51 ? "duplicateTarget" : index === 51 ? "missingFile" : "other",
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.spyOn(api.subtitleUpdates, "list").mockResolvedValue({
    jobs: [],
    total: 53,
    counts: { queued: 0, running: 0, completed: 0, failed: 53 },
    waitingForManual: false,
  });
  vi.spyOn(api.subtitleUpdates, "listFailed").mockResolvedValue(failures);
  const retry = vi.spyOn(api.subtitleUpdates, "retryBatch").mockResolvedValue({ queued: 50 });
  const info = vi.spyOn(toast, "info");
  const screen = await render(
    <QueryClientProvider client={client}>
      <SubtitleTasksPage onSelect={vi.fn()} />
    </QueryClientProvider>,
  );
  try {
    await screen.getByRole("button", { name: "批量重试" }).click();
    const dialog = screen.getByRole("dialog");
    const search = dialog.getByRole("searchbox", { name: "搜索文件名或路径" });
    const allTypes = dialog.getByRole("checkbox", { name: "全选错误类型" });
    const allMatches = dialog.getByRole("checkbox", { name: "全选命中任务" });
    const submit = dialog.getByRole("button", { name: "提交重试" });
    await expect.element(allTypes).toBeChecked();
    await expect.element(submit).toBeDisabled();
    await allTypes.click();
    await expect.element(dialog.getByText("命中 0 条 · 已选 0 条")).toBeVisible();
    await dialog.getByRole("checkbox", { name: "资源目标重复 (51)" }).click();
    await dialog.getByRole("checkbox", { name: "文件不存在 (1)" }).click();
    await expect.element(dialog.getByText("命中 52 条 · 已选 0 条")).toBeVisible();
    await search.fill(" 741 ");
    await expect.element(dialog.getByText("命中 1 条 · 已选 0 条")).toBeVisible();
    await expect.element(dialog.getByRole("checkbox", { name: /CAWD-741/ })).toBeVisible();
    await allMatches.click();
    await expect.element(dialog.getByText("命中 1 条 · 已选 1 条")).toBeVisible();
    await search.fill("archive/cawd");
    await expect.element(dialog.getByText("命中 1 条 · 已选 1 条")).toBeVisible();
    await dialog.getByRole("checkbox", { name: "资源目标重复 (51)" }).click();
    await expect.element(dialog.getByText("暂无命中的失败任务。")).toBeVisible();
    await expect.element(submit).toBeDisabled();
    await dialog.getByRole("checkbox", { name: "资源目标重复 (51)" }).click();
    await allMatches.click();
    await search.fill("");
    await expect.element(dialog.getByText("命中 52 条 · 已选 0 条")).toBeVisible();
    const last = dialog.getByRole("checkbox", { name: /ABC-51\.strm/ });
    await last.click();
    await expect.element(dialog.getByText("命中 52 条 · 已选 1 条")).toBeVisible();
    await allMatches.click();
    await expect.element(dialog.getByText("命中 52 条 · 已选 52 条")).toBeVisible();
    await last.click();
    await expect.element(dialog.getByText("命中 52 条 · 已选 51 条")).toBeVisible();
    await submit.click();
    await expect.element(dialog).not.toBeInTheDocument();
    expect(retry).toHaveBeenCalledExactlyOnceWith(
      { jobs: failures.slice(0, 51).map(({ taskId, attempts }) => ({ taskId, attempts })) },
      expect.anything(),
    );
    expect(info).toHaveBeenCalledWith("已入队 50 条 · 1 条状态已变化，已跳过");
  } finally {
    screen.unmount();
    client.clear();
    vi.restoreAllMocks();
  }
});

test("subtitle and poster tasks show progress and let users clear completed records or retry failures", async () => {
  const running: SubtitleJob = {
    taskId: "subtitle-update-running",
    mediaPath: "/media/ABC-001.mp4",
    status: "running",
    stage: "rendering",
    progress: "裁剪并生成 poster 角标",
    notificationCount: 3,
    attempts: 1,
    createdAt: 1,
    updatedAt: 2,
    completedAt: null,
    result: null,
    warnings: [],
    error: null,
  };
  let failed: SubtitleJob = {
    ...running,
    taskId: "subtitle-update-failed",
    mediaPath: "/media/ABC-002.mp4",
    status: "failed",
    stage: "publishing",
    progress: "写入 NFO、图片与字幕记录",
    error: "Permission denied",
    warnings: ["图片来源不可用"],
  };
  const completed: SubtitleJob = {
    ...running,
    taskId: "subtitle-update-completed",
    mediaPath: "/media/ABC-003.mp4",
    status: "completed",
    stage: "completed",
    completedAt: 3,
  };
  let cleared = false;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
  vi.spyOn(api.pending, "jobs").mockResolvedValue({ jobs: [] });
  const list = vi.spyOn(api.subtitleUpdates, "list").mockImplementation(async ({ offset }) => ({
    jobs: offset ? (cleared ? [] : [completed]) : [running, failed],
    counts: { queued: 48, running: 1, completed: cleared ? 0 : 1, failed: 1 },
    total: cleared ? 50 : 51,
    waitingForManual: true,
  }));
  vi.spyOn(api.subtitleUpdates, "get").mockImplementation(async ({ id }) =>
    id === completed.taskId ? (cleared ? null : completed) : failed,
  );
  const clearCompleted = vi.spyOn(api.subtitleUpdates, "clearCompleted").mockImplementation(async () => {
    cleared = true;
    return { cleared: 1 };
  });
  const retry = vi
    .spyOn(api.subtitleUpdates, "retry")
    .mockRejectedValueOnce(new Error("该影片已有处理任务"))
    .mockImplementation(async () => {
      failed = { ...failed, status: "queued", stage: "queued", progress: "等待重试", error: null, warnings: [] };
      return { taskId: failed.taskId };
    });
  function Workbench() {
    const [id, select] = useState<string>();
    return <PendingTasksPage selectedId={id} onSelect={select} />;
  }
  const screen = await render(
    <QueryClientProvider client={client}>
      <Workbench />
    </QueryClientProvider>,
  );
  try {
    await screen.getByRole("button", { name: "字幕与海报", exact: true }).click();
    await expect.element(screen.getByRole("heading", { name: "ABC-001.mp4" })).toBeVisible();
    await expect.element(screen.getByRole("status")).toHaveTextContent("裁剪并生成 poster 角标");
    await expect.element(screen.getByText("排队 48 · 运行 1 · 完成 1 · 失败 1", { exact: true })).toBeVisible();
    await expect.element(screen.getByText("正在等待手动任务完成，结束后自动继续队列。", { exact: true })).toBeVisible();
    await screen.getByRole("button", { name: "下一页", exact: true }).click();
    await expect.element(screen.getByRole("heading", { name: "ABC-003.mp4" })).toBeVisible();
    expect(list).toHaveBeenCalledWith({ offset: 50, limit: 50 });
    await expect.element(screen.getByText("第 2/2 页 · 共 51 条", { exact: true })).toBeVisible();
    await screen.getByRole("button", { name: /ABC-003.mp4/ }).click();
    await expect.element(screen.getByRole("heading", { name: "ABC-003.mp4" })).toBeVisible();
    const clearButton = screen.getByRole("button", { name: "清除已完成记录", exact: true });
    await clearButton.click();
    await expect.element(clearButton).toBeDisabled();
    expect(clearCompleted).toHaveBeenCalledOnce();
    await expect.element(screen.getByText("第 1/1 页 · 共 50 条", { exact: true })).toBeVisible();
    await expect.element(screen.getByRole("heading", { name: "ABC-003.mp4" })).not.toBeInTheDocument();
    await screen.getByRole("button", { name: /ABC-002.mp4/ }).click();
    await expect.element(screen.getByText("Permission denied", { exact: true })).toBeVisible();
    await expect.element(screen.getByText("图片来源不可用", { exact: true })).toBeVisible();
    await screen.getByRole("button", { name: "继续处理", exact: true }).click();
    await expect.element(screen.getByRole("alert")).toHaveTextContent("该影片已有处理任务");
    await screen.getByRole("button", { name: "继续处理", exact: true }).click();
    await expect.element(screen.getByRole("status")).toHaveTextContent("等待重试");
    expect(retry).toHaveBeenLastCalledWith({ id: failed.taskId });
    await expect.element(screen.getByRole("button", { name: "继续处理", exact: true })).not.toBeInTheDocument();
    await screen.getByRole("button", { name: "文件处理", exact: true }).click();
    await expect.element(screen.getByText("暂无处理任务。", { exact: true })).toBeVisible();
  } finally {
    screen.unmount();
    client.clear();
    vi.restoreAllMocks();
  }
});

test("pending selection displays local data immediately, reuses cached diagnostics and locks STRM deletion", async () => {
  const items: PendingItemDto[] = ["ABC-001.strm", "ABC-002.mp4"].map((fileName) => ({
    id: fileName,
    kind: "failed",
    ref: { rootId: "root", relativePath: fileName },
    path: `/media/${fileName}`,
    fileName,
    libraryId: null,
    libraryName: null,
    movieId: null,
    number: null,
    detail: null,
    candidates: [],
    createdAt: "2026-11-11T00:00:00.000Z",
    updatedAt: "2026-11-11T00:00:00.000Z",
  }));
  const diagnostic: PendingDetailResponse = { item: items[0], siteResults: [], numberRecognition: null };
  let resolveDetail!: (value: PendingDetailResponse) => void;
  let rejectDetail!: (error: Error) => void;
  let finishDelete!: () => void;
  const firstDetail = new Promise<PendingDetailResponse>((resolve) => {
    resolveDetail = resolve;
  });
  const secondDetail = new Promise<PendingDetailResponse>((_resolve, reject) => {
    rejectDetail = reject;
  });
  const deletion = new Promise<{ taskId: string }>((resolve) => {
    finishDelete = () => resolve({ taskId: "delete-task" });
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
  const list = vi.spyOn(api.pending, "list").mockResolvedValue({ items });
  const detail = vi
    .spyOn(api.pending, "detail")
    .mockReturnValueOnce(firstDetail)
    .mockReturnValueOnce(secondDetail)
    .mockResolvedValue(diagnostic);
  const remove = vi.spyOn(api.pending, "delete").mockReturnValue(deletion);
  vi.spyOn(api.deletions, "list").mockResolvedValue({ jobs: [] });
  vi.spyOn(api.libraries, "list").mockResolvedValue({ libraries: [] });
  const router = createRouter({
    routeTree: createRootRoute({ component: PendingPage }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const app = (
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
  const screen = await render(app);
  try {
    await expect.element(screen.getByRole("heading", { name: items[0].fileName })).toBeVisible();
    await expect.element(screen.getByText(items[0].path, { exact: true })).toBeVisible();
    await expect.element(screen.getByRole("status")).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "删除", exact: true })).toBeEnabled();
    await expect.element(screen.getByRole("heading", { name: "AI 番号提取" })).not.toBeInTheDocument();
    resolveDetail(diagnostic);
    await expect.element(screen.getByRole("heading", { name: "AI 番号提取" })).toBeVisible();
    await expect.element(screen.getByRole("status")).not.toBeInTheDocument();

    await screen.getByRole("button", { name: /ABC-002.mp4/ }).click();
    await expect.element(screen.getByRole("heading", { name: items[1].fileName })).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "删除", exact: true })).not.toBeInTheDocument();
    await expect.element(screen.getByRole("heading", { name: "AI 番号提取" })).not.toBeInTheDocument();
    await expect.poll(() => detail.mock.calls.length).toBe(2);
    rejectDetail(new Error("Connection lost"));
    await expect.element(screen.getByRole("alert")).toHaveTextContent("Connection lost");
    await expect.element(screen.getByRole("heading", { name: items[1].fileName })).toBeVisible();
    await expect.element(screen.getByRole("status")).not.toBeInTheDocument();

    await screen.getByRole("button", { name: /ABC-001.strm/ }).click();
    await expect.element(screen.getByRole("heading", { name: "AI 番号提取" })).toBeVisible();
    expect(detail).toHaveBeenCalledTimes(2);
    await screen.rerender(<div />);
    await screen.rerender(app);
    await expect.element(screen.getByRole("heading", { name: "AI 番号提取" })).toBeVisible();
    expect(list).toHaveBeenCalledOnce();
    expect(detail).toHaveBeenCalledTimes(2);

    detail.mockResolvedValue({ ...diagnostic, numberRecognition: { status: "skipped", reason: "disabled" } });
    await client.invalidateQueries({ queryKey: queryKeys.pending.all });
    await expect.element(screen.getByText("未执行 AI 提取", { exact: true })).toBeVisible();
    expect(detail).toHaveBeenCalledTimes(3);
    await screen.getByRole("button", { name: "删除", exact: true }).click();
    expect(remove).toHaveBeenCalledExactlyOnceWith({ id: items[0].id });
    await expect.element(screen.getByRole("dialog")).not.toBeInTheDocument();
    await expect.element(screen.getByRole("button", { name: "正在提交…" })).toBeDisabled();
    await expect.element(screen.getByText("正在提交删除任务，执行进度可在工作台查看。")).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "忽略", exact: true })).toBeDisabled();
    list.mockResolvedValue({ items: [] });
    finishDelete();
    await expect.element(screen.getByRole("heading", { name: items[0].fileName })).not.toBeInTheDocument();
    await expect.element(screen.getByRole("button", { name: "删除", exact: true })).not.toBeInTheDocument();
    await expect.element(screen.getByText("正在提交删除任务，执行进度可在工作台查看。")).not.toBeInTheDocument();
  } finally {
    resolveDetail(diagnostic);
    finishDelete();
    screen.unmount();
    client.clear();
    vi.restoreAllMocks();
  }
});

test("new files stay in the workbench until accepted and background actions show live progress and recovery", async () => {
  const item: PendingItemDto = {
    id: "new",
    kind: "new_file",
    ref: { rootId: "root", relativePath: "new.strm" },
    path: "/media/new.strm",
    fileName: "new.strm",
    libraryId: "library",
    libraryName: "Media",
    movieId: null,
    number: null,
    detail: null,
    candidates: [],
    createdAt: "2026-11-11T00:00:00.000Z",
    updatedAt: "2026-11-11T00:00:00.000Z",
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
  const newFiles = vi.spyOn(api.pending, "newFiles").mockResolvedValue({ items: [item] });
  vi.spyOn(api.pending, "detail").mockResolvedValue({ item, siteResults: [], numberRecognition: null });
  vi.spyOn(api.deletions, "list").mockResolvedValue({ jobs: [] });
  vi.spyOn(api.libraries, "list").mockResolvedValue({ libraries: [] });
  let accept!: (result: { taskId: string }) => void;
  const submitted = new Promise<{ taskId: string }>((resolve) => {
    accept = resolve;
  });
  const retry = vi.spyOn(api.pending, "retry").mockReturnValue(submitted);
  const success = vi.spyOn(toast, "success");
  let jobs: PendingActionJob[] = [
    {
      id: "action",
      itemId: item.id,
      action: "confirm",
      item,
      status: "running",
      progress: "正在核验 115 文件",
      error: null,
      attempts: 1,
      nextAttemptAt: null,
      createdAt: 1,
      updatedAt: 2,
      completedAt: null,
      canRetry: false,
    },
  ];
  vi.spyOn(api.pending, "jobs").mockImplementation(async () => ({ jobs }));
  const continueTask = vi.spyOn(api.pending, "retryJob").mockImplementation(async () => {
    jobs = [{ ...jobs[0], id: "resumed", status: "queued", progress: "等待执行", canRetry: false, error: null }];
    return { taskId: "resumed" };
  });
  const select = vi.fn();
  const router = createRouter({
    routeTree: createRootRoute({ component: () => <PendingPage newFiles /> }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const screen = await render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  try {
    await expect.element(screen.getByRole("heading", { name: "待刮削", exact: true })).toBeVisible();
    await screen.getByRole("button", { name: "刮削", exact: true }).click();
    expect(retry).toHaveBeenCalledExactlyOnceWith({ id: item.id, libraryId: "library" });
    await expect.element(screen.getByRole("heading", { name: item.fileName })).toBeVisible();
    newFiles.mockResolvedValue({ items: [] });
    accept({ taskId: "scrape" });
    await expect.element(screen.getByRole("heading", { name: item.fileName })).not.toBeInTheDocument();
    expect(success).toHaveBeenCalledWith("已提交到工作台", {
      action: { label: "查看工作台", onClick: expect.any(Function) },
    });
    await screen.rerender(
      <QueryClientProvider client={client}>
        <PendingTasksPage selectedId="action" onSelect={select} />
      </QueryClientProvider>,
    );
    await expect.element(screen.getByRole("heading", { name: item.fileName })).toBeVisible();
    await expect.element(screen.getByRole("status")).toHaveTextContent("正在核验 115 文件");
    jobs = [
      { ...jobs[0], status: "retrying", progress: "等待自动重试", error: "HTTP 503", nextAttemptAt: Date.now() + 2000 },
    ];
    await client.invalidateQueries({ queryKey: queryKeys.pending.jobs });
    await expect.element(screen.getByRole("status")).toHaveTextContent("等待自动重试");
    await expect.element(screen.getByRole("button", { name: "继续处理" })).not.toBeInTheDocument();
    jobs = [{ ...jobs[0], status: "failed", progress: "需要人工处理", canRetry: true, nextAttemptAt: null }];
    await client.invalidateQueries({ queryKey: queryKeys.pending.jobs });
    await screen.getByRole("button", { name: "继续处理" }).click();
    await expect.poll(() => select.mock.calls).toEqual([["resumed"]]);
    expect(continueTask).toHaveBeenCalledExactlyOnceWith({ id: "action" });
    await expect.element(screen.getByRole("status")).toHaveTextContent("等待执行");
    jobs = [{ ...jobs[0], status: "completed", progress: "处理完成" }];
    await client.invalidateQueries({ queryKey: queryKeys.pending.jobs });
    await expect.element(screen.getByRole("status")).toHaveTextContent("处理完成");
    await expect.element(screen.getByRole("button", { name: "继续处理" })).not.toBeInTheDocument();
  } finally {
    accept({ taskId: "scrape" });
    screen.unmount();
    client.clear();
    vi.restoreAllMocks();
  }
});
