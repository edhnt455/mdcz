import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createPersistenceDatabase,
  type EmbyDeletionEventRow,
  EmbyDeletionRepository,
  LibraryRepository,
  MediaRootRepository,
  PendingRepository,
  runMigrations,
  ScrapeRunRepository,
  SiteResultRepository,
} from "@mdcz/persistence";
import { mergeRuntimeConfig } from "@mdcz/runtime/config";
import type { MediaLibrary } from "@mdcz/runtime/library";
import { type Configuration, configurationSchema, type DeepPartial, defaultConfiguration } from "@mdcz/shared/config";
import type { EmbyDeletionNotification } from "@mdcz/shared/embyDeletion";
import { type MoviePilotFile, moviePilotResourceIdentity } from "@mdcz/shared/moviePilot";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTaskEventBus } from "../taskEvents";
import { EmbyDeletionService } from "./embyDeletionService";
import { readStrmBinding } from "./strmDeletionService";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const fixture = async (mode: "off" | "delete" | "observe" = "delete", cloud = false) => {
  const directory = await mkdtemp(path.join(tmpdir(), "mdcz-emby-delete-"));
  const output = path.join(directory, "Link");
  const source = path.join(directory, "Normal");
  await mkdir(output);
  await mkdir(source);
  let database = createPersistenceDatabase({ path: path.join(directory, "test.sqlite") });
  runMigrations(database);
  cleanups.push(async () => {
    database.close();
    await rm(directory, { force: true, recursive: true });
  });
  const root = await new MediaRootRepository(database).ensurePath(output);
  const mediaLibrary: MediaLibrary = {
    id: "library-1",
    createdAt: new Date(),
    updatedAt: new Date(),
    name: "AV",
    sourcePath: source,
    outputPath: output,
    folderTemplate: "{number}",
    fileTemplate: "{number}",
    placement: cloud ? "copy" : "move",
    automation: "off",
    discovery: "events",
    cloudPath: "",
    scanIntervalMinutes: 15,
  };
  let now = Date.now() + 1_000;
  const maintenance = { isBusy: false };
  const notifications = vi.fn();
  const taskEvents = createTaskEventBus();
  taskEvents.subscribe(notifications);
  const invalidateAvailability = vi.fn();
  const cloudFile: MoviePilotFile = {
    storage: "u115",
    type: "file",
    path: "/Media/AV/original.mp4",
    name: "original.mp4",
    fileid: "3545943398428968654",
    parent_fileid: "3545480291139191977",
    pickcode: "sample-pickcode",
    size: 123456,
  };
  const media: MoviePilotFile = {
    storage: "u115",
    type: "dir",
    path: "/Media/",
    name: "Media",
    fileid: "3296841631948340730",
    parent_fileid: "0",
  };
  const av: MoviePilotFile = {
    storage: "u115",
    type: "dir",
    path: "/Media/AV/",
    name: "AV",
    fileid: "3545480291139191977",
    parent_fileid: media.fileid,
  };
  const remote = {
    files: [cloudFile],
    loseAcknowledgement: false,
    rejectDeletion: false,
    deleteCalls: 0,
    listCalls: 0,
    failLists: false,
  };
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    expect(url.origin).toBe("https://mp.test");
    expect(new Headers(init?.headers).get("X-API-KEY")).toBe("test-mp-token");
    if (url.pathname.endsWith("/storage/options"))
      return Response.json({ success: true, message: "", data: [{ type: "u115", name: "115" }] });
    const body = JSON.parse(String(init?.body)) as MoviePilotFile;
    if (url.pathname.endsWith("/storage/delete")) {
      remote.deleteCalls++;
      expect(body).toEqual(cloudFile);
      if (remote.rejectDeletion) return Response.json({ success: false, message: "denied", data: null });
      remote.files = remote.files.filter((file) => file.fileid !== body.fileid);
      if (remote.loseAcknowledgement) throw new Error("Connection reset after deletion");
      return Response.json({ success: true, message: "", data: null });
    }
    expect(url.pathname).toBe("/api/v1/storage/list");
    remote.listCalls++;
    if (remote.failLists) return Response.json({ success: false, message: "storage unavailable", data: null });
    const rows = body.fileid === "0" ? [media] : body.fileid === media.fileid ? [av] : remote.files;
    const page = Number(url.searchParams.get("page") ?? 1);
    const count = Number(url.searchParams.get("count") ?? 200);
    const data = rows.slice((page - 1) * count, page * count);
    return Response.json(
      { success: true, message: "", data },
      {
        headers: {
          "X-Total-Count": String(rows.length),
          "X-Page": String(page),
          "X-Page-Size": String(count),
          "X-Result-Count": String(data.length),
        },
      },
    );
  });
  let configuration = defaultConfiguration;
  const dependencies = {
    persistence: { getState: async () => ({ database, repositories: {} as never }) },
    libraries: { list: async () => [{ ...mediaLibrary, placement: cloud ? "copy" : "move" } as MediaLibrary] },
    maintenance,
    taskEvents,
    invalidateAvailability,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    now: () => now,
    config: {
      get: async () => configuration,
      update: async (patch: DeepPartial<Configuration>) => {
        configuration = configurationSchema.parse(mergeRuntimeConfig(configuration, patch));
        return configuration;
      },
    },
    moviePilotFetch: fetcher,
  };
  const createService = () => new EmbyDeletionService(dependencies);
  const service = createService();
  const token = mode === "off" ? "" : (await service.rotateSecret()).token;
  if (cloud)
    await service.configureMoviePilot({
      baseUrl: "https://mp.test",
      rootPath: "/Media/AV",
      storage: "u115",
      token: "test-mp-token",
    });
  await service.configure({ mode, serverId: mode === "off" ? "" : "emby-server", libraryIds: [mediaLibrary.id] });
  const addMovie = async (name = "ABC-123", movieId = "movie", files = [`${name}.mp4`]) =>
    await new LibraryRepository(database).upsertEntry({
      movie: {
        id: movieId,
        number: name,
        crawlerDataJson: JSON.stringify({ number: name }),
        assets: [{ kind: "poster", uri: `${name}.jpg`, rootId: root.id, relativePath: `${name}.jpg` }],
      },
      files: files.map((relativePath, index) => ({
        fileId: `${movieId}-${index}`,
        rootId: root.id,
        rootRelativePath: relativePath,
        size: 100,
        ...(cloud
          ? {
              retainedSourceIdentity: path.join(source, relativePath),
              strmSourceJson: JSON.stringify({
                sourcePath: path.join(source, relativePath),
                sha256: createHash("sha256")
                  .update("https://mp.test/api/v1/plugin/P115StrmHelper/redirect_url?pickcode=sample-pickcode\n")
                  .digest("hex"),
                resourceIdentity: moviePilotResourceIdentity(
                  "https://mp.test/api/v1/plugin/P115StrmHelper/redirect_url?pickcode=sample-pickcode",
                ),
              }),
            }
          : {}),
        assets: [
          { kind: "subtitle", uri: `${relativePath}.srt`, rootId: root.id, relativePath: `${relativePath}.srt` },
        ],
      })),
    });
  const notification = (
    relativePath = "ABC-123.mp4",
    overrides: Partial<EmbyDeletionNotification> = {},
  ): EmbyDeletionNotification => ({
    Event: "library.deleted",
    Date: new Date(now).toISOString(),
    Server: { Id: "emby-server" },
    Item: { Id: relativePath, Type: "Movie", IsFolder: false, Path: path.join(output, relativePath) },
    ...overrides,
  });
  const advance = async (target = service) => {
    now += 6_000;
    await target.runDue();
  };
  const count = (table: string) =>
    (database.sqlite.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number }).count;
  return {
    service,
    createService,
    addMovie,
    notification,
    advance,
    count,
    root,
    mediaLibrary,
    output,
    source,
    token,
    maintenance,
    remote,
    fetcher,
    notifications,
    logger: dependencies.logger,
    invalidateAvailability,
    get database() {
      return database;
    },
    get now() {
      return now;
    },
    repository: () => new EmbyDeletionRepository(database),
    events: () =>
      (
        database.sqlite.prepare("SELECT id FROM emby_deletion_events ORDER BY received_at DESC, id DESC").all() as {
          id: string;
        }[]
      ).map(({ id }) => new EmbyDeletionRepository(database).event(id) as EmbyDeletionEventRow),
    reopen: () => {
      database.close();
      database = createPersistenceDatabase({ path: path.join(directory, "test.sqlite") });
      runMigrations(database);
    },
  };
};

