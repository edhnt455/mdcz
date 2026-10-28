import type { NumberRecognitionResult, PendingBatchResponse, PendingItemDto } from "@mdcz/shared/pending";
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
  onRetryNumberRecognition: vi.fn(),
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

test("pending details show AI outcomes, inputs, rejected output and missing or skipped diagnostics", async () => {
  const screen = await render(
    <PendingView {...props} onBatch={vi.fn()} detail={{ item: items[0], siteResults: [], numberRecognition: null }} />,
  );
  await expect.element(screen.getByRole("heading", { name: "AI 番号提取" })).toBeVisible();
  await expect.element(screen.getByText("此条目未保存提取诊断，重试后可查看本次执行结果。")).toBeVisible();
  const attempt: NumberRecognitionResult = {
    status: "recognized",
    fileName: "www.98T.la@IPZZ-802DIGITALCHANNEL.strm",
    parentDirectory: "Normal",
    previousNumber: "IPZZ-802D",
    number: "IPZZ-802",
    evidence: "IPZZ-802",
    model: "test-model",
    elapsedMs: 1250,
    rawResponse: '{"number":"IPZZ-802","evidence":"IPZZ-802"}',
    error: null,
    prompt: "Extract a code from fileName",
    systemPrompt: "Shared instructions",
  };
  for (const [status, message] of [
    ["recognized", "AI 已提取到有效番号"],
    ["unchanged", "AI 返回原番号"],
    ["no_number", "AI 未提取到番号"],
    ["failed", "AI 调用或返回校验失败，未采用结果"],
  ] as const) {
    await screen.rerender(
      <PendingView
        {...props}
        onBatch={vi.fn()}
        detail={{
          item: items[0],
          siteResults: [],
          numberRecognition: {
            ...attempt,
            status,
            number: status === "no_number" ? null : status === "unchanged" ? attempt.previousNumber : attempt.number,
            evidence: status === "no_number" ? null : attempt.evidence,
            error: status === "failed" ? "Invalid source evidence" : null,
          },
        }}
      />,
    );
    await expect.element(screen.getByText(message, { exact: true })).toBeVisible();
  }
  await expect.element(screen.getByText("Invalid source evidence")).toBeVisible();
  await expect.element(screen.getByText(attempt.fileName, { exact: true })).toBeVisible();
  await expect.element(screen.getByText("1.3s", { exact: true })).toBeVisible();
  await screen.getByText("AI 原始响应", { exact: true }).click();
  await expect.element(screen.getByText(attempt.rawResponse ?? "", { exact: true })).toBeVisible();
  await screen.getByText("查看请求提示词", { exact: true }).click();
  await expect.element(screen.getByText(attempt.prompt, { exact: true })).toBeVisible();
  await expect.element(screen.getByText(attempt.systemPrompt, { exact: true })).toBeVisible();
  await screen.rerender(
    <PendingView
      {...props}
      onBatch={vi.fn()}
      detail={{
        item: items[0],
        siteResults: [],
        numberRecognition: { status: "skipped", reason: "manual_number" },
      }}
    />,
  );
  await expect.element(screen.getByText("未执行 AI 提取", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("已手动指定番号或命中已保存的番号映射规则。")).toBeVisible();
  await expect.element(screen.getByText("AI 原始响应", { exact: true })).not.toBeInTheDocument();
});

test("AI extraction retry locks actions while running, shows errors and supports another attempt without a library", async () => {
  let rejectRequest!: (error: Error) => void;
  const onRetryNumberRecognition = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectRequest = reject;
        }),
    )
    .mockResolvedValue(undefined);
  const onRetry = vi.fn();
  const detail = { item: { ...items[0], libraryId: null }, siteResults: [], numberRecognition: null };
  const screen = await render(
    <PendingView
      {...props}
      onRetry={onRetry}
      onRetryNumberRecognition={onRetryNumberRecognition}
      onBatch={vi.fn()}
      detail={detail}
    />,
  );
  const retry = screen.getByRole("button", { name: "重试 AI 番号提取", exact: true });
  await expect.element(retry).toBeEnabled();
  await retry.click();
  expect(onRetryNumberRecognition).toHaveBeenCalledExactlyOnceWith(items[0].id);
  await expect.element(screen.getByRole("button", { name: "正在提取…", exact: true })).toBeDisabled();
  await expect.element(screen.getByRole("button", { name: "忽略", exact: true })).toBeDisabled();
  rejectRequest(new Error("Connection lost"));
  await expect.element(screen.getByRole("alert")).toHaveTextContent("Connection lost");
  await expect.element(retry).toBeEnabled();
  await retry.click();
  await expect.element(retry).toBeEnabled();
  expect(onRetryNumberRecognition).toHaveBeenCalledTimes(2);
  await expect.element(screen.getByRole("alert")).not.toBeInTheDocument();
  expect(onRetry).not.toHaveBeenCalled();
  await screen.rerender(
    <PendingView {...props} onBatch={vi.fn()} detail={{ ...detail, item: { ...detail.item, kind: "uncensored" } }} />,
  );
  await expect.element(retry).not.toBeInTheDocument();
});
