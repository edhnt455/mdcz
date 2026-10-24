import { join } from "node:path";
import { getDesktopUserDataPath } from "@main/appIdentity";
import type { SignalService } from "@main/services/SignalService";
import { applyImageWatermarks, ImageWatermarkService } from "@mdcz/runtime/scrape";
import type { Configuration } from "@mdcz/shared/config";
import type { CrawlerData, DownloadedAssets, FileInfo, NfoLocalState, VideoMeta } from "@mdcz/shared/types";
import { app } from "electron";
import type { Logger } from "winston";

export const imageWatermarkService = new ImageWatermarkService({
  dataDir: getDesktopUserDataPath(),
  builtinDirectory: app.isPackaged
    ? join(process.resourcesPath, "watermark")
    : join(app.getAppPath(), "../../packages/runtime/resources/watermark"),
});

export const applyDesktopImageWatermarks = async (input: {
  assets: DownloadedAssets;
  config: Pick<Configuration, "download">;
  crawlerData: CrawlerData;
  fileInfo: FileInfo;
  localState?: NfoLocalState;
  videoMeta?: VideoMeta;
  logger: Pick<Logger, "warn">;
  signal?: AbortSignal;
  signalService?: Pick<SignalService, "showLogText">;
}): Promise<DownloadedAssets> =>
  await applyImageWatermarks({
    ...input,
    dataDir: getDesktopUserDataPath(),
    watermarkService: imageWatermarkService,
  });
