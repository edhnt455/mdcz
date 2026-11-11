import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createPersistenceDatabase,
  EmbyDeletionRepository,
  LibraryRepository,
  MediaRootRepository,
  PendingRepository,
  runMigrations,
} from "@mdcz/persistence";
import type { MediaLibrary } from "@mdcz/runtime/library";
import { defaultConfiguration } from "@mdcz/shared/config";
import { type MoviePilotFile, moviePilotResourceIdentity } from "@mdcz/shared/moviePilot";
import { afterEach, expect, test, vi } from "vitest";
import { PendingDeletionService } from "./pendingDeletionService";
import type { ServerPersistenceService } from "./persistenceService";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function fixture() {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "mdcz-pending-delete-")));
  const normal = path.join(directory, "Normal");
  const link = path.join(directory, "Link");
  for (const root of [normal, link]) {
    await mkdir(root);
    await writeFile(path.join(root, ".mdcz-library-id"), root);
  }
  const sourcePath = path.join(normal, "ABC-123.strm");
  const content = "https://mp.test/api/v1/plugin/P115StrmHelper/redirect_url?pickcode=code\n";
  await writeFile(sourcePath, content);
  const database = createPersistenceDatabase({ path: path.join(directory, "db.sqlite") });
  runMigrations(database);
  cleanups.push(async () => {
    database.close();
    await rm(directory, { recursive: true, force: true });
  });
  const mediaRoots = new MediaRootRepository(database);
  const root = await mediaRoots.ensurePath(normal);
  const library = new LibraryRepository(database);
  const pending = new PendingRepository(database);
  pending.upsert({ rootId: root.id, relativePath: "ABC-123.strm", libraryId: "library", kind: "failed" });
  const id = pending.list()[0].id;
  const configuration = structuredClone(defaultConfiguration);
  const cloudRoot: MoviePilotFile = {
    storage: "u115",
    type: "dir",
    path: "/AV/",
    name: "AV",
    fileid: "root",
    parent_fileid: "0",
  };
  const target: MoviePilotFile = {
    storage: "u115",
    type: "file",
    path: "/AV/source.mp4",
    fileid: "115-file",
    parent_fileid: "root",
    pickcode: "code",
    size: 1024,
  };
  const remote = {
    files: [target],
    reject: false,
    loseResponse: false,
    verifyFails: false,
    deleted: [] as string[],
    beforeDelete: undefined as (() => Promise<void>) | undefined,
  };
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    const endpoint = new URL(String(url)).pathname;
    if (endpoint.endsWith("/options")) return Response.json({ success: true, message: "", data: [{ type: "u115" }] });
    const body = JSON.parse(String(init?.body)) as MoviePilotFile;
    if (endpoint.endsWith("/delete")) {
      await remote.beforeDelete?.();
      if (remote.reject) return Response.json({ success: false, message: "denied", data: null });
      remote.deleted.push(body.fileid);
      remote.files = remote.files.filter((file) => file.fileid !== body.fileid);
      if (remote.loseResponse) throw new Error("lost response");
      return Response.json({ success: true, message: "", data: null });
    }
    if (remote.verifyFails && remote.deleted.length) throw new Error("verification unavailable");
    const data = body.fileid === "0" ? [cloudRoot] : remote.files.filter((file) => file.parent_fileid === body.fileid);
    return Response.json(
      { success: true, message: "", data },
      {
        headers: {
          "X-Total-Count": String(data.length),
          "X-Result-Count": String(data.length),
        },
      },
    );
  });
  configuration.embyDeletion.moviePilot = {
    id: "connection",
    baseUrl: "https://mp.test",
    storage: "u115",
    rootPath: "/AV",
    root: cloudRoot,
    token: "token",
  };
  configuration.embyDeletion.libraries = [
    {
      id: "library",
      outputPath: link,
      realPath: link,
      marker: link,
      source: { path: normal, realPath: normal, marker: normal },
    },
  ];
  let busy = false;
  const logger = { info: vi.fn(), error: vi.fn() };
  const deps = {
    persistence: {
      getState: async () => ({ database, repositories: { pending, mediaRoots, library } }),
    } as unknown as Pick<ServerPersistenceService, "getState">,
    config: { get: async () => configuration },
    libraries: {
      get: async () => ({ id: "library", placement: "copy", sourcePath: normal, outputPath: link }) as MediaLibrary,
    },
    isBusy: () => busy,
    invalidate: vi.fn(),
    moviePilotFetch: fetcher,
    logger,
  };
  return {
    id,
    sourcePath,
    content,
    remote,
    pending,
    library,
    mediaRoots,
    link,
    configuration,
    fetcher,
    logger,
    repository: new EmbyDeletionRepository(database),
    restart: () => new PendingDeletionService(deps),
    setBusy: () => {
      busy = true;
    },
  };
}

