import type { BatchTranslateScanItem } from "@mdcz/shared/toolTypes";
import { getT } from "@mdcz/views/i18n";
import { BatchNfoTranslatorWorkspaceDetail } from "@mdcz/views/tools";
import { expect, test, vi } from "vitest";
import { render } from "vitest-browser-react";

const items: BatchTranslateScanItem[] = ["ABC-001", "ABC-002"].map((number) => ({
  number,
  filePath: `/library/${number}.mp4`,
  nfoPath: `/library/${number}.nfo`,
  directory: "/library",
  title: `当前标题 Alice ${number}`,
  plot: `已经翻译的简介 アリス ${number}\n${"完整的简介内容。".repeat(60)}`,
  pendingFields: ["title", "plot"],
  reason: "content",
}));

test("shows current text and persists individual and bulk manual completion with retryable failures", async () => {
  const t = getT();
  const onApply = vi.fn(async (selected: BatchTranslateScanItem[]) =>
    selected.map((item) => ({
      ...item,
      success: true,
      translatedFields: item.pendingFields,
      savedNfoPath: item.nfoPath,
    })),
  );
  onApply.mockRejectedValueOnce(new Error("Permission denied"));
  const screen = await render(<BatchNfoTranslatorWorkspaceDetail items={items} onApply={onApply} onScan={vi.fn()} />);

  await expect.element(screen.getByRole("columnheader", { name: t.tools.currentTitle })).toBeVisible();
  await expect.element(screen.getByRole("columnheader", { name: t.tools.currentPlot })).toBeVisible();
  await expect.element(screen.getByText(items[0].title, { exact: true })).toBeVisible();
  const plot = screen.getByText(items[0].plot, { exact: true });
  await expect.element(plot).toBeVisible();
  await plot.click();
  expect(plot.element().closest("details")?.open).toBe(true);

  const ignoreFirst = screen.getByRole("button", { name: `${t.tools.ignoreTranslation} ABC-001`, exact: true });
  await ignoreFirst.click();
  await expect.element(screen.getByText("Permission denied", { exact: true })).toBeVisible();
  await expect.element(ignoreFirst).toBeEnabled();
  await expect
    .element(screen.getByRole("button", { name: t.tools.ignoreSelectedTranslations(2), exact: true }))
    .toBeEnabled();
  await ignoreFirst.click();
  expect(onApply).toHaveBeenLastCalledWith([items[0]], 20, "ignore");
  await expect.element(screen.getByText(t.tools.batchTranslateStatus.ignored, { exact: true })).toBeVisible();
  await expect.element(ignoreFirst).toBeDisabled();
  await screen.getByRole("button", { name: t.tools.ignoreSelectedTranslations(1), exact: true }).click();
  expect(onApply).toHaveBeenLastCalledWith([items[1]], 20, "ignore");
  await expect
    .element(screen.getByRole("button", { name: t.tools.ignoreSelectedTranslations(0), exact: true }))
    .toBeDisabled();
  await expect.element(screen.getByRole("button", { name: t.tools.translateSelected(0), exact: true })).toBeDisabled();
  expect(screen.getByText(t.tools.batchTranslateStatus.ignored, { exact: true }).elements()).toHaveLength(2);
});

