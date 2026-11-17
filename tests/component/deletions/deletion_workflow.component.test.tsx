import type { DeletionJob } from "@mdcz/shared/deletions";
import { DeletionWorkbenchView } from "@mdcz/views/deletions";
import { useState } from "react";
import { expect, test, vi } from "vitest";
import { render } from "vitest-browser-react";

const job = (overrides: Partial<DeletionJob> = {}): DeletionJob => ({
  id: "emby/blocked",
  source: "emby",
  status: "needs_review",
  step: "validating",
  name: "DPMI-080",
  libraryName: "AV",
  linkPath: "/AV/Link/DPMI-080.strm",
  sourcePaths: ["/AV/Normal/DPMI-080.strm"],
  cloudPath: "/AV/DPMI-080.mp4",
  cloudFileId: "3547706619045348516",
  cloudSize: 1024 ** 3,
  cloudDeleted: false,
  cloudPlanned: true,
  sharedResource: false,
  error: "当前影片的 Normal 来源无法核验",
  result: null,
  attempts: 8,
  nextAttemptAt: null,
  createdAt: 1793200000000,
  updatedAt: 1793200001000,
  completedAt: null,
  canRetry: true,
  retryRunId: null,
  retryPlanned: false,
  ...overrides,
});
const completed = job({
  id: "emby/completed",
  name: "IPZZ-934",
  status: "completed",
  step: "completed",
  error: null,
  cloudDeleted: true,
  canRetry: false,
});

test("manual cleanup confirms the selected library record and shows its result", async () => {
  const manual = vi.fn().mockResolvedValue(true);
  const failed = job({ id: "action/failed", source: "library", cloudPlanned: false, progress: "需要人工处理" });
  const props = {
    jobs: [failed],
    selected: failed,
    filter: "all" as const,
    onFilterChange: vi.fn(),
    onSelect: vi.fn(),
    onRetry: vi.fn(),
    onRefresh: vi.fn(),
    onClearCompleted: vi.fn(),
    onOpenScrape: vi.fn(),
    onManual: manual,
  };
  const screen = await render(<DeletionWorkbenchView {...props} />);
  await screen.getByRole("button", { name: "人工清理记录" }).click();
  await expect.element(screen.getByRole("dialog")).toHaveTextContent("不会删除本地或 115 文件");
  await expect.element(screen.getByRole("dialog")).toHaveTextContent(failed.linkPath ?? "");
  await screen.getByRole("button", { name: "确认清理记录" }).click();
  await expect.poll(() => manual.mock.calls).toEqual([["action/failed"]]);
  const handled = {
    ...failed,
    status: "completed" as const,
    step: "completed" as const,
    error: null,
    result: "manual_cleanup",
    progress: undefined,
  };
  await screen.rerender(<DeletionWorkbenchView {...props} jobs={[handled]} selected={handled} />);
  await expect.element(screen.getByRole("button", { name: /DPMI-080/ })).toHaveTextContent("已人工处理");
  await expect.element(screen.getByRole("button", { name: "人工清理记录" })).not.toBeInTheDocument();
});

test("workbench displays live progress for library deletion", async () => {
  const running = job({ source: "library", status: "running", progress: "正在删除文件", error: null, canRetry: false });
  const screen = await render(
    <DeletionWorkbenchView
      jobs={[running]}
      selected={running}
      filter="all"
      onFilterChange={vi.fn()}
      onSelect={vi.fn()}
      onRetry={vi.fn()}
      onRefresh={vi.fn()}
      onClearCompleted={vi.fn()}
      onOpenScrape={vi.fn()}
    />,
  );
  await expect.element(screen.getByRole("status")).toHaveTextContent("正在删除文件");
  await expect.element(screen.getByText("媒体库删除", { exact: false }).last()).toBeVisible();
  await expect.element(screen.getByText("核验当前影片", { exact: true })).not.toBeInTheDocument();
});

