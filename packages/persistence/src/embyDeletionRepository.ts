import { randomUUID } from "node:crypto";
import path from "node:path";
import { filesystemPathKey, isPathInside } from "@mdcz/media-store";
import { and, asc, desc, eq, inArray, isNull, lt, lte, sql } from "drizzle-orm";
import type { PersistenceDatabase } from "./database";
import { LibraryRepository } from "./libraryRepository";
import {
  embyDeletionEvents,
  libraryItemFiles,
  libraryItems,
  mediaRoots,
  pendingItems,
  scrapeRuns,
  siteResults,
  strmCloudBindings,
} from "./schema";

export type EmbyDeletionEventRow = typeof embyDeletionEvents.$inferSelect;
export interface EmbyDeletionLibraryBinding {
  id: string;
  outputPath: string;
  realPath: string;
  marker: string;
  source?: { path: string; realPath: string; marker: string };
}

export class EmbyDeletionRepository {
  constructor(private readonly database: PersistenceDatabase) {}

  ignorePendingLibraryDeletions(completedAt = Date.now()): void {
    this.database.db
      .update(embyDeletionEvents)
      .set({ status: "ignored", result: "settings_changed", completedAt })
      .where(and(eq(embyDeletionEvents.status, "pending"), eq(embyDeletionEvents.eventType, "library.deleted")))
      .run();
  }

  clearUnblockedBindings(): void {
    this.database.db.delete(strmCloudBindings).where(eq(strmCloudBindings.blocked, false)).run();
  }

  hasCloudWork(): boolean {
    return Boolean(
      this.database.db
        .select({ id: embyDeletionEvents.id })
        .from(embyDeletionEvents)
        .where(
          and(
            eq(embyDeletionEvents.eventType, "deep.delete"),
            sql`${embyDeletionEvents.status} in ('pending', 'needs_review')`,
          ),
        )
        .limit(1)
        .get(),
    );
  }

  binding(fileId: string) {
    return this.database.db.select().from(strmCloudBindings).where(eq(strmCloudBindings.fileId, fileId)).get();
  }

  bind(values: typeof strmCloudBindings.$inferInsert): void {
    if (this.binding(values.fileId)?.blocked)
      throw new Error("STRM source is suppressed by a deletion; review it before rebinding");
    this.database.db
      .insert(strmCloudBindings)
      .values(values)
      .onConflictDoUpdate({ target: strmCloudBindings.fileId, set: values })
      .run();
  }

  suppress(fileIds: readonly string[]): void {
    if (fileIds.length)
      this.database.db
        .update(strmCloudBindings)
        .set({ blocked: true })
        .where(inArray(strmCloudBindings.fileId, [...fileIds]))
        .run();
  }

  relatedBindings(connectionId: string, cloudFileId: string) {
    return this.database.db
      .select()
      .from(strmCloudBindings)
      .where(
        sql`json_extract(${strmCloudBindings.snapshotJson}, '$.connectionId') = ${connectionId} and json_extract(${strmCloudBindings.snapshotJson}, '$.target.fileid') = ${cloudFileId}`,
      )
      .all();
  }

  otherReference(
    fileId: string | null,
    connectionId: string,
    cloudFileId: string,
    resource: string | undefined,
  ): string | undefined {
    const row = this.database.sqlite
      .prepare<unknown[], { root: string; relative: string }>(`
      SELECT coalesce(r.real_path, r.host_path) AS root, f.root_relative_path AS relative
      FROM library_item_files f JOIN media_roots r ON r.id = f.root_id
      LEFT JOIN strm_cloud_bindings b ON b.file_id = f.id
      WHERE f.id != ? AND (
        CASE WHEN json_valid(f.strm_source_json) THEN json_extract(f.strm_source_json, '$.resourceIdentity') END = ?
        OR CASE WHEN json_valid(b.snapshot_json) THEN (
          json_extract(b.snapshot_json, '$.connectionId') = ?
          AND json_extract(b.snapshot_json, '$.target.fileid') = ?
          AND json_extract(b.snapshot_json, '$.fileUpdatedAt') = f.updated_at
        ) END
      ) LIMIT 1
    `)
      .get(fileId ?? "", resource ?? null, connectionId, cloudFileId);
    return row ? filesystemPathKey(path.resolve(row.root, row.relative)) : undefined;
  }

