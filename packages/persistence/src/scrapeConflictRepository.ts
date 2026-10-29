import { desc, eq, isNotNull } from "drizzle-orm";
import type { PersistenceDatabase } from "./database";
import { scrapeConflictResolutions } from "./schema";

export type ScrapeConflictRow = typeof scrapeConflictResolutions.$inferSelect;

export class ScrapeConflictRepository {
  constructor(private readonly database: PersistenceDatabase) {}

  get(itemId: string): ScrapeConflictRow | undefined {
    return this.database.db
      .select()
      .from(scrapeConflictResolutions)
      .where(eq(scrapeConflictResolutions.itemId, itemId))
      .get();
  }

  list(taskId: string): ScrapeConflictRow[] {
    return this.database.db
      .select()
      .from(scrapeConflictResolutions)
      .where(eq(scrapeConflictResolutions.taskId, taskId))
      .all();
  }

  jobs(): ScrapeConflictRow[] {
    return this.database.db
      .select()
      .from(scrapeConflictResolutions)
      .where(isNotNull(scrapeConflictResolutions.keep))
      .orderBy(desc(scrapeConflictResolutions.updatedAt))
      .all();
  }

  preview(input: typeof scrapeConflictResolutions.$inferInsert): void {
    const existing = this.get(input.itemId);
    if (existing?.keep) throw new Error("A duplicate resolution is already in progress");
    this.database.db
      .insert(scrapeConflictResolutions)
      .values({ ...input, updatedAt: Date.now() })
      .onConflictDoUpdate({ target: scrapeConflictResolutions.itemId, set: { ...input, updatedAt: Date.now() } })
      .run();
  }

  update(itemId: string, patch: Partial<typeof scrapeConflictResolutions.$inferInsert>): void {
    this.database.db
      .update(scrapeConflictResolutions)
      .set({ ...patch, updatedAt: Date.now() })
      .where(eq(scrapeConflictResolutions.itemId, itemId))
      .run();
  }
}
