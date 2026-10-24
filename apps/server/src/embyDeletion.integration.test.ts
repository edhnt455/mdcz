import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { closeTestServers, createTempRoot, createTestLibrary, createTestServer, loginAsAdmin } from "./app.testSupport";

afterEach(closeTestServers);

it("authenticates webhook and management routes, validates input, persists notifications and revokes rotated secrets", async () => {
  const { fastify, services } = await createTestServer();
  expect((await fastify.inject({ url: "/trpc/embyDeletion.status" })).statusCode).toBe(401);
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
  await rotate();
  expect((await fastify.inject(request)).statusCode).toBe(401);
  expect((await services.embyDeletion.reconcile()).queued).toBe(1);
});
