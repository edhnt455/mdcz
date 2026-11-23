import type { LibraryEntryFilter } from "@mdcz/persistence";
import type { Configuration } from "@mdcz/shared/config";
import { filenameKeywordPattern } from "@mdcz/shared/filenameKeywords";
import type { LibraryMatchesInput } from "@mdcz/shared/serverDtos";
import type { MediaLibraryService } from "./mediaLibraryService";

/** A library owns the movies that live under its source or output directory. */
export const toLibraryEntryFilter = async (
  input: LibraryMatchesInput | undefined,
  libraries: Pick<MediaLibraryService, "get">,
  configuration: Pick<Configuration, "scrape">,
): Promise<LibraryEntryFilter> => {
  const { query, rootId, libraryId, issues, actors, studios, tags, missingActors, missingSubtitles, hasTranslation } =
    input ?? {};
  const library = libraryId ? await libraries.get(libraryId) : undefined;
  return {
    query,
    rootId,
    issues,
    actors,
    studios,
    tags,
    missingActors,
    hasTranslation,
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
