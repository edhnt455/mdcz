import { RateLimiter } from "@mdcz/runtime/network";
import { describe, expect, it, vi } from "vitest";

const getQueueCount = (limiter: RateLimiter): number => {
  return (limiter as unknown as { queues: Map<string, unknown> }).queues.size;
};

describe("RateLimiter", () => {
  it("evicts idle queues after the ttl once their rate window has expired", async () => {
    vi.useFakeTimers();
    try {
      const limiter = new RateLimiter(5, 1_000);
      limiter.setDomainInterval("javdb.com", 3_000);

      await limiter.schedule("https://images.example.com/poster.jpg", async () => undefined);
      await limiter.schedule("https://javdb.com/a", async () => undefined);
      expect(getQueueCount(limiter)).toBe(2);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(getQueueCount(limiter)).toBe(1);
      const start = vi.fn(async () => undefined);
      const pending = limiter.schedule("https://javdb.com/b", start);
      await vi.advanceTimersByTimeAsync(1_999);
      expect(start).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await pending;
      expect(start).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(3_000);
      expect(getQueueCount(limiter)).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
