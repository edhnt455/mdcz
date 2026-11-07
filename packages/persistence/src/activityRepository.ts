import type { PersistenceDatabase } from "./database";
import { clearedActivities } from "./schema";

export class ActivityRepository {
  constructor(private readonly database: PersistenceDatabase) {}

  listCleared(): Map<string, string> {
    return new Map(
      this.database.db
        .select()
        .from(clearedActivities)
        .all()
        .map((entry) => [`${entry.kind}:${entry.id}`, entry.updatedAt]),
    );
  }

  clear(entries: { kind: string; id: string; updatedAt: string }[]): void {
    this.database.sqlite.transaction(() => {
      for (const { kind, id, updatedAt } of entries) {
        this.database.db
          .insert(clearedActivities)
          .values({ kind, id, updatedAt })
          .onConflictDoUpdate({ target: [clearedActivities.kind, clearedActivities.id], set: { updatedAt } })
          .run();
      }
    })();
  }
}
