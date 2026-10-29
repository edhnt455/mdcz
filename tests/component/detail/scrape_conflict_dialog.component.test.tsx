import { type ScrapeConflictPreview, scrapeConflictSetupErrors } from "@mdcz/shared/scrapeConflict";
import type { DetailActionPort } from "@mdcz/views/adapters/ports";
import { ScrapeConflictDialog } from "@mdcz/views/scrape/ScrapeConflictDialog";
import { expect, test, vi } from "vitest";
import { render } from "vitest-browser-react";

const preview: ScrapeConflictPreview = {
  token: "verified-preview",
  sameResource: false,
  keep: null,
  step: null,
  existing: {
    name: "original.mp4",
    size: 1024 ** 3,
    cloudPath: "/AV/original.mp4",
    normalPath: "/Normal/original.strm",
    linkPath: "/Link/ABC-123.strm",
  },
  incoming: {
    name: "restored.mp4",
    size: 2 * 1024 ** 3,
    cloudPath: "/AV/restored.mp4",
    normalPath: "/Normal/restored.strm",
    linkPath: null,
  },
};
const input = { taskId: "task", itemId: "item" };

test.each(["existing", "incoming"] as const)("shows actual source sizes and explicitly keeps %s", async (keep) => {
  const previewConflict = vi
    .fn()
    .mockRejectedValueOnce(new Error(scrapeConflictSetupErrors.moviePilotRequired))
    .mockResolvedValue(preview);
  const resolveConflict = vi.fn(async () => undefined);
  const port = { previewConflict, resolveConflict } as unknown as DetailActionPort;
  const screen = await render(<ScrapeConflictDialog input={input} port={port} />);
  await screen.getByRole("button", { name: "处理重复" }).click();
  await expect.element(screen.getByRole("alert")).toHaveTextContent("尚未配置 MoviePilot");
  await expect
    .element(screen.getByRole("link", { name: "在新标签页打开 STRM 联动设置" }))
    .toHaveAttribute("href", "/settings?section=mediaServer");
  await expect
    .element(screen.getByRole("link", { name: "在新标签页打开 STRM 联动设置" }))
    .toHaveAttribute("target", "_blank");
  await screen.getByRole("button", { name: "重试" }).click();
  await expect.element(screen.getByText("1.00 GB", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("2.00 GB", { exact: true })).toBeVisible();
  const confirm = screen.getByRole("button", { name: "删除另一版本并继续" });
  await expect.element(confirm).toBeDisabled();
  await screen.getByRole("radio", { name: keep === "existing" ? "保留已入库版本" : "保留本次新版本" }).click();
  await expect
    .element(
      screen.getByText(
        keep === "existing"
          ? "删除它对应的 Normal STRM，保留现有 Link STRM。"
          : "删除它对应的 Normal 和 Link STRM，再重试本次新版本的刮削。",
        { exact: true },
      ),
    )
    .toBeVisible();
  await confirm.click();
  expect(resolveConflict).toHaveBeenCalledExactlyOnceWith({ ...input, keep, token: preview.token });
  await expect.element(screen.getByText("重复已处理。")).toBeVisible();
});

test("keeps errors visible and permits resuming the same deletion", async () => {
  const resolveConflict = vi.fn().mockRejectedValueOnce(new Error("115 unavailable")).mockResolvedValueOnce(undefined);
  const port = {
    previewConflict: vi.fn(async () => ({ ...preview, sameResource: true })),
    resolveConflict,
  } as unknown as DetailActionPort;
  const screen = await render(<ScrapeConflictDialog input={input} port={port} />);
  await screen.getByRole("button", { name: "处理重复" }).click();
  await expect
    .element(screen.getByText("两个 STRM 指向同一个 115 视频，将保留云端视频，只清理多余的本地 STRM。"))
    .toBeVisible();
  await screen.getByRole("radio", { name: "保留本次新版本" }).click();
  await screen.getByRole("button", { name: "删除另一版本并继续" }).click();
  await expect.element(screen.getByRole("alert")).toHaveTextContent("115 unavailable");
  await screen.getByRole("button", { name: "删除另一版本并继续" }).click();
  await expect.element(screen.getByText("重复已处理。")).toBeVisible();
  expect(resolveConflict).toHaveBeenCalledTimes(2);
});