describe("Emby deletion sync", () => {
  it("atomically removes movie records, assets and pending work while retaining task history and disk sidecars", async () => {
    const f = await fixture();
    await f.addMovie();
    const pending = new PendingRepository(f.database);
    pending.upsert({
      kind: "uncensored",
      rootId: f.root.id,
      relativePath: "old.mp4",
      movieId: "movie",
      number: "ABC-123",
    });
    pending.upsert({ kind: "failed", rootId: f.root.id, relativePath: "ABC-123.mp4" });
    new SiteResultRepository(f.database).record("ABC-123", [{ site: "javdb", status: "success", elapsedMs: 1 }]);
    const runs = new ScrapeRunRepository(f.database);
    const run = await runs.create({
      libraryId: f.mediaLibrary.id,
      rootId: f.root.id,
      executionMode: "single",
      items: [{ ordinal: 0, rootId: f.root.id, relativePath: "source.mp4" }],
    });
    await runs.finalize({ runId: run.id, disposition: "failed" });
    await writeFile(path.join(f.output, "ABC-123.jpg"), "poster");
    await writeFile(path.join(f.source, "unrelated.mp4"), "source");
    const event = await f.service.accept(f.notification());
    expect(await f.service.accept(f.notification())).toMatchObject({ id: event.id, duplicate: true });
    expect(f.logger.info.mock.calls.filter(([message]) => message.includes(event.id))).toHaveLength(1);
    for (let i = 0; i < 25; i++)
      await f.service.accept(f.notification(`noise-${i}.mp4`, { Server: { Id: "other-server" } }));
    expect((await f.service.status()).recent.map((entry) => entry.id)).toEqual([event.id]);
    expect((await f.service.status()).counts).toEqual({ pending: 1, needs_review: 0 });
    await f.advance();
    expect(f.count("library_items")).toBe(1);
    await f.advance();
    for (const table of ["library_items", "library_item_files", "library_item_assets", "pending_items", "site_results"])
      expect(f.count(table)).toBe(0);
    expect(f.count("scrape_runs")).toBe(1);
    expect(await readFile(path.join(f.output, "ABC-123.jpg"), "utf8")).toBe("poster");
    expect(await readFile(path.join(f.source, "unrelated.mp4"), "utf8")).toBe("source");
    expect(f.invalidateAvailability).toHaveBeenCalledOnce();
    expect(f.notifications).toHaveBeenCalledWith({
      kind: "invalidate",
      resources: ["library", "pending"],
    });
    expect(f.repository().event(event.id)).toMatchObject({ status: "completed", result: "records_removed" });
    expect((await f.service.status()).recent).toEqual([]);
    expect((await f.service.status()).counts).toEqual({ pending: 0, needs_review: 0 });
    expect(f.logger.info).toHaveBeenCalledWith(expect.stringContaining('"result":"records_removed"'));
  });

  it.each([
    "version",
    "movie",
    "pending",
  ] as const)("preserves shared metadata referenced by another %s", async (reference) => {
    const f = await fixture();
    await f.addMovie("ABC-123", "movie", reference === "version" ? ["ABC-123.mp4", "ABC-123-4K.mp4"] : undefined);
    if (reference === "movie") await f.addMovie("ABC-123", "another-movie", ["other.mp4"]);
    if (reference === "pending")
      new PendingRepository(f.database).upsert({
        kind: "failed",
        rootId: f.root.id,
        relativePath: "pending.mp4",
        number: "abc-123",
      });
    new SiteResultRepository(f.database).record("ABC-123", [{ site: "javdb", status: "success", elapsedMs: 1 }]);
    await f.service.accept(f.notification());
    await f.advance();
    await f.advance();
    expect(f.count("site_results")).toBe(1);
    expect(f.count("library_item_files")).toBe(reference === "pending" ? 0 : 1);
    if (reference === "version")
      expect(
        (await new LibraryRepository(f.database).getEntryById("movie")).files.map((file) => file.rootRelativePath),
      ).toEqual(["ABC-123-4K.mp4"]);
  });

  it.each([
    ["wrong server", "server_not_allowed"],
    ["wrong event", "event_not_supported"],
    ["episode", "item_not_a_movie_file"],
    ["folder", "item_not_a_movie_file"],
    ["missing date", "event_date_missing"],
    ["outside", "path_not_allowed"],
    ["traversal", "path_not_allowed"],
    ["unknown", "file_not_registered"],
    ["stale", "event_predates_file_record"],
    ["no path", "path_not_allowed"],
  ])("ignores %s notifications without removing records", async (kind, reason) => {
    const f = await fixture();
    await f.addMovie();
    const event = f.notification();
    if (!event.Item) throw new Error("Expected movie notification");
    if (kind === "wrong server") event.Server.Id = "other";
    if (kind === "wrong event") event.Event = "library.new";
    if (kind === "episode") event.Item.Type = "Episode";
    if (kind === "folder") event.Item.IsFolder = true;
    if (kind === "missing date") delete event.Date;
    if (kind === "outside") event.Item.Path = `${f.output}-other/ABC-123.mp4`;
    if (kind === "traversal") event.Item.Path = `${f.output}/../Link/ABC-123.mp4`;
    if (kind === "unknown") event.Item.Path = path.join(f.output, "unknown.mp4");
    if (kind === "stale") event.Date = new Date(f.now - 120_000).toISOString();
    if (kind === "no path") delete event.Item.Path;
    expect(await f.service.accept(event)).toMatchObject({ status: "ignored" });
    await f.advance();
    await f.advance();
    expect(f.count("library_items")).toBe(1);
    expect(f.events()[0]?.result).toBe(reason);
    expect((await f.service.status()).recent).toEqual([]);
    expect(f.logger.info).toHaveBeenCalledWith(expect.stringContaining(`"result":"${reason}"`));
  });

  it.each(["observe", "existing", "reappeared", "updated"] as const)("retains records when %s", async (condition) => {
    const f = await fixture(condition === "observe" ? "observe" : "delete");
    await f.addMovie();
    if (condition === "existing") await writeFile(path.join(f.output, "ABC-123.mp4"), "video");
    await f.service.accept(f.notification());
    await f.advance();
    if (condition === "reappeared") await writeFile(path.join(f.output, "ABC-123.mp4"), "new video");
    if (condition === "updated")
      f.database.sqlite.prepare("UPDATE library_item_files SET updated_at = updated_at + 1").run();
    await f.advance();
    expect(f.count("library_items")).toBe(1);
    expect(f.events()[0]).toMatchObject({
      status: "ignored",
      result:
        condition === "observe"
          ? "would_remove_records"
          : condition === "updated"
            ? "file_record_changed"
            : "file_still_exists",
    });
  });

  it("recovers queued work after reopening the database and allows secret rotation independently of jobs", async () => {
    const f = await fixture();
    await f.addMovie();
    await f.service.assertToken(f.token);
    await f.service.accept(f.notification());
    await f.advance();
    f.reopen();
    const restarted = f.createService();
    const next = await restarted.rotateSecret();
    await expect(restarted.assertToken(f.token)).rejects.toThrow("Invalid Emby webhook credential");
    await restarted.assertToken(next.token);
    await f.advance(restarted);
    expect(f.count("library_items")).toBe(0);
    expect(JSON.stringify(await restarted.status())).not.toContain(next.token);
  });

  it("waits for live media tasks and never deletes records while they can publish", async () => {
    const f = await fixture();
    await f.addMovie();
    const runs = new ScrapeRunRepository(f.database);
    const run = await runs.create({
      libraryId: f.mediaLibrary.id,
      rootId: f.root.id,
      executionMode: "single",
      items: [],
    });
    await f.service.accept(f.notification());
    await f.advance();
    expect(f.events()[0]?.result).toBe("waiting_for_media_tasks");
    await runs.finalize({ runId: run.id, disposition: "failed" });
    await f.advance();
    f.maintenance.isBusy = true;
    await f.advance();
    expect(f.count("library_items")).toBe(1);
    f.maintenance.isBusy = false;
    await f.advance();
    expect(f.count("library_items")).toBe(0);
  });

  it("requires mount identity, stops retrying after repeated errors, and can be disabled with the mount offline", async () => {
    const f = await fixture();
    await f.addMovie();
    await f.service.accept(f.notification());
    await rm(path.join(f.output, ".mdcz-library-id"));
    for (let attempt = 0; attempt < 8; attempt++) {
      f.database.sqlite.prepare("UPDATE emby_deletion_events SET next_attempt_at = 0").run();
      await f.advance();
    }
    expect(f.events()[0]).toMatchObject({ status: "needs_review", attempts: 8 });
    expect(f.count("library_items")).toBe(1);
    await expect(
      f.service.configure({ mode: "delete", serverId: "emby-server", libraryIds: [f.mediaLibrary.id] }),
    ).rejects.toThrow("identity marker is missing");
    await rename(f.output, `${f.output}-offline`);
    expect(
      (await f.service.configure({ mode: "off", serverId: "emby-server", libraryIds: [f.mediaLibrary.id] })).settings
        .mode,
    ).toBe("off");
  });

  it("cancels old jobs when changing modes and reconciles only registered output files", async () => {
    const manual = await fixture("off", true);
    expect((await manual.createService().status()).settings).toEqual({
      mode: "off",
      serverId: "",
      libraryIds: [manual.mediaLibrary.id],
    });
    expect((await manual.service.status()).configured).toBe(false);
    expect(await readFile(path.join(manual.source, ".mdcz-library-id"), "utf8")).toMatch(/^mdcz:/u);
    expect(await manual.service.bindSources()).toEqual({ verified: 0, unverified: 0 });
    expect(manual.remote.deleteCalls).toBe(0);
    await expect(
      manual.service.configure({ mode: "observe", serverId: "emby-server", libraryIds: [manual.mediaLibrary.id] }),
    ).rejects.toThrow("webhook");
    const f = await fixture("observe");
    await f.addMovie();
    await writeFile(path.join(f.output, "unregistered.mp4"), "video");
    await f.service.accept(f.notification());
    await f.service.configure({ mode: "delete", serverId: "emby-server", libraryIds: [f.mediaLibrary.id] });
    await f.advance();
    await f.advance();
    expect(f.count("library_items")).toBe(1);
    expect(await f.service.reconcile()).toEqual({ queued: 1 });
    await f.advance();
    await f.advance();
    expect(f.count("library_items")).toBe(0);
    expect(await readFile(path.join(f.output, "unregistered.mp4"), "utf8")).toBe("video");
    expect((await f.service.configure({ mode: "off", serverId: "", libraryIds: [] })).settings).toEqual({
      mode: "off",
      serverId: "",
      libraryIds: [],
    });
  });

  it("rolls back every business record and completion state when cleanup fails", async () => {
    const f = await fixture();
    await f.addMovie();
    new SiteResultRepository(f.database).record("ABC-123", [{ site: "javdb", status: "success", elapsedMs: 1 }]);
    new PendingRepository(f.database).upsert({
      kind: "failed",
      rootId: f.root.id,
      relativePath: "ABC-123.mp4",
      movieId: "movie",
    });
    f.database.sqlite.exec(
      "CREATE TRIGGER reject_site_delete BEFORE DELETE ON site_results BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END",
    );
    await f.service.accept(f.notification());
    await f.advance();
    await f.advance();
    for (const table of ["library_items", "library_item_files", "pending_items", "site_results"])
      expect(f.count(table)).toBe(1);
    expect(f.events()[0]).toMatchObject({
      status: "pending",
      attempts: 1,
      result: "simulated write failure",
    });
    f.database.sqlite.exec("DROP TRIGGER reject_site_delete");
    f.database.sqlite.prepare("UPDATE emby_deletion_events SET next_attempt_at = 0").run();
    await f.advance();
    expect(f.count("library_items")).toBe(0);
  });
});

