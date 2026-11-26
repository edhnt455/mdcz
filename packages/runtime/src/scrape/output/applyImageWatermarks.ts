import { readFile, writeFile } from "node:fs/promises";
import { atomicWriteFile } from "@mdcz/media-store";
import type { Configuration } from "@mdcz/shared/config";
import { toErrorMessage } from "@mdcz/shared/error";
import {
  BADGE_ARTWORK_KINDS,
  type BadgeArtworkRecords,
  type CrawlerData,
  type DownloadedAssets,
  type FileInfo,
  type NfoLocalState,
  type VideoMeta,
} from "@mdcz/shared/types";
import { badgeBasePath, encodeBadgeArtwork, resolveArtworkBadges } from "../badgeArtwork";
import type { RuntimeScrapeSignalService } from "../FileScraper";
import { ImageWatermarkService } from "../ImageWatermarkService";
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
  watermarkService?: Pick<ImageWatermarkService, "renderImage">;
}): Promise<DownloadedAssets> => {
  const settings = input.config.download;
  const kinds = [...new Set([...BADGE_ARTWORK_KINDS, ...(settings.tagBadges ? settings.tagBadgeTargets : [])])];
  const paths = new Set(
    kinds.flatMap((kind) => {
      const path = input.assets[kind];
      return path && input.assets.downloaded.includes(path) ? [path] : [];
    }),
  );
  const records: BadgeArtworkRecords = {};
  const watermarkService = input.watermarkService ?? new ImageWatermarkService({ dataDir: input.dataDir });
  for (const imagePath of paths) {
    throwIfAborted(input.signal);
    const associated = BADGE_ARTWORK_KINDS.filter((kind) => input.assets[kind] === imagePath);
    const target = settings.tagBadgeTargets.find((kind) => input.assets[kind] === imagePath);
    const plan = resolveArtworkBadges(
      target ?? associated[0] ?? "fanart",
      input.crawlerData,
      input.fileInfo,
      input.localState,
      settings,
      input.videoMeta,
    );
    if (!associated.length && !plan.badges.length) continue;
    for (const kind of associated) records[kind] = null;
    try {
      const base = await readFile(imagePath);
      const { data, record } = await encodeBadgeArtwork(base, plan, settings, watermarkService, (message) =>
        input.logger.warn(message),
      );
      throwIfAborted(input.signal);
      if (data !== base) {
        input.signalService?.showLogText(`[${input.fileInfo.number}] 正在添加图片水印…`);
        if (associated.length) await writeFile(badgeBasePath(imagePath), base, { flag: "wx" });
        await atomicWriteFile(imagePath, data);
      }
      for (const kind of associated) records[kind] = record;
    } catch (error) {
      input.logger.warn(`为 ${imagePath} 添加标签水印失败：${toErrorMessage(error)}`);
    }
  }

  throwIfAborted(input.signal);
  return Object.keys(records).length
    ? { ...input.assets, badgeRecords: { ...input.assets.badgeRecords, ...records } }
    : input.assets;
};
