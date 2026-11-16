import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { EmbyDeletionNotification } from "@mdcz/shared/embyDeletion";
import Database from "better-sqlite3";

export interface InboxReceipt {
  id: string;
  payload: string;
  receivedAt: number;
  attempts: number;
  error: string | null;
}

// This database has no media transactions: acknowledging a notification never waits for a scan or publication.
export class WebhookInbox {
  readonly database: Database.Database;

  constructor(path: string, readOnly = false) {
    if (!readOnly) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.database = new Database(path, { readonly: readOnly });
    try {
      this.database.pragma("busy_timeout = 100");
      if (readOnly) return;
      chmodSync(path, 0o600);
      if (this.database.pragma("journal_mode = WAL", { simple: true }) !== "wal")
        throw new Error("通知队列需要 SQLite WAL");
      this.database.pragma("synchronous = FULL");
      this.database.exec(`CREATE TABLE IF NOT EXISTS webhook_inbox (
        id TEXT PRIMARY KEY, digest TEXT NOT NULL UNIQUE, payload TEXT,
        received_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL DEFAULT 0, error TEXT, delivered_at INTEGER,
        result TEXT
      ); CREATE INDEX IF NOT EXISTS webhook_inbox_due ON webhook_inbox(delivered_at, next_attempt_at, received_at)`);
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  accept(notification: EmbyDeletionNotification, now = Date.now()) {
    const payload = JSON.stringify(notification);
    const digest = createHash("sha256").update(payload).digest("hex");
    return this.database.transaction(() => {
      const existing = this.database
        .prepare<unknown[], { id: string }>("SELECT id FROM webhook_inbox WHERE digest = ?")
        .get(digest);
      if (existing) return { id: existing.id, status: "pending" as const, duplicate: true };
      const id = randomUUID();
      this.database
        .prepare("INSERT INTO webhook_inbox (id, digest, payload, received_at) VALUES (?, ?, ?, ?)")
        .run(id, digest, payload, now);
      return { id, status: "pending" as const, duplicate: false };
    })();
  }

  due(now = Date.now()): InboxReceipt | undefined {
    return this.database
      .prepare<unknown[], InboxReceipt>(`SELECT id, payload, received_at AS receivedAt, attempts, error
      FROM webhook_inbox WHERE delivered_at IS NULL AND next_attempt_at <= ? ORDER BY received_at, id LIMIT 1`)
      .get(now);
  }

  pending(): InboxReceipt[] {
    return this.database
      .prepare<unknown[], InboxReceipt>(`SELECT id, payload, received_at AS receivedAt, attempts, error
      FROM webhook_inbox WHERE delivered_at IS NULL ORDER BY received_at DESC`)
      .all();
  }

  delivered(id: string, result: unknown): void {
    this.database
      .prepare("UPDATE webhook_inbox SET delivered_at = ?, payload = NULL, error = NULL, result = ? WHERE id = ?")
      .run(Date.now(), JSON.stringify(result), id);
  }

  retry(receipt: InboxReceipt, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.database
      .prepare("UPDATE webhook_inbox SET attempts = attempts + 1, next_attempt_at = ?, error = ? WHERE id = ?")
      .run(
        Date.now() + Math.min(60_000, 1000 * 2 ** Math.min(receipt.attempts, 6)),
        message.slice(0, 1000),
        receipt.id,
      );
  }

  pruneDelivered(now = Date.now()): void {
    this.database.prepare("DELETE FROM webhook_inbox WHERE delivered_at < ?").run(now - 30 * 24 * 60 * 60_000);
  }

  close(): void {
    this.database.close();
  }
}
