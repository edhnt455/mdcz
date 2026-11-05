import { isDeepStrictEqual } from "node:util";
import PQueue from "p-queue";

interface DomainRateLimit {
  interval: number;
  intervalCap: number;
  concurrency: number;
}

interface QueueEntry {
  queue: PQueue;
  cleanupTimer: ReturnType<typeof setTimeout> | null;
}

const DEFAULT_IDLE_QUEUE_TTL_MS = 60_000;

export class RateLimiter {
  private readonly defaultLimit: DomainRateLimit;

  private readonly domainLimits = new Map<string, DomainRateLimit>();

  private readonly queues = new Map<string, QueueEntry>();

  constructor(
    defaultRequestsPerSecond = 5,
    private readonly idleQueueTtlMs = DEFAULT_IDLE_QUEUE_TTL_MS,
  ) {
    this.defaultLimit = {
      interval: 1000,
      intervalCap: Math.max(1, Math.trunc(defaultRequestsPerSecond)),
      concurrency: 1,
    };
  }

  setDomainLimit(domain: string, requestsPerSecond: number, concurrency = 1): void {
    this.setDomainInterval(domain, 1000, requestsPerSecond, concurrency);
  }

  setDomainInterval(domain: string, intervalMs: number, intervalCap = 1, concurrency = 1): void {
    const limit = {
      interval: Math.max(1, Math.trunc(intervalMs)),
      intervalCap: Math.max(1, Math.trunc(intervalCap)),
      concurrency,
    };
    const previous = this.domainLimits.get(domain) ?? this.defaultLimit;
    // A replacement queue would start beside the old one while it drains.
    if (isDeepStrictEqual(previous, limit)) return;
    if (isDeepStrictEqual(limit, this.defaultLimit)) this.domainLimits.delete(domain);
    else this.domainLimits.set(domain, limit);
    this.disposeQueue(domain);
  }

  clearDomainLimit(domain: string): void {
    if (this.domainLimits.delete(domain)) this.disposeQueue(domain);
  }

  async schedule<T>(urlOrDomain: string, task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const domain = this.extractDomain(urlOrDomain);
    const entry = this.getOrCreateQueue(domain);
    this.clearCleanupTimer(entry);

    return entry.queue.add(task, signal ? { signal } : undefined).finally(() => {
      this.scheduleIdleCleanup(domain, entry);
    });
  }

  clear(): void {
    this.queues.forEach((entry) => {
      this.clearCleanupTimer(entry);
      entry.queue.clear();
    });
    this.queues.clear();
  }

  private getOrCreateQueue(domain: string): QueueEntry {
    const existing = this.queues.get(domain);

    if (existing) {
      return existing;
    }

    const limit = this.domainLimits.get(domain) ?? this.defaultLimit;
    // A one-request limit is a minimum delay between starts, even at a window boundary.
    const entry: QueueEntry = { queue: new PQueue({ ...limit, strict: limit.intervalCap === 1 }), cleanupTimer: null };
    this.queues.set(domain, entry);

    return entry;
  }

  private scheduleIdleCleanup(domain: string, entry: QueueEntry): void {
    if (
      this.idleQueueTtlMs <= 0 ||
      entry.queue.size > 0 ||
      entry.queue.pending > 0 ||
      this.queues.get(domain) !== entry
    ) {
      return;
    }

    this.clearCleanupTimer(entry);
    const { interval } = this.domainLimits.get(domain) ?? this.defaultLimit;
    const cleanupDelay = Math.max(this.idleQueueTtlMs, interval);
    entry.cleanupTimer = setTimeout(() => {
      if (entry.queue.size > 0 || entry.queue.pending > 0 || this.queues.get(domain) !== entry) {
        return;
      }

      this.clearCleanupTimer(entry);
      this.queues.delete(domain);
    }, cleanupDelay);
    entry.cleanupTimer.unref?.();
  }

  private clearCleanupTimer(entry: QueueEntry): void {
    if (!entry.cleanupTimer) {
      return;
    }

    clearTimeout(entry.cleanupTimer);
    entry.cleanupTimer = null;
  }

  private disposeQueue(domain: string): void {
    const entry = this.queues.get(domain);
    if (!entry) {
      return;
    }

    this.clearCleanupTimer(entry);
    this.queues.delete(domain);
  }

  private extractDomain(urlOrDomain: string): string {
    try {
      const normalized = urlOrDomain.startsWith("http") ? urlOrDomain : `https://${urlOrDomain}`;
      return new URL(normalized).hostname;
    } catch {
      return urlOrDomain;
    }
  }
}
