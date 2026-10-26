import { appendFile, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { filesystemPathKey } from "@mdcz/media-store";
import type { MediaLibrary } from "@mdcz/runtime/library";
import { defaultConfiguration } from "@mdcz/shared/config";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LibraryWatchService } from "./libraryWatchService";

const directories: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const createLibrary = async (id: string, overrides: Partial<MediaLibrary> = {}): Promise<MediaLibrary> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mdcz-library-watch-"));
  directories.push(directory);
  await mkdir(path.join(directory, "source"));
  return {
    id,
    name: id,
    sourcePath: path.join(directory, "source"),
    outputPath: path.join(directory, "output"),
    folderTemplate: "{number}",
    fileTemplate: "{number}",
    placement: "move",
    automation: "scrape",
    discovery: "clouddrive",
    cloudPath: `/cloud/${id}`,
    scanIntervalMinutes: 1,
    ...overrides,
  } as MediaLibrary;
};

/** Watch dependencies over real directories, with the snapshot store shared across service instances. */
const createHarness = (libraries: MediaLibrary[]) => {
  const configuration = structuredClone(defaultConfiguration);
  configuration.scrape.minVideoSizeMb = 0;
  const snapshots = new Map<string, Set<string>>();
  const roots = libraries.map((library) => ({
    id: library.id,
    hostPath: library.sourcePath,
    realPath: library.sourcePath,
  }));
  const scrape = {
    start: vi.fn().mockResolvedValue({ task: { id: "task-1" } }),
    liveRuns: vi.fn().mockResolvedValue({ runs: [] }),
  };
  const pending = { upsert: vi.fn().mockReturnValue(true) };
  const knownMediaIdentities = vi.fn((_keys: string[]) => new Set<string>());
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const onPending = vi.fn();
  const registerPathIntent = vi.fn(async (hostPath: string) =>
    roots.find((root) => hostPath === root.hostPath || hostPath.startsWith(`${root.hostPath}${path.sep}`)),
  );
  const create = () =>
    new LibraryWatchService({
      config: { get: async () => configuration },
      libraries: { list: async () => libraries } as never,
      mediaRoots: {
        registerPathIntent,
        listRoots: async () => roots,
        rootIntegrityGuard: () => async () => {},
        prepareOutputDirectory: async () => ({ id: "output", relativeDirectory: "" }),
      } as never,
      scrape,
      maintenance: { getActiveSession: async () => null },
      persistence: {
        getState: async () => ({
          repositories: {
            libraryState: {
              loadWatchSnapshot: (id: string) => (snapshots.has(id) ? new Set(snapshots.get(id)) : undefined),
              saveWatchSnapshot: (id: string, keys: ReadonlySet<string>) => snapshots.set(id, new Set(keys)),
            },
            library: { knownMediaIdentities },
            pending,
          },
        }),
      } as never,
      logger,
      onPending,
    });
  const settled = () => vi.waitFor(() => expect(vi.getTimerCount()).toBe(libraries.length), { interval: 0 });
  const advance = async (ms: number) => {
    await vi.advanceTimersByTimeAsync(ms);
    await settled();
  };
  return { create, settled, advance, scrape, pending, knownMediaIdentities, registerPathIntent, logger, onPending };
};

