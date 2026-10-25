import { getT } from "@mdcz/views/i18n";
import { PersonMediaLibraryDetail, type PersonServerPanelState } from "@mdcz/views/tools";
import { expect, test, vi } from "vitest";
import { render } from "vitest-browser-react";

const panel: PersonServerPanelState = {
  checkPending: false,
  checkResult: null,
  infoMode: "missing",
  photoMode: "missing",
  infoSyncRunning: false,
  photoSyncRunning: false,
  infoText: "",
  photoText: "",
  progress: 0,
};
const callbacks = () => ({
  onCheck: vi.fn(),
  onInfoModeChange: vi.fn(),
  onOpenSettings: vi.fn(),
  onPhotoModeChange: vi.fn(),
  onServerChange: vi.fn(),
  onSyncInfo: vi.fn(),
  onSyncPhoto: vi.fn(),
});

test("shows automatic waiting and offers a manual supplement without starting work on render", async () => {
  const actions = callbacks();
  const t = getT();
  const screen = await render(
    <PersonMediaLibraryDetail
      {...actions}
      activeServer="emby"
      emby={panel}
      jellyfin={panel}
      syncState={{
        job: null,
        automatic: {
          status: "waiting",
          waitingActors: 2,
          lastRunAt: null,
          nextRunAt: "2026-10-25T12:00:00Z",
          error: null,
        },
      }}
    />,
  );
  await expect.element(screen.getByText(t.tools.autoPhotoSync.waiting(2))).toBeVisible();
  await expect.element(screen.getByText(t.tools.autoPhotoSync.description)).toBeVisible();
  expect(actions.onSyncPhoto).not.toHaveBeenCalled();
  await screen.getByRole("button", { name: t.tools.autoPhotoSync.syncNow }).click();
  expect(actions.onSyncPhoto).toHaveBeenCalledExactlyOnceWith("emby");
});

test("shows background progress, prevents duplicate writes, and displays actionable failures", async () => {
  const actions = callbacks();
  const t = getT();
  const screen = await render(
    <PersonMediaLibraryDetail
      {...actions}
      activeServer="emby"
      emby={{ ...panel, photoSyncRunning: true, progress: 50 }}
      jellyfin={panel}
      syncState={{
        automatic: { status: "running", waitingActors: 0, lastRunAt: null, nextRunAt: null, error: null },
        job: {
          id: "job",
          server: "emby",
          kind: "photo",
          mode: "missing",
          trigger: "automatic",
          status: "running",
          current: 1,
          total: 2,
          startedAt: "2026-10-25T12:00:00Z",
          finishedAt: null,
          result: null,
          error: null,
        },
      }}
    />,
  );
  await expect.element(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "50");
  for (const button of screen.getByRole("button", { name: t.tools.syncing }).elements()) expect(button).toBeDisabled();
  await screen.rerender(
    <PersonMediaLibraryDetail
      {...actions}
      activeServer="emby"
      emby={panel}
      jellyfin={panel}
      syncState={{
        automatic: { status: "blocked", waitingActors: 0, lastRunAt: null, nextRunAt: null, error: "Emby HTTP 403" },
        job: {
          id: "job",
          server: "emby",
          kind: "photo",
          mode: "missing",
          trigger: "automatic",
          status: "completed",
          current: 2,
          total: 2,
          startedAt: "2026-10-25T12:00:00Z",
          finishedAt: "2026-10-25T12:01:00Z",
          error: null,
          result: {
            processedCount: 1,
            failedCount: 1,
            skippedCount: 0,
            failures: [{ personId: "b", name: "Actor B", stage: "upload photo", message: "Upload failed" }],
          },
        },
      }}
    />,
  );
  await expect.element(screen.getByRole("alert")).toHaveTextContent("Emby HTTP 403");
  await expect.element(screen.getByText("Actor B: Upload failed")).toBeVisible();
  await expect.element(screen.getByRole("button", { name: t.tools.autoPhotoSync.syncNow })).toBeEnabled();
});
