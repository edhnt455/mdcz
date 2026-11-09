import type { ActivityEntryDto } from "@mdcz/shared/serverDtos";
import { getT } from "@mdcz/views/i18n";
import { ActivityTimelineCard } from "@mdcz/views/overview";
import { expect, test, vi } from "vitest";
import { render } from "vitest-browser-react";

test("activity limits error details and allows clearing finished entries only when idle", async () => {
  const onClearCompleted = vi.fn();
  const t = getT();
  const active: ActivityEntryDto = {
    id: "active",
    kind: "scrape",
    status: "running",
    target: "Library",
    updatedAt: "2026-11-07T10:00:00Z",
    startedAt: null,
    completedAt: null,
    durationMs: null,
    counts: null,
    error: null,
  };
  const finished: ActivityEntryDto = { ...active, id: "finished", status: "failed", error: "Target already exists" };
  const screen = await render(<ActivityTimelineCard entries={[active]} onClearCompleted={onClearCompleted} />);
  const clearButton = screen.getByRole("button", { name: t.overview.activity.clearCompleted });
  await expect.element(clearButton).toBeDisabled();
  await screen.rerender(<ActivityTimelineCard entries={[active, finished]} onClearCompleted={onClearCompleted} />);
  await expect.element(clearButton).toBeEnabled();
  await clearButton.click();
  expect(onClearCompleted).toHaveBeenCalledTimes(1);
  await screen.rerender(
    <ActivityTimelineCard entries={[active, finished]} onClearCompleted={onClearCompleted} isClearing />,
  );
  await expect.element(clearButton).toBeDisabled();
  for (const count of [1, 10, 12]) {
    const errors = Array.from(
      { length: count },
      (_, index) => `Conflict ${index + 1}\n待处理文件：/source/${index + 1}.strm\n目标路径：/target/${index + 1}.strm`,
    );
    await screen.rerender(<ActivityTimelineCard entries={[{ ...finished, error: errors.join("\n\n") }]} />);
    const visibleErrors = screen.getByText(errors.slice(0, 10).join("\n\n"), { exact: true });
    await expect.element(visibleErrors).toBeVisible();
    expect(visibleErrors.element().textContent).toBe(errors.slice(0, 10).join("\n\n"));
    if (count > 10) {
      await expect.element(screen.getByText(t.overview.activity.hiddenErrors(count - 10))).toBeVisible();
      await expect.element(screen.getByText(/Conflict 11/)).not.toBeInTheDocument();
    } else {
      await expect.element(screen.getByText(/条错误未显示/)).not.toBeInTheDocument();
    }
  }
  await screen.rerender(<ActivityTimelineCard entries={[]} onClearCompleted={onClearCompleted} />);
  await expect.element(screen.getByRole("heading", { name: t.overview.activity.title })).not.toBeInTheDocument();
});
