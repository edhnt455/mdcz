import path from "node:path";
import { filesystemPathKey } from "@mdcz/media-store";
import { MOVIE_NFO_BASE_NAME } from "@mdcz/shared/assetNaming";
import type { Configuration } from "@mdcz/shared/config";
import type { FileInfo } from "@mdcz/shared/types";
import type { DirectoryInventory } from "./DirectoryInventory";

export const loadLocalNfoSnapshot = async (
  fileInfo: FileInfo,
  inventory: DirectoryInventory,
  rules: Configuration["scrape"],
) => {
  const directory = path.dirname(fileInfo.filePath);
  const videos = await inventory.mediaEntries(directory);
  const singleMovie = videos.every(
    (entry) => inventory.fileInfo(path.join(directory, entry.name), rules).number === fileInfo.number,
  );
  const candidates = preferredLocalNfoBaseNames(fileInfo.fileName, fileInfo.part?.suffix, singleMovie);
  const nfos = await inventory.files(directory, (name) => path.extname(name).toLowerCase() === ".nfo");
  const [selectedName] = selectLocalNfoNames(
    nfos.map((entry) => entry.name),
    candidates,
    singleMovie,
  );
  const registered =
    inventory.registeredNfos.get(filesystemPathKey(await inventory.entryPath(fileInfo.filePath))) ?? [];
  const nfoPath =
    (await newestNfosFirst(registered, (nfoPath) => inventory.stats(nfoPath)))[0] ??
    (selectedName ? path.join(directory, selectedName) : undefined);
  return nfoPath ? await inventory.loadNfo(nfoPath) : undefined;
};

export const preferredLocalNfoBaseNames = (
  fileName: string,
  partSuffix: string | undefined,
  singleMovieDirectory: boolean,
): string[] => [
  ...(partSuffix && fileName.endsWith(partSuffix) ? [fileName.slice(0, -partSuffix.length)] : []),
  fileName,
  ...(singleMovieDirectory ? [MOVIE_NFO_BASE_NAME] : []),
];

/** Every NFO name that belongs to the video, most preferred first. */
export const selectLocalNfoNames = (
  nfoNames: readonly string[],
  preferredBaseNames: readonly string[],
  singleMovieDirectory: boolean,
): string[] => {
  const matches = preferredBaseNames.flatMap((baseName) =>
    nfoNames.filter((name) => path.parse(name).name.toLowerCase() === baseName.toLowerCase()),
  );
  if (matches.length) return [...new Set(matches)];
  return singleMovieDirectory && nfoNames.length === 1 ? [...nfoNames] : [];
};

/**
 * The NFOs that exist, the one saved last first: with `<video>.nfo` and `movie.nfo` side by side, whichever media
 * server a person edited in wins. Ties keep the given order. Missing files (stale registrations) are dropped.
 */
export const newestNfosFirst = async (
  nfoPaths: readonly string[],
  stats: (nfoPath: string) => Promise<{ mtimeMs: number }>,
): Promise<string[]> => {
  const existing: Array<{ nfoPath: string; mtimeMs: number }> = [];
  for (const nfoPath of nfoPaths) {
    try {
      existing.push({ nfoPath, mtimeMs: (await stats(nfoPath)).mtimeMs });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return existing.sort((left, right) => right.mtimeMs - left.mtimeMs).map(({ nfoPath }) => nfoPath);
};
