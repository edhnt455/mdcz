import { randomUUID } from "node:crypto";
import path from "node:path";
import { type RuntimeLogger, runtimeLoggerService, toErrorMessage } from "../shared";
import { CreatedDirectories, outputFileSystem } from "./outputFileSystem";
import { TemporaryPaths } from "./publicationJournal";
import type { PublicationFileSystem } from "./types";

export type WriteArtifact = { targetPath: string; removeSourcesAfterCommit?: readonly string[] } & (
  | { data: Buffer | string }
  | { sourcePath: string; size: number; consume?: boolean }
  | { symlinkTo: string }
);

export class WriteOutput {
  constructor(
    private readonly fileSystem: PublicationFileSystem = outputFileSystem,
    private readonly logger: Pick<RuntimeLogger, "warn"> = runtimeLoggerService.getLogger("WriteOutput"),
  ) {}

  async install<TResult>(
    artifacts: readonly WriteArtifact[],
    options: {
      validate?(): Promise<void> | void;
      beforeCommit?(): Promise<void> | void;
      commit(): TResult | Promise<TResult>;
      protectedMediaFiles?: readonly string[];
      /** The caller's, which then takes back the empty folders itself once it has restored what else it moved. */
      directories?: CreatedDirectories;
    },
  ): Promise<TResult> {
    const directories = options.directories ?? new CreatedDirectories(this.fileSystem);
    const staged: Array<{ targetPath: string; temporaryPath: string; size?: number }> = [];
    const replacements: Array<{ targetPath: string; backupPath?: string; linkedBackup?: boolean; installed: boolean }> =
      [];
    const temporaryPaths = new TemporaryPaths();
    let committed = false;
    const stagingId = randomUUID();
    const pathKey = (value: string) =>
      process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
    const protectedMedia = new Set((options.protectedMediaFiles ?? []).map(pathKey));
    const targets = new Set<string>();
    const consumedSources = new Map<string, WriteArtifact>();
    for (const artifact of artifacts) {
      const target = pathKey(artifact.targetPath);
      if (protectedMedia.has(target)) throw new Error(`输出目标不能覆盖源媒体文件：${artifact.targetPath}`);
      if (targets.has(target)) throw new Error(`资源目标重复：${artifact.targetPath}`);
      targets.add(target);
    }
    for (const artifact of artifacts) {
      if (!("sourcePath" in artifact) || !artifact.consume) continue;
      const source = pathKey(artifact.sourcePath);
      if (protectedMedia.has(source) || targets.has(source))
        throw new Error(`不能消耗媒体文件或最终资源：${artifact.sourcePath}`);
      consumedSources.set(source, artifact);
    }
    try {
      for (const artifact of artifacts) {
        // Already in place, e.g. carried along when its movie folder was renamed.
        if ("sourcePath" in artifact && pathKey(artifact.sourcePath) === pathKey(artifact.targetPath)) continue;
        await directories.make(path.dirname(artifact.targetPath));
        const consuming = "sourcePath" in artifact && consumedSources.get(pathKey(artifact.sourcePath)) === artifact;
        const temporaryPath =
          "sourcePath" in artifact && consuming
            ? artifact.sourcePath
            : `${artifact.targetPath}.mdcz-staging-${stagingId}.part`;
        if (consuming && !(await this.fileSystem.lstat(temporaryPath)).isFile())
          throw new Error(`暂存来源必须是普通文件：${temporaryPath}`);
        temporaryPaths.add(temporaryPath);
        if ("symlinkTo" in artifact) {
          await this.fileSystem.symlink(artifact.symlinkTo, temporaryPath);
          staged.push({ targetPath: artifact.targetPath, temporaryPath });
          continue;
        }
        const expectedSize =
          "data" in artifact
            ? typeof artifact.data === "string"
              ? Buffer.byteLength(artifact.data, "utf8")
              : artifact.data.length
            : artifact.size;
        staged.push({ targetPath: artifact.targetPath, temporaryPath, size: expectedSize });
        if ("data" in artifact) {
          await this.fileSystem.writeFile(temporaryPath, artifact.data, { flush: true });
        } else {
          const source = await this.fileSystem.stat(artifact.sourcePath);
          if (!source.isFile() || source.size !== artifact.size)
            throw new Error(`资源来源已变化：${artifact.sourcePath}`);
          if (!consuming) await this.fileSystem.copyFile(artifact.sourcePath, temporaryPath);
        }
        if (!("data" in artifact)) await this.fileSystem.flush?.(temporaryPath);
        if ((await this.fileSystem.stat(temporaryPath)).size !== expectedSize)
          throw new Error(`暂存资源大小不匹配：${artifact.targetPath}`);
      }
      await options.validate?.();
      await options.beforeCommit?.();
      for (const artifact of staged) {
        let existingTarget: Awaited<ReturnType<PublicationFileSystem["lstat"]>> | undefined;
        try {
          const existing = await this.fileSystem.lstat(artifact.targetPath);
          if (!existing.isFile() && !existing.isSymbolicLink())
            throw new Error(`资源目标不是文件：${artifact.targetPath}`);
          existingTarget = existing;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        const replacement: (typeof replacements)[number] = { targetPath: artifact.targetPath, installed: false };
        if (existingTarget) {
          // A hard link keeps the target in place until the atomic replace, so a stop never leaves it missing;
          // symlinks and filesystems without links fall back to moving the original aside.
          const backupPath = `${artifact.targetPath}.mdcz-backup-${stagingId}`;
          try {
            // link(2) may follow a symlink on some platforms, which would back up the wrong file.
            if (!existingTarget.isFile()) throw new Error("仅支持链接普通文件");
            await this.fileSystem.link(artifact.targetPath, backupPath);
            replacement.linkedBackup = true;
          } catch {
            await this.fileSystem.rename(artifact.targetPath, backupPath);
          }
          replacement.backupPath = backupPath;
        }
        replacements.push(replacement);
        try {
          await this.fileSystem.rename(artifact.temporaryPath, artifact.targetPath);
          temporaryPaths.settle(artifact.temporaryPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EXDEV" || artifact.size === undefined) throw error;
          const localStaging = `${artifact.targetPath}.mdcz-staging-${stagingId}.part`;
          temporaryPaths.add(localStaging);
          await this.fileSystem.copyFile(artifact.temporaryPath, localStaging);
          await this.fileSystem.flush?.(localStaging);
          if ((await this.fileSystem.stat(localStaging)).size !== artifact.size)
            throw new Error(`暂存资源大小不匹配：${artifact.targetPath}`);
          await this.fileSystem.rename(localStaging, artifact.targetPath);
          temporaryPaths.settle(localStaging);
        }
        replacement.installed = true;
      }
      const value = await options.commit();
      committed = true;
      for (const replacement of replacements) {
        if (replacement.backupPath) temporaryPaths.add(replacement.backupPath);
      }
      const obsoleteSources = new Set(
        artifacts
          .flatMap((artifact) => artifact.removeSourcesAfterCommit ?? [])
          .filter((sourcePath) => !targets.has(pathKey(sourcePath)) && !protectedMedia.has(pathKey(sourcePath))),
      );
      for (const sourcePath of obsoleteSources) {
        try {
          await this.fileSystem.rm(sourcePath, { force: true });
        } catch (error) {
          this.logger.warn(`资源已发布，但移除来源 ${sourcePath} 失败：${toErrorMessage(error)}`);
        }
      }
      return value;
    } catch (error) {
      if (!committed) {
        for (const replacement of replacements.toReversed()) {
          const { backupPath, targetPath } = replacement;
          try {
            if (backupPath && (replacement.installed || !replacement.linkedBackup))
              await this.fileSystem.rename(backupPath, targetPath);
            else if (backupPath) temporaryPaths.add(backupPath);
            else if (replacement.installed) await this.fileSystem.rm(targetPath, { force: true });
          } catch (restoreError) {
            this.logger.warn(
              `恢复资源 ${targetPath}${backupPath ? `（备份：${backupPath}）` : ""} 失败：${toErrorMessage(restoreError)}`,
            );
          }
        }
      }
      throw error;
    } finally {
      await temporaryPaths.removeAll(this.fileSystem, (message) => this.logger.warn(message));
      if (!committed && !options.directories) await directories.removeEmpty((message) => this.logger.warn(message));
    }
  }
}
