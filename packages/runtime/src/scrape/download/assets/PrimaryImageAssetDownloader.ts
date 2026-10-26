import { join } from "node:path";

import { throwIfAborted } from "../../utils/abort";
import {
  buildImageCandidates,
  resolveExistingImageAsset,
  runParallel,
  shouldFallbackToExistingAsset,
  shouldKeepAsset,
} from "./helpers";
import { PosterImageDerivationService } from "./PosterImageDerivationService";
import type { AssetDownloader, DownloadExecutionContext, DownloadExecutionPlan, PrimaryImageKey } from "./types";

type PrimaryImageTask = {
  key: PrimaryImageKey;
  candidates: string[];
  path: string;
  existingPath: string;
  keepExisting: boolean;
};

export class PrimaryImageAssetDownloader implements AssetDownloader {
  constructor(private readonly posterDerivationService?: PosterImageDerivationService) {}

  shouldDownload(plan: DownloadExecutionPlan): boolean {
    return plan.config.download.downloadThumb || plan.config.download.downloadPoster;
  }

  async download(context: DownloadExecutionContext): Promise<void> {
    const { assets, imageDownloader, imageSources, logger, plan } = context;

    throwIfAborted(plan.signal);

    const primaryTasks = this.buildPrimaryImageTasks(plan);
    const pendingPrimaryTasks: PrimaryImageTask[] = [];

    for (const task of primaryTasks) {
      const existingAsset = await resolveExistingImageAsset(task.existingPath, plan.inventory);
      if (
        shouldKeepAsset(plan.assetDecisions[task.key], task.keepExisting) &&
        existingAsset &&
        !plan.forceReplace[task.key]
      ) {
        assets[task.key] = existingAsset;
        continue;
      }

      if (task.candidates.length > 0) {
        pendingPrimaryTasks.push(task);
      }
    }

    const primaryResults = await runParallel(
      pendingPrimaryTasks,
      3,
      async (task) => {
        return await imageDownloader.downloadBestImage(task.candidates, task.path, plan.signal);
      },
      {
        warn: (message) => logger.warn(message),
      },
    );

    for (const result of primaryResults) {
      if (!result?.success || !result.value) {
        continue;
      }

      const key = result.key as PrimaryImageKey;
      const { path: downloadedPath, url } = result.value;
      assets[key] = downloadedPath;
      assets.downloaded.push(downloadedPath);
      imageSources.set(downloadedPath, {
        source: plan.imageAlternatives.image_sources?.[`${key}_url`]?.[url] ?? "unknown",
        url,
      });
    }

    for (const task of primaryTasks) {
      if (!assets[task.key]) {
        const existingAsset = await resolveExistingImageAsset(task.existingPath, plan.inventory);
        if (existingAsset && shouldFallbackToExistingAsset(plan.assetDecisions[task.key])) {
          assets[task.key] = existingAsset;
        }
      }
    }

    await this.deriveSmallPosterFromThumb(context);
  }

  private buildPrimaryImageTasks(plan: DownloadExecutionPlan): PrimaryImageTask[] {
    const tasks: PrimaryImageTask[] = [];

    this.addPrimaryImageTask(
      tasks,
      "thumb",
      plan.config.download.downloadThumb,
      plan.config.download.keepThumb,
      plan.data.thumb_url,
      plan.imageAlternatives.thumb_url,
      join(plan.outputDir, plan.assetFileNames.thumb),
      plan.existingAssets?.thumb ?? join(plan.existingAssetDir, plan.assetFileNames.thumb),
    );
    this.addPrimaryImageTask(
      tasks,
      "poster",
      plan.config.download.downloadPoster,
      plan.config.download.keepPoster,
      plan.data.poster_url,
      plan.imageAlternatives.poster_url,
      join(plan.outputDir, plan.assetFileNames.poster),
      plan.existingAssets?.poster ?? join(plan.existingAssetDir, plan.assetFileNames.poster),
    );

    return tasks;
  }

  private addPrimaryImageTask(
    tasks: PrimaryImageTask[],
    key: PrimaryImageKey,
    enabled: boolean,
    keepExisting: boolean,
    primaryUrl: string | undefined,
    alternatives: string[] | undefined,
    path: string,
    existingPath: string,
  ): void {
    if (!enabled) {
      return;
    }

    tasks.push({
      key,
      candidates: buildImageCandidates(primaryUrl, alternatives),
      path,
      existingPath,
      keepExisting,
    });
  }

  private async deriveSmallPosterFromThumb(context: DownloadExecutionContext): Promise<void> {
    const { assets, logger, plan } = context;
    if (!plan.config.download.downloadPoster) {
      return;
    }
    if (
      assets.poster &&
      !assets.downloaded.includes(assets.poster) &&
      shouldKeepAsset(plan.assetDecisions.poster, plan.config.download.keepPoster) &&
      !plan.forceReplace.poster
    )
      return;

    throwIfAborted(plan.signal);

    const posterTargetPath = join(plan.outputDir, plan.assetFileNames.poster);
    const service = this.posterDerivationService ?? new PosterImageDerivationService(logger);
    let coverPath: string | undefined;
    const result = await service.deriveFromThumbIfNeeded({
      posterPath: assets.poster,
      targetPath: posterTargetPath,
      resolveThumbPath: async () => {
        coverPath = await context.resolveCover();
        return coverPath;
      },
    });

    if (result.status !== "derived") {
      return;
    }

    assets.poster = result.path;
    const coverSource = coverPath ? context.imageSources.get(coverPath) : undefined;
    context.imageSources.set(result.path, {
      ...coverSource,
      source: coverSource?.source ?? "local",
      derivedFrom: assets.thumb === coverPath ? "thumb" : "cover",
    });
    if (!assets.downloaded.includes(result.path)) {
      assets.downloaded.push(result.path);
    }

    const thumbSourceUrl = plan.data.thumb_source_url ?? plan.data.thumb_url;
    if (thumbSourceUrl) {
      plan.callbacks?.onDerivedPosterSource?.(thumbSourceUrl);
    }
  }
}
