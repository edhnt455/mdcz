import { join } from "node:path";
import { buildMovieAssetFileNames } from "@mdcz/shared/assetNaming";
import type { Configuration } from "@mdcz/shared/config";
import type { CrawlerData, DiscoveredAssets, DownloadedAssets } from "@mdcz/shared/types";
import { type RuntimeDownloadNetworkClient, runWithNetworkChannel } from "../../network";
import { type RuntimeLogger, runtimeLoggerService } from "../../shared";
import type { ImageAlternatives } from "../aggregation";
import { DirectoryInventory } from "../DirectoryInventory";
import { throwIfAborted } from "../utils/abort";
import { FanartAssetDownloader } from "./assets/FanartAssetDownloader";
import { buildImageCandidates } from "./assets/helpers";
import { PrimaryImageAssetDownloader } from "./assets/PrimaryImageAssetDownloader";
import { SceneImageAssetDownloader } from "./assets/SceneImageAssetDownloader";
import { TrailerAssetDownloader } from "./assets/TrailerAssetDownloader";
import type {
  AssetDownloader,
  DownloadCallbacks,
  DownloadExecutionContext,
  DownloadExecutionPlan,
} from "./assets/types";
import { ImageDownloadService } from "./ImageDownloadService";
import { getUrlHost, type ImageHostCooldownStore, ImageHostCooldownTracker } from "./ImageHostCooldownTracker";
import { SceneImageDownloader } from "./SceneImageDownloader";

export type { DownloadCallbacks } from "./assets/types";

export interface DownloadManagerOptions {
  imageHostCooldownStore: ImageHostCooldownStore;
  logger?: Pick<RuntimeLogger, "info" | "warn">;
}

interface DownloadExecutionOptions {
  movieBaseName?: string;
  existingAssetDir?: string;
  existingAssets?: DiscoveredAssets;
  inventory?: DirectoryInventory;
}

export class DownloadManager {
  private readonly logger: Pick<RuntimeLogger, "info" | "warn">;

  private readonly imageDownloader: ImageDownloadService;

  private readonly sceneImageDownloader: SceneImageDownloader;

  private readonly downloaders: AssetDownloader[];

  constructor(networkClient: RuntimeDownloadNetworkClient, options: DownloadManagerOptions) {
    this.logger = options.logger ?? runtimeLoggerService.getLogger("DownloadManager");
    const hostCooldownTracker = new ImageHostCooldownTracker(options.imageHostCooldownStore, this.logger);

    this.imageDownloader = new ImageDownloadService(networkClient, hostCooldownTracker, this.logger);
    this.sceneImageDownloader = new SceneImageDownloader(this.imageDownloader, hostCooldownTracker, this.logger);
    this.downloaders = [
      new PrimaryImageAssetDownloader(),
      new SceneImageAssetDownloader(),
      new FanartAssetDownloader(),
      new TrailerAssetDownloader(),
    ];
  }

