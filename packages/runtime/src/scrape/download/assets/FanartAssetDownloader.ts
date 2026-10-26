import { join } from "node:path";

import { throwIfAborted } from "../../utils/abort";
import { buildImageAssetPathFromSource, resolveExistingImageAsset, shouldKeepAsset } from "./helpers";
import type { AssetDownloader, DownloadExecutionContext, DownloadExecutionPlan } from "./types";

export class FanartAssetDownloader implements AssetDownloader {
  shouldDownload(plan: DownloadExecutionPlan): boolean {
    return plan.config.download.downloadFanart;
  }

  async download(context: DownloadExecutionContext): Promise<void> {
    const { assets, imageDownloader, plan } = context;

    throwIfAborted(plan.signal);

    const fanartTargetPath = join(plan.outputDir, plan.assetFileNames.fanart);
    const existingTargetPath = join(plan.existingAssetDir, plan.assetFileNames.fanart);
    const thumbPath = assets.thumb;
    const existingFanart = await resolveExistingImageAsset(
      plan.existingAssets?.fanart ??
        (thumbPath ? buildImageAssetPathFromSource(existingTargetPath, thumbPath) : existingTargetPath),
      plan.inventory,
    );
    const sourceRefreshed =
      plan.forceReplace.fanart || (thumbPath !== undefined && assets.downloaded.includes(thumbPath));
    if (
      existingFanart &&
      shouldKeepAsset(plan.assetDecisions.fanart, sourceRefreshed ? false : plan.config.download.keepFanart)
    ) {
      assets.fanart = existingFanart;
      return;
    }

    // Fanart has no source of its own: it is a copy of the landscape cover.
    const coverPath = await context.resolveCover();
    const createdPath = coverPath
      ? await imageDownloader.copyDerivedImage(
          coverPath,
          buildImageAssetPathFromSource(fanartTargetPath, coverPath),
          "fanart",
        )
      : undefined;
    if (createdPath) {
      assets.fanart = createdPath;
      assets.downloaded.push(createdPath);
      const coverSource = coverPath ? context.imageSources.get(coverPath) : undefined;
      context.imageSources.set(createdPath, {
        ...coverSource,
        source: coverSource?.source ?? "local",
        derivedFrom: assets.thumb === coverPath ? "thumb" : "cover",
      });
      return;
    }

    if (existingFanart && plan.assetDecisions.fanart !== "replace") {
      assets.fanart = existingFanart;
    }
  }
}
