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
  const { query, rootId, libraryId, health, issues, ignored, actors, studios, tags, missingActors, missingSubtitles } =
    input ?? {};
  const library = libraryId ? await libraries.get(libraryId) : undefined;
  return {
    query,
    rootId,
    health,
    issues,
    healthIgnored: ignored,
    includeBackdrop: configuration.download.downloadFanart,
    actors,
    studios,
    tags,
    missingActors,
    missingSubtitles:
      missingSubtitles !== undefined
        ? {
            missing: missingSubtitles,
            pattern: filenameKeywordPattern(configuration.scrape.subtitleKeywords).source,
            excludedPattern: filenameKeywordPattern(configuration.scrape.umrKeywords).source,
          }
        : undefined,
    pathPrefixes: library ? [library.sourcePath, library.outputPath].filter(Boolean) : undefined,
  };
};
