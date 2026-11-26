import { setTimeout as sleep } from "node:timers/promises";
import type { Configuration } from "@mdcz/shared/config";
import { parseRetryAfterMs, readRetryAfterHeader } from "../../../shared";
import { getScrapeConcurrency } from "../../executionPolicy";
import { throwIfAborted } from "../../utils/abort";
import {
  type LlmApiClient,
  LlmEmptyResponseError,
  type LlmJsonSchema,
  normalizeLlmBaseUrl,
  toLlmTextRequest,
} from "./LlmApiClient";

const RETRY_AFTER_CAP_MS = 15_000;

export class LlmRequestService {
  constructor(
    private readonly logger: { warn(message: string): void },
    private readonly llmApiClient: Pick<LlmApiClient, "generateText"> & Partial<Pick<LlmApiClient, "setDomainLimit">>,
  ) {}

  async requestText(config: Configuration, prompt: string, signal?: AbortSignal, outputSchema?: LlmJsonSchema) {
    const settings = config.translate;
    const hostname = new URL(normalizeLlmBaseUrl(settings.llmBaseUrl)).hostname;
    this.llmApiClient.setDomainLimit?.(hostname, settings.llmMaxRequestsPerSecond, getScrapeConcurrency(config));
    const maxRetries = settings.llmMaxRetries;
    const request = { ...toLlmTextRequest(settings, prompt, outputSchema), maxRetries };
    for (let attempt = 0; ; attempt++) {
      throwIfAborted(signal);
      try {
        return await this.llmApiClient.generateText(request, signal);
      } catch (error) {
        throwIfAborted(signal);
        if (attempt >= maxRetries) throw error;
        const response =
          typeof error === "object" && error !== null
            ? (error as { status?: number; headers?: Headers; response?: { headers?: Headers } })
            : undefined;
        const rateLimited = response?.status === 429;
        if (!rateLimited && !(error instanceof LlmEmptyResponseError)) throw error;
        const retryAfter = rateLimited
          ? parseRetryAfterMs(readRetryAfterHeader(response?.headers ?? response?.response?.headers))
          : null;
        const delay = Math.min(retryAfter ?? 1000 * 2 ** attempt, RETRY_AFTER_CAP_MS);
        const reason = rateLimited ? "HTTP 429" : "空响应";
        this.logger.warn(`大模型请求因${reason}而重试（${attempt + 1}/${maxRetries}），将在 ${delay} 毫秒后执行`);
        await sleep(delay, undefined, signal ? { signal } : undefined);
      }
    }
  }
}
