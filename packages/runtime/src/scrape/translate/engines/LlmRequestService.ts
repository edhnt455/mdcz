import { setTimeout as sleep } from "node:timers/promises";
import type { Configuration } from "@mdcz/shared/config";
import PQueue from "p-queue";
import { preserveNetworkExecutionContext } from "../../../network";
import { parseRetryAfterMs, readRetryAfterHeader, toErrorMessage } from "../../../shared";
import { isAbortError, throwIfAborted } from "../../utils/abort";
import { type LlmApiClient, type LlmJsonSchema, LlmTransportError, toLlmTextRequest } from "./LlmApiClient";

const OPENAI_RETRY_STATUS_CODE = 429;
const RETRY_AFTER_CAP_MS = 15_000;
const REQUEST_TIMEOUT_PATTERN =
  /request timeout|timed ?out|timeout \(\d+ ms\)|error reading response stream|kind: *body|econnreset|etimedout/iu;
interface RetryDecision {
  delayMs: number;
  reason: string;
}

export class LlmRequestService {
  private readonly requestQueues = new Map<number, PQueue>();

  constructor(
    private readonly logger: { warn(message: string): void },
    private readonly llmApiClient: LlmApiClient,
  ) {}

  requestText(config: Configuration["translate"], prompt: string, signal?: AbortSignal, outputSchema?: LlmJsonSchema) {
    return this.executeRequestWithRetry(
      config,
      () => this.llmApiClient.generateText(toLlmTextRequest(config, prompt, outputSchema), signal),
      signal,
    );
  }

  private getQueue(config: Configuration["translate"]): PQueue {
    const requestsPerSecond = config.llmMaxRequestsPerSecond;
    const existing = this.requestQueues.get(requestsPerSecond);
    if (existing) {
      return existing;
    }

    const queue = new PQueue({
      concurrency: 1,
      interval: 1000,
      intervalCap: requestsPerSecond,
    });
    this.requestQueues.set(requestsPerSecond, queue);
    return queue;
  }

  private async executeRequestWithRetry<T>(
    config: Configuration["translate"],
    request: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const maxRetryCount = config.llmMaxRetries;
    let attempt = 0;

    while (true) {
      try {
        const queue = this.getQueue(config);
        return await queue.add(
          preserveNetworkExecutionContext(async () => {
            throwIfAborted(signal);
            return request();
          }),
          signal ? { signal } : undefined,
        );
      } catch (error) {
        if (isAbortError(error)) {
          throw error;
        }
        if (attempt >= maxRetryCount) {
          throw error;
        }

        const retryDecision = this.getRetryDecision(error, attempt);
        if (!retryDecision) {
          throw error;
        }

        attempt += 1;
        this.logger.warn(
          `LLM request retrying after ${retryDecision.reason} (${attempt}/${maxRetryCount}) in ${retryDecision.delayMs}ms`,
        );
        await sleep(retryDecision.delayMs, undefined, signal ? { signal } : undefined);
      }
    }
  }

  private getRetryDecision(error: unknown, attempt: number): RetryDecision | null {
    if (error instanceof LlmTransportError) {
      return { delayMs: this.getExponentialDelayMs(attempt), reason: "transport error" };
    }

    if (!error || typeof error !== "object") {
      return null;
    }

    const status = (error as { status?: unknown }).status;
    if (status !== OPENAI_RETRY_STATUS_CODE) {
      if (this.isRetryableTimeout(error)) {
        return { delayMs: this.getExponentialDelayMs(attempt), reason: "timeout" };
      }
      return null;
    }

    const headers =
      (error as { headers?: unknown }).headers ?? (error as { response?: { headers?: unknown } }).response?.headers;

    const rawRetryAfter = readRetryAfterHeader(headers);
    const parsed = parseRetryAfterMs(rawRetryAfter);
    if (parsed !== null) {
      return { delayMs: Math.min(parsed, RETRY_AFTER_CAP_MS), reason: "HTTP 429" };
    }

    return { delayMs: this.getExponentialDelayMs(attempt), reason: "HTTP 429" };
  }

  private getExponentialDelayMs(attempt: number): number {
    return Math.min(1000 * 2 ** attempt, RETRY_AFTER_CAP_MS);
  }

  private isRetryableTimeout(error: unknown): boolean {
    const message = toErrorMessage(error);
    return REQUEST_TIMEOUT_PATTERN.test(message);
  }
}
