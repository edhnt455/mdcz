import { basename, dirname, join } from "node:path";
import { canonicalPath, filesystemPathKey } from "@mdcz/media-store";

import { acquireMediaTask } from "./mediaTasks";

let registration = Promise.resolve();

const resolveCanonicalOutputDirectory = async (directory: string): Promise<string> => {
  try {
    return await canonicalPath(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (dirname(directory) === directory) return filesystemPathKey(directory);
    return join(await resolveCanonicalOutputDirectory(dirname(directory)), basename(directory));
  }
};

export async function outputDirectoryKeys(
  targetPaths: readonly string[],
  canonicalDirectory: (directory: string) => Promise<string> = resolveCanonicalOutputDirectory,
  metadataDirectories: readonly string[] = [],
): Promise<string[]> {
  return [
    ...new Set(
      await Promise.all(
        [...targetPaths.map((targetPath) => dirname(targetPath)), ...metadataDirectories].map(
          async (directory) => `directory:${filesystemPathKey(await canonicalDirectory(directory))}`,
        ),
      ),
    ),
  ].sort();
}

export const acquireOutputDirectories = async (
  targetPaths: readonly string[],
  canonicalDirectory?: (directory: string) => Promise<string>,
  metadataDirectories: readonly string[] = [],
): Promise<() => void> => {
  const previous = registration;
  let registered!: () => void;
  registration = new Promise<void>((resolve) => {
    registered = resolve;
  });
  await previous;
  try {
    const keys = await outputDirectoryKeys(targetPaths, canonicalDirectory, metadataDirectories);
    return acquireMediaTask(keys, "文件发布");
  } finally {
    registered();
  }
};
