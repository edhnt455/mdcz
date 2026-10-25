import type { PendingBatchResponse, PendingItemDto } from "@mdcz/shared/pending";
import { ConfirmDialogHost } from "@mdcz/views/common";
import { PendingView, type PendingViewProps } from "@mdcz/views/pending";
import { expect, test, vi } from "vitest";
import { render } from "vitest-browser-react";

const items: PendingItemDto[] = ["ABC-001", "ABC-002"].map((id) => ({
  id,
  kind: "failed",
  ref: { rootId: "root", relativePath: `${id}.mp4` },
  path: `/media/${id}.mp4`,
  fileName: `${id}.mp4`,
  libraryId: "library",
  libraryName: "媒体库",
  movieId: null,
  number: id,
  detail: null,
  candidates: [],
  createdAt: "2026-10-25T00:00:00.000Z",
  updatedAt: "2026-10-25T00:00:00.000Z",
}));

const props: Omit<PendingViewProps, "onBatch"> = {
  items,
  selectedId: items[0].id,
  onSelect: vi.fn(),
  libraries: [],
  onRetry: vi.fn(),
  onIgnore: vi.fn(),
  onConfirmUncensored: vi.fn(),
};

test("batch selection supports select all, locks while processing and retains only failed selections", async () => {
  let settle!: (result: PendingBatchResponse) => void;
  const onBatch = vi.fn(
    () =>
      new Promise<PendingBatchResponse>((resolve) => {
        settle = resolve;
      }),
  );
  const screen = await render(<PendingView {...props} onBatch={onBatch} />);
  const process = screen.getByRole("button", { name: "批量处理" });
  await expect.element(process).toBeDisabled();
  await screen.getByRole("checkbox", { name: "选择 ABC-001.mp4" }).click();
  await expect.element(screen.getByRole("checkbox", { name: "全选" })).toHaveAttribute("aria-checked", "mixed");
  await screen.getByRole("checkbox", { name: "全选" }).click();
  await expect.element(screen.getByText("已选 2 项")).toBeVisible();
  await process.click();
  expect(onBatch).toHaveBeenCalledExactlyOnceWith({ action: "retry", ids: ["ABC-001", "ABC-002"] });
  await expect.element(process).toBeDisabled();
  await expect.element(screen.getByRole("button", { name: "批量忽略" })).toBeDisabled();
  settle({ succeededIds: ["ABC-001"], failures: [{ id: "ABC-002", message: "Library unavailable" }] });
  await expect.element(screen.getByText("成功 1 项 · 失败 1 项")).toBeVisible();
  await expect.element(screen.getByText("ABC-002.mp4: Library unavailable")).toBeVisible();
  await expect.element(screen.getByRole("checkbox", { name: "选择 ABC-001.mp4" })).not.toBeChecked();
  await expect.element(screen.getByRole("checkbox", { name: "选择 ABC-002.mp4" })).toBeChecked();
  await screen.rerender(<PendingView {...props} items={[items[0]]} onBatch={onBatch} />);
  await expect.element(screen.getByText("已选 0 项")).toBeVisible();
  await expect.element(process).toBeDisabled();
});

test("batch ignore requires confirmation and preserves selections after cancellation or request failure", async () => {
  const onBatch = vi
    .fn()
    .mockRejectedValueOnce(new Error("Connection lost"))
    .mockResolvedValue({ succeededIds: ["ABC-001"], failures: [] });
  const screen = await render(
    <>
      <PendingView {...props} onBatch={onBatch} />
      <ConfirmDialogHost />
    </>,
  );
  const ignore = screen.getByRole("button", { name: "批量忽略", exact: true });
  await screen.getByRole("checkbox", { name: "选择 ABC-001.mp4" }).click();
  await ignore.click();
  let dialog = screen.getByRole("dialog", { name: "忽略选中的 1 个文件？" });
  await expect.element(dialog.getByText("仅从待处理列表移除所选条目，文件本身保持不变。")).toBeVisible();
  await dialog.getByRole("button", { name: "取消" }).click();
  expect(onBatch).not.toHaveBeenCalled();
  await ignore.click();
  dialog = screen.getByRole("dialog", { name: "忽略选中的 1 个文件？" });
  await dialog.getByRole("button", { name: "批量忽略" }).click();
  await expect.element(screen.getByRole("alert")).toHaveTextContent("Connection lost");
  await expect.element(screen.getByText("已选 1 项")).toBeVisible();
  await ignore.click();
  await screen.getByRole("dialog").getByRole("button", { name: "批量忽略" }).click();
  expect(onBatch).toHaveBeenLastCalledWith({ action: "ignore", ids: ["ABC-001"] });
  await expect.element(screen.getByText("已选 0 项")).toBeVisible();
});
