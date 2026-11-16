import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTempDirectory } from "../../../../tests/harness/tempDirectory";
import { WebhookInbox } from "./webhookInbox";

describe("durable webhook inbox", () => {
  it("commits before acknowledgement, survives connection loss, and deduplicates transferred receipts", async () => {
    const directory = await createTempDirectory("webhook-inbox");
    const path = join(directory.path, "inbox.sqlite");
    let inbox = new WebhookInbox(path);
    const payload = {
      Event: "library.deleted",
      Server: { Id: "emby" },
      Item: { Id: "movie", Path: "/media/movie.strm", Type: "Movie" },
      Date: new Date().toISOString(),
    };
    try {
      const accepted = inbox.accept(payload);
      expect(inbox.database.pragma("synchronous", { simple: true })).toBe(2);
      inbox.close();
      inbox = new WebhookInbox(path);
      const receipt = inbox.due();
      expect(receipt).toMatchObject({ id: accepted.id, attempts: 0 });
      expect(inbox.accept(payload)).toMatchObject({ id: accepted.id, duplicate: true });
      if (!receipt) throw new Error("Missing committed receipt");
      inbox.retry(receipt, new Error("temporarily unavailable"));
      expect(inbox.due()).toBeUndefined();
      expect(inbox.pending()[0]).toMatchObject({ attempts: 1, error: "temporarily unavailable" });
      const reader = new WebhookInbox(path, true);
      try {
        expect(reader.pending()).toHaveLength(1);
        expect(() => reader.accept({ ...payload, Item: { Id: "other" } })).toThrow();
        inbox.delivered(accepted.id, { id: "domain-event" });
        expect(reader.pending()).toEqual([]);
      } finally {
        reader.close();
      }
      inbox.close();
      inbox = new WebhookInbox(path);
      expect(inbox.accept(payload)).toMatchObject({ id: accepted.id, duplicate: true });
      expect(inbox.pending()).toEqual([]);
      expect(inbox.database.prepare("SELECT payload FROM webhook_inbox").get()).toEqual({ payload: null });
    } finally {
      inbox.close();
      await directory.cleanup();
    }
  });
});
