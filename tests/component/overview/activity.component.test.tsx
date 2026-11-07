import type { ActivityEntryDto } from "@mdcz/shared/serverDtos";
import { getT } from "@mdcz/views/i18n";
import { ActivityTimelineCard } from "@mdcz/views/overview";
import { expect, test, vi } from "vitest";
import { render } from "vitest-browser-react";

test("activity clearing is available only for finished entries and disabled while pending", async () => {
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
  await screen.rerender(<ActivityTimelineCard entries={[]} onClearCompleted={onClearCompleted} />);
  await expect.element(screen.getByRole("heading", { name: t.overview.activity.title })).not.toBeInTheDocument();
});
