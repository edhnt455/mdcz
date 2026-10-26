import { eq } from "drizzle-orm";
import type { PersistenceDatabase } from "./database";
import { libraryWatchSnapshots, pendingItems } from "./schema";

export class LibraryStateRepository {
  constructor(private readonly database: PersistenceDatabase) {}

  loadWatchSnapshot(libraryId: string): Set<string> | undefined {
    const row = this.database.db
      .select({ fileKeysJson: libraryWatchSnapshots.fileKeysJson })
      .from(libraryWatchSnapshots)
      .where(eq(libraryWatchSnapshots.libraryId, libraryId))
      .get();
    return row ? new Set(JSON.parse(row.fileKeysJson) as string[]) : undefined;
  }

  saveWatchSnapshot(libraryId: string, fileKeys: ReadonlySet<string>): void {
    const fileKeysJson = JSON.stringify([...fileKeys]);
    this.database.db
      .insert(libraryWatchSnapshots)
      .values({ libraryId, fileKeysJson })
      .onConflictDoUpdate({ target: libraryWatchSnapshots.libraryId, set: { fileKeysJson } })
      .run();
  }

  deleteWatchSnapshot(libraryId: string): void {
    this.database.db.delete(libraryWatchSnapshots).where(eq(libraryWatchSnapshots.libraryId, libraryId)).run();
  }

  removeLibrary(libraryId: string): void {
    this.database.sqlite.transaction(() => {
      this.deleteWatchSnapshot(libraryId);
      this.database.db.update(pendingItems).set({ libraryId: null }).where(eq(pendingItems.libraryId, libraryId)).run();
    })();
  }
}
