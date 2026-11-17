import path from "node:path";
import {
  EmbyDeletionRepository,
  PendingActionRepository,
  PendingRepository,
  ScrapeConflictRepository,
} from "@mdcz/persistence";
import type { PendingService } from "@mdcz/runtime/library/pendingService";
import type { DeletionJob, DeletionJobList, DeletionRetryResponse } from "@mdcz/shared/deletions";
import type { StrmCloudBinding } from "@mdcz/shared/moviePilot";
import { pendingItemSchema } from "@mdcz/shared/pending";
import type { ServerConfigService } from "./configService";
import type { EmbyDeletionService } from "./embyDeletionService";
import type { ServerPersistenceService } from "./persistenceService";
import type { ScrapeConflictSnapshot } from "./scrapeConflictService";
import type { ScrapeService } from "./scrapeService";

export class DeletionService {
  constructor(
    private readonly deps: {
      persistence: Pick<ServerPersistenceService, "getState">;
      config: Pick<ServerConfigService, "get">;
      emby: Pick<EmbyDeletionService, "processing" | "retry">;
      scrape: Pick<ScrapeService, "conflicts">;
      pending: Pick<PendingService, "retryJob">;
      isRunning?: (source: "emby" | "duplicate", id: string) => boolean;
    },
  ) {}

  async list(id?: string): Promise<DeletionJobList> {
    const state = await this.deps.persistence.getState();
    const configuration = await this.deps.config.get();
    const events = new EmbyDeletionRepository(state.database);
    const conflicts = new ScrapeConflictRepository(state.database);
    const names = new Map(configuration.libraries.map((library) => [library.id, library.name]));
    const rows = id
      ? id.startsWith("emby/")
        ? [events.event(id.slice(5))].filter((row) => row !== undefined)
        : []
      : events.jobs();
    const manual = id
      ? id.startsWith("duplicate/")
        ? [conflicts.get(id.slice(10))].filter((row) => row !== undefined)
        : []
      : conflicts.jobs();
    const snapshots = new Map(
      rows.map((row) => [row.id, row.snapshotJson ? (JSON.parse(row.snapshotJson) as StrmCloudBinding) : null]),
    );
    const sourcePaths = events.relatedSourcePaths(
      [...snapshots.values()].flatMap((snapshot) =>
        snapshot ? [{ connectionId: snapshot.connectionId, fileId: snapshot.target.fileid }] : [],
      ),
    );
    const jobs: DeletionJob[] = rows.map((event) => {
      const snapshot = snapshots.get(event.id);
      const observed =
        event.status === "ignored" &&
        ["would_remove_records", "would_delete_strm_resource", "would_keep_shared_resource"].includes(
          event.result ?? "",
        );
      const running = this.deps.isRunning?.("emby", event.id) ?? this.deps.emby.processing.has(event.id);
      const paused = event.status === "pending" && configuration.embyDeletion.mode === "off";
      const file = !snapshot && event.path ? events.findFile(event.path) : undefined;
      const error =
        event.status === "needs_review" ||
        (event.status === "pending" &&
          event.attempts > 0 &&
          ![
            "confirming_missing_file",
            "waiting_for_media_tasks",
            "waiting_for_link_removal",
            "waiting_for_resource",
            "deleting_cloud",
            "cleaning_source",
            "cleaning_records",
          ].includes(event.result ?? ""))
          ? event.result
          : null;
      return {
        id: `emby/${event.id}`,
        source: "emby",
        status: running
          ? "running"
          : paused
            ? "paused"
            : event.status === "pending" && error
              ? "retrying"
              : event.status,
        step: event.step,
        name: event.path ? path.basename(event.path, path.extname(event.path)) : event.itemId,
        libraryName: names.get(event.libraryId ?? "") ?? "",
        linkPath: event.path,
        sourcePaths: snapshot
          ? [
              ...new Set([
                snapshot.source.sourcePath,
                ...(sourcePaths.get(JSON.stringify([snapshot.connectionId, snapshot.target.fileid])) ?? []),
              ]),
            ]
          : file?.id === event.fileId && file?.retainedSourceIdentity
            ? [file.retainedSourceIdentity]
            : [],
        cloudPath: snapshot?.target.path ?? null,
        cloudFileId: snapshot?.target.fileid ?? null,
        cloudSize: snapshot?.target.size ?? null,
        cloudDeleted: event.cloudDeletedAt !== null,
        cloudPlanned: event.eventType === "deep.delete",
        sharedResource: ["would_keep_shared_resource", "shared_resource_retained"].includes(event.result ?? ""),
        error,
        result: event.result,
        attempts: event.attempts,
        nextAttemptAt: event.status === "pending" ? event.nextAttemptAt : null,
        createdAt: event.receivedAt,
        updatedAt: event.completedAt ?? event.cloudDeletedAt ?? event.receivedAt,
        completedAt: event.completedAt,
        canRetry:
          !running &&
          configuration.embyDeletion.mode !== "off" &&
          (event.status === "pending" ||
            event.status === "needs_review" ||
            (observed && configuration.embyDeletion.mode === "delete")),
        retryRunId: null,
        retryPlanned: false,
      };
    });
    for (const row of manual) {
      if (!row.keep) continue;
      const snapshot = JSON.parse(row.snapshotJson) as ScrapeConflictSnapshot;
      const selected = row.keep === "incoming" ? snapshot.existing : snapshot.incoming;
      const shared = snapshot.existing.cloud.target.fileid === snapshot.incoming.cloud.target.fileid;
      const running =
        this.deps.isRunning?.("duplicate", row.itemId) ?? this.deps.scrape.conflicts.isRunning(row.itemId);
      const completed = row.step === "completed";
      jobs.push({
        id: `duplicate/${row.itemId}`,
        source: "duplicate",
        status: completed ? "completed" : running ? "running" : row.error ? "needs_review" : "pending",
        step: row.step === "cleaning_local" ? "cleaning_source" : row.step,
        name: selected.cloud.target.name ?? path.basename(selected.cloud.target.path),
        libraryName: names.get(snapshot.library.id) ?? "",
        linkPath: row.keep === "incoming" ? snapshot.existingLinkPath : null,
        sourcePaths: [selected.cloud.source.sourcePath],
        cloudPath: selected.cloud.target.path,
        cloudFileId: selected.cloud.target.fileid,
        cloudSize: selected.cloud.target.size ?? null,
        cloudDeleted: !shared && !["validating", "deleting_cloud"].includes(row.step),
        cloudPlanned: true,
        sharedResource: shared,
        error: row.error,
        result: null,
        attempts: 0,
        nextAttemptAt: null,
        createdAt: snapshot.previewedAt,
        updatedAt: row.updatedAt || snapshot.previewedAt,
        completedAt: completed ? row.updatedAt : null,
        canRetry: !completed && !running,
        retryRunId: row.retryRunId,
        retryPlanned: row.keep === "incoming",
      });
    }
    const available = new Map(new PendingRepository(state.database).list().map((item) => [item.id, item.taskId]));
    const actions = new PendingActionRepository(state.database).list();
    const active = new Set(
      actions.filter((row) => ["queued", "running", "retrying"].includes(row.status)).map((row) => row.itemId),
    );
    for (const row of actions) {
      if (row.action !== "delete" || (id && id !== `action/${row.id}`)) continue;
      const item = pendingItemSchema.parse(JSON.parse(row.itemJson));
      const input = JSON.parse(row.inputJson);
      jobs.push({
        id: `action/${row.id}`,
        source: "libraryFile" in input ? "library" : "pending",
        status: row.status === "queued" ? "pending" : row.status === "failed" ? "needs_review" : row.status,
        step: row.status === "completed" ? "completed" : "validating",
        name: item.fileName,
        libraryName: item.libraryName ?? "",
        linkPath: item.path,
        sourcePaths: [],
        cloudPath: null,
        cloudFileId: null,
        cloudSize: null,
        cloudDeleted: false,
        cloudPlanned: false,
        sharedResource: false,
        error: row.error,
        result: null,
        attempts: row.attempts,
        nextAttemptAt: row.nextAttemptAt,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        completedAt: row.status === "completed" ? row.completedAt : null,
        canRetry: row.status === "failed" && !active.has(row.itemId) && available.get(row.itemId) === row.id,
        retryRunId: null,
        retryPlanned: false,
        progress: row.progress,
      });
    }
    jobs.sort((a, b) => {
      const rank = (job: DeletionJob) =>
        job.status === "running" ? 0 : job.status === "completed" || job.status === "ignored" ? 2 : 1;
      return (
        rank(a) - rank(b) ||
        (rank(a) === 2 ? (b.completedAt ?? b.updatedAt) - (a.completedAt ?? a.updatedAt) : a.createdAt - b.createdAt)
      );
    });
    return { jobs };
  }

