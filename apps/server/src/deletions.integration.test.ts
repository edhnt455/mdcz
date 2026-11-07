import { createPersistenceDatabase, EmbyDeletionRepository, ScrapeConflictRepository } from "@mdcz/persistence";
import { afterEach, expect, it, vi } from "vitest";
import { closeTestServers, createTestServer, loginAsAdmin } from "./app.testSupport";

afterEach(async () => {
  vi.restoreAllMocks();
  await closeTestServers();
});

it("clears all finished deletion records while preserving unfinished work and media", async () => {
  const { fastify, services } = await createTestServer();
  const request = { method: "POST" as const, url: "/trpc/deletions.clearCompleted", payload: {} };
  expect((await fastify.inject(request)).statusCode).toBe(401);
  const token = await loginAsAdmin(fastify);
  const headers = { authorization: `Bearer ${token}` };
  await services.embyDeletion.close();
  const { database } = await services.persistence.getState();
  const events = new EmbyDeletionRepository(database);
  const conflicts = new ScrapeConflictRepository(database);
  const now = Date.now();
  const retained = [];
  for (let index = 0; index < 60; index++) {
    const { event } = events.enqueue({
      dedupKey: `event-${index}`,
      serverId: "server",
      itemId: `movie-${index}`,
      receivedAt: now + index,
      nextAttemptAt: now + 60_000,
      status: index % 2 ? "ignored" : "completed",
      completedAt: now,
    });
    if (index === 0) {
      services.embyDeletion.processingId = event.id;
      retained.push(`emby/${event.id}`);
    }
  }
  for (const status of ["pending", "needs_review"] as const) {
    const { event } = events.enqueue({
      dedupKey: status,
      serverId: "server",
      itemId: status,
      receivedAt: now,
      nextAttemptAt: now + 60_000,
      status,
    });
    retained.push(`emby/${event.id}`);
  }
  const version = {
    cloud: { target: { fileid: "cloud-file", path: "/cloud/movie.mp4" }, source: { sourcePath: "/Normal/movie.strm" } },
  };
  for (const step of [
    "validating",
    "deleting_cloud",
    "verifying_cloud",
    "cleaning_local",
    "retrying",
    "completed",
  ] as const) {
    conflicts.preview({
      itemId: step,
      taskId: "scrape-task",
      snapshotJson: JSON.stringify({
        library: { id: "library" },
        existing: version,
        incoming: version,
        previewedAt: now,
      }),
      token: step,
      keep: "existing",
      step,
    });
    if (step !== "completed") retained.push(`duplicate/${step}`);
  }
  conflicts.preview({ itemId: "preview", taskId: "scrape-task", token: "preview", snapshotJson: "{}" });
  const before = await services.deletions.list();
  expect(before.jobs.filter((job) => job.status === "completed" || job.status === "ignored")).toHaveLength(50);
  const fetcher = vi.spyOn(globalThis, "fetch");
  const response = await fastify.inject({ ...request, headers });
  expect(response.statusCode).toBe(200);
  expect(response.json().result.data).toEqual({ cleared: 60 });
  expect((await services.deletions.list()).jobs.map((job) => job.id).sort()).toEqual(retained.sort());
  expect(conflicts.get("preview")).toBeDefined();
  expect((await fastify.inject({ ...request, headers })).json().result.data).toEqual({ cleared: 0 });
  expect(fetcher).not.toHaveBeenCalled();
  fetcher.mockRestore();
  services.embyDeletion.processingId = null;
  const databasePath = services.persistence.databasePath;
  await fastify.close();
  const reopened = createPersistenceDatabase({ path: databasePath });
  try {
    expect(new EmbyDeletionRepository(reopened).jobs()).toHaveLength(3);
    expect(new ScrapeConflictRepository(reopened).jobs()).toHaveLength(5);
  } finally {
    reopened.close();
  }
});
