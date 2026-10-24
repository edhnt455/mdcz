import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createPersistenceDatabase,
  EmbyDeletionRepository,
  LibraryRepository,
  MediaLibraryRepository,
  MediaRootRepository,
  PendingRepository,
  runMigrations,
  ScrapeRunRepository,
  SiteResultRepository,
} from "@mdcz/persistence";
import type { MediaLibrary } from "@mdcz/runtime/library";
import type { EmbyDeletionNotification } from "@mdcz/shared/embyDeletion";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTaskEventBus } from "../taskEvents";
import { EmbyDeletionService } from "./embyDeletionService";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const fixture = async (mode: "delete" | "observe" = "delete") => {
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
  const mediaLibrary = new MediaLibraryRepository(database).create({
    name: "AV",
    sourcePath: source,
    outputPath: output,
    folderTemplate: "{number}",
    fileTemplate: "{number}",
    placement: "move",
    automation: "off",
    discovery: "events",
    cloudPath: "",
    scanIntervalMinutes: 15,
  });
  let now = Date.now() + 1_000;
  const maintenance = { isBusy: false };
  const notifications = vi.fn();
  const taskEvents = createTaskEventBus();
  taskEvents.subscribe(notifications);
  const invalidateAvailability = vi.fn();
  const dependencies = {
    persistence: { getState: async () => ({ database, repositories: {} as never }) },
    libraries: { list: async () => [{ ...mediaLibrary, placement: "move" } as MediaLibrary] },
    maintenance,
    taskEvents,
    invalidateAvailability,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    now: () => now,
  };
  const createService = () => new EmbyDeletionService(dependencies);
  const service = createService();
  const { token } = await service.rotateSecret();
  await service.configure({ mode, serverId: "emby-server", libraryIds: [mediaLibrary.id] });
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
    notifications,
    invalidateAvailability,
    get database() {
      return database;
    },
    get now() {
      return now;
    },
    repository: () => new EmbyDeletionRepository(database),
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
    expect((await f.service.status()).recent[0]).toMatchObject({ status: "completed", result: "records_removed" });
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
    expect((await f.service.status()).recent[0]?.result).toBe(reason);
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
    expect((await f.service.status()).recent[0]).toMatchObject({
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
    expect((await f.service.status()).recent[0]?.result).toBe("waiting_for_media_tasks");
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
    expect((await f.service.status()).recent[0]).toMatchObject({ status: "needs_review", attempts: 8 });
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
    expect((await f.service.status()).recent[0]).toMatchObject({
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
