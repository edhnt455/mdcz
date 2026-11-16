import { link, mkdir, readFile, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { closeTestServers, createTempRoot, createTestLibrary, createTestServer, loginAsAdmin } from "./app.testSupport";
import { LibraryDeletionService } from "./services/libraryDeletionService";

afterEach(async () => {
  await closeTestServers();
  vi.restoreAllMocks();
});

it.each(["file", "entry", "batch"] as const)("deep deletes disk media through the %s API", async (mode) => {
  const { fastify, services } = await createTestServer();
  const token = await loginAsAdmin(fastify);
  const source = await createTempRoot("library-delete-source");
  const output = await createTempRoot("library-delete-output");
  await createTestLibrary(fastify, token, source, { placement: "copy", outputPath: output });
  const root = await services.mediaRoots.ensurePath({ hostPath: output });
  const { library, pending } = (await services.persistence.getState()).repositories;
  for (const name of ["CD1.mp4", "CD2.mp4", "other.mp4"]) {
    await writeFile(join(source, name), name);
    if (mode === "file") await link(join(source, name), join(output, name));
    else if (mode === "entry") await symlink(join(source, name), join(output, name));
    else await writeFile(join(output, name), name);
  }
  for (const name of ["CD2.srt", "movie.nfo", "poster.jpg"]) await writeFile(join(output, name), name);
  library.writeEntry(
    { id: "movie" },
    ["CD1.mp4", "CD2.mp4"].map((name, index) => ({
      fileId: `cd${index + 1}`,
      rootId: root.id,
      rootRelativePath: name,
      retainedSourceIdentity: join(source, name),
    })),
  );
  library.writeEntry({ id: "other" }, [
    {
      fileId: "other",
      rootId: root.id,
      rootRelativePath: "other.mp4",
      retainedSourceIdentity: join(source, "other.mp4"),
    },
  ]);
  pending.upsert({ rootId: root.id, relativePath: "CD2.mp4", movieId: "movie", kind: "failed" });
  const request = {
    method: "POST" as const,
    headers: { authorization: `Bearer ${token}` },
    url: mode === "file" ? "/trpc/library.removeFile" : "/trpc/library.delete",
    payload: mode === "file" ? { fileId: "cd2" } : { ids: mode === "batch" ? ["movie", "other", "movie"] : ["movie"] },
  };
  expect((await fastify.inject({ ...request, headers: {} })).statusCode).toBe(401);
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const execute = LibraryDeletionService.prototype.execute;
  vi.spyOn(LibraryDeletionService.prototype, "execute").mockImplementation(async function (
    this: LibraryDeletionService,
    ...args
  ) {
    await blocked;
    return execute.apply(this, args);
  });
  try {
    const response = await fastify.inject(request);
    expect(response.statusCode, response.body).toBe(200);
    const taskIds = response.json().result.data.taskIds as string[];
    expect(taskIds).toHaveLength(mode === "file" ? 1 : mode === "entry" ? 2 : 3);
    expect((await fastify.inject(request)).json().result.data.taskIds).toEqual(taskIds);
    await expect
      .poll(async () => (await services.pending.jobs()).jobs.some((job) => job.status === "running"))
      .toBe(true);
    for (const name of ["CD1.mp4", "CD2.mp4", "other.mp4"])
      expect(await readFile(join(output, name), "utf8")).toBe(name);
    const read = await fastify.inject({ method: "GET", url: "/trpc/pending.jobs", headers: request.headers });
    expect(read.statusCode).toBe(200);
    const conflict = await fastify.inject({
      method: "POST",
      url: "/trpc/library.edit.start",
      headers: request.headers,
      payload: { ids: ["movie"], edit: { field: "studio", operation: "set", value: "studio" } },
    });
    expect(conflict.statusCode).toBe(409);
  } finally {
    release();
  }
  await services.pending.waitForIdle();
  expect((await services.pending.jobs()).jobs.every((job) => job.status === "completed")).toBe(true);
  const removed =
    mode === "file" ? ["CD2.mp4"] : mode === "entry" ? ["CD1.mp4", "CD2.mp4"] : ["CD1.mp4", "CD2.mp4", "other.mp4"];
  for (const name of removed) {
    await expect(readFile(join(output, name))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(source, name))).rejects.toMatchObject({ code: "ENOENT" });
  }
  if (mode === "file") expect((await library.getEntryById("movie")).files.map((file) => file.id)).toEqual(["cd1"]);
  else await expect(library.getEntryById("movie")).rejects.toThrow("未找到");
  if (mode !== "batch") expect(await readFile(join(output, "other.mp4"), "utf8")).toBe("other.mp4");
  else expect(await library.listEntries()).toEqual([]);
  expect(pending.list()).toEqual([]);
  for (const name of ["CD2.srt", "movie.nfo", "poster.jpg"])
    expect(await readFile(join(output, name), "utf8")).toBe(name);
});