test.each([false, true])("deletes verified 115, STRM and pending records (published: %s)", async (published) => {
  const f = await fixture();
  const service = f.restart();
  const linkPath = path.join(f.link, "ABC-123.strm");
  if (published) {
    await writeFile(linkPath, f.content);
    const root = await f.mediaRoots.ensurePath(f.link);
    const entry = await f.library.upsertEntry({
      movie: { number: "ABC-123" },
      files: [
        {
          fileId: "published",
          rootId: root.id,
          rootRelativePath: "ABC-123.strm",
          strmSourceJson: JSON.stringify({
            sourcePath: f.sourcePath,
            sha256: createHash("sha256").update(f.content).digest("hex"),
            resourceIdentity: moviePilotResourceIdentity(f.content.trim()),
          }),
        },
      ],
    });
    f.pending.delete([f.id]);
    f.pending.upsert({
      rootId: root.id,
      relativePath: "ABC-123.strm",
      libraryId: "library",
      kind: "uncensored",
      movieId: entry.id,
    });
    f.id = f.pending.list()[0].id;
    const file = f.repository.findFile(linkPath);
    if (!file) throw new Error("Expected a published STRM");
    f.repository.bind({
      fileId: file.id,
      libraryId: "library",
      linkPath,
      sourcePath: f.sourcePath,
      blocked: false,
      snapshotJson: JSON.stringify({
        connectionId: "connection",
        fileUpdatedAt: file.updatedAt.getTime(),
        source: JSON.parse(file.strmSourceJson ?? "{}"),
        target: f.remote.files[0],
        ancestors: [f.configuration.embyDeletion.moviePilot?.root],
      }),
    });
  } else {
    f.remote.files.push({
      storage: "u115",
      type: "dir",
      path: "/AV/Unrelated/",
      name: "Unrelated",
      fileid: "unrelated",
      parent_fileid: "root",
    });
    f.remote.files.push({ ...f.remote.files[0], fileid: "second", path: "/AV/second.mp4", pickcode: "second" });
    f.remote.files.push({ ...f.remote.files[0], fileid: "stale", path: "/AV/stale.mp4", pickcode: "stale" });
  }
  f.remote.beforeDelete = async () => {
    expect(await readFile(f.sourcePath, "utf8")).toBe(f.content);
    expect(f.pending.get(f.id).deletionJson).toContain("deleting_cloud");
  };
  await service.delete(f.id);
  expect(f.remote.deleted).toEqual(["115-file"]);
  await expect(readFile(f.sourcePath)).rejects.toMatchObject({ code: "ENOENT" });
  expect(f.pending.list()).toEqual([]);
  expect(f.repository.binding(`pending:${f.id}`)?.blocked).toBe(true);
  if (published) {
    await expect(readFile(linkPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await f.library.listEntries()).toEqual([]);
    expect(f.logger.info).toHaveBeenCalledWith(expect.stringContaining("复用已核验的 115 来源关联"));
    expect(f.logger.info).not.toHaveBeenCalledWith(expect.stringContaining("开始建立 115 来源索引"));
  } else {
    const root = await f.mediaRoots.ensurePath(path.dirname(f.sourcePath));
    const secondPath = path.join(path.dirname(f.sourcePath), "second.strm");
    await writeFile(secondPath, f.content.replace("pickcode=code", "pickcode=second"));
    f.pending.upsert({ rootId: root.id, relativePath: "second.strm", libraryId: "library", kind: "failed" });
    f.remote.beforeDelete = undefined;
    await service.delete(f.pending.list()[0].id);
    expect(f.remote.deleted).toEqual(["115-file", "second"]);
    await expect(readFile(secondPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      f.fetcher.mock.calls.filter(([, init]) => init?.body && JSON.parse(String(init.body)).fileid === "unrelated"),
    ).toHaveLength(1);
    expect(f.logger.info).toHaveBeenCalledWith(expect.stringContaining("复用 115 来源索引"));
    expect(f.pending.list()).toEqual([]);
    const stale = f.remote.files.find((file) => file.fileid === "stale");
    if (!stale) throw new Error("Expected a cached file");
    stale.size = 2048;
    await writeFile(
      path.join(path.dirname(f.sourcePath), "stale.strm"),
      f.content.replace("pickcode=code", "pickcode=stale"),
    );
    f.pending.upsert({ rootId: root.id, relativePath: "stale.strm", libraryId: "library", kind: "failed" });
    const staleId = f.pending.list()[0].id;
    await expect(service.delete(staleId)).rejects.toThrow("目标身份已变化");
    expect(f.remote.deleted).toEqual(["115-file", "second"]);
    expect(f.pending.get(staleId).deletionJson).toBeNull();
    f.pending.delete([staleId]);
    f.logger.error.mockClear();
    for (const reason of ["expired", "missing", "connection"]) {
      const code = `next-${reason}`;
      f.remote.files.push({
        storage: "u115",
        type: "file",
        fileid: code,
        pickcode: code,
        path: `/AV/${code}.mp4`,
        parent_fileid: "root",
        size: 1024,
      });
      await writeFile(
        path.join(path.dirname(f.sourcePath), `${code}.strm`),
        f.content.replace("pickcode=code", `pickcode=${code}`),
      );
      f.pending.upsert({ rootId: root.id, relativePath: `${code}.strm`, libraryId: "library", kind: "failed" });
      const clock = reason === "expired" ? vi.spyOn(Date, "now").mockReturnValue(Date.now() + 5 * 60_000 + 1) : null;
      if (reason === "connection" && f.configuration.embyDeletion.moviePilot)
        f.configuration.embyDeletion.moviePilot.id = "new-connection";
      try {
        await service.delete(f.pending.list()[0].id);
      } finally {
        clock?.mockRestore();
      }
    }
    expect(
      f.fetcher.mock.calls.filter(([, init]) => init?.body && JSON.parse(String(init.body)).fileid === "unrelated"),
    ).toHaveLength(4);
    expect(f.remote.deleted).toEqual(["115-file", "second", "next-expired", "next-missing", "next-connection"]);
    expect(f.pending.list()).toEqual([]);
  }
  expect(f.logger.info).toHaveBeenCalledWith(expect.stringContaining("删除完成"));
  expect(f.logger.error).not.toHaveBeenCalled();
});

test.each([
  "denied",
  "verification unavailable",
  "replacement",
  "lost response",
] as const)("preserves retry evidence and local files after %s", async (scenario) => {
  const f = await fixture();
  const service = f.restart();
  if (scenario === "denied") {
    f.fetcher.mockRejectedValueOnce(new Error("index unavailable"));
    await expect(service.delete(f.id)).rejects.toThrow("连接失败");
    expect(f.pending.get(f.id).deletionJson).toBeNull();
  }
  f.remote.reject = scenario === "denied";
  f.remote.verifyFails = scenario === "verification unavailable";
  f.remote.loseResponse = scenario === "lost response";
  if (scenario === "replacement")
    f.remote.beforeDelete = async () => {
      await writeFile(f.sourcePath, "replacement");
    };
  await expect(service.delete(f.id)).rejects.toThrow();
  expect(f.logger.error).toHaveBeenCalledWith(expect.stringContaining("删除失败"));
  expect(await readFile(f.sourcePath, "utf8")).toBe(scenario === "replacement" ? "replacement" : f.content);
  expect(f.pending.get(f.id).deletionJson).toBeTruthy();
  if (scenario === "lost response") {
    await expect(f.restart().delete(f.id)).rejects.toThrow("没有删除成功记录");
    expect(f.remote.deleted).toEqual(["115-file"]);
    return;
  }
  f.remote.reject = false;
  f.remote.verifyFails = false;
  f.remote.beforeDelete = undefined;
  if (scenario === "replacement") await writeFile(f.sourcePath, f.content);
  await f.restart().delete(f.id);
  expect(f.remote.deleted).toEqual(["115-file"]);
  expect(f.pending.list()).toEqual([]);
});

test.each([
  "busy",
  "wrong server",
  "ambiguous",
  "shared",
  "changed mount",
] as const)("rejects unsafe deletion before side effects: %s", async (scenario) => {
  const f = await fixture();
  if (scenario === "busy") f.setBusy();
  if (scenario === "wrong server") await writeFile(f.sourcePath, f.content.replace("mp.test", "other.test"));
  if (scenario === "ambiguous")
    f.remote.files.push({ ...f.remote.files[0], fileid: "another", path: "/AV/another.mp4" });
  if (scenario === "changed mount") await writeFile(path.join(f.link, ".mdcz-library-id"), "changed");
  if (scenario === "shared") {
    const root = await f.mediaRoots.ensurePath(f.link);
    await f.library.upsertEntry({
      movie: { number: "ABC-123" },
      files: [
        {
          fileId: "published",
          rootId: root.id,
          rootRelativePath: "ABC-123.strm",
          strmSourceJson: JSON.stringify({
            sourcePath: f.sourcePath,
            resourceIdentity: moviePilotResourceIdentity(f.content.trim()),
          }),
        },
      ],
    });
  }
  await expect(f.restart().delete(f.id)).rejects.toThrow();
  expect(f.remote.deleted).toEqual([]);
  expect(f.pending.get(f.id).deletionJson).toBeNull();
  expect(await readFile(f.sourcePath, "utf8")).toBe(
    scenario === "wrong server" ? f.content.replace("mp.test", "other.test") : f.content,
  );
});
