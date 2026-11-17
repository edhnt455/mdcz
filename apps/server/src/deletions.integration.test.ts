import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createPersistenceDatabase, EmbyDeletionRepository, ScrapeConflictRepository } from "@mdcz/persistence";
import { afterEach, expect, it, vi } from "vitest";
import { closeTestServers, createTempRoot, createTestLibrary, createTestServer, loginAsAdmin } from "./app.testSupport";

afterEach(async () => {
  vi.restoreAllMocks();
  await closeTestServers();
});

it.each([
  "current",
  "missing",
  "changed",
  "reimported",
  "active",
  "pending changed",
] as const)("manually resolves a library deletion with %s record", async (scenario) => {
  const { fastify, services } = await createTestServer();
  const token = await loginAsAdmin(fastify);
  const headers = { authorization: `Bearer ${token}` };
  const directory = await createTempRoot("manual-library-delete");
  const { rootId } = await createTestLibrary(fastify, token, directory, { placement: "inPlace", outputPath: "" });
  const state = await services.persistence.getState();
  const { library } = state.repositories;
  const filePath = join(directory, "missing.strm");
  await writeFile(filePath, "untouched");
  library.writeEntry({ id: "movie" }, [
    { fileId: "file", rootId, rootRelativePath: "missing.strm" },
    { fileId: "other", rootId, rootRelativePath: "other.strm" },
  ]);
  const submitted = await fastify.inject({
    method: "POST",
    url: "/trpc/library.removeFile",
    headers,
    payload: { fileId: "file" },
  });
  expect(submitted.statusCode).toBe(200);
  const taskId = submitted.json().result.data.taskIds[0] as string;
  await services.pending.waitForIdle();
  expect((await services.deletions.detail(`action/${taskId}`)).status).toBe("needs_review");
  state.database.sqlite
    .prepare(
      `INSERT INTO pending_actions SELECT 'duplicate', item_id, item_updated_at, action, input_json, item_json, status, progress, error, attempts, next_attempt_at, created_at, updated_at, completed_at FROM pending_actions WHERE id = ?`,
    )
    .run(taskId);
  if (scenario === "changed")
    library.writeEntry({ id: "movie" }, [{ fileId: "file", rootId, rootRelativePath: "missing.strm", size: 999 }]);
  if (scenario === "missing" || scenario === "reimported") library.removeFile("file");
  if (scenario === "reimported")
    library.writeEntry({ id: "movie" }, [{ fileId: "replacement", rootId, rootRelativePath: "missing.strm" }]);
  if (scenario === "pending changed")
    state.repositories.pending.upsert(
      { rootId, relativePath: "missing.strm", kind: "uncensored" },
      new Date(Date.now() + 5000),
    );
  if (scenario === "active")
    state.database.sqlite
      .prepare(
        `INSERT INTO pending_actions SELECT 'active', item_id, item_updated_at, action, input_json, item_json, 'queued', progress, error, attempts, next_attempt_at, created_at, updated_at, completed_at FROM pending_actions WHERE id = ?`,
      )
      .run(taskId);
  const request = {
    method: "POST" as const,
    url: "/trpc/deletions.resolveManually",
    payload: { id: `action/${scenario === "current" ? "duplicate" : taskId}` },
  };
  expect((await fastify.inject(request)).statusCode).toBe(401);
  const fetcher = vi.spyOn(globalThis, "fetch");
  const response = await fastify.inject({ ...request, headers });
  expect(fetcher).not.toHaveBeenCalled();
  if (["changed", "reimported", "active", "pending changed"].includes(scenario)) {
    expect(response.statusCode).not.toBe(200);
    expect((await services.deletions.detail(`action/${taskId}`)).status).toBe("needs_review");
  } else {
    expect(response.statusCode, response.body).toBe(200);
    const jobs = (await services.deletions.list()).jobs;
    expect(jobs.filter((job) => job.result === "manual_cleanup")).toHaveLength(2);
    expect(jobs.filter((job) => job.result === "manual_cleanup").every((job) => job.status === "completed")).toBe(true);
    expect((await library.getEntryById("movie")).files.map((file) => file.id)).toEqual(["other"]);
  }
  expect(await readFile(filePath, "utf8")).toBe("untouched");
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
      services.embyDeletion.processing.set(event.id, Promise.resolve());
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
  for (const step of ["validating", "deleting_cloud", "cleaning_local", "retrying", "completed"] as const) {
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
  expect(before.jobs.filter((job) => job.status === "completed" || job.status === "ignored")).toHaveLength(60);
  const fetcher = vi.spyOn(globalThis, "fetch");
  const response = await fastify.inject({ ...request, headers });
  expect(response.statusCode).toBe(200);
  expect(response.json().result.data).toEqual({ cleared: 60 });
  expect((await services.deletions.list()).jobs.map((job) => job.id).sort()).toEqual(retained.sort());
  expect(conflicts.get("preview")).toBeDefined();
  expect((await fastify.inject({ ...request, headers })).json().result.data).toEqual({ cleared: 0 });
  expect(fetcher).not.toHaveBeenCalled();
  fetcher.mockRestore();
  services.embyDeletion.processing.clear();
  const databasePath = services.persistence.databasePath;
  await fastify.close();
  const reopened = createPersistenceDatabase({ path: databasePath });
  try {
    expect(new EmbyDeletionRepository(reopened).jobs()).toHaveLength(3);
    expect(new ScrapeConflictRepository(reopened).jobs()).toHaveLength(4);
  } finally {
    reopened.close();
  }
});
