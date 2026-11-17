import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { closeTestServers, createTempRoot, createTestLibrary, createTestServer, loginAsAdmin } from "./app.testSupport";
import { PendingDeletionService } from "./services/pendingDeletionService";

afterEach(async () => {
  await closeTestServers();
  vi.restoreAllMocks();
});

it("unifies queued deletions, preserves failure recovery and clears completed tasks", async () => {
  const root = await createTempRoot("pending-workflow");
  for (const name of ["first.strm", "second.strm"]) await writeFile(join(root, name), "original STRM");
  const { fastify, services } = await createTestServer();
  const token = await loginAsAdmin(fastify);
  const headers = { authorization: `Bearer ${token}` };
  const library = await createTestLibrary(fastify, token, root, { placement: "inPlace" });
  const { pending } = (await services.persistence.getState()).repositories;
  for (const relativePath of ["first.strm", "second.strm", "new.mp4"])
    pending.upsert({ ...library, kind: relativePath === "new.mp4" ? "new_file" : "failed", relativePath });
  const first = pending.list().find((item) => item.relativePath === "first.strm");
  const second = pending.list().find((item) => item.relativePath === "second.strm");
  if (!first || !second) throw new Error("Missing fixtures");
  let release!: () => void;
  const running = new Promise<void>((resolve) => {
    release = resolve;
  });
  const execute = vi.spyOn(PendingDeletionService.prototype, "delete").mockImplementation(async (id, progress) => {
    progress?.("115 已删除，正在清理 STRM");
    if (id === first.id) {
      pending.saveDeletion(id, pending.get(id).updatedAt, '{"step":"cleaning_source"}');
      await running;
      throw new Error("Source cleanup denied");
    }
    pending.delete([id]);
  });
  const request = (procedure: string, payload: object) =>
    fastify.inject({ method: "POST", url: `/trpc/${procedure}`, headers, payload });
  try {
    expect((await fastify.inject({ method: "GET", url: "/trpc/pending.jobs" })).statusCode).toBe(401);
    expect((await services.pending.list()).items.map((item) => item.fileName).sort()).toEqual([
      "first.strm",
      "second.strm",
    ]);
    expect((await services.pending.list(true)).items.map((item) => item.fileName)).toEqual(["new.mp4"]);
    const accepted = await request("pending.delete", { id: first.id });
    expect(accepted.statusCode).toBe(200);
    const jobId = accepted.json().result.data.taskId as string;
    expect((await request("pending.delete", { id: first.id })).json().result.data.taskId).toBe(jobId);
    await expect.poll(() => execute.mock.calls.length).toBe(1);
    expect((await services.pending.list()).items.map((item) => item.id)).toEqual([second.id]);
    expect((await services.pending.jobs()).jobs.find((job) => job.id === jobId)).toMatchObject({
      status: "running",
      progress: "115 已删除，正在清理 STRM",
    });
    expect((await request("pending.ignore", { id: first.id })).statusCode).not.toBe(200);
    const next = await request("pending.delete", { id: second.id });
    expect(next.statusCode).toBe(200);
    expect((await services.pending.jobs()).jobs.map((job) => [job.id, job.status])).toEqual([
      [jobId, "running"],
      [next.json().result.data.taskId, "queued"],
    ]);
    expect((await services.deletions.list()).jobs.map((job) => [job.id, job.status, job.source])).toEqual([
      [`action/${jobId}`, "running", "pending"],
      [`action/${next.json().result.data.taskId}`, "pending", "pending"],
    ]);
    expect((await services.pending.list()).items).toEqual([]);
    await writeFile(join(root, "second.strm"), "replaced STRM");
    release();
    await services.pending.waitForIdle();
    expect(execute).toHaveBeenCalledTimes(1);
    const failed = (await services.pending.jobs()).jobs;
    expect(failed.every((job) => job.status === "failed")).toBe(true);
    expect(failed.find((job) => job.itemId === second.id)?.error).toContain("STRM 文件已变化");
    expect((await services.pending.list()).items).toEqual([]);
    expect(await services.deletions.detail(`action/${jobId}`)).toMatchObject({
      status: "needs_review",
      error: "Source cleanup denied",
      canRetry: true,
    });
    const retry = await request("deletions.retry", { id: `action/${next.json().result.data.taskId}` });
    expect(retry.statusCode).toBe(200);
    await services.pending.waitForIdle();
    expect((await services.pending.list()).items).toEqual([]);
    const retriedId = retry.json().result.data.jobId as string;
    expect((await services.deletions.list()).jobs.map((job) => [job.id, job.status])).toEqual([
      [`action/${jobId}`, "needs_review"],
      [retriedId, "completed"],
    ]);
    expect(await services.deletions.clearCompleted()).toEqual({ cleared: 1 });
    expect((await services.deletions.list()).jobs.map((job) => job.id)).toEqual([`action/${jobId}`]);
  } finally {
    release();
  }
});
