import type { DeletionJob } from "@mdcz/shared/deletions";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { expect, test, vi } from "vitest";
import { render } from "vitest-browser-react";
import { api } from "./client";
import { DeletionTasksPage } from "./deletionTasks";
import { queryKeys } from "./lib/queryKeys";

test("deletion actions follow persisted progress, recover stalled requests and refresh cleared selections", async () => {
  const pending: DeletionJob = {
    id: "emby/pending",
    source: "emby",
    status: "pending",
    step: "validating",
    name: "Pending movie",
    libraryName: "Movies",
    linkPath: null,
    sourcePaths: [],
    cloudPath: null,
    cloudFileId: null,
    cloudSize: null,
    cloudDeleted: false,
    cloudPlanned: false,
    sharedResource: false,
    error: null,
    result: null,
    attempts: 0,
    nextAttemptAt: null,
    createdAt: 1,
    updatedAt: 1,
    completedAt: null,
    canRetry: false,
    retryRunId: null,
    retryPlanned: false,
  };
  const completed: DeletionJob = { ...pending, id: "emby/completed", name: "Finished movie", status: "completed" };
  let jobs = [pending, completed];
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  vi.spyOn(api.deletions, "list").mockImplementation(async () => ({ jobs }));
  vi.spyOn(api.deletions, "detail").mockImplementation(async ({ id }) => {
    const selected = jobs.find((job) => job.id === id);
    if (!selected) throw new Error("未找到删除任务");
    return selected;
  });
  const clear = vi
    .spyOn(api.deletions, "clearCompleted")
    .mockRejectedValueOnce(new Error("Clear failed"))
    .mockImplementation(async () => {
      jobs = jobs.filter((job) => job.status !== "completed");
      return { cleared: 1 };
    });
  const error = vi.spyOn(toast, "error");
  const success = vi.spyOn(toast, "success");
  let finishFirst!: (value: { runId: null }) => void;
  let finishSecond!: (value: { runId: null }) => void;
  const first = new Promise<{ runId: null }>((resolve) => {
    finishFirst = resolve;
  });
  const second = new Promise<{ runId: null }>((resolve) => {
    finishSecond = resolve;
  });
  const retry = vi.spyOn(api.deletions, "retry").mockReturnValueOnce(first).mockReturnValueOnce(second);
  function Workbench() {
    const [selectedId, onSelect] = useState<string | undefined>(completed.id);
    return <DeletionTasksPage selectedId={selectedId} onSelect={onSelect} />;
  }
  const routeTree = createRootRoute({ component: Workbench });
  const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: ["/"] }) });
  const screen = await render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  try {
    await expect.element(screen.getByRole("heading", { name: completed.name })).toBeVisible();
    await screen.getByRole("button", { name: "清除已结束记录" }).click();
    await expect.poll(() => error.mock.calls).toEqual([["Clear failed"]]);
    await expect.element(screen.getByRole("button", { name: /Finished movie/ })).toBeVisible();
    await screen.getByRole("button", { name: "清除已结束记录" }).click();
    await expect.element(screen.getByRole("heading", { name: pending.name })).toBeVisible();
    await expect.element(screen.getByRole("button", { name: /Finished movie/ })).not.toBeInTheDocument();
    await expect.element(screen.getByRole("button", { name: "清除已结束记录" })).toBeDisabled();
    await expect.element(screen.getByRole("alert")).not.toBeInTheDocument();
    expect(clear).toHaveBeenCalledTimes(2);
    expect(success).toHaveBeenCalledExactlyOnceWith("已清除已结束记录");
    jobs = [
      {
        ...pending,
        source: "duplicate",
        status: "needs_review",
        step: "verifying_cloud",
        cloudPlanned: true,
        cloudDeleted: true,
        canRetry: true,
        updatedAt: 2,
        error: "目录核验失败",
      },
    ];
    await client.invalidateQueries({ queryKey: queryKeys.deletions.all });
    const resume = screen.getByRole("button", { name: "继续已确认的删除" });
    await resume.click();
    await expect.element(screen.getByRole("button", { name: "加载中…" })).toBeDisabled();
    jobs = [{ ...jobs[0], status: "running", canRetry: false, updatedAt: 3, error: null }];
    await client.invalidateQueries({ queryKey: queryKeys.deletions.all });
    await expect.element(resume).not.toBeInTheDocument();
    jobs = [{ ...jobs[0], status: "needs_review", canRetry: true, updatedAt: 4, error: "完整目录仍不可核验" }];
    await client.invalidateQueries({ queryKey: queryKeys.deletions.all });
    await expect.element(resume).toBeEnabled();
    await expect.element(screen.getByRole("alert")).toHaveTextContent("完整目录仍不可核验");
    await resume.click();
    expect(retry).toHaveBeenCalledTimes(2);
    finishFirst({ runId: null });
    await expect.poll(() => success.mock.calls.length).toBe(2);
    await expect.element(screen.getByRole("button", { name: "加载中…" })).toBeDisabled();
    finishSecond({ runId: null });
    await expect.element(resume).toBeEnabled();
    jobs = [{ ...pending, status: "completed" }];
    await client.invalidateQueries({ queryKey: queryKeys.deletions.all });
    await screen.getByRole("button", { name: "清除已结束记录" }).click();
    await expect.element(screen.getByText("暂无删除任务")).toBeVisible();
    await expect.element(screen.getByText("选择影片，查看联动删除流程")).toBeVisible();
    await expect.element(screen.getByRole("alert")).not.toBeInTheDocument();
  } finally {
    finishFirst({ runId: null });
    finishSecond({ runId: null });
    screen.unmount();
    client.clear();
    vi.restoreAllMocks();
  }
});
