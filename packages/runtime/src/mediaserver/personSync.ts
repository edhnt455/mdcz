import { readFile } from "node:fs/promises";
import type { Configuration } from "@mdcz/shared/config";
import type { PersonSyncResult } from "@mdcz/shared/ipcTypes";
import type { RuntimeNetworkClient } from "../network";
import { detectImageFormat, parseImageDimensions } from "../scrape/utils/image";

export type PersonSyncBatchOutcome = "processed" | "skipped";

type ProgressSignalService = {
  resetProgress(): void;
  setProgress(value: number, current?: number, total?: number): void;
};

export interface LoadedPrimaryImage {
  content: Uint8Array;
  contentType: string;
}

export const createEmptyPersonSyncResult = (): PersonSyncResult => ({
  processedCount: 0,
  failedCount: 0,
  skippedCount: 0,
});

export const formatPersonSyncError = (error: unknown, configuration?: Configuration): string => {
  let text = error instanceof Error ? error.message : String(error);
  if (error && typeof error === "object" && "code" in error && "message" in error) {
    const code = (error as { code?: unknown }).code;
    const message = (error as { message?: unknown }).message;
    if (typeof code === "string" && typeof message === "string") {
      text = `${code}: ${message}`;
    }
  }

  for (const key of [configuration?.emby.apiKey, configuration?.jellyfin.apiKey]) {
    if (key) text = text.replaceAll(key, "[redacted]");
  }
  return text.replace(/([?&](?:api_key|apiKey|token)=)[^\s&]+/giu, "$1[redacted]");
};

export const loadPrimaryImageFromSource = async (
  networkClient: RuntimeNetworkClient,
  source: string | undefined,
): Promise<LoadedPrimaryImage | null> => {
  const normalizedSource = source?.trim();
  if (!normalizedSource) {
    return null;
  }

  const content = /^https?:\/\//iu.test(normalizedSource)
    ? await networkClient.getContent?.(normalizedSource, {
        headers: {
          accept: "image/*",
        },
      })
    : await readFile(normalizedSource);

  if (!content) {
    return null;
  }

  const format = detectImageFormat(content);
  if (!format || !parseImageDimensions(content)) throw new Error("Invalid actor image content");

  return {
    content,
    contentType: `image/${format}`,
  };
};

export const runPersonSyncBatch = async <TItem>(options: {
  items: ReadonlyArray<TItem>;
  signalService: ProgressSignalService;
  processItem: (item: TItem) => Promise<PersonSyncBatchOutcome>;
  onError: (item: TItem, error: unknown) => void;
}): Promise<PersonSyncResult> => {
  if (options.items.length === 0) {
    return createEmptyPersonSyncResult();
  }

  let processedCount = 0;
  let failedCount = 0;
  let skippedCount = 0;
  let completed = 0;
  const total = options.items.length;

  options.signalService.resetProgress();

  for (const item of options.items) {
    try {
      const outcome = await options.processItem(item);
      if (outcome === "processed") {
        processedCount += 1;
      } else {
        skippedCount += 1;
      }
    } catch (error) {
      failedCount += 1;
      options.onError(item, error);
    } finally {
      completed += 1;
      options.signalService.setProgress(Math.round((completed / total) * 100), completed, total);
    }
  }

  return {
    processedCount,
    failedCount,
    skippedCount,
  };
};
