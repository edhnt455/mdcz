import path from "node:path";
import { EmbyDeletionRepository, ScrapeConflictRepository } from "@mdcz/persistence";
import type { DeletionJob, DeletionJobList, DeletionRetryResponse } from "@mdcz/shared/deletions";
import type { StrmCloudBinding } from "@mdcz/shared/moviePilot";
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
      emby: Pick<EmbyDeletionService, "processingId" | "retry">;
      scrape: Pick<ScrapeService, "conflicts">;
    },
  ) {}

  async list(id?: string): Promise<DeletionJobList> {
    const state = await this.deps.persistence.getState();
    const configuration = await this.deps.config.get();
    const events = new EmbyDeletionRepository(state.database);
    events.status(Date.now());
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
    const jobs: DeletionJob[] = rows.map((event) => {
      const snapshot = event.snapshotJson ? (JSON.parse(event.snapshotJson) as StrmCloudBinding) : null;
      const observed =
        event.status === "ignored" &&
        ["would_remove_records", "would_delete_strm_resource", "would_keep_shared_resource"].includes(
          event.result ?? "",
        );
      const running = this.deps.emby.processingId === event.id;
      const paused = event.status === "pending" && configuration.embyDeletion.mode === "off";
      const file = !snapshot && event.path ? events.findFile(event.path) : undefined;
      const error =
        event.status === "needs_review" ||
        (event.status === "pending" &&
          event.attempts > 0 &&
          ![
            "confirming_missing_file",
            "waiting_for_media_tasks",
            "deleting_cloud",
            "verifying_cloud",
            "cleaning_source",
            "confirming_source_cleanup",
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
                ...events.relatedBindings(snapshot.connectionId, snapshot.target.fileid).map((row) => row.sourcePath),
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
      const running = this.deps.scrape.conflicts.isRunning(row.itemId);
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
    jobs.sort((a, b) => {
      const active = (job: DeletionJob) => (job.status === "completed" || job.status === "ignored" ? 1 : 0);
      return active(a) - active(b) || b.createdAt - a.createdAt;
    });
    let finished = 0;
    return { jobs: jobs.filter((job) => (job.status !== "completed" && job.status !== "ignored") || finished++ < 50) };
  }

  async detail(id: string): Promise<DeletionJob> {
    const job = (await this.list(id)).jobs[0];
    if (!job) throw new Error("Deletion job not found");
    return job;
  }

  async retry(id: string): Promise<DeletionRetryResponse> {
    const job = await this.detail(id);
    if (!job.canRetry) throw new Error("This deletion job cannot be retried in its current state");
    if (job.source === "emby") {
      await this.deps.emby.retry(id.slice(5));
      return { runId: null };
    }
    const state = await this.deps.persistence.getState();
    const row = new ScrapeConflictRepository(state.database).get(id.slice(10));
    if (!row?.keep) throw new Error("Duplicate resolution has no confirmed version choice");
    return this.deps.scrape.conflicts.resolve({
      taskId: row.taskId,
      itemId: row.itemId,
      token: row.token,
      keep: row.keep,
    });
  }
}
