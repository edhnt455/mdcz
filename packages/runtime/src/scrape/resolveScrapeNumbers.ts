import { filesystemPathKey } from "@mdcz/media-store";
import type { Configuration } from "@mdcz/shared/config";
import PQueue from "p-queue";
import { movieNumbersMatch } from "../crawler/base/identity";
import { isUnrecoverableNetworkError } from "../network";
import { toErrorMessage } from "../shared";
import type { AggregationResult, AggregationService } from "./aggregation";
import type { DirectoryInventory } from "./DirectoryInventory";
import { groupMovieMembers, type MovieGroup } from "./movieGroups";
import type { NumberRecognitionService } from "./NumberRecognitionService";
import { ScrapeFailureError } from "./scrapeFailure";
import { loadLocalNfoSnapshot } from "./selectLocalNfo";
import { isAbortError, throwIfAborted } from "./utils/abort";
import { parseFileInfo } from "./utils/number";

export const resolveScrapeNumbers = async (input: {
  groups: MovieGroup[];
  inventory: DirectoryInventory;
  configuration: Configuration;
  aggregationService: Pick<AggregationService, "aggregate">;
  recognitionService: Pick<NumberRecognitionService, "recognize">;
  logger: { info(message: string): void; warn(message: string): void };
  signal?: AbortSignal;
  unpin?: boolean;
  beforeLookup?: (signal?: AbortSignal) => Promise<void>;
}): Promise<{ groups: MovieGroup[]; aggregationService: Pick<AggregationService, "aggregate"> }> => {
  if (!input.configuration.scrape.aiNumberFallback) return input;
  const { inventory, configuration, signal, logger } = input;
  const lookups = new Map<string, Promise<{ result: AggregationResult } | { error: unknown }>>();
  const aggregationService: Pick<AggregationService, "aggregate"> = {
    aggregate: async (number, options) => {
      throwIfAborted(options?.signal);
      const key = JSON.stringify([number, options?.manualScrape ?? null]);
      let pending = lookups.get(key);
      if (!pending) {
        pending = (async () => {
          await input.beforeLookup?.(options?.signal);
          return await input.aggregationService.aggregate(number, options);
        })().then(
          (result) => ({ result }),
          (error: unknown) => ({ error }),
        );
        lookups.set(key, pending);
      }
      const outcome = await pending;
      throwIfAborted(options?.signal);
      if ("error" in outcome) throw outcome.error;
      return structuredClone(outcome.result);
    },
  };
  const members = input.groups.flatMap((group) => group.members);
  for (const member of members)
    inventory.resolvedFileInfos.set(filesystemPathKey(member.fileInfo.filePath), member.fileInfo);
  const queue = new PQueue({ concurrency: configuration.scrape.threadNumber });
  await Promise.all(
    members.map((member) =>
      queue.add(
        async () => {
          throwIfAborted(signal);
          if (member.error || member.numberIsManual || member.manualScrape?.detailUrl) return;
          const fileInfo = member.fileInfo;
          try {
            if (!(await inventory.stats(fileInfo.filePath)).isFile()) return;
            const snapshot = await loadLocalNfoSnapshot(fileInfo, inventory, configuration.scrape);
            if (!input.unpin && snapshot?.localState?.sourcePin) return;
          } catch (error) {
            if (isAbortError(error) || isUnrecoverableNetworkError(error)) throw error;
            member.error = toErrorMessage(error);
            return;
          }
          if (fileInfo.number) {
            try {
              await aggregationService.aggregate(fileInfo.number, { manualScrape: member.manualScrape, signal });
              return;
            } catch (error) {
              if (isAbortError(error) || isUnrecoverableNetworkError(error)) throw error;
              if (!(error instanceof ScrapeFailureError) || !error.canRetryNumber) return;
            }
          }
          logger.info(`[number-recognition] Trying AI for ${fileInfo.fileName}; previous=${fileInfo.number || "none"}`);
          try {
            const number = await input.recognitionService.recognize(
              fileInfo.filePath,
              fileInfo.number,
              configuration,
              signal,
            );
            throwIfAborted(signal);
            if (!number || movieNumbersMatch(number, fileInfo.number)) {
              logger.warn(
                `[number-recognition] AI found no alternative number for ${fileInfo.fileName}; manual repair required`,
              );
              return;
            }
            member.fileInfo = parseFileInfo(
              fileInfo.filePath,
              configuration.scrape.filenameIgnoreTokens,
              configuration.scrape.numberMappings,
              configuration.scrape,
              number,
            );
            inventory.resolvedFileInfos.set(filesystemPathKey(fileInfo.filePath), member.fileInfo);
            logger.info(`[number-recognition] ${fileInfo.fileName}: ${fileInfo.number || "none"} -> ${number}`);
          } catch (error) {
            if (isAbortError(error) || isUnrecoverableNetworkError(error)) throw error;
            logger.warn(
              `[number-recognition] AI failed for ${fileInfo.fileName}: ${toErrorMessage(error)}; manual repair required`,
            );
          }
        },
        signal ? { signal } : undefined,
      ),
    ),
  );

  return { groups: groupMovieMembers(members), aggregationService };
};
