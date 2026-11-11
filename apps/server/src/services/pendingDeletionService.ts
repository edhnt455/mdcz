import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { filesystemPathKey, isPathInside, resolveRootRelativePath } from "@mdcz/media-store";
import { type EmbyDeletionLibraryBinding, EmbyDeletionRepository } from "@mdcz/persistence";
import { type MediaLibraryService, mediaPathOwnership } from "@mdcz/runtime/library";
import { parseStrmTarget } from "@mdcz/runtime/scrape/utils/strm";
import type { Configuration } from "@mdcz/shared/config";
import { toErrorMessage } from "@mdcz/shared/error";
import { moviePilotResourceIdentity, type StrmCloudBinding, type StrmSourceSnapshot } from "@mdcz/shared/moviePilot";
import { MoviePilotClient } from "./moviePilotClient";
import type { ServerPersistenceService } from "./persistenceService";
import type { RuntimeLogService } from "./runtimeLogService";
import { readStrmBinding, StrmDeletionService } from "./strmDeletionService";

interface PendingDeletionSnapshot {
  library: EmbyDeletionLibraryBinding;
  cloud: StrmCloudBinding;
  fileId: string | null;
  fileUpdatedAt: number | null;
  linkPath: string | null;
  step: "deleting_cloud" | "verifying_cloud" | "cleaning_source";
}

export class PendingDeletionService {
  private indexCache?: {
    key: string;
    expiresAt: number;
    promise: ReturnType<MoviePilotClient["index"]>;
  };
  constructor(
    private readonly deps: {
      persistence: Pick<ServerPersistenceService, "getState">;
      config: { get(): Promise<Configuration> };
      libraries: Pick<MediaLibraryService, "get">;
      isBusy(): boolean;
      invalidate(): void;
      logger: Pick<ReturnType<RuntimeLogService["getLogger"]>, "info" | "error">;
      moviePilotFetch?: typeof fetch;
    },
  ) {}