const strmFixture = async (mode: "delete" | "observe" = "delete", files = ["ABC-123.strm"]) => {
  const f = await fixture(mode, true);
  const content = "https://mp.test/api/v1/plugin/P115StrmHelper/redirect_url?pickcode=sample-pickcode\n";
  for (const name of files) {
    await writeFile(path.join(f.source, name), content);
    await writeFile(path.join(f.output, name), content);
  }
  await f.addMovie("ABC-123", "movie", files);
  expect(await f.service.bindSources()).toEqual({ verified: files.length, unverified: 0 });
  await rm(path.join(f.output, files[0]));
  return Object.assign(f, { event: f.notification(files[0], { Event: "deep.delete" }), content });
};

describe("copy STRM deep deletion", () => {
  it("persists cloud acknowledgement, confirms source cleanup and suppresses reimport across database reopen", async () => {
    const f = await strmFixture();
    const accepted = await f.service.accept(f.event);
    expect(await f.service.accept({ ...f.event, Date: new Date(f.now + 1_000).toISOString() })).toMatchObject({
      id: accepted.id,
      duplicate: true,
    });
    await f.advance();
    await f.advance();
    expect(f.events().find((event) => event.id === accepted.id)?.result).toBe("confirming_source_cleanup");
    expect(f.remote.deleteCalls).toBe(1);
    expect(f.count("library_item_files")).toBe(1);
    expect(f.events()[0]).toMatchObject({ step: "cleaning_records", status: "pending" });
    await expect(readFile(path.join(f.source, "ABC-123.strm"))).rejects.toMatchObject({ code: "ENOENT" });
    f.reopen();
    await f.advance(f.createService());
    expect(f.count("library_item_files")).toBe(0);
    expect(f.repository().associationCounts().blocked).toBe(1);
    const repository = new LibraryRepository(f.database);
    expect(repository.knownMediaIdentities([path.join(f.source, "ABC-123.strm")])).toContain(
      path.join(f.source, "ABC-123.strm"),
    );
    const snapshot = readStrmBinding(f.repository(), "movie-0");
    expect(() =>
      repository.assertNotSuppressed(["/different/source.strm"], [snapshot?.source.resourceIdentity ?? ""]),
    ).toThrow("suppressed");
    expect(() =>
      repository.writeEntry({ id: "reimport" }, [
        {
          fileId: "reimport",
          rootId: f.root.id,
          rootRelativePath: "different.strm",
          sourceEntryIdentity: "/different/source.strm",
          strmSourceJson: JSON.stringify({ resourceIdentity: snapshot?.source.resourceIdentity }),
        },
      ]),
    ).toThrow("suppressed");
    expect(f.count("library_item_files")).toBe(0);
    expect(JSON.stringify(await f.createService().status())).not.toContain("test-mp-token");
    expect(JSON.stringify(f.logger.info.mock.calls)).not.toContain("test-mp-token");
    expect(JSON.stringify(f.logger.info.mock.calls)).not.toContain("sample-pickcode");
  });

  it("keeps shared cloud resources and sources until the final registered reference is deleted", async () => {
    const f = await strmFixture("delete", ["ABC-123.strm", "shared.strm"]);
    await f.service.accept(f.event);
    await f.advance();
    await f.advance();
    expect(f.remote.deleteCalls).toBe(0);
    expect(f.count("library_item_files")).toBe(1);
    expect(await readFile(path.join(f.source, "ABC-123.strm"), "utf8")).toBe(f.content);
    expect(await readFile(path.join(f.source, "shared.strm"), "utf8")).toBe(f.content);
    expect(new LibraryRepository(f.database).knownMediaIdentities([path.join(f.source, "ABC-123.strm")])).toContain(
      path.join(f.source, "ABC-123.strm"),
    );
    await rm(path.join(f.output, "shared.strm"));
    await f.service.accept(f.notification("shared.strm", { Event: "deep.delete" }));
    await f.advance();
    await f.advance();
    await f.advance();
    expect(f.remote.deleteCalls).toBe(1);
    expect(f.count("library_item_files")).toBe(0);
    for (const name of ["ABC-123.strm", "shared.strm"])
      await expect(readFile(path.join(f.source, name))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("requires explicit deep intent and allows reviewed observations to resume in delete mode", async () => {
    const f = await strmFixture("observe");
    expect(await f.service.reconcile()).toEqual({ queued: 0 });
    expect(await f.service.accept({ ...f.event, Event: "library.deleted" })).toMatchObject({ status: "ignored" });
    expect(f.events()[0].result).toBe("deep_delete_required");
    const event = await f.service.accept(f.event);
    await f.advance();
    await f.advance();
    expect(f.remote.deleteCalls).toBe(0);
    expect(f.count("library_item_files")).toBe(1);
    expect(f.events().find((candidate) => candidate.id === event.id)?.result).toBe("would_delete_strm_resource");
    await f.service.configure({ mode: "delete", serverId: "emby-server", libraryIds: [f.mediaLibrary.id] });
    await f.service.retry(event.id);
    await f.advance();
    await f.advance();
    expect(f.remote.deleteCalls).toBe(1);
    expect(f.count("library_item_files")).toBe(0);
  });

  it.each([
    "lost acknowledgement",
    "replaced source",
    "query failure",
    "notification mismatch",
  ] as const)("preserves sources and records on %s", async (failure) => {
    const f = await strmFixture();
    if (failure === "lost acknowledgement") f.remote.loseAcknowledgement = true;
    if (failure === "replaced source") await writeFile(path.join(f.source, "ABC-123.strm"), "different-resource");
    if (failure === "query failure") f.remote.failLists = true;
    if (failure === "notification mismatch")
      f.event.Description =
        "Mount Paths:\nhttps://mp.test/api/v1/plugin/P115StrmHelper/redirect_url?pickcode=unrelated-resource";
    await f.service.accept(f.event);
    await f.advance();
    await f.advance();
    expect(f.count("library_item_files")).toBe(1);
    expect(await readFile(path.join(f.source, "ABC-123.strm"), "utf8")).toBe(
      failure === "replaced source" ? "different-resource" : f.content,
    );
    expect(f.remote.deleteCalls).toBe(failure === "lost acknowledgement" ? 1 : 0);
    if (failure === "lost acknowledgement") {
      f.database.sqlite.prepare("UPDATE emby_deletion_events SET next_attempt_at = 0").run();
      await f.advance();
      expect(f.events()[0].result).toContain("without a persisted deletion acknowledgement");
      expect(f.remote.deleteCalls).toBe(1);
    }
  });

  it("pauses partial deletions when disabled and detects source regeneration before removing records", async () => {
    const f = await strmFixture();
    const accepted = await f.service.accept(f.event);
    await f.advance();
    await f.advance();
    await f.service.configure({ mode: "off", serverId: "emby-server", libraryIds: [f.mediaLibrary.id] });
    await f.advance();
    expect(f.count("library_item_files")).toBe(1);
    expect(f.events()[0]).toMatchObject({ status: "pending", step: "cleaning_records" });
    await writeFile(path.join(f.source, "ABC-123.strm"), f.content);
    await rename(
      path.join(f.source, "ABC-123.strm"),
      `${path.join(f.source, "ABC-123.strm")}.mdcz-delete-${accepted.id}`,
    );
    await f.service.configure({ mode: "delete", serverId: "emby-server", libraryIds: [f.mediaLibrary.id] });
    await f.advance();
    expect(f.count("library_item_files")).toBe(1);
    expect(f.events()[0].result).toContain("recreated");
    f.database.sqlite.prepare("UPDATE emby_deletion_events SET next_attempt_at = 0").run();
    await f.advance();
    expect(f.count("library_item_files")).toBe(0);
    expect(f.remote.deleteCalls).toBe(1);
  });
});