  jobs(): EmbyDeletionEventRow[] {
    return this.database.db.select().from(embyDeletionEvents).orderBy(desc(embyDeletionEvents.receivedAt)).all();
  }

  associationCounts(connectionId?: string) {
    const verified =
      this.database.db
        .select({ count: sql<number>`count(*)` })
        .from(strmCloudBindings)
        .innerJoin(libraryItemFiles, eq(libraryItemFiles.id, strmCloudBindings.fileId))
        .where(
          sql`${strmCloudBindings.blocked} = 0 and json_extract(${strmCloudBindings.snapshotJson}, '$.connectionId') = ${connectionId ?? null} and json_extract(${strmCloudBindings.snapshotJson}, '$.fileUpdatedAt') = ${libraryItemFiles.updatedAt}`,
        )
        .get()?.count ?? 0;
    const blocked =
      this.database.db
        .select({ count: sql<number>`count(*)` })
        .from(strmCloudBindings)
        .where(eq(strmCloudBindings.blocked, true))
        .get()?.count ?? 0;
    return { verified, blocked };
  }

  retry(id: string): void {
    const row = this.database.db.select().from(embyDeletionEvents).where(eq(embyDeletionEvents.id, id)).get();
    if (
      !row ||
      !(
        row.status === "pending" ||
        row.status === "needs_review" ||
        (row.status === "ignored" &&
          ["would_remove_records", "would_delete_strm_resource", "would_keep_shared_resource"].includes(
            row.result ?? "",
          ))
      )
    )
      throw new Error("Only unfinished jobs or observed deletions can be retried");
    this.update(id, { status: "pending", attempts: 0, result: null, completedAt: null, nextAttemptAt: Date.now() });
  }

  findFile(absolutePath: string) {
    for (const root of this.database.db.select().from(mediaRoots).all()) {
      for (const rootPath of new Set(
        [root.hostPath, root.realPath].filter((value): value is string => Boolean(value)),
      )) {
        if (!isPathInside(rootPath, absolutePath)) continue;
        const relativePath = path.relative(rootPath, absolutePath).split(path.sep).join("/");
        const file = this.database.db
          .select()
          .from(libraryItemFiles)
          .where(and(eq(libraryItemFiles.rootId, root.id), eq(libraryItemFiles.rootRelativePath, relativePath)))
          .get();
        if (file) return file;
      }
    }
    return undefined;
  }

  knownFiles(bindings: readonly EmbyDeletionLibraryBinding[]) {
    return this.database.db
      .select({ file: libraryItemFiles, root: mediaRoots })
      .from(libraryItemFiles)
      .innerJoin(mediaRoots, eq(libraryItemFiles.rootId, mediaRoots.id))
      .all()
      .flatMap(({ file, root }) => {
        const absolutePath = filesystemPathKey(path.resolve(root.hostPath, file.rootRelativePath));
        const binding = bindings.find(
          (binding) => absolutePath !== binding.outputPath && isPathInside(binding.outputPath, absolutePath),
        );
        return binding ? [{ file, path: absolutePath, libraryId: binding.id }] : [];
      });
  }

  enqueue(input: Omit<typeof embyDeletionEvents.$inferInsert, "id">) {
    const id = randomUUID();
    this.database.db
      .insert(embyDeletionEvents)
      .values({ ...input, id })
      .onConflictDoNothing({ target: embyDeletionEvents.dedupKey })
      .run();
    const event = this.database.db
      .select()
      .from(embyDeletionEvents)
      .where(eq(embyDeletionEvents.dedupKey, input.dedupKey))
      .get();
    if (!event) throw new Error("Emby deletion event was not persisted");
    return { event, duplicate: event.id !== id };
  }