  async delete(id: string): Promise<void> {
    const started = Date.now();
    const report = (message: string) =>
      this.deps.logger.info(`[待处理删除 ${id}] ${message}（累计 ${((Date.now() - started) / 1000).toFixed(1)} 秒）`);
    let release: (() => void) | undefined;
    report("开始处理，115 网络请求总时限 120 秒");
    try {
      const state = await this.deps.persistence.getState();
      const pending = state.repositories.pending;
      const item = pending.get(id);
      const root = await state.repositories.mediaRoots.get(item.rootId);
      const itemPath = filesystemPathKey(resolveRootRelativePath(root, item.relativePath));
      if (path.extname(itemPath).toLowerCase() !== ".strm") throw new Error("仅支持删除 STRM 及其 115 源文件");
      const libraryId = item.libraryId;
      if (!libraryId) throw new Error("此条目没有关联媒体库，无法核验删除范围");
      const configuration = await this.deps.config.get();
      const connection = configuration.embyDeletion.moviePilot;
      const library = configuration.embyDeletion.libraries.find((entry) => entry.id === libraryId);
      if (!connection || !library?.source) throw new Error("请先配置 MoviePilot 和此媒体库的 STRM 来源关联");
      const repository = new EmbyDeletionRepository(state.database);
      const strm = new StrmDeletionService(() => configuration.embyDeletion);
      const client = new MoviePilotClient(connection, connection.token, this.deps.moviePilotFetch, {
        signal: AbortSignal.timeout(120_000),
        onProgress: report,
      });
      const file = repository.findFile(itemPath);
      const recorded = file?.strmSourceJson ? (JSON.parse(file.strmSourceJson) as StrmSourceSnapshot) : null;
      const sourcePath = recorded?.sourcePath ?? itemPath;
      release = mediaPathOwnership.acquireAll([itemPath, filesystemPathKey(sourcePath)]);
      report(`核验 STRM：${itemPath}`);
      let snapshot = item.deletionJson ? (JSON.parse(item.deletionJson) as PendingDeletionSnapshot) : null;
      const assertActive = async () => {
        const current = (await this.deps.config.get()).embyDeletion;
        const configured = await this.deps.libraries.get(libraryId);
        if (this.deps.isBusy() || repository.hasLiveScrapes()) throw new Error("请等待媒体任务结束后再删除");
        if (
          current.moviePilot?.id !== connection.id ||
          JSON.stringify(current.libraries.find((entry) => entry.id === library.id)) !== JSON.stringify(library) ||
          configured.placement !== "copy" ||
          filesystemPathKey(configured.sourcePath) !== library.source?.path ||
          filesystemPathKey(configured.outputPath) !== library.outputPath ||
          pending.get(id).updatedAt.getTime() !== item.updatedAt.getTime()
        )
          throw new Error("媒体库配置或待处理条目已变化，请刷新后重试");
        await strm.assertMounts(library);
        const currentFile = repository.findFile(itemPath);
        if (currentFile?.id !== file?.id || currentFile?.updatedAt.getTime() !== file?.updatedAt.getTime())
          throw new Error("已入库文件记录已变化，需要检查");
        if (snapshot) {
          const other = repository.otherReference(
            snapshot.fileId,
            connection.id,
            snapshot.cloud.target.fileid,
            snapshot.cloud.source.resourceIdentity,
          );
          if (other) throw new Error(`115 源文件仍被其他已入库 STRM 引用，无法删除：${other}`);
        }
      };
      await assertActive();
      if (!snapshot) {
        if (!isPathInside(library.source.realPath, filesystemPathKey(sourcePath)))
          throw new Error("STRM 不在此媒体库已验证的来源目录内");
        const stat = await lstat(sourcePath);
        if (
          path.extname(sourcePath).toLowerCase() !== ".strm" ||
          !stat.isFile() ||
          stat.size > 64 * 1024 ||
          !isPathInside(library.source.realPath, filesystemPathKey(await realpath(sourcePath)))
        )
          throw new Error("STRM 文件类型或位置已变化");
        const content = await readFile(sourcePath);
        const sha256 = createHash("sha256").update(content).digest("hex");
        if (recorded && recorded.sha256 !== sha256) throw new Error("已记录的 STRM 来源文件被替换");
        const playback = parseStrmTarget(content.toString("utf8"));
        const resourceIdentity = playback ? moviePilotResourceIdentity(playback) : undefined;
        const expected = new URL("api/v1/plugin/P115StrmHelper/redirect_url", `${connection.baseUrl}/`);
        if (!resourceIdentity?.startsWith(`${expected.origin}${expected.pathname}?pickcode=`))
          throw new Error("STRM 未指向已配置的 MoviePilot 115 文件");
        const pickcode = new URL(resourceIdentity).searchParams.get("pickcode") ?? "";
        const binding = file ? readStrmBinding(repository, file.id) : undefined;
        let candidates: { target: StrmCloudBinding["target"]; ancestors: StrmCloudBinding["ancestors"] }[];
        if (
          binding?.connectionId === connection.id &&
          binding.fileUpdatedAt === file?.updatedAt.getTime() &&
          binding.source.sourcePath === filesystemPathKey(sourcePath) &&
          binding.source.sha256 === sha256 &&
          binding.source.resourceIdentity === resourceIdentity
        ) {
          report("复用已核验的 115 来源关联");
          candidates = [binding];
        } else {
          const key = JSON.stringify(connection);
          const previous = this.indexCache;
          let cache =
            previous && previous.key === key && previous.expiresAt > Date.now()
              ? previous
              : { key, expiresAt: Number.POSITIVE_INFINITY, promise: client.index(connection) };
          const reused = cache === previous;
          if (reused) report("复用 115 来源索引，跳过重复遍历；删除前仍实时核验目标");
          this.indexCache = cache;
          try {
            candidates = (await cache.promise).get(pickcode) ?? [];
            if (reused && !candidates.length) {
              report("索引未匹配到此 STRM，重新扫描新加入的 115 文件");
              cache = { key, expiresAt: Number.POSITIVE_INFINITY, promise: client.index(connection) };
              this.indexCache = cache;
              candidates = (await cache.promise).get(pickcode) ?? [];
            }
            if (!Number.isFinite(cache.expiresAt)) cache.expiresAt = Date.now() + 5 * 60_000;
          } catch (error) {
            if (this.indexCache === cache) this.indexCache = undefined;
            throw error;
          }
        }
        if (candidates.length !== 1 || candidates[0].target.size == null)
          throw new Error("无法唯一核验 STRM 对应的 115 源文件");
        snapshot = {
          library,
          cloud: {
            ...candidates[0],
            connectionId: connection.id,
            fileUpdatedAt: file?.updatedAt.getTime() ?? 0,
            source: { sourcePath: filesystemPathKey(sourcePath), sha256, resourceIdentity },
          },
          fileId: file?.id ?? null,
          fileUpdatedAt: file?.updatedAt.getTime() ?? null,
          linkPath: recorded && sourcePath !== itemPath ? itemPath : null,
          step: "deleting_cloud",
        };
      }
      if (
        snapshot.cloud.connectionId !== connection.id ||
        JSON.stringify(snapshot.library) !== JSON.stringify(library) ||
        snapshot.cloud.source.sourcePath !== filesystemPathKey(sourcePath)
      )
        throw new Error("删除任务的来源关联已变化，需要检查");
      await assertActive();
      if (snapshot.fileId && (file?.id !== snapshot.fileId || file.updatedAt.getTime() !== snapshot.fileUpdatedAt))
        throw new Error("已入库文件记录已变化，需要检查");
      const linkLibrary = {
        ...library,
        source: { path: library.outputPath, realPath: library.realPath, marker: library.marker },
      };
      const linkSnapshot = {
        ...snapshot.cloud,
        source: { ...snapshot.cloud.source, sourcePath: snapshot.linkPath ?? itemPath },
      };
      if (snapshot.step === "deleting_cloud") {
        report(`实时核验 115 目标：${snapshot.cloud.target.path}`);
        await strm.assertSource(library, snapshot.cloud, false);
        if (snapshot.linkPath) await strm.assertSource(linkLibrary, linkSnapshot, false);
        const target = await client.verify(connection, snapshot.cloud);
        if (!target) throw new Error("115 文件已消失但没有删除成功记录，请人工核查");
        await assertActive();
        await strm.assertSource(library, snapshot.cloud, false);
        if (snapshot.linkPath) await strm.assertSource(linkLibrary, linkSnapshot, false);
        const tombstoneId = `pending:${id}`;
        state.database.sqlite.transaction(() => {
          pending.saveDeletion(id, item.updatedAt, JSON.stringify(snapshot));
          if (!repository.binding(tombstoneId))
            repository.bind({
              fileId: tombstoneId,
              libraryId: library.id,
              linkPath: itemPath,
              sourcePath: snapshot.cloud.source.sourcePath,
              snapshotJson: JSON.stringify(snapshot.cloud),
              blocked: true,
            });
        })();
        report(`删除 115 源文件：${target.path}`);
        await client.deleteFile(target);
        snapshot.step = "verifying_cloud";
        pending.saveDeletion(id, item.updatedAt, JSON.stringify(snapshot));
      }
      if (snapshot.step === "verifying_cloud") {
        report("115 已响应删除，正在确认文件已消失");
        await assertActive();
        await client.test();
        if (await client.verify(connection, snapshot.cloud))
          throw new Error("115 已响应删除，但文件仍存在，请稍后重试");
        snapshot.step = "cleaning_source";
        pending.saveDeletion(id, item.updatedAt, JSON.stringify(snapshot));
      }
      await assertActive();
      report("清理本地 STRM 和媒体记录");
      const active = () => {
        if (this.deps.isBusy() || repository.hasLiveScrapes()) throw new Error("媒体任务已启动，请结束后重试删除");
        return true;
      };
      await strm.removeSource(`pending-${id}`, library, snapshot.cloud, active);
      if (snapshot.linkPath) await strm.removeSource(`pending-${id}`, linkLibrary, linkSnapshot, active);
      state.database.sqlite.transaction(() => {
        if (snapshot.fileId) state.repositories.library.removeFile(snapshot.fileId);
        pending.delete([id]);
      })();
      this.deps.invalidate();
      report("删除完成");
    } catch (error) {
      this.deps.logger.error(
        `[待处理删除 ${id}] 删除失败：${toErrorMessage(error)}（累计 ${((Date.now() - started) / 1000).toFixed(1)} 秒）`,
      );
      throw error;
    } finally {
      release?.();
    }
  }
}
