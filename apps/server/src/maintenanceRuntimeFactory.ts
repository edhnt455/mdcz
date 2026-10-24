import { dirname, join } from "node:path";
import type { ActorSourceProvider } from "@mdcz/runtime/actorSource";
import type { PersistentCooldownStore } from "@mdcz/runtime/cooldown";
import type { CrawlerProvider } from "@mdcz/runtime/crawler";
import { MaintenanceRuntime, type MaintenanceRuntimeDependencies } from "@mdcz/runtime/maintenance";
import type { NetworkClient } from "@mdcz/runtime/network";
import {
  type ActorImageService,
  applyImageWatermarks,
  DownloadManager,
  FileOrganizer,
  ImageWatermarkService,
  NfoGenerator,
  type SiteResultSink,
  TranslateService,
} from "@mdcz/runtime/scrape";
import { runtimeLoggerService } from "@mdcz/runtime/shared";
import type { TranslationMappingStore } from "@mdcz/runtime/translate";
import type { ServerConfigService } from "./services/configService";
import { resolveServerBundledMappingDirectory } from "./translationMappingStore";

export interface ServerMaintenanceRuntimeDependencies {
  config: ServerConfigService;
  prepareScrapeItem?: MaintenanceRuntimeDependencies["prepareScrapeItem"];
  networkClient: NetworkClient;
  crawlerProvider: CrawlerProvider;
  imageHostCooldownStore: PersistentCooldownStore;
  actorImageService: ActorImageService;
  actorSourceProvider: ActorSourceProvider;
  mappingStore?: TranslationMappingStore;
  recordSiteResults: SiteResultSink;
  loadSiteResults: MaintenanceRuntimeDependencies["loadSiteResults"];
}

export const createServerMaintenanceRuntime = (deps: ServerMaintenanceRuntimeDependencies): MaintenanceRuntime => {
  const logger = runtimeLoggerService.getLogger("maintenance");
  const watermarkService = new ImageWatermarkService({
    dataDir: deps.config.runtimePaths.dataDir,
    builtinDirectory: join(dirname(resolveServerBundledMappingDirectory()), "watermark"),
  });
  return new MaintenanceRuntime({
    actorImageService: deps.actorImageService,
    actorSourceProvider: deps.actorSourceProvider,
    crawlerProvider: deps.crawlerProvider,
    recordSiteResults: deps.recordSiteResults,
    loadSiteResults: deps.loadSiteResults,
    logger,
    prepareScrapeItem: deps.prepareScrapeItem,
    config: deps.config,
    downloadManager: new DownloadManager(deps.networkClient, {
      imageHostCooldownStore: deps.imageHostCooldownStore,
      logger,
    }),
    fileOrganizer: new FileOrganizer(logger),
    networkPolicyClient: deps.networkClient,
    nfoGenerator: new NfoGenerator(),
    postProcessAssets: async ({ configuration, ...input }) =>
      await applyImageWatermarks({
        ...input,
        config: configuration,
        dataDir: deps.config.runtimePaths.dataDir,
        logger,
        watermarkService,
      }),
    signalService: {
      setProgress: () => undefined,
      showLogText: () => undefined,
    },
    translateService: new TranslateService(deps.networkClient, { logger, mappingStore: deps.mappingStore }),
  });
};
