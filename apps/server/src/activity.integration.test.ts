import { ActivityRepository, createPersistenceDatabase } from "@mdcz/persistence";
import { afterEach, expect, it } from "vitest";
import { closeTestServers, createTempRoot, createTestServer, loginAsAdmin } from "./app.testSupport";

afterEach(closeTestServers);

it("authenticates activity clearing and persists it without deleting tasks or scan results", async () => {
  const { fastify, services } = await createTestServer();
  const request = { method: "POST" as const, url: "/trpc/activity.clearCompleted", payload: {} };
  expect((await fastify.inject(request)).statusCode).toBe(401);
  const token = await loginAsAdmin(fastify);
  const headers = { authorization: `Bearer ${token}` };
  const { root } = await services.mediaRoots.admitDirectory({ hostPath: await createTempRoot("activity") });
  const { repositories } = await services.persistence.getState();
  const scan = await repositories.scanTasks.create({ rootId: root.id });
  await repositories.scanTasks.claim(scan.id);
  await repositories.scanTasks.complete({
    taskId: scan.id,
    rootId: root.id,
    results: [{ relativePath: "movie.mp4", size: 1, modifiedAt: null }],
    directoryCount: 1,
  });
  const run = await repositories.scrapeRuns.create({
    rootId: root.id,
    libraryId: "library",
    executionMode: "single",
    items: [],
  });
  await repositories.scrapeRuns.finalize({ runId: run.id, disposition: "failed", error: "Target already exists" });
  const queued = await repositories.scanTasks.create({ rootId: root.id });
  const notifications: unknown[] = [];
  const unsubscribe = services.taskEvents.subscribe((event) => notifications.push(event));
  const response = await fastify.inject({ ...request, headers });
  expect(response.statusCode).toBe(200);
  expect(response.json().result.data).toEqual({ cleared: 2 });
  expect(notifications).toContainEqual({ kind: "invalidate", resources: ["activity"] });
  unsubscribe();
  const activity = await fastify.inject({ method: "GET", url: "/trpc/activity.list", headers });
  expect(activity.json().result.data.entries).toMatchObject([{ id: queued.id, status: "queued" }]);
  expect((await services.scrape.history()).runs).toMatchObject([{ id: run.id }]);
  expect(await repositories.scanTasks.listScanResults(scan.id)).toHaveLength(1);
  expect((await fastify.inject({ ...request, headers })).json().result.data).toEqual({ cleared: 0 });
  const databasePath = services.persistence.databasePath;
  await fastify.close();
  const reopened = createPersistenceDatabase({ path: databasePath });
  try {
    expect([...new ActivityRepository(reopened).listCleared().keys()].sort()).toEqual([
      `scan:${scan.id}`,
      `scrape:${run.id}`,
    ]);
  } finally {
    reopened.close();
  }
});