it("continues after failed deletions, protects queued file identity and retries repaired files", async () => {
  const { fastify, services } = await createTestServer();
  const token = await loginAsAdmin(fastify);
  const directory = await createTempRoot("library-delete-failure");
  const outside = await createTempRoot("library-delete-outside");
  const { rootId } = await createTestLibrary(fastify, token, directory, { placement: "inPlace", outputPath: "" });
  await writeFile(join(directory, "first.mp4"), "first");
  await writeFile(join(outside, "second.mp4"), "outside");
  await symlink(outside, join(directory, "escaped"));
  await mkdir(join(directory, "directory.mp4"));
  const state = await services.persistence.getState();
  const { library, pendingActions } = state.repositories;
  for (const [id, relativePath] of [
    ["first", "first.mp4"],
    ["second", "escaped/second.mp4"],
    ["dir", "directory.mp4"],
    ["strm", "unbound.strm"],
    ["last", "last.mp4"],
  ])
    library.writeEntry({ id }, [{ fileId: id, rootId, rootRelativePath: relativePath }]);
  const request = (ids: string[]) =>
    fastify.inject({
      method: "POST",
      url: "/trpc/library.delete",
      headers: { authorization: `Bearer ${token}` },
      payload: { ids },
    });
  await writeFile(join(directory, "last.mp4"), "last");
  const submitted = await request(["first", "second", "dir", "strm", "last"]);
  expect(submitted.statusCode, submitted.body).toBe(200);
  await services.pending.waitForIdle();
  const jobs = (await services.pending.jobs()).jobs;
  expect(jobs.filter((job) => job.status === "completed")).toHaveLength(2);
  expect(jobs.filter((job) => job.status === "failed")).toHaveLength(3);
  await expect(library.getEntryById("last")).rejects.toThrow("未找到");
  await expect(library.getEntryById("first")).rejects.toThrow("未找到");
  expect((await library.getEntryById("second")).files).toHaveLength(1);
  expect(await readFile(join(outside, "second.mp4"), "utf8")).toBe("outside");
  for (const id of ["dir", "strm"]) expect((await library.getEntryById(id)).files).toHaveLength(1);
  const failed = jobs.find((job) => job.item.fileName === "second.mp4");
  if (!failed) throw new Error("Missing failed deletion");
  expect(failed.canRetry).toBe(true);
  await unlink(join(directory, "escaped"));
  await mkdir(join(directory, "escaped"));
  await writeFile(join(directory, "escaped/second.mp4"), "repaired");
  const retry = await fastify.inject({
    method: "POST",
    url: "/trpc/pending.retryJob",
    headers: { authorization: `Bearer ${token}` },
    payload: { id: failed.id },
  });
  expect(retry.statusCode, retry.body).toBe(200);
  await services.pending.waitForIdle();
  expect((await services.pending.jobs()).jobs.find((job) => job.id === retry.json().result.data.taskId)?.status).toBe(
    "completed",
  );
  await expect(library.getEntryById("second")).rejects.toThrow("未找到");
  expect(await readFile(join(outside, "second.mp4"), "utf8")).toBe("outside");
  await writeFile(join(directory, "changed.mp4"), "original");
  library.writeEntry({ id: "changed" }, [{ fileId: "changed", rootId, rootRelativePath: "changed.mp4" }]);
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const execute = LibraryDeletionService.prototype.execute;
  const paused = vi.spyOn(LibraryDeletionService.prototype, "execute").mockImplementation(async function (
    this: LibraryDeletionService,
    ...args
  ) {
    await blocked;
    return execute.apply(this, args);
  });
  try {
    const accepted = await request(["changed"]);
    expect(accepted.statusCode).toBe(200);
    expect(pendingActions.list().some((job) => JSON.parse(job.inputJson).libraryFile?.fileId === "changed")).toBe(true);
    library.writeEntry({ id: "changed" }, [{ fileId: "changed", rootId, rootRelativePath: "changed.mp4", size: 999 }]);
  } finally {
    release();
  }
  await services.pending.waitForIdle();
  expect((await services.pending.jobs()).jobs.find((job) => job.item.fileName === "changed.mp4")).toMatchObject({
    status: "failed",
    error: expect.stringContaining("任务提交后媒体文件记录已变化"),
  });
  expect(await readFile(join(directory, "changed.mp4"), "utf8")).toBe("original");
  paused.mockRestore();
});
