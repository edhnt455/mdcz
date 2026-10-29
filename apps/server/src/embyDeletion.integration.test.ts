import { join } from "node:path";
import { EmbyDeletionRepository } from "@mdcz/persistence";
import { afterEach, expect, it } from "vitest";
import { closeTestServers, createTempRoot, createTestLibrary, createTestServer, loginAsAdmin } from "./app.testSupport";

afterEach(closeTestServers);

it("authenticates webhook and management routes, validates input, persists notifications and revokes rotated secrets", async () => {
  const { fastify, services } = await createTestServer();
  expect((await fastify.inject({ url: "/trpc/embyDeletion.status" })).statusCode).toBe(401);
  expect((await fastify.inject({ url: "/trpc/deletions.list" })).statusCode).toBe(401);
  expect(
    (await fastify.inject({ method: "POST", url: "/trpc/deletions.retry", payload: { id: "emby/test" } })).statusCode,
  ).toBe(401);
  for (const route of ["configureMoviePilot", "testMoviePilot", "bindSources"]) {
    expect((await fastify.inject({ method: "POST", url: `/trpc/embyDeletion.${route}`, payload: {} })).statusCode).toBe(
      401,
    );
  }
  const admin = await loginAsAdmin(fastify);
  const headers = { authorization: `Bearer ${admin}` };
  const source = await createTempRoot("emby-normal");
  const output = await createTempRoot("emby-link");
  const { libraryId } = await createTestLibrary(fastify, admin, source, { outputPath: output });
  const rotate = () => fastify.inject({ method: "POST", url: "/trpc/embyDeletion.rotateSecret", headers, payload: {} });
  const rotated = await rotate();
  expect(rotated.statusCode).toBe(200);
  const secret = rotated.json().result.data.token as string;
  const configured = await fastify.inject({
    method: "POST",
    url: "/trpc/embyDeletion.configure",
    headers,
    payload: { mode: "observe", serverId: "emby-1", libraryIds: [libraryId] },
  });
  expect(configured.statusCode).toBe(200);
  const state = await services.persistence.getState();
  const root = await state.repositories.mediaRoots.ensurePath(output);
  await state.repositories.library.upsertEntry({
    movie: { id: "movie", number: "ABC-123" },
    files: [{ fileId: "video", rootId: root.id, rootRelativePath: "ABC-123.mp4" }],
  });
  const payload = {
    Event: "library.deleted",
    Date: new Date().toISOString(),
    Server: { Id: "emby-1" },
    Item: { Id: "42", Type: "Movie", Path: join(output, "ABC-123.mp4") },
  };
  const request = { method: "POST" as const, url: `/api/webhooks/emby/${secret}`, payload };
  expect((await fastify.inject({ ...request, url: "/api/webhooks/emby/incorrect" })).statusCode).toBe(401);
  expect((await fastify.inject({ ...request, payload: { Event: "library.deleted" } })).statusCode).toBe(400);
  const accepted = await fastify.inject(request);
  expect(accepted.statusCode).toBe(202);
  expect(accepted.json()).toMatchObject({ status: "pending", duplicate: false });
  const repeated = await fastify.inject(request);
  expect(repeated.statusCode).toBe(200);
  expect(repeated.json()).toMatchObject({ id: accepted.json().id, duplicate: true });
  const status = await fastify.inject({ url: "/trpc/embyDeletion.status", headers });
  expect(status.json().result.data).toMatchObject({
    configured: true,
    counts: { pending: 1 },
    libraries: [{ id: libraryId, outputPath: output }],
  });
  expect(status.body).not.toContain(secret);
  expect(status.body).not.toContain("secretHash");
  expect(status.json().result.data).not.toHaveProperty("recent");
  const jobs = await fastify.inject({ url: "/trpc/deletions.list", headers });
  const jobId = `emby/${accepted.json().id}`;
  expect(jobs.json().result.data.jobs).toEqual([
    expect.objectContaining({
      id: jobId,
      source: "emby",
      name: "ABC-123",
      status: "pending",
      step: "validating",
      canRetry: true,
    }),
  ]);
  const detail = await fastify.inject({
    url: `/trpc/deletions.detail?input=${encodeURIComponent(JSON.stringify({ id: jobId }))}`,
    headers,
  });
  expect(detail.json().result.data.linkPath).toBe(join(output, "ABC-123.mp4"));
  expect(detail.body).not.toContain(secret);
  const retry = await fastify.inject({ method: "POST", url: "/trpc/deletions.retry", headers, payload: { id: jobId } });
  expect(retry.statusCode).toBe(200);
  expect(retry.json().result.data).toEqual({ runId: null });
  new EmbyDeletionRepository(state.database).update(accepted.json().id, {
    attempts: 1,
    step: "cleaning_records",
    result: "confirming_source_cleanup",
  });
  expect(await services.deletions.detail(jobId)).toMatchObject({ status: "pending", error: null, cloudPlanned: false });
  await rotate();
  expect((await fastify.inject(request)).statusCode).toBe(401);
  expect((await services.embyDeletion.reconcile()).queued).toBe(1);
});
