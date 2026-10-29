import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { filesystemPathKey, isPathInside } from "@mdcz/media-store";
import { EmbyDeletionRepository, ScrapeConflictRepository } from "@mdcz/persistence";
import { type MediaLibraryService, mediaPathOwnership } from "@mdcz/runtime/library";
import { parseStrmTarget } from "@mdcz/runtime/scrape/utils/strm";
import type { Configuration } from "@mdcz/shared/config";
import type { EmbyDeletionConfig } from "@mdcz/shared/embyDeletion";
import type { RootFileRef } from "@mdcz/shared/mediaRef";
import type { StrmCloudBinding, StrmSourceSnapshot } from "@mdcz/shared/moviePilot";
import { moviePilotResourceIdentity } from "@mdcz/shared/moviePilot";
import type {
  ScrapeConflictInput,
  ScrapeConflictPreview,
  ScrapeConflictResolution,
  ScrapeConflictResolveInput,
  ScrapeConflictVersion,
} from "@mdcz/shared/scrapeConflict";
import { scrapeConflictSetupErrors } from "@mdcz/shared/scrapeConflict";
import type { ScrapeRunSnapshotDto } from "@mdcz/shared/serverDtos";
import { MoviePilotClient } from "./moviePilotClient";
import type { ServerPersistenceService } from "./persistenceService";
import { readStrmBinding, StrmDeletionService } from "./strmDeletionService";

type LibraryBinding = EmbyDeletionConfig["libraries"][number];
type Version = {
  cloud: StrmCloudBinding;
  fileId: string | null;
  fileUpdatedAt: number | null;
  linkHash: string | null;
};
interface Snapshot {
  library: LibraryBinding;
  existingLinkPath: string;
  incoming: Version;
  existing: Version;
  sourceRef: RootFileRef;
  previewedAt: number;
}
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

export class ScrapeConflictService {
  private readonly running = new Set<string>();

  constructor(
    private readonly deps: {
      persistence: Pick<ServerPersistenceService, "getState">;
      config: { get(): Promise<Configuration> };
      libraries: Pick<MediaLibraryService, "get">;
      snapshot(input: ScrapeConflictInput): Promise<ScrapeRunSnapshotDto>;
      retry(input: ScrapeConflictInput): Promise<ScrapeRunSnapshotDto>;
      isBusy(): boolean;
      invalidate(): void;
      moviePilotFetch?: typeof fetch;
    },
  ) {}

  async restore(snapshot: ScrapeRunSnapshotDto): Promise<ScrapeRunSnapshotDto> {
    const state = await this.deps.persistence.getState();
    const rows = new ScrapeConflictRepository(state.database).list(snapshot.task.id);
    const items = [...snapshot.items];
    for (const row of rows) {
      if (items.some((item) => item.id === row.itemId)) continue;
      const saved = JSON.parse(row.snapshotJson) as Snapshot;
      items.push({
        id: row.itemId,
        resultId: null,
        ...saved.sourceRef,
        fileName: path.basename(saved.sourceRef.relativePath),
        status: "failed",
        conflict: { sourcePath: saved.incoming.cloud.source.sourcePath, targetPath: saved.existingLinkPath },
        error: "Target directory already contains a movie with the same name",
        crawlerData: null,
        nfoRootId: null,
        nfoRelativePath: null,
        outputRootId: null,
        outputRelativePath: null,
        assets: [],
        manualUrl: null,
      });
    }
    return { ...snapshot, items };
  }

