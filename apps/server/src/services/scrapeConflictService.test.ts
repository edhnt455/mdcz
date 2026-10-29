import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createPersistenceDatabase,
  EmbyDeletionRepository,
  LibraryRepository,
  MediaRootRepository,
  PendingRepository,
  runMigrations,
  ScrapeConflictRepository,
  ScrapeRunRepository,
} from "@mdcz/persistence";
import type { MediaLibrary } from "@mdcz/runtime/library";
import { defaultConfiguration } from "@mdcz/shared/config";
import { type MoviePilotFile, moviePilotResourceIdentity } from "@mdcz/shared/moviePilot";
import { scrapeConflictSetupErrors } from "@mdcz/shared/scrapeConflict";
import type { ScrapeRunSnapshotDto } from "@mdcz/shared/serverDtos";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerPersistenceService } from "./persistenceService";
import { ScrapeConflictService } from "./scrapeConflictService";
import { StrmDeletionService } from "./strmDeletionService";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
const input = { taskId: "task", itemId: "incoming" };
const content = (code: string) => `https://mp.test/api/v1/plugin/P115StrmHelper/redirect_url?pickcode=${code}\n`;

async function fixture(shared = false) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "mdcz-conflict-")));
  const normal = path.join(directory, "Normal");
  const link = path.join(directory, "Link");
  await mkdir(normal);
  await mkdir(link);
  for (const root of [normal, link]) await writeFile(path.join(root, ".mdcz-library-id"), root);
  const database = createPersistenceDatabase({ path: path.join(directory, "db.sqlite") });
  runMigrations(database);
  cleanups.push(async () => {
    database.close();
    await rm(directory, { recursive: true, force: true });
  });
  const mediaRoots = new MediaRootRepository(database);
  const sourceRoot = await mediaRoots.ensurePath(normal);
  const outputRoot = await mediaRoots.ensurePath(link);
  const existingNormal = path.join(normal, "old.strm");
  const incomingNormal = path.join(normal, "new.strm");
  const linkPath = path.join(link, "ABC-123.strm");
  await writeFile(existingNormal, content("old"));
  await writeFile(incomingNormal, content(shared ? "old" : "new"));
  await writeFile(linkPath, content("old"));
  await writeFile(path.join(link, "ABC-123.nfo"), "retained metadata");
  const library = new LibraryRepository(database);
  const pending = new PendingRepository(database);
  const scrapeRuns = new ScrapeRunRepository(database);
  const repository = new EmbyDeletionRepository(database);
  const entry = await library.upsertEntry({
    movie: { number: "ABC-123" },
    files: [
      {
        fileId: "existing",
        rootId: outputRoot.id,
        rootRelativePath: "ABC-123.strm",
        retainedSourceIdentity: existingNormal,
        strmSourceJson: JSON.stringify({
          sourcePath: existingNormal,
          sha256: createHash("sha256").update(content("old")).digest("hex"),
          resourceIdentity: moviePilotResourceIdentity(content("old").trim()),
        }),
      },
    ],
  });
  const cloudRoot: MoviePilotFile = {
    storage: "u115",
    type: "dir",
    path: "/AV/",
    name: "AV",
    fileid: "root",
    parent_fileid: "0",
  };
  const files: MoviePilotFile[] = ["old", "new"].map((id, index) => ({
    storage: "u115",
    type: "file",
    path: `/AV/${id}.mp4`,
    name: `${id}.mp4`,
    fileid: id,
    pickcode: id,
    parent_fileid: "root",
    size: (index + 1) * 1024 ** 3,
  }));
  const remote = { files, reject: false, loseResponse: false, verificationFails: false, deletions: [] as string[] };
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    const endpoint = new URL(String(url)).pathname;
    if (endpoint.endsWith("/options")) return Response.json({ success: true, message: "", data: [{ type: "u115" }] });
    const body = JSON.parse(String(init?.body)) as MoviePilotFile;
    if (endpoint.endsWith("/delete")) {
      if (remote.reject) return Response.json({ success: false, message: "denied", data: null });
      remote.deletions.push(body.fileid);
      remote.files = remote.files.filter((file) => file.fileid !== body.fileid);
      if (remote.loseResponse) throw new Error("Lost response");
      return Response.json({ success: true, message: "", data: null });
    }
    if (remote.verificationFails && remote.deletions.length) throw new Error("Unavailable after deletion");
    const data = body.fileid === "0" ? [cloudRoot] : remote.files;
    return Response.json(
      { success: true, message: "", data },
      {
        headers: {
          "X-Total-Count": String(data.length),
          "X-Page": "1",
          "X-Page-Size": "200",
          "X-Result-Count": String(data.length),
        },
      },
    );
  });
  const configuration = structuredClone(defaultConfiguration);
  configuration.embyDeletion.moviePilot = {
    id: "connection",
    baseUrl: "https://mp.test",
    token: "token",
    storage: "u115",
    rootPath: "/AV",
    root: cloudRoot,
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
  const repositories = { library, pending, mediaRoots, scrapeRuns };
  const persistence = { getState: async () => ({ database, repositories }) } as unknown as Pick<
    ServerPersistenceService,
    "getState"
  >;
  const mediaLibrary = { id: "library", placement: "copy", outputPath: link, sourcePath: normal } as MediaLibrary;
  const run = {
    task: { id: "task", libraryId: "library", continuity: "final" },
    items: [
      {
        id: "incoming",
        rootId: sourceRoot.id,
        relativePath: "new.strm",
        status: "failed",
        conflict: { sourcePath: incomingNormal, targetPath: linkPath },
      },
    ],
  } as ScrapeRunSnapshotDto;
  let busy = false;
  const retry = vi.fn(async () => ({ task: { id: "retry" } }) as ScrapeRunSnapshotDto);
  const deps = {
    persistence,
    config: { get: async () => configuration },
    libraries: { get: async () => mediaLibrary },
    snapshot: async () => run,
    retry,
    isBusy: () => busy,
    invalidate: vi.fn(),
    moviePilotFetch: fetcher,
  };
  await new StrmDeletionService(() => configuration.embyDeletion, fetcher).bind(repository);
  return {
    directory,
    existingNormal,
    incomingNormal,
    linkPath,
    remote,
    repository,
    entry,
    library,
    configuration,
    run,
    jobs: new ScrapeConflictRepository(database),
    service: new ScrapeConflictService(deps),
    restart: () => new ScrapeConflictService(deps),
    retry,
    setBusy: (value: boolean) => {
      busy = value;
    },
  };
}