test("workbench isolates movie errors, shows persisted steps and retries only the selected movie", async () => {
  const onRetry = vi.fn();
  function Workbench() {
    const jobs = [job(), completed];
    const [selected, setSelected] = useState(jobs[0]);
    const [filter, setFilter] = useState<"all" | "unfinished" | "completed">("all");
    return (
      <DeletionWorkbenchView
        jobs={jobs}
        selected={selected}
        filter={filter}
        onFilterChange={setFilter}
        onSelect={(id) => setSelected(jobs.find((item) => item.id === id) ?? jobs[0])}
        onRetry={onRetry}
        onRefresh={vi.fn()}
        onClearCompleted={vi.fn()}
        onOpenScrape={vi.fn()}
      />
    );
  }
  const screen = await render(<Workbench />);
  await expect.element(screen.getByRole("alert")).toHaveTextContent("当前影片的 Normal 来源无法核验");
  await expect.element(screen.getByText("核验当前影片", { exact: true }).last()).toBeVisible();
  await expect.element(screen.getByText("/AV/Normal/DPMI-080.strm", { exact: true })).toBeVisible();
  await screen.getByRole("button", { name: "重试未完成步骤" }).click();
  expect(onRetry).toHaveBeenCalledExactlyOnceWith("emby/blocked");
  await screen.getByRole("button", { name: /IPZZ-934/ }).click();
  await expect.element(screen.getByRole("heading", { name: "IPZZ-934" })).toBeVisible();
  await expect.element(screen.getByRole("alert")).not.toBeInTheDocument();
  await expect.element(screen.getByText("115 已返回删除成功")).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "重试未完成步骤" })).not.toBeInTheDocument();
  await screen.getByRole("button", { name: "未完成", exact: true }).click();
  await expect.element(screen.getByRole("button", { name: /IPZZ-934/ })).not.toBeInTheDocument();
  await expect.element(screen.getByRole("button", { name: /DPMI-080/ })).toBeVisible();
  const local = job({ cloudPlanned: false, cloudPath: null, sourcePaths: [], error: null });
  await screen.rerender(
    <DeletionWorkbenchView
      jobs={[local]}
      selected={local}
      filter="all"
      onFilterChange={vi.fn()}
      onSelect={vi.fn()}
      onRetry={onRetry}
      onRefresh={vi.fn()}
      onClearCompleted={vi.fn()}
      onOpenScrape={vi.fn()}
    />,
  );
  await expect.element(screen.getByText("媒体库文件", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("删除 115 源视频", { exact: true })).not.toBeInTheDocument();
  await expect.element(screen.getByText("清理影片记录", { exact: true })).toBeVisible();
});

test("workbench clears finished records regardless of the filter and disables clearing while busy or empty", async () => {
  const onClearCompleted = vi.fn();
  const props = {
    jobs: [job(), completed, job({ id: "emby/ignored", status: "ignored", name: "Observed" })],
    selected: null,
    filter: "all" as const,
    onFilterChange: vi.fn(),
    onSelect: vi.fn(),
    onRetry: vi.fn(),
    onRefresh: vi.fn(),
    onOpenScrape: vi.fn(),
    onClearCompleted,
  };
  const screen = await render(<DeletionWorkbenchView {...props} />);
  const clear = screen.getByRole("button", { name: "清除已结束记录" });
  await expect.element(clear).toBeEnabled();
  await screen.getByRole("button", { name: "未完成", exact: true }).click();
  await clear.click();
  expect(onClearCompleted).toHaveBeenCalledOnce();
  await screen.rerender(<DeletionWorkbenchView {...props} clearing />);
  await expect.element(clear).toBeDisabled();
  await screen.rerender(<DeletionWorkbenchView {...props} jobs={[job()]} />);
  await expect.element(clear).toBeDisabled();
  await expect.element(screen.getByRole("button", { name: /DPMI-080/ })).toBeVisible();
  await screen.rerender(<DeletionWorkbenchView {...props} jobs={[]} />);
  await expect.element(clear).toBeDisabled();
  await expect.element(screen.getByText("暂无删除任务")).toBeVisible();
});
