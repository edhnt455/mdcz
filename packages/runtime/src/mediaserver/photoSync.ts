import type { Configuration } from "@mdcz/shared/config";
import type { PersonSyncFailure, PersonSyncResult } from "@mdcz/shared/toolTypes";
import type { ActorLookupResult, ActorSourceHint } from "../actorSource/types";
import type { RuntimeNetworkClient } from "../network";
import type { MediaServerMode } from ".";
import { getHttpStatus, MediaServerServiceError } from "./errors";
import {
  createEmptyPersonSyncResult,
  formatPersonSyncError,
  loadPrimaryImageFromSource,
  runPersonSyncBatch,
} from "./personSync";

interface MediaServerPhotoSyncLogger {
  warn(message: string): void;
}

export interface RuntimePhotoActorSourceProvider {
  lookup(
    configuration: Configuration,
    query: string | { name: string; requiredField?: "photo_url"; sourceHints?: ActorSourceHint[] },
  ): Promise<{
    profile: { photo_url?: string };
    sourceResults: ActorLookupResult["sourceResults"];
  }>;
}

interface ProgressSignalService {
  resetProgress(): void;
  setProgress(value: number, current?: number, total?: number): void;
  showLogText(message: string, level?: "info" | "warn" | "error"): void;
}

export interface PhotoSyncOptions {
  canContinue?: () => boolean;
  shouldProcess?: (personId: string, name: string) => boolean;
  sourceHints?: (name: string) => ActorSourceHint[];
}

interface MediaServerPhotoSyncOptions<TPerson> extends PhotoSyncOptions {
  configuration: Configuration;
  mode: MediaServerMode;
  serviceName: string;
  signalService: ProgressSignalService;
  networkClient: RuntimeNetworkClient;
  actorSourceProvider: RuntimePhotoActorSourceProvider;
  logger: MediaServerPhotoSyncLogger;
  fetchPersons: () => Promise<ReadonlyArray<TPerson>>;
  getPersonName: (person: TPerson) => string;
  getPersonId: (person: TPerson) => string;
  hasPrimaryImage: (person: TPerson) => boolean;
  hasPrimaryImageNow?: (person: TPerson) => Promise<boolean>;
  uploadPrimaryImage: (personId: string, bytes: Uint8Array, contentType: string) => Promise<void>;
  buildCompletionMessage?: (result: PersonSyncResult, total: number) => string;
}

export const runMediaServerPhotoSync = async <TPerson>(
  options: MediaServerPhotoSyncOptions<TPerson>,
): Promise<PersonSyncResult> => {
  const persons = (await options.fetchPersons()).filter(
    (person) =>
      !options.shouldProcess || options.shouldProcess(options.getPersonId(person), options.getPersonName(person)),
  );
  if (persons.length === 0) {
    if (!options.shouldProcess) options.signalService.showLogText(`${options.serviceName} 未返回可同步的演员`, "warn");
    return createEmptyPersonSyncResult();
  }

  let stage = "查找照片来源";
  const failures: PersonSyncFailure[] = [];
  const result = await runPersonSyncBatch({
    items: persons,
    signalService: options.signalService,
    processItem: async (person) => {
      if (options.canContinue && !options.canContinue()) return "skipped";
      stage = "查找照片来源";
      const actorName = options.getPersonName(person).trim();
      if (!actorName) {
        return "skipped";
      }

      if (options.mode === "missing" && options.hasPrimaryImage(person)) {
        return "skipped";
      }

      const actorSource = await options.actorSourceProvider.lookup(options.configuration, {
        name: actorName,
        requiredField: "photo_url",
        ...(options.sourceHints ? { sourceHints: options.sourceHints(actorName) } : {}),
      });
      const sourceTrace = actorSource.sourceResults.map((result) => {
        const outcome = !result.success ? "查询失败" : result.profile?.photo_url?.trim() ? "找到照片" : "未找到照片";
        const warnings = result.warnings.length ? ` (${result.warnings.join("; ")})` : "";
        const sites = result.siteResults?.map(
          (site) => `${site.site}：${!site.success ? "查询失败" : site.photoFound ? "找到照片" : "未找到照片"}`,
        );
        const siteTrace = sites?.length ? ` [${sites.join("; ")}]` : "";
        return `${result.source}: ${outcome}${siteTrace}${warnings}`;
      });
      options.signalService.showLogText(
        `${options.serviceName} 演员 ${actorName} 的照片查询：${sourceTrace.join(" → ") || "未查询任何照片来源"}`,
        actorSource.sourceResults.some((result) => !result.success || result.warnings.length) ? "warn" : "info",
      );
      const source = actorSource.profile.photo_url;
      stage = source && /^https?:\/\//iu.test(source) ? "下载照片" : "读取本地照片";
      if (source && stage === "读取本地照片") {
        options.signalService.showLogText(`使用 ${actorName} 的本地 ${options.serviceName} 演员照片：${source}`);
      }
      const image = await loadPrimaryImageFromSource(options.networkClient, actorSource.profile.photo_url);

      if (!image) {
        options.signalService.showLogText(`未找到 ${actorName} 的 ${options.serviceName} 演员照片来源`, "warn");
        return "skipped";
      }

      if (options.canContinue && !options.canContinue()) return "skipped";
      if (options.mode === "missing" && options.hasPrimaryImageNow) {
        stage = "检查当前照片";
        if (await options.hasPrimaryImageNow(person)) {
          return "skipped";
        }
      }
      if (options.canContinue && !options.canContinue()) return "skipped";
      stage = "上传照片";
      await options.uploadPrimaryImage(options.getPersonId(person), image.content, image.contentType);

      options.signalService.showLogText(`已更新 ${options.serviceName} 演员照片：${actorName}`);
      return "processed";
    },
    onError: (person, error) => {
      const actorName = options.getPersonName(person).trim() || options.getPersonName(person);
      const status = error instanceof MediaServerServiceError ? error.status : getHttpStatus(error);
      if ((stage === "上传照片" || stage === "检查当前照片") && (status === 401 || status === 403)) throw error;
      failures.push({
        personId: options.getPersonId(person),
        name: actorName,
        stage,
        message: formatPersonSyncError(error, options.configuration),
      });
      options.logger.warn(
        `更新 ${options.serviceName} 演员 ${actorName} 的照片失败（${stage}）：${formatPersonSyncError(error, options.configuration)}`,
      );
    },
  });

  options.signalService.showLogText(
    options.buildCompletionMessage?.(result, persons.length) ??
      `${options.serviceName} 演员照片同步完成。成功：${result.processedCount}，失败：${result.failedCount}，跳过：${result.skippedCount}`,
  );

  return failures.length ? { ...result, failures } : result;
};