test("refreshes displayed title and plot after translation and hides ignore actions for restoring", async () => {
  const t = getT();
  const onApply = vi.fn(async (selected: BatchTranslateScanItem[]) =>
    selected.map((item) => ({
      ...item,
      success: true,
      translatedFields: item.pendingFields,
      title: "新的译名",
      plot: "新的译文",
    })),
  );
  const screen = await render(
    <BatchNfoTranslatorWorkspaceDetail items={items.slice(0, 1)} onApply={onApply} onScan={vi.fn()} />,
  );
  await screen.getByRole("button", { name: t.tools.startBatchTranslate, exact: true }).click();
  await expect.element(screen.getByText("新的译名", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("新的译文", { exact: true })).toBeVisible();
  await screen.getByRole("button", { name: `${t.tools.ignoreTranslation} ABC-001`, exact: true }).click();
  await expect.element(screen.getByText(t.tools.batchTranslateStatus.ignored, { exact: true })).toBeVisible();
  await screen.getByRole("button", { name: t.tools.batchTranslateModeOptions.restore, exact: true }).click();
  await screen.getByRole("button", { name: t.tools.scanPendingItems, exact: true }).click();
  expect(
    screen.getByRole("button", { name: `${t.tools.ignoreTranslation} ABC-001`, exact: true }).elements(),
  ).toHaveLength(0);
});

test("selects only the chosen reason for bulk actions and resets the filter on scanning", async () => {
  const t = getT();
  const mixedItems: BatchTranslateScanItem[] = [{ ...items[0], reason: "task_failed" }, items[1]];
  let finishApply: (() => void) | undefined;
  const onApply = vi.fn(async (selected: BatchTranslateScanItem[]) => {
    await new Promise<void>((resolve) => {
      finishApply = resolve;
    });
    return selected.map((item) => ({ ...item, success: true, translatedFields: item.pendingFields }));
  });
  const onScan = vi.fn();
  const screen = await render(
    <BatchNfoTranslatorWorkspaceDetail items={mixedItems} onApply={onApply} onScan={onScan} />,
  );
  const filters = screen.getByRole("group", { name: t.tools.translationReasonFilter });
  const failedFilter = filters.getByRole("button", { name: `${t.tools.translationReasonOptions.task_failed} (1)` });
  const contentFilter = filters.getByRole("button", { name: `${t.tools.translationReasonOptions.content} (1)` });
  await failedFilter.click();
  await expect.element(failedFilter).toHaveAttribute("aria-pressed", "true");
  await expect.element(screen.getByText(items[0].title, { exact: true })).toBeVisible();
  expect(screen.getByText(items[1].title, { exact: true }).elements()).toHaveLength(0);
  const selectAll = screen.getByRole("checkbox").first();
  await selectAll.click();
  await expect.element(screen.getByRole("button", { name: t.tools.translateSelected(0), exact: true })).toBeDisabled();
  await selectAll.click();
  await screen.getByRole("button", { name: t.tools.translateSelected(1), exact: true }).click();
  expect(onApply).toHaveBeenLastCalledWith([mixedItems[0]], 20, "untranslated");
  await expect.element(contentFilter).toBeDisabled();
  finishApply?.();
  await expect.element(contentFilter).toBeEnabled();

  await contentFilter.click();
  expect(screen.getByText(items[0].title, { exact: true }).elements()).toHaveLength(0);
  await screen.getByRole("button", { name: t.tools.ignoreSelectedTranslations(1), exact: true }).click();
  expect(onApply).toHaveBeenLastCalledWith([mixedItems[1]], 20, "ignore");
  finishApply?.();
  await expect
    .element(filters.getByRole("button", { name: `${t.tools.translationReasonOptions.content} (0)` }))
    .toBeEnabled();
  await expect
    .element(screen.getByRole("button", { name: t.tools.ignoreSelectedTranslations(0), exact: true }))
    .toBeDisabled();
  await filters.getByRole("button", { name: `${t.tools.translationReasonOptions.all} (1)` }).click();
  await expect.element(screen.getByRole("button", { name: t.tools.translateSelected(1), exact: true })).toBeEnabled();
  await failedFilter.click();
  await screen.getByRole("button", { name: t.tools.scanPendingItems, exact: true }).click();
  expect(onScan).toHaveBeenCalledWith(expect.any(String), "untranslated");
  await expect
    .element(filters.getByRole("button", { name: `${t.tools.translationReasonOptions.all} (1)` }))
    .toHaveAttribute("aria-pressed", "true");

  const contentItems = Array.from({ length: 301 }, (_, index) => ({
    ...items[1],
    filePath: `/library/content-${index}.mp4`,
  }));
  await screen.rerender(<BatchNfoTranslatorWorkspaceDetail items={contentItems} onApply={onApply} onScan={onScan} />);
  await filters.getByRole("button", { name: `${t.tools.translationReasonOptions.task_failed} (0)` }).click();
  await expect.element(screen.getByText(t.tools.noMatchingTranslationReason, { exact: true })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: t.tools.translateSelected(0), exact: true })).toBeDisabled();
  await screen.rerender(
    <BatchNfoTranslatorWorkspaceDetail items={[...contentItems, mixedItems[0]]} onApply={onApply} onScan={onScan} />,
  );
  await expect
    .element(filters.getByRole("button", { name: `${t.tools.translationReasonOptions.all} (302)` }))
    .toHaveAttribute("aria-pressed", "true");
  await failedFilter.click();
  await expect.element(screen.getByText(items[0].title, { exact: true })).toBeVisible();
  await screen.getByRole("button", { name: t.tools.translateSelected(1), exact: true }).click();
  expect(onApply).toHaveBeenLastCalledWith([mixedItems[0]], 20, "untranslated");
  finishApply?.();
  await expect.element(failedFilter).toBeEnabled();
});