  due(now: number): EmbyDeletionEventRow[] {
    return this.database.db
      .select()
      .from(embyDeletionEvents)
      .where(and(eq(embyDeletionEvents.status, "pending"), lte(embyDeletionEvents.nextAttemptAt, now)))
      .orderBy(asc(embyDeletionEvents.receivedAt))
      .limit(20)
      .all();
  }

  update(id: string, patch: Partial<typeof embyDeletionEvents.$inferInsert>): void {
    this.database.db.update(embyDeletionEvents).set(patch).where(eq(embyDeletionEvents.id, id)).run();
  }

  event(id: string): EmbyDeletionEventRow | undefined {
    return this.database.db.select().from(embyDeletionEvents).where(eq(embyDeletionEvents.id, id)).get();
  }

  finish(id: string, status: "completed" | "ignored" | "needs_review", result: string, now: number): void {
    this.update(id, { status, result, completedAt: now });
  }

  hasLiveScrapes(): boolean {
    return Boolean(
      this.database.db
        .select({ id: scrapeRuns.id })
        .from(scrapeRuns)
        .where(isNull(scrapeRuns.disposition))
        .limit(1)
        .get(),
    );
  }

  clean(event: EmbyDeletionEventRow, now: number): boolean {
    return this.database.sqlite.transaction(() => {
      if (
        this.database.db.select().from(embyDeletionEvents).where(eq(embyDeletionEvents.id, event.id)).get()?.status !==
        "pending"
      )
        return false;
      const file = this.database.db
        .select()
        .from(libraryItemFiles)
        .where(eq(libraryItemFiles.id, event.fileId ?? ""))
        .get();
      if (!file) {
        this.finish(event.id, "completed", "already_removed", now);
        return false;
      }
      if (file.itemId !== event.movieId || file.updatedAt.getTime() !== event.fileUpdatedAt) {
        this.finish(event.id, "ignored", "file_record_changed", now);
        return false;
      }
      const item = this.database.db.select().from(libraryItems).where(eq(libraryItems.id, file.itemId)).get();
      if (!item) throw new Error("Emby deletion target movie is missing");
      this.database.db
        .delete(pendingItems)
        .where(and(eq(pendingItems.rootId, file.rootId), eq(pendingItems.relativePath, file.rootRelativePath)))
        .run();
      new LibraryRepository(this.database).removeFile(file.id);
      const number = item.number?.trim().toUpperCase();
      if (
        number &&
        !this.database.db
          .select({ id: libraryItems.id })
          .from(libraryItems)
          .where(sql`upper(trim(${libraryItems.number})) = ${number}`)
          .limit(1)
          .get() &&
        !this.database.db
          .select({ id: pendingItems.id })
          .from(pendingItems)
          .where(sql`upper(trim(${pendingItems.number})) = ${number}`)
          .limit(1)
          .get()
      ) {
        this.database.db.delete(siteResults).where(eq(siteResults.number, number)).run();
      }
      this.update(event.id, { step: "completed" });
      this.finish(event.id, "completed", "records_removed", now);
      return true;
    })();
  }

  status(now: number) {
    this.database.db
      .delete(embyDeletionEvents)
      .where(
        and(
          lt(embyDeletionEvents.completedAt, now - 30 * 24 * 60 * 60_000),
          sql`${embyDeletionEvents.status} in ('completed', 'ignored')`,
        ),
      )
      .run();
    const counts = { pending: 0, needs_review: 0 };
    for (const row of this.database.db
      .select({ status: embyDeletionEvents.status, count: sql<number>`count(*)` })
      .from(embyDeletionEvents)
      .where(inArray(embyDeletionEvents.status, ["pending", "needs_review"]))
      .groupBy(embyDeletionEvents.status)
      .all())
      if (row.status === "pending" || row.status === "needs_review") counts[row.status] = row.count;
    return { counts };
  }
}
