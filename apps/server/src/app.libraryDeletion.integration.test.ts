import { link, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { LibraryTaskGate } from "@mdcz/runtime/tasks";
import { afterEach, expect, it, vi } from "vitest";
import { closeTestServers, createTempRoot, createTestLibrary, createTestServer, loginAsAdmin } from "./app.testSupport";
import { LibraryDeletionService } from "./services/libraryDeletionService";

afterEach(closeTestServers);

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
  const response = await fastify.inject(request);
  expect(response.statusCode, response.body).toBe(200);
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

it("keeps failed files indexed, reports partial progress, and releases deletion task ownership", async () => {
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
  const { library } = state.repositories;
  for (const [id, relativePath] of [
    ["first", "first.mp4"],
    ["second", "escaped/second.mp4"],
    ["dir", "directory.mp4"],
    ["strm", "unbound.strm"],
  ])
    library.writeEntry({ id }, [{ fileId: id, rootId, rootRelativePath: relativePath }]);
  const request = (ids: string[]) =>
    fastify.inject({
      method: "POST",
      url: "/trpc/library.delete",
      headers: { authorization: `Bearer ${token}` },
      payload: { ids },
    });
  const failed = await request(["first", "second"]);
  expect(failed.statusCode).not.toBe(200);
  expect(failed.body).toContain("已删除 1 个文件");
  await expect(library.getEntryById("first")).rejects.toThrow("未找到");
  expect((await library.getEntryById("second")).files).toHaveLength(1);
  expect(await readFile(join(outside, "second.mp4"), "utf8")).toBe("outside");
  for (const id of ["dir", "strm"]) {
    expect((await request([id])).statusCode).not.toBe(200);
    expect((await library.getEntryById(id)).files).toHaveLength(1);
  }
  const gate = new LibraryTaskGate();
  let unblock!: (value: typeof state) => void;
  const blocked = new Promise<typeof state>((resolve) => {
    unblock = resolve;
  });
  const getState = vi.fn(() => blocked);
  const deletion = new LibraryDeletionService(
    { getState },
    () => services.config.get(),
    { delete: vi.fn() },
    gate,
    vi.fn(),
  );
  const running = deletion.delete({ ids: ["second"] });
  expect(() => gate.assertAvailable("scrape")).toThrow("深度删除正在运行");
  await expect(deletion.delete({ ids: ["second"] })).rejects.toThrow("深度删除正在运行");
  unblock(state);
  await expect(running).rejects.toThrow("超出媒体根目录");
  expect(() => gate.assertAvailable("scrape")).not.toThrow();
});