  async preview(input: ScrapeConflictInput): Promise<ScrapeConflictPreview> {
    if (this.running.has(input.itemId)) throw new Error("Duplicate resolution is already running");
    const state = await this.deps.persistence.getState();
    const jobs = new ScrapeConflictRepository(state.database);
    const saved = jobs.get(input.itemId);
    if (saved && saved.taskId !== input.taskId) throw new Error("Duplicate resolution belongs to another task");
    if (saved?.keep)
      return this.toPreview(JSON.parse(saved.snapshotJson) as Snapshot, saved.token, saved.keep, saved.step);
    const run = await this.deps.snapshot(input);
    const item = run.items.find((candidate) => candidate.id === input.itemId);
    if (run.task.continuity === "live" || item?.status !== "failed" || !item.conflict || !run.task.libraryId)
      throw new Error("Select a completed STRM duplicate conflict");
    const configuration = await this.deps.config.get();
    const connection = configuration.embyDeletion.moviePilot;
    const library = configuration.embyDeletion.libraries.find((candidate) => candidate.id === run.task.libraryId);
    const configuredLibrary = await this.deps.libraries.get(run.task.libraryId);
    if (configuredLibrary.placement !== "copy") throw new Error(scrapeConflictSetupErrors.copyLibraryRequired);
    if (!connection) throw new Error(scrapeConflictSetupErrors.moviePilotRequired);
    if (!library?.source) throw new Error(scrapeConflictSetupErrors.libraryBindingRequired);
    if (
      filesystemPathKey(configuredLibrary.sourcePath) !== library.source.path ||
      filesystemPathKey(configuredLibrary.outputPath) !== library.outputPath
    )
      throw new Error(scrapeConflictSetupErrors.libraryPathsChanged);
    const repository = new EmbyDeletionRepository(state.database);
    const root = await state.repositories.mediaRoots.get(item.rootId);
    const sourcePath = filesystemPathKey(path.resolve(root.realPath ?? root.hostPath, item.relativePath));
    if (sourcePath !== filesystemPathKey(item.conflict.sourcePath)) throw new Error("Conflict source identity changed");
    const targetPath = filesystemPathKey(item.conflict.targetPath);
    if (!isPathInside(library.realPath, targetPath)) throw new Error("Conflict target is outside this library");
    const existingFile = repository.findFile(targetPath);
    if (!existingFile) throw new Error("Existing Link STRM has no library record; scan it first");
    const binding = readStrmBinding(repository, existingFile.id);
    const source =
      binding?.connectionId === connection.id && binding.fileUpdatedAt === existingFile.updatedAt.getTime()
        ? binding.source
        : existingFile.strmSourceJson
          ? (JSON.parse(existingFile.strmSourceJson) as StrmSourceSnapshot)
          : undefined;
    if (!source) throw new Error("Existing STRM has no recorded Normal source; verify its association first");
    const strm = new StrmDeletionService(() => configuration.embyDeletion);
    await strm.assertMounts(library);
    const client = new MoviePilotClient(connection, connection.token, this.deps.moviePilotFetch);
    const index = await client.index(connection);
    const versions: Version[] = [];
    for (const normalPath of [source.sourcePath, sourcePath]) {
      if (!isPathInside(library.source.realPath, filesystemPathKey(normalPath)))
        throw new Error("Normal STRM is outside this library");
      const stat = await lstat(normalPath);
      if (
        path.extname(normalPath).toLowerCase() !== ".strm" ||
        !stat.isFile() ||
        stat.size > 64 * 1024 ||
        !isPathInside(library.source.realPath, filesystemPathKey(await realpath(normalPath)))
      )
        throw new Error("Normal STRM file type or location changed");
      const content = await readFile(normalPath);
      const playback = parseStrmTarget(content.toString("utf8"));
      const resourceIdentity = playback ? moviePilotResourceIdentity(playback) : undefined;
      const expected = new URL("api/v1/plugin/P115StrmHelper/redirect_url", `${connection.baseUrl}/`);
      if (!resourceIdentity?.startsWith(`${expected.origin}${expected.pathname}?pickcode=`))
        throw new Error("STRM does not identify a file on the configured MoviePilot server");
      const pickcode = new URL(resourceIdentity).searchParams.get("pickcode") ?? "";
      const candidates = index.get(pickcode) ?? [];
      if (candidates.length !== 1) throw new Error("115 source could not be uniquely verified");
      versions.push({
        cloud: {
          connectionId: connection.id,
          fileUpdatedAt: 0,
          source: { sourcePath: filesystemPathKey(normalPath), sha256: hash(content), resourceIdentity },
          ...candidates[0],
        },
        fileId: null,
        fileUpdatedAt: null,
        linkHash: null,
      });
    }
    const [existing, incoming] = versions;
    if (source.sha256 !== existing.cloud.source.sha256) throw new Error("Recorded Normal STRM was replaced");
    const linkStat = await lstat(targetPath);
    if (
      path.extname(targetPath).toLowerCase() !== ".strm" ||
      !linkStat.isFile() ||
      linkStat.size > 64 * 1024 ||
      !isPathInside(library.realPath, filesystemPathKey(await realpath(targetPath)))
    )
      throw new Error("Link STRM file type or location changed");
    existing.linkHash = hash(await readFile(targetPath));
    if (existing.linkHash !== existing.cloud.source.sha256)
      throw new Error("Normal and Link refer to different resources");
    existing.fileId = existingFile.id;
    existing.fileUpdatedAt = existingFile.updatedAt.getTime();
    const snapshot: Snapshot = {
      library,
      existing,
      incoming,
      existingLinkPath: targetPath,
      sourceRef: { rootId: item.rootId, relativePath: item.relativePath },
      previewedAt: Date.now(),
    };
    const token = randomUUID();
    jobs.preview({ itemId: input.itemId, taskId: input.taskId, snapshotJson: JSON.stringify(snapshot), token });
    return this.toPreview(snapshot, token, null, null);
  }

