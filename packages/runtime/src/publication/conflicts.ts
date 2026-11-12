import { join } from "node:path";
import { canonicalPath } from "@mdcz/media-store";
import { isSharedDirectoryTarget, type PublicationTarget } from "@mdcz/shared/mediaLibrary";
import { outputFileSystem } from "./outputFileSystem";
import type { PublicationOutputPort } from "./types";

export class PublicationConflictError extends Error {
  constructor(
    readonly sourcePath: string,
    readonly targetPath: string,
    readonly reason = "目标位置已存在影片",
  ) {
    super(`${reason}\n源文件：${sourcePath}\n目标路径：${targetPath}`);
    this.name = "PublicationConflictError";
  }
}

export const assertMovieDirectoryOwnership = async (input: {
  target: Pick<PublicationTarget, "placement" | "folderTemplate">;
  movieId: string;
  sourcePaths: readonly string[];
  directories: readonly string[];
  library: Pick<PublicationOutputPort, "publicationSnapshot">;
}): Promise<void> => {
  const { target, library, sourcePaths } = input;
  if (target.placement === "inPlace" || isSharedDirectoryTarget(target)) return;

  // A rescrape may adopt the library movie that already owns its source files at commit time.
  const movieIds = new Set([
    input.movieId,
    ...library.publicationSnapshot({ paths: sourcePaths }).files.map((file) => file.itemId),
  ]);
  for (const directory of input.directories) {
    // Read under the output lock because the preparation inventory can predate another publication.
    const entries = await outputFileSystem
      .readdir(directory, { withFileTypes: true })
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
    if (!entries.length) continue;
    const canonicalDirectory = await canonicalPath(directory);
    const paths = [...new Set([directory, canonicalDirectory])].flatMap((path) =>
      entries.filter((entry) => entry.isFile() || entry.isSymbolicLink()).map((entry) => join(path, entry.name)),
    );
    if (!paths.length) continue;
    const { files, assets } = library.publicationSnapshot({ paths });
    if (files.some((file) => !movieIds.has(file.itemId)) || assets.some((asset) => !movieIds.has(asset.itemId))) {
      throw new PublicationConflictError(
        sourcePaths[0] ?? directory,
        directory,
        /\{\s*(?:raw)?number\s*\}/iu.test(input.target.folderTemplate)
          ? "此输出目录已属于其他影片，当前模板已包含番号。请核对媒体库中的两部影片并移出错误记录"
          : "此输出目录已属于其他影片。请在文件夹模板中加入 {number}，为每部影片生成独立目录",
      );
    }
  }
};
