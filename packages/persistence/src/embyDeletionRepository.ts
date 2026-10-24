import { randomUUID } from "node:crypto";
import path from "node:path";
import { filesystemPathKey, isPathInside } from "@mdcz/media-store";
import { and, asc, desc, eq, isNull, lt, lte, sql } from "drizzle-orm";
import type { PersistenceDatabase } from "./database";
import { LibraryRepository } from "./libraryRepository";
import {
  embyDeletionEvents,
  embyDeletionSettings,
  libraryItemFiles,
  libraryItems,
  mediaRoots,
  pendingItems,
  scrapeRuns,
  siteResults,
} from "./schema";

export type EmbyDeletionEventRow = typeof embyDeletionEvents.$inferSelect;
export interface EmbyDeletionLibraryBinding {
  id: string;
  outputPath: string;
  realPath: string;
  marker: string;
}

export class EmbyDeletionRepository {
  constructor(private readonly database: PersistenceDatabase) {}

  settings() {
    const row = this.database.db.select().from(embyDeletionSettings).get();
    if (!row) throw new Error("Emby deletion settings are missing");
    return { ...row, libraries: JSON.parse(row.librariesJson) as EmbyDeletionLibraryBinding[] };
  }

  configure(input: { mode: "off" | "observe" | "delete"; serverId: string; libraries: EmbyDeletionLibraryBinding[] }) {
    this.database.sqlite.transaction(() => {
      this.database.db
        .update(embyDeletionSettings)
        .set({ mode: input.mode, serverId: input.serverId, librariesJson: JSON.stringify(input.libraries) })
        .where(eq(embyDeletionSettings.id, 1))
        .run();
      this.database.db
        .update(embyDeletionEvents)
        .set({ status: "ignored", result: "settings_changed", completedAt: Date.now() })
        .where(eq(embyDeletionEvents.status, "pending"))
        .run();
    })();
  }

  setSecretHash(secretHash: string): void {
    this.database.db.update(embyDeletionSettings).set({ secretHash }).where(eq(embyDeletionSettings.id, 1)).run();
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
        return bindings.some(
          (binding) => absolutePath !== binding.outputPath && isPathInside(binding.outputPath, absolutePath),
        )
          ? [{ file, path: absolutePath }]
          : [];
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
    const counts = { pending: 0, completed: 0, ignored: 0, needs_review: 0 };
    for (const row of this.database.db
      .select({ status: embyDeletionEvents.status, count: sql<number>`count(*)` })
      .from(embyDeletionEvents)
      .groupBy(embyDeletionEvents.status)
      .all())
      counts[row.status] = row.count;
    const recent = this.database.db
      .select({
        id: embyDeletionEvents.id,
        serverId: embyDeletionEvents.serverId,
        path: embyDeletionEvents.path,
        status: embyDeletionEvents.status,
        result: embyDeletionEvents.result,
        receivedAt: embyDeletionEvents.receivedAt,
        completedAt: embyDeletionEvents.completedAt,
        attempts: embyDeletionEvents.attempts,
      })
      .from(embyDeletionEvents)
      .orderBy(desc(embyDeletionEvents.receivedAt), desc(embyDeletionEvents.id))
      .limit(20)
      .all();
    return { counts, recent };
  }
}
