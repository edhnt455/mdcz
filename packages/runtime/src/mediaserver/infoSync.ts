import type { Configuration } from "@mdcz/shared/config";
import type { PersonSyncResult } from "@mdcz/shared/toolTypes";
import type { MediaServerMode } from ".";
import { createEmptyPersonSyncResult, formatPersonSyncError, runPersonSyncBatch } from "./personSync";
import {
  type ExistingPersonSyncState,
  normalizeExistingPersonSyncState,
  type PlannedPersonSyncState,
  planPersonSync,
} from "./planner";

interface MediaServerInfoSyncLogger {
  warn(message: string): void;
}

export interface RuntimeInfoActorSourceProvider {
  lookup(
    configuration: Configuration,
    query: string | { name: string; requiredField?: "photo_url" | "description" },
  ): Promise<{
    profile: Parameters<typeof planPersonSync>[0];
    warnings?: string[];
  }>;
}

const logActorSourceWarnings = (
  logger: MediaServerInfoSyncLogger,
  actorName: string,
  warnings: string[] | undefined,
): void => {
  for (const warning of warnings ?? []) {
    logger.warn(`演员 ${actorName} 的来源警告：${warning}`);
  }
};

interface ProgressSignalService {
  resetProgress(): void;
  setProgress(value: number, current?: number, total?: number): void;
  showLogText(message: string, level?: "info" | "warn" | "error"): void;
}

interface MediaServerInfoSyncOptions<TPerson, TDetail> {
  configuration: Configuration;
  mode: MediaServerMode;
  serviceName: string;
  signalService: ProgressSignalService;
  actorSourceProvider: RuntimeInfoActorSourceProvider;
  logger: MediaServerInfoSyncLogger;
  fetchPersons: () => Promise<ReadonlyArray<TPerson>>;
  getPersonName: (person: TPerson) => string;
  fetchPersonDetail: (person: TPerson) => Promise<TDetail>;
  buildExistingState: (person: TPerson, detail: TDetail) => ExistingPersonSyncState;
  updatePersonInfo: (person: TPerson, detail: TDetail, synced: PlannedPersonSyncState) => Promise<void>;
  actorLookupQuery?: (person: TPerson) => string | { name: string };
  buildCompletionMessage?: (result: PersonSyncResult, total: number) => string;
}

export const runMediaServerInfoSync = async <TPerson, TDetail>(
  options: MediaServerInfoSyncOptions<TPerson, TDetail>,
): Promise<PersonSyncResult> => {
  const persons = await options.fetchPersons();
  if (persons.length === 0) {
    options.signalService.showLogText(`${options.serviceName} 未返回可同步的演员`, "warn");
    return createEmptyPersonSyncResult();
  }

  const result = await runPersonSyncBatch({
    items: persons,
    signalService: options.signalService,
    processItem: async (person) => {
      const detail = await options.fetchPersonDetail(person);
      const existing = normalizeExistingPersonSyncState(options.buildExistingState(person, detail));
      const personName = options.getPersonName(person);
      const actorSource = await options.actorSourceProvider.lookup(
        options.configuration,
        options.actorLookupQuery?.(person) ?? personName,
      );
      logActorSourceWarnings(options.logger, personName, actorSource.warnings);

      const synced = planPersonSync(actorSource.profile, existing, options.mode);
      if (!synced.shouldUpdate) {
        return "skipped";
      }

      await options.updatePersonInfo(person, detail, synced);

      options.signalService.showLogText(`已更新 ${options.serviceName} 演员信息：${personName}`);
      return "processed";
    },
    onError: (person, error) => {
      options.logger.warn(
        `更新 ${options.serviceName} 演员 ${options.getPersonName(person)} 的信息失败：${formatPersonSyncError(error)}`,
      );
    },
  });

  options.signalService.showLogText(
    options.buildCompletionMessage?.(result, persons.length) ??
      `${options.serviceName} 演员信息同步完成。成功：${result.processedCount}，失败：${result.failedCount}，跳过：${result.skippedCount}`,
  );

  return result;
};