  private toPreview(
    snapshot: Snapshot,
    token: string,
    keep: ScrapeConflictPreview["keep"],
    step: string | null,
  ): ScrapeConflictPreview {
    const version = (entry: Version): ScrapeConflictVersion => {
      if (entry.cloud.target.size == null) throw new Error("115 source size is unavailable");
      return {
        name: entry.cloud.target.name ?? path.posix.basename(entry.cloud.target.path),
        size: entry.cloud.target.size,
        cloudPath: entry.cloud.target.path,
        normalPath: entry.cloud.source.sourcePath,
        linkPath: entry.fileId ? snapshot.existingLinkPath : null,
      };
    };
    return {
      token,
      existing: version(snapshot.existing),
      incoming: version(snapshot.incoming),
      sameResource: snapshot.existing.cloud.target.fileid === snapshot.incoming.cloud.target.fileid,
      keep,
      step,
    };
  }

  async resolve(input: ScrapeConflictResolveInput): Promise<ScrapeConflictResolution> {
    if (this.running.has(input.itemId)) throw new Error("Duplicate resolution is already running");
    this.running.add(input.itemId);
    let release: (() => void) | undefined;
    try {
      const state = await this.deps.persistence.getState();
      const jobs = new ScrapeConflictRepository(state.database);
      const job = jobs.get(input.itemId);
      if (!job || job.taskId !== input.taskId || job.token !== input.token)
        throw new Error("Refresh the duplicate preview before deleting");
      if (job.keep && job.keep !== input.keep) throw new Error("Continue the previously selected resolution");
      if (job.step === "completed") return { runId: job.retryRunId };
      const snapshot = JSON.parse(job.snapshotJson) as Snapshot;
      if (job.step === "retrying") {
        const retry = (await state.repositories.scrapeRuns.list()).find(
          (run) =>
            run.previousRunId === input.taskId &&
            run.createdAt.getTime() >= snapshot.previewedAt &&
            run.items.length === 1 &&
            run.items[0].rootId === snapshot.sourceRef.rootId &&
            run.items[0].relativePath === snapshot.sourceRef.relativePath,
        );
        if (retry) {
          jobs.update(input.itemId, { step: "completed", retryRunId: retry.id });
          return { runId: retry.id };
        }
      }
      const configuration = await this.deps.config.get();
      const connection = configuration.embyDeletion.moviePilot;
      if (!connection || connection.id !== snapshot.existing.cloud.connectionId)
        throw new Error("MoviePilot connection changed; review required");
      const repository = new EmbyDeletionRepository(state.database);
      const selected = input.keep === "existing" ? snapshot.incoming : snapshot.existing;
      const retained = input.keep === "existing" ? snapshot.existing : snapshot.incoming;
      const shared = selected.cloud.target.fileid === retained.cloud.target.fileid;
      const linkPath = snapshot.existingLinkPath;
      release = mediaPathOwnership.acquireAll([
        ...new Set([linkPath, snapshot.existing.cloud.source.sourcePath, snapshot.incoming.cloud.source.sourcePath]),
      ]);
      const strm = new StrmDeletionService(() => configuration.embyDeletion);
      const client = new MoviePilotClient(connection, connection.token, this.deps.moviePilotFetch);
      const assertActive = async () => {
        const current = (await this.deps.config.get()).embyDeletion;
        const library = await this.deps.libraries.get(snapshot.library.id);
        if (this.deps.isBusy() || repository.hasLiveScrapes())
          throw new Error("Wait for active media tasks before resolving duplicates");
        if (
          current.moviePilot?.id !== connection.id ||
          JSON.stringify(current.libraries.find((entry) => entry.id === snapshot.library.id)) !==
            JSON.stringify(snapshot.library) ||
          library.placement !== "copy" ||
          filesystemPathKey(library.sourcePath) !== snapshot.library.source?.path ||
          filesystemPathKey(library.outputPath) !== snapshot.library.outputPath
        )
          throw new Error("STRM library settings changed; review required");
        await strm.assertMounts(snapshot.library);
      };
      await assertActive();
      await strm.assertSource(snapshot.library, retained.cloud, false);
      if (!(await client.verify(connection, retained.cloud)))
        throw new Error("The version to keep is no longer available on 115");
      let step: string = job.step;
      if (step === "validating" || step === "deleting_cloud") {
        const file = repository.findFile(linkPath);
        if (file?.id !== snapshot.existing.fileId || file.updatedAt.getTime() !== snapshot.existing.fileUpdatedAt)
          throw new Error("Existing library file changed; refresh the preview");
        await strm.assertSource(snapshot.library, selected.cloud, false);
        await this.assertLink(strm, snapshot, false);
        if (!shared) {
          if (repository.otherReferences(selected.fileId ?? "", connection.id, selected.cloud.target.fileid))
            throw new Error("Other library files reference this 115 video; deletion requires review");
          if (
            repository
              .knownFiles(configuration.embyDeletion.libraries.filter((entry) => entry.source))
              .some(
                ({ file, path: filePath }) =>
                  path.extname(filePath).toLowerCase() === ".strm" &&
                  (readStrmBinding(repository, file.id)?.connectionId !== connection.id ||
                    readStrmBinding(repository, file.id)?.fileUpdatedAt !== file.updatedAt.getTime()),
              )
          )
            throw new Error("Verify registered STRM associations in settings before deleting a 115 resource");
        }
        const target = shared ? undefined : await client.verify(connection, selected.cloud);
        if (!shared && !target)
          throw new Error("115 file is absent without a saved deletion acknowledgement; review required");
        await assertActive();
        await strm.assertSource(snapshot.library, retained.cloud, false);
        await strm.assertSource(snapshot.library, selected.cloud, false);
        await this.assertLink(strm, snapshot, false);
        jobs.update(input.itemId, { keep: input.keep });
        if (selected.cloud.source.sourcePath !== retained.cloud.source.sourcePath) {
          const tombstone = {
            ...selected.cloud,
            source: { ...selected.cloud.source, ...(shared ? { resourceIdentity: undefined } : {}) },
          };
          const tombstoneId = `conflict:${input.itemId}`;
          if (!repository.binding(tombstoneId))
            repository.bind({
              fileId: tombstoneId,
              libraryId: snapshot.library.id,
              sourcePath: selected.cloud.source.sourcePath,
              linkPath: selected.cloud.source.sourcePath,
              snapshotJson: JSON.stringify(tombstone),
              blocked: true,
            });
        }
        if (target) {
          jobs.update(input.itemId, { step: "deleting_cloud" });
          await client.deleteFile(target);
          jobs.update(input.itemId, { step: "verifying_cloud" });
          step = "verifying_cloud";
        } else {
          jobs.update(input.itemId, { step: "cleaning_local" });
          step = "cleaning_local";
        }
      }
      if (step === "verifying_cloud") {
        await assertActive();
        await client.test();
        if (await client.verify(connection, selected.cloud))
          throw new Error("115 deletion was acknowledged but the video is still listed; retry later");
        jobs.update(input.itemId, { step: "cleaning_local" });
        step = "cleaning_local";
      }
      if (step === "cleaning_local") {
        await assertActive();
        if (selected.cloud.source.sourcePath !== retained.cloud.source.sourcePath) {
          await strm.removeSource(input.itemId, snapshot.library, selected.cloud, () => {
            if (this.deps.isBusy() || repository.hasLiveScrapes())
              throw new Error("Media tasks started during deletion; retry when idle");
            return true;
          });
        }
        if (input.keep === "incoming") {
          await assertActive();
          await this.assertLink(strm, snapshot, true);
          await strm.removeSource(
            input.itemId,
            {
              ...snapshot.library,
              source: {
                path: snapshot.library.outputPath,
                realPath: snapshot.library.realPath,
                marker: snapshot.library.marker,
              },
            },
            { ...selected.cloud, source: { sourcePath: linkPath, sha256: snapshot.existing.linkHash ?? "" } },
            () => {
              if (this.deps.isBusy() || repository.hasLiveScrapes())
                throw new Error("Media tasks started during deletion; retry when idle");
              return true;
            },
          );
          const file = repository.findFile(linkPath);
          if (file) {
            if (file.id !== selected.fileId || file.updatedAt.getTime() !== selected.fileUpdatedAt)
              throw new Error("Library record changed during deletion; review required");
            state.repositories.library.removeFile(file.id);
          }
        } else {
          state.repositories.pending.deleteFiles([snapshot.sourceRef]);
        }
        jobs.update(input.itemId, { step: input.keep === "incoming" ? "retrying" : "completed" });
        step = input.keep === "incoming" ? "retrying" : "completed";
        this.deps.invalidate();
      }
      if (step === "retrying") {
        await assertActive();
        release();
        release = undefined;
        const run = await this.deps.retry(input);
        jobs.update(input.itemId, { step: "completed", retryRunId: run.task.id });
        return { runId: run.task.id };
      }
      return { runId: null };
    } finally {
      release?.();
      this.running.delete(input.itemId);
    }
  }

  private async assertLink(strm: StrmDeletionService, snapshot: Snapshot, allowMissing: boolean): Promise<void> {
    await strm.assertSource(
      {
        ...snapshot.library,
        source: {
          path: snapshot.library.outputPath,
          realPath: snapshot.library.realPath,
          marker: snapshot.library.marker,
        },
      },
      {
        ...snapshot.existing.cloud,
        source: { sourcePath: snapshot.existingLinkPath, sha256: snapshot.existing.linkHash ?? "" },
      },
      allowMissing,
    );
  }
}
