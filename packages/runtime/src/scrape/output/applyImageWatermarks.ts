import type { Configuration } from "@mdcz/shared/config";
import { toErrorMessage } from "@mdcz/shared/error";
import type { CrawlerData, DownloadedAssets, FileInfo, NfoLocalState, VideoMeta } from "@mdcz/shared/types";
import type { RuntimeScrapeSignalService } from "../FileScraper";
import { ImageWatermarkService } from "../ImageWatermarkService";
import { resolvePosterBadgeDefinitions } from "../posterBadges";
import { throwIfAborted } from "../utils/abort";

export const applyImageWatermarks = async (input: {
  assets: DownloadedAssets;
  config: Pick<Configuration, "download">;
  crawlerData: CrawlerData;
  dataDir: string;
  fileInfo: FileInfo;
  localState?: NfoLocalState;
  videoMeta?: VideoMeta;
  logger: { warn(message: string): void };
  signal?: AbortSignal;
  signalService?: Pick<RuntimeScrapeSignalService, "showLogText">;
  watermarkService?: Pick<ImageWatermarkService, "applyTagBadges">;
}): Promise<DownloadedAssets> => {
  if (!input.config.download.tagBadges) {
    return input.assets;
  }

  const paths = [
    ...new Set(
      input.config.download.tagBadgeTargets
        .map((target) => input.assets[target])
        .filter((path): path is string => Boolean(path && input.assets.downloaded.includes(path))),
    ),
  ];
  if (paths.length === 0) return input.assets;

  const badges = resolvePosterBadgeDefinitions(
    input.crawlerData,
    input.fileInfo,
    input.localState,
    input.config.download.tagBadgeTypes,
    input.videoMeta,
  );
  if (badges.length === 0) {
    return input.assets;
  }

  throwIfAborted(input.signal);
  input.signalService?.showLogText(`[${input.fileInfo.number}] Applying image watermarks...`);

  const watermarkService = input.watermarkService ?? new ImageWatermarkService({ dataDir: input.dataDir });
  for (const imagePath of paths) {
    throwIfAborted(input.signal);
    try {
      await watermarkService.applyTagBadges(imagePath, badges, input.config.download, (message) =>
        input.logger.warn(message),
      );
    } catch (error) {
      input.logger.warn(`Failed to apply tag badges for ${imagePath}: ${toErrorMessage(error)}`);
    }
  }

  throwIfAborted(input.signal);
  return input.assets;
};
