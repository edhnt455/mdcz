import type { PendingActionJob, PendingDetailResponse, PendingItemDto } from "@mdcz/shared/pending";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { toast } from "sonner";
import { expect, test, vi } from "vitest";
import { render } from "vitest-browser-react";
import { api } from "./client";
import { queryKeys } from "./lib/queryKeys";
import { PendingTasksPage } from "./pendingTasks";
import { PendingPage } from "./routes/pending";

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
      action: "delete",
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
