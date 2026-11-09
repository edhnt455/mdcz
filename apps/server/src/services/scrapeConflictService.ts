import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { filesystemPathKey, isPathInside } from "@mdcz/media-store";
import { EmbyDeletionRepository, ScrapeConflictRepository } from "@mdcz/persistence";
import { type MediaLibraryService, mediaPathOwnership } from "@mdcz/runtime/library";
import { parseFileInfo } from "@mdcz/runtime/scrape/utils/number";
import { parseStrmTarget } from "@mdcz/runtime/scrape/utils/strm";
import type { Configuration } from "@mdcz/shared/config";
import type { EmbyDeletionConfig } from "@mdcz/shared/embyDeletion";
import type { RootFileRef } from "@mdcz/shared/mediaRef";
import type { StrmCloudBinding, StrmSourceSnapshot } from "@mdcz/shared/moviePilot";
import { moviePilotResourceIdentity, strmReferenceErrors } from "@mdcz/shared/moviePilot";
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
export interface ScrapeConflictSnapshot {
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

  isRunning(itemId: string): boolean {
    return this.running.has(itemId);
  }

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
      const saved = JSON.parse(row.snapshotJson) as ScrapeConflictSnapshot;
      items.push({
        id: row.itemId,
        resultId: null,
        ...saved.sourceRef,
        fileName: path.basename(saved.sourceRef.relativePath),
        status: "failed",
        conflict: { sourcePath: saved.incoming.cloud.source.sourcePath, targetPath: saved.existingLinkPath },
        error: "目标目录中已存在同名影片",
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
    if (this.running.has(input.itemId)) throw new Error("重复版本处理正在运行");
    const state = await this.deps.persistence.getState();
    const jobs = new ScrapeConflictRepository(state.database);
    const saved = jobs.get(input.itemId);
    if (saved && saved.taskId !== input.taskId) throw new Error("重复版本处理属于其他任务");
    if (saved?.keep)
      return this.toPreview(
        JSON.parse(saved.snapshotJson) as ScrapeConflictSnapshot,
        saved.token,
        saved.keep,
        saved.step,
      );
    const run = await this.deps.snapshot(input);
    const item = run.items.find((candidate) => candidate.id === input.itemId);
    if (run.task.continuity === "live" || item?.status !== "failed" || !item.conflict || !run.task.libraryId)
      throw new Error("请选择一个已结束的 STRM 重复冲突条目");
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
    if (sourcePath !== filesystemPathKey(item.conflict.sourcePath)) throw new Error("冲突来源身份已变化");
    const targetPath = filesystemPathKey(item.conflict.targetPath);
    if (!isPathInside(library.realPath, targetPath)) throw new Error("冲突目标不在此媒体库内");
    const existingFile = repository.findFile(targetPath);
    if (!existingFile) throw new Error("现有 Link STRM 没有媒体库记录，请先扫描入库");
    const binding = readStrmBinding(repository, existingFile.id);
    const source =
      binding?.connectionId === connection.id && binding.fileUpdatedAt === existingFile.updatedAt.getTime()
        ? binding.source
        : existingFile.strmSourceJson
          ? (JSON.parse(existingFile.strmSourceJson) as StrmSourceSnapshot)
          : undefined;
    if (!source) throw new Error("现有 STRM 没有已记录的 Normal 来源，请先核验关联");
    const strm = new StrmDeletionService(() => configuration.embyDeletion);
    await strm.assertMounts(library);
    const client = new MoviePilotClient(connection, connection.token, this.deps.moviePilotFetch);
    const index = await client.index(connection);
    const versions: Version[] = [];
    for (const normalPath of [source.sourcePath, sourcePath]) {
      if (!isPathInside(library.source.realPath, filesystemPathKey(normalPath)))
        throw new Error("Normal STRM 不在此媒体库内");
      const stat = await lstat(normalPath);
      if (
        path.extname(normalPath).toLowerCase() !== ".strm" ||
        !stat.isFile() ||
        stat.size > 64 * 1024 ||
        !isPathInside(library.source.realPath, filesystemPathKey(await realpath(normalPath)))
      )
        throw new Error("Normal STRM 文件类型或位置已变化");
      const content = await readFile(normalPath);
      const playback = parseStrmTarget(content.toString("utf8"));
      const resourceIdentity = playback ? moviePilotResourceIdentity(playback) : undefined;
      const expected = new URL("api/v1/plugin/P115StrmHelper/redirect_url", `${connection.baseUrl}/`);
      if (!resourceIdentity?.startsWith(`${expected.origin}${expected.pathname}?pickcode=`))
        throw new Error("STRM 未指向已配置 MoviePilot 服务器上的文件");
      const pickcode = new URL(resourceIdentity).searchParams.get("pickcode") ?? "";
      const candidates = index.get(pickcode) ?? [];
      if (candidates.length !== 1) throw new Error("无法唯一核验 115 来源");
      if (candidates[0].target.size == null) throw new Error("无法获取 115 来源文件大小");
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
    if (source.sha256 !== existing.cloud.source.sha256) throw new Error("已记录的 Normal STRM 已被替换");
    const linkStat = await lstat(targetPath);
    if (
      path.extname(targetPath).toLowerCase() !== ".strm" ||
      !linkStat.isFile() ||
      linkStat.size > 64 * 1024 ||
      !isPathInside(library.realPath, filesystemPathKey(await realpath(targetPath)))
    )
      throw new Error("Link STRM 文件类型或位置已变化");
    existing.linkHash = hash(await readFile(targetPath));
    if (existing.linkHash !== existing.cloud.source.sha256) throw new Error("Normal 和 Link 指向不同资源");
    existing.fileId = existingFile.id;
    existing.fileUpdatedAt = existingFile.updatedAt.getTime();
    const snapshot: ScrapeConflictSnapshot = {
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

  async resolveAutomatically(input: ScrapeConflictInput): Promise<ScrapeConflictResolution | null> {
    if (!(await this.deps.config.get()).scrape.autoResolveDuplicates) return null;
    const preview = await this.preview(input);
    if (preview.keep) return null;
    const configuration = await this.deps.config.get();
    if (!configuration.scrape.autoResolveDuplicates) return null;
    const [existingSubtitled, incomingSubtitled] = [preview.existing, preview.incoming].map(
      (version) => parseFileInfo(path.posix.basename(version.name), [], {}, configuration.scrape).isSubtitled,
    );
    const preferIncoming =
      existingSubtitled !== incomingSubtitled ? incomingSubtitled : preview.incoming.size > preview.existing.size;
    const keep = !preview.sameResource && preferIncoming ? "incoming" : "existing";
    return this.resolve({ ...input, token: preview.token, keep }, true);
  }

  private toPreview(
    snapshot: ScrapeConflictSnapshot,
    token: string,
    keep: ScrapeConflictPreview["keep"],
    step: string | null,
  ): ScrapeConflictPreview {
    const version = (entry: Version): ScrapeConflictVersion => {
      if (entry.cloud.target.size == null) throw new Error("无法获取 115 来源文件大小");
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

  async resolve(input: ScrapeConflictResolveInput, automatic = false): Promise<ScrapeConflictResolution> {
    if (this.running.has(input.itemId)) throw new Error("重复版本处理正在运行");
    this.running.add(input.itemId);
    let release: (() => void) | undefined;
    try {
      const state = await this.deps.persistence.getState();
      const jobs = new ScrapeConflictRepository(state.database);
      const job = jobs.get(input.itemId);
      if (!job || job.taskId !== input.taskId || job.token !== input.token)
        throw new Error("请刷新重复版本预览后再删除");
      if (job.keep && job.keep !== input.keep) throw new Error("请继续此前选择的处理方式");
      if (job.step === "completed") return { runId: job.retryRunId };
      jobs.update(input.itemId, { keep: input.keep, error: null });
      const snapshot = JSON.parse(job.snapshotJson) as ScrapeConflictSnapshot;
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
        throw new Error("MoviePilot 连接已变化，需要检查");
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
        const currentConfiguration = await this.deps.config.get();
        if (automatic && !currentConfiguration.scrape.autoResolveDuplicates)
          throw new Error("自动处理重复版本已关闭，请手动继续");
        const current = currentConfiguration.embyDeletion;
        const library = await this.deps.libraries.get(snapshot.library.id);
        if (this.deps.isBusy() || repository.hasLiveScrapes()) throw new Error("请等待媒体任务结束后再处理重复版本");
        if (
          current.moviePilot?.id !== connection.id ||
          JSON.stringify(current.libraries.find((entry) => entry.id === snapshot.library.id)) !==
            JSON.stringify(snapshot.library) ||
          library.placement !== "copy" ||
          filesystemPathKey(library.sourcePath) !== snapshot.library.source?.path ||
          filesystemPathKey(library.outputPath) !== snapshot.library.outputPath
        )
          throw new Error("STRM 媒体库设置已变化，需要检查");
        await strm.assertMounts(snapshot.library);
      };
      await assertActive();
      await strm.assertSource(snapshot.library, retained.cloud, false);
      if (!(await client.verify(connection, retained.cloud))) throw new Error("要保留的版本已不在 115 中");
      let step: string = job.step;
      if (step === "validating" || step === "deleting_cloud") {
        const file = repository.findFile(linkPath);
        if (file?.id !== snapshot.existing.fileId || file.updatedAt.getTime() !== snapshot.existing.fileUpdatedAt)
          throw new Error("现有媒体库文件已变化，请刷新预览");
        await strm.assertSource(snapshot.library, selected.cloud, false);
        await this.assertLink(strm, snapshot, false);
        if (!shared) {
          const other = repository.otherReference(
            selected.fileId,
            connection.id,
            selected.cloud.target.fileid,
            selected.cloud.source.resourceIdentity,
          );
          if (other) throw new Error(`${strmReferenceErrors.shared}\n${other}`);
        }
        const target = shared ? undefined : await client.verify(connection, selected.cloud);
        if (!shared && !target) throw new Error("115 文件已不存在，但没有已保存的删除确认记录，需要检查");
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
          throw new Error("115 已确认删除，但视频仍在列表中，请稍后重试");
        jobs.update(input.itemId, { step: "cleaning_local" });
        step = "cleaning_local";
      }
      if (step === "cleaning_local") {
        await assertActive();
        if (selected.cloud.source.sourcePath !== retained.cloud.source.sourcePath) {
          await strm.removeSource(input.itemId, snapshot.library, selected.cloud, () => {
            if (this.deps.isBusy() || repository.hasLiveScrapes())
              throw new Error("删除期间启动了媒体任务，请在空闲时重试");
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
                throw new Error("删除期间启动了媒体任务，请在空闲时重试");
              return true;
            },
          );
          const file = repository.findFile(linkPath);
          if (file) {
            if (file.id !== selected.fileId || file.updatedAt.getTime() !== selected.fileUpdatedAt)
              throw new Error("删除期间媒体库记录已变化，需要检查");
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
    } catch (error) {
      const state = await this.deps.persistence.getState();
      const jobs = new ScrapeConflictRepository(state.database);
      const job = jobs.get(input.itemId);
      if (
        job?.taskId === input.taskId &&
        job.token === input.token &&
        (!job.keep || job.keep === input.keep) &&
        job.step !== "completed"
      ) {
        jobs.update(input.itemId, { error: error instanceof Error ? error.message : String(error) });
        this.deps.invalidate();
      }
      throw error;
    } finally {
      release?.();
      this.running.delete(input.itemId);
    }
  }

  private async assertLink(
    strm: StrmDeletionService,
    snapshot: ScrapeConflictSnapshot,
    allowMissing: boolean,
  ): Promise<void> {
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
