import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { PersistenceDatabase } from "./database";
import { pendingActions, pendingItems } from "./schema";

export type PendingActionRecord = typeof pendingActions.$inferSelect;

export class PendingActionRepository {
  constructor(private readonly database: PersistenceDatabase) {}

  list(): PendingActionRecord[] {
    return this.database.db
      .select()
      .from(pendingActions)
      .where(sql`
      ${pendingActions.status} in ('queued', 'running', 'retrying')
      or exists (select 1 from pending_items p where p.task_id = ${pendingActions.id})
      or ${pendingActions.id} in (select id from pending_actions order by created_at desc, rowid desc limit 100)
    `)
      .orderBy(desc(pendingActions.createdAt), sql`rowid desc`)
      .all();
  }

  enqueue(
    input: Pick<PendingActionRecord, "itemId" | "itemUpdatedAt" | "action" | "inputJson" | "itemJson">,
  ): PendingActionRecord {
    return this.database.sqlite.transaction(() => {
      const active = this.database.db
        .select()
        .from(pendingActions)
        .where(
          and(
            eq(pendingActions.itemId, input.itemId),
            inArray(pendingActions.status, ["queued", "running", "retrying"]),
          ),
        )
        .get();
      if (active) {
        if (active.action !== input.action || active.inputJson !== input.inputJson)
          throw new Error("此文件已有正在执行的操作");
        return active;
      }
      const now = Date.now();
      const item = this.database.db.select().from(pendingItems).where(eq(pendingItems.id, input.itemId)).get();
      if (!item || item.updatedAt.getTime() !== input.itemUpdatedAt)
        throw new Error("提交期间条目已变化，请刷新后重试");
      const row: PendingActionRecord = {
        ...input,
        id: randomUUID(),
        status: "queued",
        progress: "等待执行",
        error: null,
        attempts: 0,
        nextAttemptAt: null,
        createdAt: now,
        updatedAt: now,
        completedAt: null,
      };
      this.database.db.insert(pendingActions).values(row).run();
      return row;
    })();
  }

  recover(): void {
    this.database.db
      .update(pendingActions)
      .set({ status: "queued", progress: "服务重启，等待继续", updatedAt: Date.now() })
      .where(eq(pendingActions.status, "running"))
      .run();
  }

  claim(): PendingActionRecord | undefined {
    return this.database.sqlite.transaction(() => {
      const row = this.database.db
        .select()
        .from(pendingActions)
        .where(
          and(
            inArray(pendingActions.status, ["queued", "retrying"]),
            or(isNull(pendingActions.nextAttemptAt), lte(pendingActions.nextAttemptAt, Date.now())),
          ),
        )
        .orderBy(asc(pendingActions.createdAt), sql`rowid asc`)
        .get();
      if (!row) return;
      return this.database.db
        .update(pendingActions)
        .set({
          status: "running",
          progress: "正在核验",
          attempts: row.attempts + 1,
          nextAttemptAt: null,
          updatedAt: Date.now(),
        })
        .where(eq(pendingActions.id, row.id))
        .returning()
        .get();
    })();
  }

  progress(id: string, progress: string): void {
    this.database.db
      .update(pendingActions)
      .set({ progress, updatedAt: Date.now() })
      .where(eq(pendingActions.id, id))
      .run();
  }

  finish(row: PendingActionRecord, error?: string, retryAt?: number): void {
    this.database.sqlite.transaction(() => {
      const now = Date.now();
      this.database.db
        .update(pendingActions)
        .set({
          status: retryAt ? "retrying" : error ? "failed" : "completed",
          progress: retryAt ? "等待自动重试" : error ? "需要人工处理" : "处理完成",
          error: error ?? null,
          nextAttemptAt: retryAt ?? null,
          updatedAt: now,
          completedAt: retryAt ? null : now,
        })
        .where(eq(pendingActions.id, row.id))
        .run();
      if (error && !retryAt)
        this.database.db
          .update(pendingItems)
          .set({
            taskId: row.id,
            kind: row.action === "delete" ? "failed" : "uncensored",
            taskKind: "action",
            updatedAt: new Date(now),
            detail: `${row.action === "delete" ? "删除" : "确认类型"}失败：${error}`,
          })
          .where(and(eq(pendingItems.id, row.itemId), eq(pendingItems.updatedAt, new Date(row.itemUpdatedAt))))
          .run();
    })();
  }
}