  async detail(id: string): Promise<DeletionJob> {
    const job = (await this.list(id)).jobs[0];
    if (!job) throw new Error("未找到删除任务");
    return job;
  }

  async clearCompleted(): Promise<{ cleared: number }> {
    const { database } = await this.deps.persistence.getState();
    return database.sqlite.transaction(() => ({
      cleared:
        new EmbyDeletionRepository(database).clearCompleted([...this.deps.emby.processing.keys()]) +
        new ScrapeConflictRepository(database).clearCompleted() +
        new PendingActionRepository(database).clearCompletedDeletions(),
    }))();
  }

  async retry(id: string): Promise<DeletionRetryResponse> {
    const job = await this.detail(id);
    if (!job.canRetry) throw new Error("当前状态下无法重试此删除任务");
    if (job.source === "library" || job.source === "pending") {
      const result = await this.deps.pending.retryJob(id.slice(7));
      return { runId: null, jobId: `action/${result.taskId}` };
    }
    if (job.source === "emby") {
      await this.deps.emby.retry(id.slice(5));
      return { runId: null };
    }
    const state = await this.deps.persistence.getState();
    const row = new ScrapeConflictRepository(state.database).get(id.slice(10));
    if (!row?.keep) throw new Error("重复版本处理尚未确认要保留的版本");
    return this.deps.scrape.conflicts.resolve({
      taskId: row.taskId,
      itemId: row.itemId,
      token: row.token,
      keep: row.keep,
    });
  }
}
