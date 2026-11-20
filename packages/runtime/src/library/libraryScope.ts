import type { LibraryEntryFilter } from "@mdcz/persistence";
import type { Configuration } from "@mdcz/shared/config";
import { filenameKeywordPattern } from "@mdcz/shared/filenameKeywords";
import type { LibraryMatchesInput } from "@mdcz/shared/serverDtos";
import type { MediaLibraryService } from "./mediaLibraryService";

/** A library owns the movies that live under its source or output directory. */
export const toLibraryEntryFilter = async (
  input: LibraryMatchesInput | undefined,
  libraries: Pick<MediaLibraryService, "get">,
  configuration: Pick<Configuration, "download" | "scrape">,
): Promise<LibraryEntryFilter> => {
  const { query, rootId, libraryId, health, ignored, actor, studio, tag, missingSubtitles } = input ?? {};
  const library = libraryId ? await libraries.get(libraryId) : undefined;
  return {
    query,
    rootId,
    health,
    healthIgnored: ignored,
    includeBackdrop: configuration.download.downloadFanart,
    actor,
    studio,
    tag,
    missingSubtitles: missingSubtitles
      ? {
          pattern: filenameKeywordPattern(configuration.scrape.subtitleKeywords).source,
          excludedPattern: filenameKeywordPattern(configuration.scrape.umrKeywords).source,
        }
      : undefined,
    pathPrefixes: library ? [library.sourcePath, library.outputPath].filter(Boolean) : undefined,
  };
};
