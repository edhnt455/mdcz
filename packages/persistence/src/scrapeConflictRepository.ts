import { eq } from "drizzle-orm";
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

  preview(input: typeof scrapeConflictResolutions.$inferInsert): void {
    const existing = this.get(input.itemId);
    if (existing?.keep) throw new Error("A duplicate resolution is already in progress");
    this.database.db
      .insert(scrapeConflictResolutions)
      .values(input)
      .onConflictDoUpdate({ target: scrapeConflictResolutions.itemId, set: input })
      .run();
  }

  update(itemId: string, patch: Partial<typeof scrapeConflictResolutions.$inferInsert>): void {
    this.database.db
      .update(scrapeConflictResolutions)
      .set(patch)
      .where(eq(scrapeConflictResolutions.itemId, itemId))
      .run();
  }
}