  async downloadAll(
    outputDir: string,
    data: CrawlerData,
    config: Configuration,
    imageAlternatives: Partial<ImageAlternatives> = {},
    callbacks?: DownloadCallbacks,
    options: DownloadExecutionOptions = {},
  ): Promise<DownloadedAssets> {
    const assets: DownloadedAssets = {
      sceneImages: [],
      downloaded: [],
    };

    const plan = this.createExecutionPlan(outputDir, data, config, imageAlternatives, callbacks, options);
    let cover: Promise<{ path: string; url: string } | undefined> | undefined;
    const context: DownloadExecutionContext = {
      plan,
      assets,
      imageDownloader: this.imageDownloader,
      sceneImageDownloader: this.sceneImageDownloader,
      imageSources: new Map(),
      // outputDir is the publication staging folder, so a cover fetched there only as a source is never published.
      resolveCover: async () => {
        if (assets.thumb || config.download.downloadThumb) return assets.thumb;
        cover ??= this.imageDownloader.downloadBestImage(
          buildImageCandidates(data.thumb_url, plan.imageAlternatives.thumb_url),
          join(outputDir, ".mdcz-cover.jpg"),
          plan.signal,
        );
        const downloaded = await cover;
        if (downloaded) {
          context.imageSources.set(downloaded.path, {
            source: plan.imageAlternatives.image_sources?.thumb_url?.[downloaded.url] ?? "unknown",
            url: downloaded.url,
          });
        }
        return downloaded?.path;
      },
      logger: this.logger,
    };

    throwIfAborted(plan.signal);

    await runWithNetworkChannel("media", async () => {
      for (const downloader of this.downloaders) {
        if (!downloader.shouldDownload(plan)) continue;
        throwIfAborted(plan.signal);
        await downloader.download(context);
      }
    });

    const downloadedPaths = new Set(assets.downloaded);
    const existingKinds = [
      assets.thumb && !downloadedPaths.has(assets.thumb) ? "thumb" : undefined,
      assets.poster && !downloadedPaths.has(assets.poster) ? "poster" : undefined,
      assets.fanart && !downloadedPaths.has(assets.fanart) ? "fanart" : undefined,
      assets.trailer && !downloadedPaths.has(assets.trailer) ? "trailer" : undefined,
      assets.sceneImages.length > 0 && assets.sceneImages.every((asset) => !downloadedPaths.has(asset))
        ? "scene images"
        : undefined,
    ].filter((kind): kind is string => Boolean(kind));
    if (existingKinds.length > 0) {
      this.logger.info(`[${data.number}] Using existing local assets: ${existingKinds.join(", ")}`);
    }

    const imageFields = {
      thumb: { enabled: config.download.downloadThumb, paths: assets.thumb ? [assets.thumb] : [] },
      poster: { enabled: config.download.downloadPoster, paths: assets.poster ? [assets.poster] : [] },
      fanart: { enabled: config.download.downloadFanart, paths: assets.fanart ? [assets.fanart] : [] },
      scene_images: { enabled: config.download.downloadSceneImages, paths: assets.sceneImages },
    };
    this.logger.info(
      `[image-sources] ${JSON.stringify({
        number: data.number,
        fields: Object.fromEntries(
          Object.entries(imageFields).map(([field, { enabled, paths }]) => [
            field,
            paths.length === 0
              ? { status: enabled ? "missing" : "disabled" }
              : paths.map((path) => {
                  const origin = context.imageSources.get(path);
                  return {
                    status: downloadedPaths.has(path) ? (origin?.derivedFrom ? "derived" : "downloaded") : "local",
                    source: origin?.source ?? (downloadedPaths.has(path) ? "unknown" : "local"),
                    host: origin?.url ? (getUrlHost(origin.url) ?? "unknown") : undefined,
                    derivedFrom: origin?.derivedFrom,
                  };
                }),
          ]),
        ),
      })}`,
    );

    return assets;
  }

  private createExecutionPlan(
    outputDir: string,
    data: CrawlerData,
    config: Configuration,
    imageAlternatives: Partial<ImageAlternatives>,
    callbacks?: DownloadCallbacks,
    options: DownloadExecutionOptions = {},
  ): DownloadExecutionPlan {
    const movieBaseName = options.movieBaseName?.trim() || data.number.trim();

    return {
      outputDir,
      existingAssetDir: options.existingAssetDir ?? outputDir,
      existingAssets: options.existingAssets,
      inventory: options.inventory ?? new DirectoryInventory(),
      movieBaseName,
      assetFileNames: buildMovieAssetFileNames(movieBaseName, config.naming.assetNamingMode),
      data,
      config,
      imageAlternatives,
      callbacks,
      forceReplace: callbacks?.forceReplace ?? {},
      assetDecisions: callbacks?.assetDecisions ?? {},
      signal: callbacks?.signal,
    };
  }
}
