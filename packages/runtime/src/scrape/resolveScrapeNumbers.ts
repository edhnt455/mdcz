import { filesystemPathKey } from "@mdcz/media-store";
import type { Configuration } from "@mdcz/shared/config";
import PQueue from "p-queue";
import { isUnrecoverableNetworkError } from "../network";
import { toErrorMessage } from "../shared";
import type { AggregationResult, AggregationService } from "./aggregation";
import type { DirectoryInventory } from "./DirectoryInventory";
import { groupMovieMembers, type MovieGroup, type MovieMember } from "./movieGroups";
import type { NumberRecognitionService } from "./NumberRecognitionService";
import { ScrapeFailureError } from "./scrapeFailure";
import { loadLocalNfoSnapshot } from "./selectLocalNfo";
import { isAbortError, throwIfAborted } from "./utils/abort";
import { parseFileInfo } from "./utils/number";

export const createScrapeNumberResolver = (input: {
  inventory: DirectoryInventory;
  configuration: Configuration;
  aggregationService: Pick<AggregationService, "aggregate">;
  recognitionService: Pick<NumberRecognitionService, "recognize">;
  logger: { info(message: string): void; warn(message: string): void };
  unpin?: boolean;
  beforeLookup?: (signal?: AbortSignal) => Promise<void>;
}) => {
  const { inventory, configuration, logger } = input;
  const resolvedMembers = new Set<string>();
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
  const resolveGroups = async <TMember extends MovieMember>(groups: MovieGroup<TMember>[], signal?: AbortSignal) => {
    const members = groups.flatMap((group) => group.members);
    if (!configuration.scrape.aiNumberFallback) {
      for (const member of members) member.numberRecognition = { status: "skipped", reason: "disabled" };
      return groups;
    }
    for (const member of members)
      inventory.resolvedFileInfos.set(filesystemPathKey(member.fileInfo.filePath), member.fileInfo);
    const queue = new PQueue({ concurrency: configuration.scrape.threadNumber });
    await Promise.all(
      members.map((member) =>
        queue.add(
          async () => {
            throwIfAborted(signal);
            if (resolvedMembers.has(member.fileId)) return;
            resolvedMembers.add(member.fileId);
            const skipReason = member.error
              ? "source_error"
              : member.numberIsManual
                ? "manual_number"
                : member.manualScrape?.detailUrl
                  ? "manual_url"
                  : null;
            if (skipReason) {
              member.numberRecognition = { status: "skipped", reason: skipReason };
              return;
            }
            const fileInfo = member.fileInfo;
            try {
              if (!(await inventory.stats(fileInfo.filePath)).isFile()) {
                member.numberRecognition = { status: "skipped", reason: "source_error" };
                return;
              }
              const snapshot = await loadLocalNfoSnapshot(fileInfo, inventory, configuration.scrape);
              if (!input.unpin && snapshot?.localState?.sourcePin) {
                member.numberRecognition = { status: "skipped", reason: "source_pin" };
                return;
              }
            } catch (error) {
              if (isAbortError(error) || isUnrecoverableNetworkError(error)) throw error;
              member.error = toErrorMessage(error);
              member.numberRecognition = { status: "skipped", reason: "source_error" };
              return;
            }
            if (fileInfo.number) {
              try {
                await aggregationService.aggregate(fileInfo.number, { manualScrape: member.manualScrape, signal });
                member.numberRecognition = { status: "skipped", reason: "found" };
                return;
              } catch (error) {
                if (isAbortError(error) || isUnrecoverableNetworkError(error)) throw error;
                if (!(error instanceof ScrapeFailureError) || !error.canRetryNumber) {
                  member.numberRecognition = { status: "skipped", reason: "lookup_ineligible" };
                  return;
                }
              }
            }
            logger.info(
              `[number-recognition] Trying AI for ${fileInfo.fileName}; previous=${fileInfo.number || "none"}`,
            );
            const recognition = await input.recognitionService.recognize(
              fileInfo.filePath,
              fileInfo.number,
              configuration,
              signal,
            );
            throwIfAborted(signal);
            member.numberRecognition = { ...recognition, trigger: "automatic" };
            if (recognition.status !== "recognized" || !recognition.number) {
              logger.warn(
                `[number-recognition] ${fileInfo.fileName}: ${recognition.status}; number=${recognition.number ?? "none"}${recognition.error ? `; ${recognition.error}` : ""}; manual repair required`,
              );
              return;
            }
            member.fileInfo = parseFileInfo(
              fileInfo.filePath,
              configuration.scrape.filenameIgnoreTokens,
              configuration.scrape.numberMappings,
              configuration.scrape,
              recognition.number,
            );
            inventory.resolvedFileInfos.set(filesystemPathKey(fileInfo.filePath), member.fileInfo);
            logger.info(
              `[number-recognition] ${fileInfo.fileName}: ${fileInfo.number || "none"} -> ${recognition.number}`,
            );
          },
          signal ? { signal } : undefined,
        ),
      ),
    );

    return groupMovieMembers(members);
  };
  return {
    resolveGroups,
    aggregationService: configuration.scrape.aiNumberFallback ? aggregationService : input.aggregationService,
  };
};
