import type { Configuration } from "@mdcz/shared/config";
import type { FileInfo } from "@mdcz/shared/types";
import type { DirectoryInventory } from "../DirectoryInventory";
import { parseFileInfo } from "../utils/number";
import { preferSubtitleTag } from "../utils/subtitles";
import {
  findSubtitleSidecars,
  getPreferredSubtitleTagFromSidecars,
  type SubtitleSidecarMatch,
} from "./subtitleSidecars";

export interface FileInfoWithSubtitles {
  fileInfo: FileInfo;
  subtitleSidecars: SubtitleSidecarMatch[];
}

export interface ResolveFileInfoWithSubtitlesOptions {
  filenameRules?: Configuration["scrape"];
  parsedFileInfo?: FileInfo;
  subtitleSidecars?: SubtitleSidecarMatch[];
  inventory?: DirectoryInventory;
}

export const resolveFileInfoWithSubtitles = async (
  filePath: string,
  options: ResolveFileInfoWithSubtitlesOptions = {},
): Promise<FileInfoWithSubtitles> => {
  const rules = options.filenameRules;
  const parsedFileInfo =
    options.parsedFileInfo ??
    options.inventory?.fileInfo(filePath, rules) ??
    parseFileInfo(filePath, rules?.filenameIgnoreTokens, rules?.numberMappings, rules);
  const subtitleSidecars = options.subtitleSidecars ?? (await findSubtitleSidecars(filePath, options.inventory, rules));
  const subtitleTag = preferSubtitleTag(
    parsedFileInfo.subtitleTag,
    getPreferredSubtitleTagFromSidecars(subtitleSidecars),
  );

  return {
    fileInfo: {
      ...parsedFileInfo,
      isSubtitled: parsedFileInfo.isSubtitled || subtitleSidecars.length > 0,
      subtitleTag,
    },
    subtitleSidecars,
  };
};
