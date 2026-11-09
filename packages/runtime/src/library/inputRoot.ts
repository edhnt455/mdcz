import path from "node:path";
import { normalizeHostPath } from "@mdcz/media-store";

const isWithin = (rootPath: string, candidatePath: string): boolean => {
  const relative = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

export const resolveInputRootPath = (filePaths: readonly string[], preferredRootPath?: string): string => {
  if (filePaths.length === 0) throw new Error("没有文件，无法创建刮削根目录");
  const preferred = preferredRootPath?.trim();
  if (preferred) {
    const normalized = normalizeHostPath(preferred);
    if (filePaths.every((filePath) => isWithin(normalized, filePath))) return normalized;
  }
  let common = path.dirname(path.resolve(filePaths[0]));
  for (const filePath of filePaths.slice(1)) {
    const resolved = path.resolve(filePath);
    while (!isWithin(common, resolved)) {
      const parent = path.dirname(common);
      if (parent === common) throw new Error("所选文件不在同一文件系统根目录下");
      common = parent;
    }
  }
  return common;
};
