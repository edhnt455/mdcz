import { createTestPersistenceDatabase } from "@mdcz/persistence/test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TaskEventBus } from "../taskEvents";
import { ActivityService } from "./activityService";
import type { ServerPersistenceState } from "./persistenceService";

const scrapeRun = (id: string, completedAt: string) => ({
  id,
  rootDisplayName: "Downloads",
  libraryId: id === "run-done" ? "lib-1" : null,
  disposition: "completed" as const,
  createdAt: completedAt,
  startedAt: new Date(Date.parse(completedAt) - 12_000).toISOString(),
  completedAt,
  successCount: 3,
  failedCount: 1,
  skippedCount: 0,
  error: null,
});

describe("ActivityService", () => {
  let database: ReturnType<typeof createTestPersistenceDatabase>;
  const taskEvents = new TaskEventBus();
  const persistence = { getState: async () => ({ database }) as ServerPersistenceState };
  beforeEach(() => {
    database = createTestPersistenceDatabase();
  });
  afterEach(() => database.close());

  it("lists scans, scrape runs and the active maintenance session newest first, once per run", async () => {
    const service = new ActivityService({
      persistence,
      taskEvents,
      libraries: { list: async () => [{ id: "lib-1", name: "Movies" }] as never },
      scans: {
        list: async () =>
          ({
            tasks: [
              {
                id: "scan-1",
                rootId: "root",
                rootDisplayName: "Library",
                status: "completed",
                updatedAt: "2026-10-08T09:00:00.000Z",
                startedAt: null,
                completedAt: null,
                error: null,
              },
            ],
          }) as never,
      },
      scrape: {
        history: async () =>
          ({
            runs: [
              scrapeRun("run-done", "2026-10-08T10:00:00.000Z"),
              { ...scrapeRun("run-live", "2026-10-08T11:00:00.000Z"), disposition: "interrupted", completedAt: null },
            ],
            results: [],
          }) as never,
        liveRuns: async () =>
          ({
            runs: [
              {
                task: {
                  ...scrapeRun("run-done", "2026-10-08T10:00:00.000Z"),
                  status: "completed",
                  updatedAt: "2026-10-08T10:00:00.000Z",
                },
              },
              {
                task: {
                  ...scrapeRun("run-live", "2026-10-08T11:00:00.000Z"),
                  status: "running",
                  rootId: "root",
                  updatedAt: "2026-10-08T11:00:00.000Z",
                  completedAt: null,
                },
              },
            ],
          }) as never,
      },
      maintenance: {
        automationTask: async () =>
          ({
            id: "session-1",
            rootId: "root",
            rootDisplayName: "",
            status: "paused",
            startedAt: null,
            completedAt: null,
            durationMs: null,
            error: null,
            updatedAt: "2026-10-08T08:00:00.000Z",
          }) as never,
      },
    });

    const { entries } = await service.list(3);

    expect(entries.map(({ id, kind, status }) => ({ id, kind, status }))).toEqual([
      { id: "run-live", kind: "scrape", status: "running" },
      { id: "run-done", kind: "scrape", status: "completed" },
      { id: "scan-1", kind: "scan", status: "completed" },
    ]);
    expect(entries.map((entry) => entry.target)).toEqual(["Downloads", "Movies", "Library"]);
    expect(entries[1]?.counts).toEqual({ success: 3, failed: 1, skipped: 0 });
    expect(entries.map((entry) => entry.durationMs)).toEqual([null, 12_000, null]);
  });

  it("persistently clears every finished activity while preserving active tasks and later outcomes", async () => {
    const statuses = [
      "queued",
      "discovering",
      "running",
      "paused",
      "stopping",
      "completed",
      "failed",
      "stopped",
      "interrupted",
    ] as const;
    const tasks = statuses.map((status) => ({
      id: status,
      rootId: "root",
      status,
      updatedAt: "2026-10-08T10:00:00.000Z",
      startedAt: null,
      completedAt: null,
      error: null,
    }));
    const runs = Array.from({ length: 15 }, (_, index) => scrapeRun(`run-${index}`, "2026-10-08T11:00:00.000Z"));
    const maintenanceTask = { ...tasks[5], id: "completed", kind: "maintenance", durationMs: null };
    const deps = {
      persistence,
      taskEvents,
      libraries: { list: async () => [] as never },
      scans: { list: async () => ({ tasks }) as never },
      scrape: { history: async () => ({ runs, results: [] }) as never, liveRuns: async () => ({ runs: [] }) },
      maintenance: {
        automationTask: async () => maintenanceTask as never,
      },
    };
    const service = new ActivityService(deps);
    expect((await service.list(12)).entries).toHaveLength(12);
    expect(await service.clearCompleted()).toEqual({ cleared: 20 });
    const reloaded = new ActivityService(deps);
    expect((await reloaded.list()).entries.map((entry) => entry.status)).toEqual(statuses.slice(0, 5));
    expect(await reloaded.clearCompleted()).toEqual({ cleared: 0 });
    expect(tasks).toHaveLength(9);
    expect(runs).toHaveLength(15);
    tasks[2] = { ...tasks[2], status: "completed", updatedAt: "2026-10-08T12:00:00.000Z" };
    tasks[5] = { ...tasks[5], updatedAt: "2026-10-08T12:00:00.000Z" };
    expect((await reloaded.list()).entries.map((entry) => entry.id)).toEqual([
      "running",
      "completed",
      "queued",
      "discovering",
      "paused",
      "stopping",
    ]);
    expect(await reloaded.clearCompleted()).toEqual({ cleared: 2 });
  });
});
