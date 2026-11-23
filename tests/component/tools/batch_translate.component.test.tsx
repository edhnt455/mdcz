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

const library = { id: "main", name: "Main", placement: "move", outputPath: "/library" } as const;

test("defaults to the first configured output and clears scanned items when the library changes", async () => {
  const t = getT();
  const inPlace = { id: "in-place", name: "In place", placement: "inPlace", outputPath: "" } as const;
  const other = { ...library, id: "other", name: "Other", outputPath: "/other" };
  const onApply = vi.fn(async () => []);
  const onScan = vi.fn(async () => items);
  const screen = await render(
    <BatchNfoTranslatorWorkspaceDetail libraries={[inPlace, library]} onApply={onApply} onScan={onScan} />,
  );
  const picker = screen.getByRole("combobox", { name: t.tools.targetDirectory });
  const scan = screen.getByRole("button", { name: t.tools.scanPendingItems, exact: true });
  await expect.element(picker).toHaveValue(library.id);
  expect(picker.getByRole("option").elements()).toHaveLength(1);

  await screen.rerender(
    <BatchNfoTranslatorWorkspaceDetail libraries={[inPlace, library, other]} onApply={onApply} onScan={onScan} />,
  );
  await expect.element(picker).toHaveValue(library.id);
  await expect.element(picker.getByRole("option", { name: "Other · /other" })).toBeInTheDocument();
  await scan.click();
  expect(onScan).toHaveBeenLastCalledWith(library.outputPath, "untranslated");
  await expect.element(screen.getByText(items[0].title, { exact: true })).toBeVisible();
  await picker.selectOptions(other.id);
  await expect.element(screen.getByText(items[0].title, { exact: true })).not.toBeInTheDocument();
  await expect.element(screen.getByRole("button", { name: t.tools.startBatchTranslate, exact: true })).toBeDisabled();
  onScan.mockResolvedValueOnce([]);
  await scan.click();
  expect(onScan).toHaveBeenLastCalledWith(other.outputPath, "untranslated");
});

test("accepts a manual directory when no configured output is eligible", async () => {
  const t = getT();
  const onScan = vi.fn(async () => []);
  const storedKey = "mdcz:tool:batch-translate-dir";
  const storedPath = localStorage.getItem(storedKey);
  try {
    localStorage.removeItem(storedKey);
    const screen = await render(
      <BatchNfoTranslatorWorkspaceDetail
        libraries={[{ ...library, placement: "inPlace", outputPath: "" }]}
        onApply={vi.fn(async () => [])}
        onScan={onScan}
      />,
    );
    const directory = screen.getByRole("textbox", { name: t.tools.targetDirectory });
    const scan = screen.getByRole("button", { name: t.tools.scanPendingItems, exact: true });
    await expect.element(scan).toBeDisabled();
    await directory.fill("  /manual  ");
    await scan.click();
    expect(onScan).toHaveBeenCalledWith("/manual", "untranslated");
  } finally {
    if (storedPath === null) localStorage.removeItem(storedKey);
    else localStorage.setItem(storedKey, storedPath);
  }
});

test("shows current text and persists individual and bulk manual completion with retryable failures", async () => {
  const t = getT();
  const onApply = vi.fn(async (selected: BatchTranslateScanItem[]) =>
    selected.map((item) => ({
      ...item,
      success: true,
      translatedFields: item.pendingFields,
    })),
  );
  onApply.mockRejectedValueOnce(new Error("Permission denied"));
  const screen = await render(
    <BatchNfoTranslatorWorkspaceDetail libraries={[library]} onApply={onApply} onScan={async () => items} />,
  );
  await screen.getByRole("button", { name: t.tools.scanPendingItems, exact: true }).click();

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
    <BatchNfoTranslatorWorkspaceDetail
      libraries={[library]}
      onApply={onApply}
      onScan={async () => items.slice(0, 1)}
    />,
  );
  await screen.getByRole("button", { name: t.tools.scanPendingItems, exact: true }).click();
  await screen.getByRole("button", { name: t.tools.startBatchTranslate, exact: true }).click();
  await expect.element(screen.getByText("新的译名", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("新的译文", { exact: true })).toBeVisible();
  await screen.getByRole("button", { name: `${t.tools.ignoreTranslation} ABC-001`, exact: true }).click();
  await expect.element(screen.getByText(t.tools.batchTranslateStatus.ignored, { exact: true })).toBeVisible();
  await screen.getByRole("button", { name: t.tools.batchTranslateModeOptions.restore, exact: true }).click();
  await screen.getByRole("button", { name: t.tools.scanPendingItems, exact: true }).click();
  await expect.element(screen.getByText(items[0].title, { exact: true })).toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: `${t.tools.ignoreTranslation} ABC-001`, exact: true }))
    .not.toBeInTheDocument();
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
  const onScan = vi.fn(async () => mixedItems);
  const screen = await render(
    <BatchNfoTranslatorWorkspaceDetail libraries={[library]} onApply={onApply} onScan={onScan} />,
  );
  const scan = screen.getByRole("button", { name: t.tools.scanPendingItems, exact: true });
  await scan.click();
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
  onScan.mockResolvedValueOnce([mixedItems[0]]);
  await scan.click();
  expect(onScan).toHaveBeenLastCalledWith(library.outputPath, "untranslated");
  await expect
    .element(filters.getByRole("button", { name: `${t.tools.translationReasonOptions.all} (1)` }))
    .toHaveAttribute("aria-pressed", "true");

  const contentItems = Array.from({ length: 301 }, (_, index) => ({
    ...items[1],
    filePath: `/library/content-${index}.mp4`,
  }));
  onScan.mockResolvedValueOnce(contentItems);
  await scan.click();
  await filters.getByRole("button", { name: `${t.tools.translationReasonOptions.task_failed} (0)` }).click();
  await expect.element(screen.getByText(t.tools.noMatchingTranslationReason, { exact: true })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: t.tools.translateSelected(0), exact: true })).toBeDisabled();
  onScan.mockResolvedValueOnce([...contentItems, mixedItems[0]]);
  await scan.click();
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