describe("STRM duplicate resolution", () => {
  it.each(["existing", "incoming"] as const)("keeps %s and deletes only the other resource", async (keep) => {
    const f = await fixture();
    const connection = f.configuration.embyDeletion.moviePilot;
    f.configuration.embyDeletion.moviePilot = null;
    await expect(f.service.preview(input)).rejects.toThrow(scrapeConflictSetupErrors.moviePilotRequired);
    f.configuration.embyDeletion.moviePilot = connection;
    const bindings = f.configuration.embyDeletion.libraries;
    f.configuration.embyDeletion.libraries = [];
    await expect(f.service.preview(input)).rejects.toThrow(scrapeConflictSetupErrors.libraryBindingRequired);
    f.configuration.embyDeletion.libraries = bindings;
    const preview = await f.service.preview(input);
    expect(preview.existing).toMatchObject({ name: "old.mp4", size: 1024 ** 3, linkPath: f.linkPath });
    expect(preview.incoming).toMatchObject({ name: "new.mp4", size: 2 * 1024 ** 3, linkPath: null });
    expect((await f.restart().restore({ ...f.run, items: [] })).items[0]).toMatchObject({
      id: input.itemId,
      conflict: { sourcePath: f.incomingNormal, targetPath: f.linkPath },
    });
    const result = await f.service.resolve({ ...input, token: preview.token, keep });
    expect(f.remote.deletions).toEqual([keep === "existing" ? "new" : "old"]);
    await expect(lstat(keep === "existing" ? f.incomingNormal : f.existingNormal)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(keep === "existing" ? f.existingNormal : f.incomingNormal, "utf8")).toBe(
      content(keep === "existing" ? "old" : "new"),
    );
    if (keep === "existing") {
      expect(await readFile(f.linkPath, "utf8")).toBe(content("old"));
      expect(f.repository.findFile(f.linkPath)?.id).toBe("existing");
      expect(result.runId).toBeNull();
      expect(f.retry).not.toHaveBeenCalled();
    } else {
      await expect(lstat(f.linkPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(f.repository.findFile(f.linkPath)).toBeUndefined();
      expect(f.retry).toHaveBeenCalledOnce();
      expect(result.runId).toBe("retry");
      expect(() =>
        f.library.assertNotSuppressed(
          [f.incomingNormal, f.linkPath],
          [moviePilotResourceIdentity(content("new").trim()) ?? ""],
        ),
      ).not.toThrow();
    }
    expect(await readFile(path.join(path.dirname(f.linkPath), "ABC-123.nfo"), "utf8")).toBe("retained metadata");
    expect(f.jobs.get(input.itemId)?.step).toBe("completed");
    await f.restart().resolve({ ...input, token: preview.token, keep });
    expect(f.remote.deletions).toHaveLength(1);
    expect(f.retry).toHaveBeenCalledTimes(keep === "existing" ? 0 : 1);
    await expect(
      f.restart().resolve({ ...input, token: preview.token, keep: keep === "existing" ? "incoming" : "existing" }),
    ).rejects.toThrow("previously selected");
  });

  it.each(["existing", "incoming"] as const)("preserves a shared 115 resource when keeping %s", async (keep) => {
    const f = await fixture(true);
    const preview = await f.service.preview(input);
    expect(preview.sameResource).toBe(true);
    await f.service.resolve({ ...input, keep, token: preview.token });
    expect(f.remote.deletions).toEqual([]);
    expect(f.remote.files.some((file) => file.fileid === "old")).toBe(true);
    expect(() =>
      f.library.assertNotSuppressed(
        [keep === "existing" ? f.existingNormal : f.incomingNormal],
        [moviePilotResourceIdentity(content("old").trim()) ?? ""],
      ),
    ).not.toThrow();
    expect(await readFile(keep === "existing" ? f.existingNormal : f.incomingNormal, "utf8")).toBe(content("old"));
  });

  it.each([
    "stale preview",
    "changed source",
    "changed link",
    "changed cloud",
    "busy",
    "shared reference",
    "rejected",
    "lost response",
    "failed verification",
  ])("preserves local files on %s and resumes only acknowledged deletions", async (scenario) => {
    const f = await fixture();
    const preview = await f.service.preview(input);
    if (scenario === "stale preview") {
      const saved = f.jobs.get(input.itemId);
      if (!saved) throw new Error("Missing fixture preview");
      const timestamp = (JSON.parse(saved.snapshotJson) as { previewedAt: number }).previewedAt;
      const now = vi.spyOn(Date, "now").mockReturnValue(timestamp);
      try {
        expect((await f.service.preview(input)).token).not.toBe(preview.token);
      } finally {
        now.mockRestore();
      }
    }
    if (scenario === "changed source") await writeFile(f.existingNormal, content("replacement"));
    if (scenario === "changed link") await writeFile(f.linkPath, content("replacement"));
    if (scenario === "changed cloud") f.remote.files[0] = { ...f.remote.files[0], size: 123 };
    if (scenario === "busy") f.setBusy(true);
    if (scenario === "shared reference")
      await f.library
        .upsertEntry({
          movie: { number: "OTHER" },
          files: [{ fileId: "other", rootId: f.entry.files[0].rootId, rootRelativePath: "other.strm" }],
        })
        .then(() => {
          const binding = f.repository.binding("existing");
          if (!binding) throw new Error("Missing fixture binding");
          f.repository.bind({
            ...binding,
            fileId: "other",
            linkPath: path.join(path.dirname(f.linkPath), "other.strm"),
          });
        });
    f.remote.reject = scenario === "rejected";
    f.remote.loseResponse = scenario === "lost response";
    f.remote.verificationFails = scenario === "failed verification";
    await expect(f.service.resolve({ ...input, keep: "incoming", token: preview.token })).rejects.toThrow();
    for (const file of [f.existingNormal, f.incomingNormal, f.linkPath])
      expect((await lstat(file)).isFile()).toBe(true);
    expect(f.retry).not.toHaveBeenCalled();
    if (scenario === "rejected" || scenario === "failed verification") {
      f.remote.reject = false;
      f.remote.verificationFails = false;
      await f.restart().resolve({ ...input, keep: "incoming", token: preview.token });
      expect(f.remote.deletions).toEqual(["old"]);
      expect(f.retry).toHaveBeenCalledOnce();
    }
    if (scenario === "lost response") {
      await expect(f.restart().resolve({ ...input, keep: "incoming", token: preview.token })).rejects.toThrow(
        "acknowledgement",
      );
      expect(f.remote.deletions).toEqual(["old"]);
    }
  });
});
