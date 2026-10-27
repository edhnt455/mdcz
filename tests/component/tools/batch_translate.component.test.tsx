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
