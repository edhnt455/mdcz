import type { Configuration } from "@mdcz/shared/config";
import type { PersonSyncFailure, PersonSyncResult } from "@mdcz/shared/toolTypes";
import type { ActorSourceHint } from "../actorSource/types";
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
    warnings?: string[];
  }>;
}

const logActorSourceWarnings = (
  logger: MediaServerPhotoSyncLogger,
  actorName: string,
  warnings: string[] | undefined,
): void => {
  for (const warning of warnings ?? []) {
    logger.warn(`Actor source warning for ${actorName}: ${warning}`);
  }
};

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
  shouldRefreshPerson: boolean;
  refreshPerson: (personId: string) => Promise<void>;
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
    options.signalService.showLogText(`${options.serviceName} returned no actors to sync`, "warn");
    return createEmptyPersonSyncResult();
  }

  let stage = "resolve photo source";
  const failures: PersonSyncFailure[] = [];
  const result = await runPersonSyncBatch({
    items: persons,
    signalService: options.signalService,
    processItem: async (person) => {
      if (options.canContinue && !options.canContinue()) return "skipped";
      stage = "resolve photo source";
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
      logActorSourceWarnings(options.logger, actorName, actorSource.warnings);
      const source = actorSource.profile.photo_url;
      stage = source && /^https?:\/\//iu.test(source) ? "download photo" : "read local photo";
      if (source && stage === "read local photo") {
        options.signalService.showLogText(`Using local ${options.serviceName} actor photo for ${actorName}: ${source}`);
      }
      const image = await loadPrimaryImageFromSource(options.networkClient, actorSource.profile.photo_url);

      if (!image) {
        options.signalService.showLogText(
          `No ${options.serviceName} actor photo source found for ${actorName}`,
          "warn",
        );
        return "skipped";
      }

      if (options.canContinue && !options.canContinue()) return "skipped";
      if (options.mode === "missing" && options.hasPrimaryImageNow) {
        stage = "check current photo";
        if (await options.hasPrimaryImageNow(person)) {
          return "skipped";
        }
      }
      if (options.canContinue && !options.canContinue()) return "skipped";
      stage = "upload photo";
      await options.uploadPrimaryImage(options.getPersonId(person), image.content, image.contentType);
      if (options.shouldRefreshPerson) {
        try {
          await options.refreshPerson(options.getPersonId(person));
        } catch (error) {
          options.logger.warn(
            `Failed to refresh ${options.serviceName} actor ${actorName} after photo sync: ${formatPersonSyncError(error)}`,
          );
        }
      }

      options.signalService.showLogText(`Updated ${options.serviceName} actor photo: ${actorName}`);
      return "processed";
    },
    onError: (person, error) => {
      const actorName = options.getPersonName(person).trim() || options.getPersonName(person);
      const status = error instanceof MediaServerServiceError ? error.status : getHttpStatus(error);
      if ((stage === "upload photo" || stage === "check current photo") && (status === 401 || status === 403))
        throw error;
      failures.push({
        personId: options.getPersonId(person),
        name: actorName,
        stage,
        message: formatPersonSyncError(error, options.configuration),
      });
      options.logger.warn(
        `Failed to update ${options.serviceName} actor photo for ${actorName} (${stage}): ${formatPersonSyncError(error, options.configuration)}`,
      );
    },
  });

  options.signalService.showLogText(
    options.buildCompletionMessage?.(result, persons.length) ??
      `${options.serviceName} actor photo sync completed. Success: ${result.processedCount}, Failed: ${result.failedCount}, Skipped: ${result.skippedCount}`,
  );

  return failures.length ? { ...result, failures } : result;
};
