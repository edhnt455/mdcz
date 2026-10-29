import type { DeletionJob } from "@mdcz/shared/deletions";
import { DeletionQueueView, DeletionWorkbenchView } from "@mdcz/views/deletions";
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

test("pending shows only unfinished movies and opens their own workflow", async () => {
  const onOpen = vi.fn();
  const screen = await render(<DeletionQueueView jobs={[job(), completed]} onOpen={onOpen} />);
  await expect.element(screen.getByRole("heading", { name: "待处理的删除任务 · 1" })).toBeVisible();
  await expect.element(screen.getByText("IPZZ-934")).not.toBeInTheDocument();
  await expect.element(screen.getByText("当前影片的 Normal 来源无法核验")).toBeVisible();
  await screen.getByRole("button", { name: "查看删除流程" }).click();
  expect(onOpen).toHaveBeenCalledExactlyOnceWith("emby/blocked");
});

test("workbench isolates movie errors, shows persisted steps and retries only the selected movie", async () => {
  const onRetry = vi.fn();
  function Workbench() {
    const jobs = [job(), completed];
    const [selected, setSelected] = useState(jobs[0]);
    return (
      <DeletionWorkbenchView
        jobs={jobs}
        selected={selected}
        onSelect={(id) => setSelected(jobs.find((item) => item.id === id) ?? jobs[0])}
        onRetry={onRetry}
        onRefresh={vi.fn()}
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
      onSelect={vi.fn()}
      onRetry={onRetry}
      onRefresh={vi.fn()}
      onOpenScrape={vi.fn()}
    />,
  );
  await expect.element(screen.getByText("媒体库文件", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("删除 115 源视频", { exact: true })).not.toBeInTheDocument();
  await expect.element(screen.getByText("清理影片记录", { exact: true })).toBeVisible();
});
