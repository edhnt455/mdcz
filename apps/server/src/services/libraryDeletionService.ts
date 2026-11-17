import { lstat, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import { filesystemPathKey, isPathInside, resolveRootRelativePath } from "@mdcz/media-store";
import { mediaPathOwnership } from "@mdcz/runtime/library";
import type { Configuration } from "@mdcz/shared/config";
import {
  type LibraryDeletionResponse,
  type LibraryDeletionTarget,
  type PendingDeleteInput,
  pendingItemSchema,
} from "@mdcz/shared/pending";
import type { PendingDeletionService } from "./pendingDeletionService";
import type { ServerPersistenceService } from "./persistenceService";

export class LibraryDeletionService {
  constructor(
    private readonly persistence: Pick<ServerPersistenceService, "getState">,
    private readonly getConfiguration: () => Promise<Configuration>,
    private readonly strmDeletion: Pick<PendingDeletionService, "delete">,
    private readonly wake: () => void,
    private readonly invalidate: () => void,
  ) {}

  async submit(input: { fileId: string } | { ids: readonly string[] }): Promise<LibraryDeletionResponse> {
    const state = await this.persistence.getState();
    const { library, mediaRoots, pending, pendingActions } = state.repositories;
    const configuration = await this.getConfiguration();
    const roots = new Map((await mediaRoots.list()).map((root) => [root.id, root]));
    const entries =
      "fileId" in input
        ? [await library.getEntryByFileId(input.fileId)]
        : await library.getEntriesByIds([...input.ids]);
    const taskIds = state.database.sqlite.transaction(() => {
      const numbers = new Map(entries.map((entry) => [entry.id, entry.number]));
      const items = new Map(pending.list().map((item) => [JSON.stringify([item.rootId, item.relativePath]), item]));
      const active = new Map(
        pendingActions
          .list()
          .filter((job) => ["queued", "running", "retrying"].includes(job.status))
          .map((job) => [job.itemId, job]),
      );
      return entries
        .flatMap((entry) => entry.files)
        .filter((file) => !("fileId" in input) || file.id === input.fileId)
        .map((file) => {
          const recorded = library.getFileById(file.id);
          if (recorded.updatedAt.getTime() !== file.updatedAt.getTime())
            throw new Error("媒体文件记录已变化，请刷新后重试");
          const root = roots.get(file.rootId);
          if (!root) throw new Error("未找到媒体根目录");
          const filePath = filesystemPathKey(resolveRootRelativePath(root, file.rootRelativePath));
          const configured = configuration.libraries
            .filter((entry) => isPathInside(entry.outputPath || entry.sourcePath, filePath))
            .sort((a, b) => (b.outputPath || b.sourcePath).length - (a.outputPath || a.sourcePath).length)[0];
          const binding = configuration.embyDeletion.libraries
            .filter((entry) => entry.source && isPathInside(entry.outputPath, filePath))
            .sort((a, b) => b.outputPath.length - a.outputPath.length)[0];
          const key = JSON.stringify([file.rootId, file.rootRelativePath]);
          let item = items.get(key);
          const previous = item && active.get(item.id);
          if (previous) {
            if (previous.action !== "delete") throw new Error("此文件已有正在执行的操作");
            return previous.id;
          }
          if (!item) {
            pending.upsert({
              kind: "failed",
              rootId: file.rootId,
              relativePath: file.rootRelativePath,
              libraryId: binding?.id ?? configured?.id,
              movieId: file.itemId,
              number: numbers.get(file.itemId),
              detail: "媒体库深度删除",
            });
            item = pending.findByFile({ rootId: file.rootId, relativePath: file.rootRelativePath });
          }
          if (!item) throw new Error("无法创建深度删除记录");
          const target: LibraryDeletionTarget = {
            fileId: file.id,
            fileUpdatedAt: file.updatedAt.getTime(),
            rootId: file.rootId,
            relativePath: file.rootRelativePath,
            rootPath: root.hostPath,
            rootRealPath: root.realPath,
            library: configured
              ? {
                  id: configured.id,
                  sourcePath: configured.sourcePath,
                  outputPath: configured.outputPath,
                  placement: configured.placement,
                }
              : null,
            moviePilotConnectionId: configuration.embyDeletion.moviePilot?.id ?? null,
          };
          const job = pendingActions.enqueue({
            itemId: item.id,
            itemUpdatedAt: item.updatedAt.getTime(),
            action: "delete",
            inputJson: JSON.stringify({ libraryFile: target } satisfies PendingDeleteInput),
            itemJson: JSON.stringify(
              pendingItemSchema.parse({
                ...item,
                deletionPending: Boolean(item.deletionJson),
                ref: { rootId: item.rootId, relativePath: item.relativePath },
                path: filePath,
                fileName: file.fileName,
                libraryName: configured?.name ?? null,
                candidates: [],
                createdAt: item.createdAt.toISOString(),
                updatedAt: item.updatedAt.toISOString(),
              }),
            ),
          });
          active.set(item.id, job);
          return job.id;
        });
    })();
    this.invalidate();
    this.wake();
    return { taskIds };
  }

  async execute(itemId: string, target: LibraryDeletionTarget, progress: (message: string) => void): Promise<void> {
    const state = await this.persistence.getState();
    const { library, mediaRoots, pending } = state.repositories;
    const file = library.getFileById(target.fileId);
    const item = pending.get(itemId);
    if (
      file.updatedAt.getTime() !== target.fileUpdatedAt ||
      file.rootId !== target.rootId ||
      file.rootRelativePath !== target.relativePath ||
      item.rootId !== target.rootId ||
      item.relativePath !== target.relativePath
    )
      throw new Error("任务提交后媒体文件记录已变化，请检查后重新提交");
    const root = await mediaRoots.get(file.rootId);
    if (root.hostPath !== target.rootPath || root.realPath !== target.rootRealPath)
      throw new Error("任务提交后媒体根目录已变化，请检查后重新提交");
    const configuration = await this.getConfiguration();
    if (target.library) {
      const configured = configuration.libraries.find((entry) => entry.id === target.library?.id);
      if (
        !configured ||
        configured.sourcePath !== target.library.sourcePath ||
        configured.outputPath !== target.library.outputPath ||
        configured.placement !== target.library.placement
      )
        throw new Error("任务提交后媒体库配置已变化，请检查后重新提交");
    }
    const filePath = filesystemPathKey(resolveRootRelativePath(root, file.rootRelativePath));
    if (path.extname(filePath).toLowerCase() === ".strm") {
      if (target.moviePilotConnectionId && target.moviePilotConnectionId !== configuration.embyDeletion.moviePilot?.id)
        throw new Error("任务提交后 MoviePilot 连接已变化，请检查后重新提交");
      await this.strmDeletion.delete(itemId, progress, { allowMissing: true });
      return;
    }

    progress(`核验硬盘媒体文件：${filePath}`);
    const sourcePath = file.retainedSourceIdentity ? filesystemPathKey(file.retainedSourceIdentity) : filePath;
    const release = mediaPathOwnership.acquireAll([filePath, sourcePath]);
    try {
      const rootPath = filesystemPathKey(await realpath(root.hostPath));
      if (root.realPath && rootPath !== filesystemPathKey(root.realPath)) throw new Error("媒体根目录挂载已变化");
      const targets = [{ filePath, rootPath }];
      if (sourcePath !== filePath) {
        const configured = configuration.libraries.find(
          (entry) =>
            isPathInside(entry.outputPath || entry.sourcePath, filePath) && isPathInside(entry.sourcePath, sourcePath),
        );
        if (!configured) throw new Error("保留源文件不在此媒体库的来源目录内");
        targets.unshift({ filePath: sourcePath, rootPath: filesystemPathKey(await realpath(configured.sourcePath)) });
      }
      const snapshots = [];
      for (const entry of targets) {
        const directory = await realpath(path.dirname(entry.filePath)).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
        if (directory && !isPathInside(entry.rootPath, filesystemPathKey(directory)))
          throw new Error("媒体文件目录已变化或超出媒体根目录");
        const stat = await lstat(entry.filePath).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
        if (stat && !stat.isFile() && !stat.isSymbolicLink()) throw new Error("删除目标不是媒体文件");
        snapshots.push({ ...entry, stat });
      }
      if (JSON.stringify((await this.getConfiguration()).libraries) !== JSON.stringify(configuration.libraries))
        throw new Error("媒体库配置已变化，请刷新后重试");
      if (library.getFileById(file.id).updatedAt.getTime() !== file.updatedAt.getTime())
        throw new Error("媒体文件记录已变化，请刷新后重试");
      for (const entry of snapshots) {
        if (!entry.stat) continue;
        const current = await lstat(entry.filePath);
        if (
          current.dev !== entry.stat.dev ||
          current.ino !== entry.stat.ino ||
          current.size !== entry.stat.size ||
          current.mtimeMs !== entry.stat.mtimeMs
        )
          throw new Error("媒体文件已被替换，请刷新后重试");
        progress(`删除硬盘媒体文件：${entry.filePath}`);
        await unlink(entry.filePath);
      }
      progress("清理媒体库记录");
      state.database.sqlite.transaction(() => {
        library.removeFile(file.id);
        pending.delete([itemId]);
      })();
    } finally {
      release();
      this.invalidate();
    }
  }
}