describe("LibraryWatchService", () => {
  it("submits STRM arrivals immediately and waits for stable videos, acknowledging accepted files only once", async () => {
    const library = await createLibrary("movies");
    const harness = createHarness([library]);
    const { scrape } = harness;
    const source = (name: string) => path.join(library.sourcePath, name);
    vi.useFakeTimers();
    const service = harness.create();
    try {
      await writeFile(source("existing.mp4"), "baseline");
      await writeFile(source("existing.strm"), "https://media.example/existing.mp4");
      await service.start();
      await harness.settled();

      await writeFile(source("new.mp4"), "first chunk");
      await writeFile(source("stream.strm"), "https://media.example/stream.mp4");
      await writeFile(source("uppercase.STRM"), "https://media.example/uppercase.mp4");
      service.submitCloudDriveChanges([
        { action: "create", isDir: false, sourceFile: "/cloud/movies/new.mp4", destinationFile: "" },
      ]);
      await harness.advance(5_000);
      expect(scrape.start).toHaveBeenCalledExactlyOnceWith({
        executionMode: "batch",
        libraryId: "movies",
        refs: [
          { rootId: "movies", relativePath: "stream.strm" },
          { rootId: "movies", relativePath: "uppercase.STRM" },
        ],
      });
      scrape.start.mockClear();
      await harness.advance(60_000);
      await appendFile(source("new.mp4"), "second chunk");
      await harness.advance(120_000);
      expect(scrape.start).not.toHaveBeenCalled();

      scrape.start.mockRejectedValueOnce(new Error("queue unavailable"));
      await harness.advance(120_000);
      expect(harness.logger.error).toHaveBeenLastCalledWith(expect.stringContaining("queue unavailable"));
      await harness.advance(120_000);
      expect(scrape.start).toHaveBeenCalledTimes(2);
      expect(scrape.start).toHaveBeenLastCalledWith({
        executionMode: "batch",
        libraryId: "movies",
        refs: [{ rootId: "movies", relativePath: "new.mp4" }],
      });
      await harness.advance(60_000);
      expect(scrape.start).toHaveBeenCalledTimes(2);

      // The source of a hardlinked or copied movie is already in the library.
      harness.knownMediaIdentities.mockImplementation(
        (keys) => new Set(keys.filter((key) => key === filesystemPathKey(source("linked.mp4")))),
      );
      await writeFile(source("linked.mp4"), "published");
      // A downloader callback claims its file while submitting; a scan in the meantime leaves it alone.
      await writeFile(source("callback.mp4"), "downloaded");
      let accept!: () => void;
      const callback = service.submitExternal("movies", [{ rootId: "movies", relativePath: "callback.mp4" }], () => {
        return new Promise<{ task: { id: string } }>((resolve) => {
          accept = () => resolve({ task: { id: "task-2" } });
        });
      });
      await vi.waitFor(() => expect(accept).toBeTypeOf("function"));
      harness.scrape.liveRuns.mockResolvedValue({ runs: [{ task: { id: "task-2" } }] });
      await harness.advance(60_000);
      await harness.advance(120_000);
      accept();
      await expect(callback).resolves.toEqual({ task: { id: "task-2" } });
      await harness.advance(120_000);
      await harness.advance(60_000);
      expect(scrape.start).toHaveBeenCalledTimes(2);

      // A callback naming a source the library already holds, or one whose task is still running, is a no-op.
      const duplicate = vi.fn().mockResolvedValue({ task: { id: "again" } });
      await expect(
        service.submitExternal("movies", [{ rootId: "movies", relativePath: "linked.mp4" }], duplicate),
      ).resolves.toBeNull();
      await expect(
        service.submitExternal("movies", [{ rootId: "movies", relativePath: "callback.mp4" }], duplicate),
      ).resolves.toBeNull();
      expect(duplicate).not.toHaveBeenCalled();

      await service.close();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await service.close();
    }
  });

  it("keeps event, stability and full-scan deadlines across scoped changes and restarts", async () => {
    const outer = await createLibrary("outer", { cloudPath: "/cloud", scanIntervalMinutes: 60 });
    const inner = await createLibrary("inner", {
      cloudPath: "/cloud/inner",
      automation: "register",
      scanIntervalMinutes: 60,
    });
    const harness = createHarness([outer, inner]);
    vi.useFakeTimers();
    let service = harness.create();
    try {
      await writeFile(path.join(outer.sourcePath, "outer-existing.mp4"), "baseline");
      await service.start();
      await harness.settled();

      await writeFile(path.join(outer.sourcePath, "outer-new.mp4"), "ready");
      await mkdir(path.join(inner.sourcePath, "release"));
      await writeFile(path.join(inner.sourcePath, "release", "inner-new.mp4"), "ready");
      await writeFile(path.join(inner.sourcePath, "release", "stream.strm"), "https://media.example/stream.mp4");
      const arrival = {
        action: "create" as const,
        isDir: false,
        sourceFile: "/cloud/inner/release/inner-new.mp4",
        destinationFile: "",
      };
      service.submitCloudDriveChanges([
        arrival,
        { action: "create", isDir: false, sourceFile: "/elsewhere/ignored.mp4", destinationFile: "" },
      ]);
      // Every arrival counts toward the webhook's liveness; only routed changes count toward a library's.
      expect(service.cloudDriveActivity()).toEqual({
        lastEventAt: expect.any(String),
        libraries: { inner: expect.any(String) },
      });
      await harness.advance(4_000);
      service.submitCloudDriveChanges([arrival]);
      await harness.advance(1_000);
      expect(harness.registerPathIntent).toHaveBeenLastCalledWith(path.join(inner.sourcePath, "release"));
      expect(harness.registerPathIntent).toHaveBeenCalledTimes(3);
      expect(harness.pending.upsert).toHaveBeenCalledExactlyOnceWith({
        kind: "new_file",
        rootId: "inner",
        relativePath: "release/stream.strm",
        libraryId: "inner",
      });

      await mkdir(path.join(inner.sourcePath, "other"));
      await writeFile(path.join(inner.sourcePath, "other", "second.mp4"), "ready");
      service.submitCloudDriveChanges([{ ...arrival, sourceFile: "/cloud/inner/other/second.mp4" }]);
      await harness.advance(5_000);
      expect(harness.registerPathIntent).toHaveBeenLastCalledWith(path.join(inner.sourcePath, "other"));

      await harness.advance(109_000);
      service.submitCloudDriveChanges([arrival]);
      await harness.advance(4_000);
      service.submitCloudDriveChanges([arrival]);
      await harness.advance(1_000);
      service.submitCloudDriveChanges([arrival]);
      await harness.advance(999);
      expect(harness.pending.upsert).toHaveBeenCalledTimes(1);
      await harness.advance(1);
      expect(harness.scrape.start).not.toHaveBeenCalled();
      expect(harness.pending.upsert).toHaveBeenCalledTimes(2);
      expect(harness.pending.upsert).toHaveBeenLastCalledWith({
        kind: "new_file",
        rootId: "inner",
        relativePath: "release/inner-new.mp4",
        libraryId: "inner",
      });
      expect(harness.onPending).toHaveBeenCalledWith(1);
      await harness.advance(5_000);
      expect(harness.pending.upsert).toHaveBeenLastCalledWith(
        expect.objectContaining({ relativePath: "other/second.mp4" }),
      );

      // Subtree events cannot postpone the full rescan that catches a missed webhook.
      await writeFile(path.join(inner.sourcePath, "missed.mp4"), "ready");
      await harness.advance(3_469_000);
      service.submitCloudDriveChanges([arrival]);
      await harness.advance(1_000);
      expect(harness.registerPathIntent).toHaveBeenLastCalledWith(inner.sourcePath);
      await harness.advance(120_000);
      expect(harness.pending.upsert).toHaveBeenLastCalledWith(expect.objectContaining({ relativePath: "missed.mp4" }));
      await service.close();

      // Cloud transfers keep the original modification time, so files that arrived while stopped are not judged by it.
      await writeFile(path.join(inner.sourcePath, "offline.mp4"), "arrived while stopped");
      await utimes(path.join(inner.sourcePath, "offline.mp4"), new Date("2020-01-01"), new Date("2020-01-01"));
      service = harness.create();
      await service.start();
      await harness.settled();
      service.submitCloudDriveChanges([
        { action: "rename", isDir: true, sourceFile: "/cloud/inner/old", destinationFile: "/cloud/inner" },
      ]);
      await harness.advance(5_000);
      await harness.advance(120_000);
      expect(harness.pending.upsert).toHaveBeenLastCalledWith(
        expect.objectContaining({ kind: "new_file", relativePath: "offline.mp4" }),
      );
      expect(harness.pending.upsert).toHaveBeenCalledTimes(5);
      // The outer library finds its arrival through polling, independently of the inner library's events.
      expect(harness.scrape.start).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ libraryId: "outer", refs: [{ rootId: "outer", relativePath: "outer-new.mp4" }] }),
      );
    } finally {
      await service.close();
    }
  });
});
