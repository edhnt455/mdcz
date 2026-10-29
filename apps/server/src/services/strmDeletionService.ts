import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, lstat, readFile, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { filesystemPathKey, isPathInside } from "@mdcz/media-store";
import type { EmbyDeletionEventRow, EmbyDeletionLibraryBinding, EmbyDeletionRepository } from "@mdcz/persistence";
import { parseStrmTarget } from "@mdcz/runtime/scrape/utils/strm";
import type { EmbyDeletionConfig } from "@mdcz/shared/embyDeletion";
import {
  type MoviePilotConnection,
  type MoviePilotSettings,
  moviePilotResourceIdentity,
  moviePilotSettingsSchema,
  type StrmCloudBinding,
  type StrmSourceSnapshot,
} from "@mdcz/shared/moviePilot";
import { MoviePilotClient } from "./moviePilotClient";

const hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");

type StoredMoviePilot = NonNullable<EmbyDeletionConfig["moviePilot"]>;

export const moviePilotConnectionOf = (moviePilot: EmbyDeletionConfig["moviePilot"]): MoviePilotConnection | null =>
  moviePilot
    ? {
        id: moviePilot.id,
        baseUrl: moviePilot.baseUrl,
        storage: moviePilot.storage,
        rootPath: moviePilot.rootPath,
        root: moviePilot.root,
      }
    : null;

export const readStrmBinding = (repository: EmbyDeletionRepository, fileId: string): StrmCloudBinding | undefined => {
  const row = repository.binding(fileId);
  return row ? (JSON.parse(row.snapshotJson) as StrmCloudBinding) : undefined;
};

export class StrmDeletionService {
  constructor(
    private readonly readSettings: () => EmbyDeletionConfig,
    private readonly fetcher?: typeof fetch,
  ) {}

  private client(connection: StoredMoviePilot): MoviePilotClient {
    return new MoviePilotClient(connection, connection.token, this.fetcher);
  }

  async configure(current: EmbyDeletionConfig["moviePilot"], input: MoviePilotSettings): Promise<StoredMoviePilot> {
    const settings = moviePilotSettingsSchema.parse(input);
    const token = settings.token ?? current?.token;
    if (!token) throw new Error("Enter a MoviePilot API token");
    const client = new MoviePilotClient(settings, token, this.fetcher);
    await client.test();
    const { root } = await client.resolveRoot();
    return {
      id: randomUUID(),
      baseUrl: settings.baseUrl.replace(/\/+$/u, ""),
      storage: settings.storage,
      rootPath: path.posix.normalize(settings.rootPath).replace(/\/$/u, ""),
      root,
      token,
    };
  }

  async test(): Promise<{ storage: string }> {
    const connection = this.readSettings().moviePilot;
    if (!connection) throw new Error("Configure MoviePilot first");
    const client = this.client(connection);
    const result = await client.test();
    if ((await client.resolveRoot()).root.fileid !== connection.root.fileid)
      throw new Error("MoviePilot root identity changed; reconnect and rebind");
    return result;
  }

