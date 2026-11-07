import { ActivityRepository } from "@mdcz/persistence";
import type { MediaLibraryService } from "@mdcz/runtime/library";
import type { ActivityEntryDto, ActivityListResponse } from "@mdcz/shared/serverDtos";
import type { TaskEventBus } from "../taskEvents";
import type { MaintenanceService } from "./maintenanceService";
import type { ServerPersistenceService } from "./persistenceService";
import type { ScanQueueService } from "./scanQueueService";
import type { ScrapeService } from "./scrapeService";

const durationBetween = (startedAt: string | null, completedAt: string | null): number | null =>
  startedAt && completedAt ? Date.parse(completedAt) - Date.parse(startedAt) : null;

const isFinished = (entry: ActivityEntryDto): boolean =>
  ["completed", "failed", "stopped", "interrupted"].includes(entry.status);

/**
 * What the server has been doing, newest first: scans, scrape runs and the current maintenance session.
 * Finished scrape runs and scans are persisted; a maintenance session is listed only while it is the active one.
 */
export class ActivityService {
  constructor(
    private readonly deps: {
      libraries: Pick<MediaLibraryService, "list">;
      scans: Pick<ScanQueueService, "list">;
      scrape: Pick<ScrapeService, "history" | "liveRuns">;
      maintenance: Pick<MaintenanceService, "automationTask">;
      persistence: Pick<ServerPersistenceService, "getState">;
      taskEvents: Pick<TaskEventBus, "invalidate">;
    },
  ) {}

  async list(limit = 20): Promise<ActivityListResponse> {
    const [libraries, scanTasks, scrapeHistory, liveRuns, maintenanceTask] = await Promise.all([
      this.deps.libraries.list(),
      this.deps.scans.list(),
      this.deps.scrape.history(),
      this.deps.scrape.liveRuns(),
      this.deps.maintenance.automationTask(),
    ]);
    const liveRunIds = new Set(liveRuns.runs.map(({ task }) => task.id));
    const libraryNames = new Map(libraries.map((library) => [library.id, library.name]));
    const entries: ActivityEntryDto[] = [
      ...liveRuns.runs.map(({ task }) => ({
        id: task.id,
        kind: "scrape" as const,
        status: task.status,
        target: (task.libraryId && libraryNames.get(task.libraryId)) || task.rootDisplayName || task.rootId,
        updatedAt: task.updatedAt,
        startedAt: task.startedAt,
        completedAt: task.completedAt,
        durationMs: durationBetween(task.startedAt, task.completedAt),
        counts: { success: task.successCount, failed: task.failedCount, skipped: task.skippedCount },
        error: task.error,
      })),
      ...scanTasks.tasks.map((task) => ({
        id: task.id,
        kind: "scan" as const,
        status: task.status,
        target: task.rootDisplayName || task.rootId,
        updatedAt: task.updatedAt,
        startedAt: task.startedAt,
        completedAt: task.completedAt,
        durationMs: durationBetween(task.startedAt, task.completedAt),
        counts: null,
        error: task.error,
      })),
      ...scrapeHistory.runs
        .filter((run) => !liveRunIds.has(run.id))
        .map((run) => ({
          id: run.id,
          kind: "scrape" as const,
          status: run.disposition,
          target: (run.libraryId && libraryNames.get(run.libraryId)) || run.rootDisplayName || run.rootId,
          updatedAt: run.completedAt ?? run.createdAt,
          startedAt: run.startedAt,
          completedAt: run.completedAt,
          durationMs: durationBetween(run.startedAt, run.completedAt),
          counts: { success: run.successCount, failed: run.failedCount, skipped: run.skippedCount },
          error: run.error,
        })),
      ...(maintenanceTask
        ? [
            {
              id: maintenanceTask.id,
              kind: "maintenance" as const,
              status: maintenanceTask.status,
              target: maintenanceTask.rootDisplayName || maintenanceTask.rootId,
              updatedAt: maintenanceTask.updatedAt,
              startedAt: maintenanceTask.startedAt,
              completedAt: maintenanceTask.completedAt,
              durationMs: maintenanceTask.durationMs,
              counts: null,
              error: maintenanceTask.error,
            },
          ]
        : []),
    ];
    const { database } = await this.deps.persistence.getState();
    const cleared = new ActivityRepository(database).listCleared();
    return {
      entries: entries
        .filter(
          (entry) =>
            !isFinished(entry) || cleared.get(`${entry.kind}:${entry.id}`) !== (entry.completedAt ?? entry.updatedAt),
        )
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .slice(0, limit),
    };
  }

  async clearCompleted(): Promise<{ cleared: number }> {
    const { entries } = await this.list(Number.POSITIVE_INFINITY);
    const finished = entries.filter(isFinished);
    const { database } = await this.deps.persistence.getState();
    new ActivityRepository(database).clear(
      finished.map((entry) => ({ ...entry, updatedAt: entry.completedAt ?? entry.updatedAt })),
    );
    this.deps.taskEvents.invalidate("activity");
    return { cleared: finished.length };
  }
}
