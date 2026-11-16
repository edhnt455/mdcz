import { lstat, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import { filesystemPathKey, isPathInside, resolveRootRelativePath } from "@mdcz/media-store";
import { mediaPathOwnership } from "@mdcz/runtime/library";
import type { LibraryTaskGate } from "@mdcz/runtime/tasks";
import type { Configuration } from "@mdcz/shared/config";
import { toErrorMessage } from "@mdcz/shared/error";
import type { PendingDeletionService } from "./pendingDeletionService";
import type { ServerPersistenceService } from "./persistenceService";

export class LibraryDeletionService {
  private running = false;

  constructor(
    private readonly persistence: Pick<ServerPersistenceService, "getState">,
    private readonly getConfiguration: () => Promise<Configuration>,
    private readonly strmDeletion: Pick<PendingDeletionService, "delete">,
    private readonly taskGate: LibraryTaskGate,
    private readonly invalidate: () => void,
  ) {
    taskGate.track("delete", () => this.running);
  }

  async delete(input: { fileId: string } | { ids: readonly string[] }): Promise<void> {
    this.taskGate.assertAvailable();
    this.running = true;
    let deleted = 0;
    try {
      const state = await this.persistence.getState();
      const { library, mediaRoots, pending } = state.repositories;
      const entries =
        "fileId" in input
          ? [await library.getEntryByFileId(input.fileId)]
          : await library.getEntriesByIds([...input.ids]);
      const files = entries
        .flatMap((entry) => entry.files)
        .filter((file) => !("fileId" in input) || file.id === input.fileId);
      for (const file of files) {
        const recorded = library.getFileById(file.id);
        if (recorded.updatedAt.getTime() !== file.updatedAt.getTime())
          throw new Error("媒体文件记录已变化，请刷新后重试");
        const root = await mediaRoots.get(file.rootId);
        const filePath = filesystemPathKey(resolveRootRelativePath(root, file.rootRelativePath));
        if (path.extname(filePath).toLowerCase() === ".strm") {
          const configuration = await this.getConfiguration();
          const binding = configuration.embyDeletion.libraries
            .filter((entry) => entry.source && isPathInside(entry.outputPath, filePath))
            .sort((a, b) => b.outputPath.length - a.outputPath.length)[0];
          if (!configuration.embyDeletion.moviePilot || !binding)
            throw new Error("请先配置 MoviePilot 和此媒体库的 STRM 来源关联");
          let item = pending
            .list()
            .find((item) => item.rootId === file.rootId && item.relativePath === file.rootRelativePath);
          if (item) {
            pending.assertAvailable(item.id);
            if (item.libraryId !== binding.id) throw new Error("待处理条目的媒体库关联已变化，请先核查");
          } else {
            pending.upsert({
              kind: "failed",
              rootId: file.rootId,
              relativePath: file.rootRelativePath,
              libraryId: binding.id,
              movieId: file.itemId,
              detail: "媒体库深度删除未完成，请重试删除",
            });
            item = pending
              .list()
              .find((item) => item.rootId === file.rootId && item.relativePath === file.rootRelativePath);
          }
          if (!item) throw new Error("无法创建深度删除记录");
          await this.strmDeletion.delete(item.id);
          deleted++;
          continue;
        }

        const configuration = await this.getConfiguration();
        const sourcePath = recorded.retainedSourceIdentity
          ? filesystemPathKey(recorded.retainedSourceIdentity)
          : filePath;
        const release = mediaPathOwnership.acquireAll([filePath, sourcePath]);
        try {
          const rootPath = filesystemPathKey(await realpath(root.hostPath));
          if (root.realPath && rootPath !== filesystemPathKey(root.realPath)) throw new Error("媒体根目录挂载已变化");
          const targets = [{ filePath, rootPath }];
          if (sourcePath !== filePath) {
            const configured = configuration.libraries.find(
              (entry) =>
                isPathInside(entry.outputPath || entry.sourcePath, filePath) &&
                isPathInside(entry.sourcePath, sourcePath),
            );
            if (!configured) throw new Error("保留源文件不在此媒体库的来源目录内");
            targets.unshift({
              filePath: sourcePath,
              rootPath: filesystemPathKey(await realpath(configured.sourcePath)),
            });
          }
          const snapshots = [];
          for (const target of targets) {
            const directory = await realpath(path.dirname(target.filePath)).catch((error: NodeJS.ErrnoException) => {
              if (error.code === "ENOENT") return null;
              throw error;
            });
            if (directory && !isPathInside(target.rootPath, filesystemPathKey(directory)))
              throw new Error("媒体文件目录已变化或超出媒体根目录");
            const stat = await lstat(target.filePath).catch((error: NodeJS.ErrnoException) => {
              if (error.code === "ENOENT") return null;
              throw error;
            });
            if (stat && !stat.isFile() && !stat.isSymbolicLink()) throw new Error("删除目标不是媒体文件");
            snapshots.push({ ...target, stat });
          }
          if (JSON.stringify((await this.getConfiguration()).libraries) !== JSON.stringify(configuration.libraries))
            throw new Error("媒体库配置已变化，请刷新后重试");
          this.taskGate.assertAvailable("delete");
          const current = library.getFileById(file.id);
          if (current.updatedAt.getTime() !== file.updatedAt.getTime())
            throw new Error("媒体文件记录已变化，请刷新后重试");
          for (const target of snapshots) {
            if (!target.stat) continue;
            const current = await lstat(target.filePath);
            if (
              current.dev !== target.stat.dev ||
              current.ino !== target.stat.ino ||
              current.size !== target.stat.size ||
              current.mtimeMs !== target.stat.mtimeMs
            )
              throw new Error("媒体文件已被替换，请刷新后重试");
            await unlink(target.filePath);
          }
          state.database.sqlite.transaction(() => {
            library.removeFile(file.id);
            pending.deleteFiles([{ rootId: file.rootId, relativePath: file.rootRelativePath }]);
          })();
          deleted++;
        } finally {
          release();
        }
      }
    } catch (error) {
      throw new Error(`深度删除中止，已删除 ${deleted} 个文件：${toErrorMessage(error)}`, { cause: error });
    } finally {
      this.running = false;
      this.invalidate();
    }
  }
}