  async bind(
    repository: EmbyDeletionRepository,
    deletedFileId?: string,
  ): Promise<{ verified: number; unverified: number }> {
    const settings = this.readSettings();
    const connection = settings.moviePilot;
    if (!connection) throw new Error("Configure MoviePilot first");
    if (repository.hasLiveScrapes()) throw new Error("Wait for active media tasks before binding STRM sources");
    const index = await this.client(connection).index(connection);
    let verified = 0;
    let unverified = 0;
    for (const entry of repository.knownFiles(settings.libraries.filter((binding) => binding.source))) {
      if (deletedFileId && entry.file.id !== deletedFileId) continue;
      const library = settings.libraries.find((binding) => binding.id === entry.libraryId);
      if (!library?.source || path.extname(entry.path).toLowerCase() !== ".strm") continue;
      const existing = readStrmBinding(repository, entry.file.id);
      if (existing?.connectionId === connection.id && existing.fileUpdatedAt === entry.file.updatedAt.getTime()) {
        verified++;
        continue;
      }
      const source = entry.file.strmSourceJson
        ? (JSON.parse(entry.file.strmSourceJson) as StrmSourceSnapshot)
        : entry.file.retainedSourceIdentity
          ? { sourcePath: entry.file.retainedSourceIdentity, sha256: "" }
          : undefined;
      if (
        !source ||
        ![library.source.path, library.source.realPath].some((root) => isPathInside(root, source.sourcePath))
      ) {
        unverified++;
        continue;
      }
      await this.assertMounts(library);
      try {
        const sourceStat = await lstat(source.sourcePath);
        const linkStat = await lstat(entry.path).catch((error: NodeJS.ErrnoException) => {
          if (deletedFileId && source.sha256 && error.code === "ENOENT") return null;
          throw error;
        });
        if (
          !sourceStat.isFile() ||
          (linkStat && !linkStat.isFile()) ||
          sourceStat.size > 64 * 1024 ||
          (linkStat && linkStat.size > 64 * 1024) ||
          !isPathInside(library.source.realPath, filesystemPathKey(await realpath(source.sourcePath))) ||
          (linkStat && !isPathInside(library.realPath, filesystemPathKey(await realpath(entry.path))))
        )
          throw new Error("STRM file type or location changed");
        const sourceContent = await readFile(source.sourcePath);
        const sourceHash = hash(sourceContent);
        if (
          (source.sha256 && source.sha256 !== sourceHash) ||
          (linkStat && hash(await readFile(entry.path)) !== sourceHash)
        ) {
          unverified++;
          continue;
        }
        const playback = parseStrmTarget(sourceContent.toString("utf8"));
        const url = playback ? new URL(playback) : undefined;
        const expected = new URL("api/v1/plugin/P115StrmHelper/redirect_url", `${connection.baseUrl}/`);
        const pickcodes = url?.searchParams.getAll("pickcode");
        if (
          !url ||
          url.origin !== expected.origin ||
          url.pathname !== expected.pathname ||
          url.username ||
          url.password ||
          pickcodes?.length !== 1 ||
          !pickcodes[0]
        ) {
          unverified++;
          continue;
        }
        const candidates = index.get(pickcodes[0]) ?? [];
        if (candidates.length !== 1 || candidates[0].target.size == null) {
          unverified++;
          continue;
        }
        const current = repository.findFile(entry.path);
        if (
          !current ||
          current.id !== entry.file.id ||
          current.updatedAt.getTime() !== entry.file.updatedAt.getTime() ||
          this.readSettings().moviePilot?.id !== connection.id
        )
          throw new Error("STRM configuration or file record changed while binding");
        const binding: StrmCloudBinding = {
          connectionId: connection.id,
          fileUpdatedAt: current.updatedAt.getTime(),
          source: {
            sourcePath: source.sourcePath,
            sha256: sourceHash,
            resourceIdentity: moviePilotResourceIdentity(playback ?? ""),
          },
          ...candidates[0],
        };
        repository.bind({
          fileId: current.id,
          libraryId: library.id,
          linkPath: entry.path,
          sourcePath: source.sourcePath,
          snapshotJson: JSON.stringify(binding),
          blocked: false,
        });
        verified++;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          unverified++;
          continue;
        }
        throw error;
      }
    }
    return { verified, unverified };
  }

  async assertMounts(binding: EmbyDeletionLibraryBinding): Promise<void> {
    for (const root of [
      { path: binding.outputPath, realPath: binding.realPath, marker: binding.marker },
      ...(binding.source ? [binding.source] : []),
    ]) {
      if (
        filesystemPathKey(await realpath(root.path)) !== root.realPath ||
        (await readFile(path.join(root.path, ".mdcz-library-id"), "utf8")) !== root.marker
      )
        throw new Error("STRM mount identity cannot be verified");
    }
  }

  async process(input: {
    repository: EmbyDeletionRepository;
    event: EmbyDeletionEventRow;
    library: EmbyDeletionLibraryBinding;
    now: () => number;
    active: () => boolean;
  }): Promise<boolean> {
    const { repository, event, library, now, active } = input;
    const snapshot = event.snapshotJson ? (JSON.parse(event.snapshotJson) as StrmCloudBinding) : undefined;
    const connection = this.readSettings().moviePilot;
    if (
      !snapshot ||
      !connection ||
      snapshot.connectionId !== connection.id ||
      !library.source ||
      !event.fileId ||
      ![library.source.path, library.source.realPath].some((root) => isPathInside(root, snapshot.source.sourcePath))
    )
      throw new Error("STRM source binding is unavailable or changed");
    await this.assertMounts(library);
    if (!active()) return false;
    if (event.step !== "validating" && this.readSettings().mode !== "delete") return false;
    if (
      repository.otherReference(
        event.fileId,
        snapshot.connectionId,
        snapshot.target.fileid,
        snapshot.source.resourceIdentity,
      )
    ) {
      if (event.cloudDeletedAt !== null || event.step !== "validating")
        throw new Error("A new reference appeared during cloud deletion; review required");
      if (this.readSettings().mode === "observe") {
        repository.finish(event.id, "ignored", "would_keep_shared_resource", now());
        return false;
      }
      return true;
    }
    const sources = new Map<string, { library: EmbyDeletionLibraryBinding; snapshot: StrmCloudBinding }>();
    const relatedBindings = repository.relatedBindings(snapshot.connectionId, snapshot.target.fileid);
    for (const row of relatedBindings) {
      const related = { libraryId: row.libraryId, snapshot: JSON.parse(row.snapshotJson) as StrmCloudBinding };
      const allowed = this.readSettings().libraries.find(
        (entry) =>
          entry.id === related.libraryId &&
          entry.source &&
          [entry.source.path, entry.source.realPath].some((root) =>
            isPathInside(root, related.snapshot.source.sourcePath),
          ),
      );
      if (!allowed) throw new Error("A retained STRM source is outside the currently allowed libraries");
      const previous = sources.get(related.snapshot.source.sourcePath);
      if (previous && previous.snapshot.source.sha256 !== related.snapshot.source.sha256)
        throw new Error("Conflicting STRM source identities require review");
      sources.set(related.snapshot.source.sourcePath, { library: allowed, snapshot: related.snapshot });
    }
    if (!sources.size) throw new Error("No persisted STRM sources remain");
    const writable = () => active() && this.readSettings().mode === "delete";
    const client = await this.client(connection);
    let step = event.step;
    if (step === "validating" || step === "deleting_cloud") {
      const target = await client.verify(connection, snapshot);
      if (!target)
        throw new Error("Cloud file is absent without a persisted deletion acknowledgement; review required");
      for (const source of sources.values()) await this.assertSource(source.library, source.snapshot, false);
      try {
        await lstat(event.path ?? "");
        throw new Error("Link STRM reappeared; deletion requires review");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (!active()) return false;
      if (this.readSettings().mode === "observe") {
        repository.finish(event.id, "ignored", "would_delete_strm_resource", now());
        return false;
      }
      repository.suppress(relatedBindings.map((row) => row.fileId));
      repository.update(event.id, { step: "deleting_cloud", result: "deleting_cloud" });
      if (!active()) return false;
      await client.deleteFile(target);
      repository.update(event.id, { step: "verifying_cloud", cloudDeletedAt: now(), result: "verifying_cloud" });
      step = "verifying_cloud";
    }
    if (step === "verifying_cloud") {
      if (!active() || this.readSettings().mode !== "delete") return false;
      await client.test();
      if (await client.verify(connection, snapshot))
        throw new Error("Cloud deletion was acknowledged but file is still listed");
      if (!active()) return false;
      repository.update(event.id, { step: "cleaning_source", result: "cleaning_source" });
      step = "cleaning_source";
    }
    if (step === "cleaning_source") {
      if (!active() || this.readSettings().mode !== "delete") return false;
      for (const source of sources.values())
        await this.removeSource(event.id, source.library, source.snapshot, writable);
      if (!active() || this.readSettings().mode !== "delete") return false;
      repository.update(event.id, {
        step: "cleaning_records",
        result: "confirming_source_cleanup",
        nextAttemptAt: now() + 5_000,
      });
      return false;
    }
    if (step === "cleaning_records") {
      if (!active() || this.readSettings().mode !== "delete") return false;
      let regenerated = false;
      for (const source of sources.values())
        regenerated = (await this.removeSource(event.id, source.library, source.snapshot, writable)) || regenerated;
      if (regenerated) {
        throw new Error("STRM generator recreated the source; waiting for regeneration to stop");
      }
      return active();
    }
    throw new Error("Unsupported STRM deletion step");
  }

  async removeSource(
    eventId: string,
    library: EmbyDeletionLibraryBinding,
    snapshot: StrmCloudBinding,
    active: () => boolean,
  ): Promise<boolean> {
    await this.assertMounts(library);
    const sourcePath = snapshot.source.sourcePath;
    const parked = `${sourcePath}.mdcz-delete-${eventId}`;
    if (
      !library.source ||
      !isPathInside(library.source.realPath, filesystemPathKey(await realpath(path.dirname(sourcePath))))
    )
      throw new Error("STRM source directory identity changed");
    let parkedExists = false;
    try {
      await lstat(parked);
      parkedExists = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (!parkedExists) {
      if (!(await this.assertSource(library, snapshot, true))) return false;
      if (!active()) return true;
      await rename(sourcePath, parked);
    }
    const stat = await lstat(parked);
    if (!stat.isFile() || stat.size > 64 * 1024 || hash(await readFile(parked)) !== snapshot.source.sha256) {
      if (stat.isFile()) {
        try {
          await copyFile(parked, sourcePath, constants.COPYFILE_EXCL);
          await unlink(parked);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
      }
      throw new Error("STRM changed during cleanup; replacement preserved for manual review");
    }
    // Parking first makes a generator's same-path replacement independent of the file being removed.
    if (!active()) return true;
    await unlink(parked);
    return true;
  }

  async assertSource(
    library: EmbyDeletionLibraryBinding,
    snapshot: StrmCloudBinding,
    allowMissing: boolean,
  ): Promise<boolean> {
    if (!library.source) throw new Error("STRM source root is not configured");
    await this.assertMounts(library);
    try {
      const stat = await lstat(snapshot.source.sourcePath);
      if (
        !stat.isFile() ||
        stat.size > 64 * 1024 ||
        !isPathInside(library.source.realPath, filesystemPathKey(await realpath(snapshot.source.sourcePath))) ||
        hash(await readFile(snapshot.source.sourcePath)) !== snapshot.source.sha256
      )
        throw new Error("STRM source was replaced; manual review required");
      return true;
    } catch (error) {
      if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
}
