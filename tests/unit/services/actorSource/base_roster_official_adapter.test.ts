import { BaseRosterOfficialAdapter } from "@mdcz/runtime/actorSource/sources/official/BaseRosterOfficialAdapter";
import type { OfficialLookupRequest, OfficialLookupResult } from "@mdcz/runtime/actorSource/sources/official/types";
import { createAbortError } from "@mdcz/runtime/scrape/utils/abort";
import { afterEach, describe, expect, it, vi } from "vitest";

class TestRosterAdapter extends BaseRosterOfficialAdapter<string[]> {
  constructor(loadRoster: () => Promise<string[]>, setDomainLimit: ReturnType<typeof vi.fn>) {
    super(
      {
        networkClient: {
          setDomainLimit,
        },
      } as never,
      {
        key: "test-roster",
        rateLimitedHosts: ["studio.example.com", "images.example.com"],
      },
    );
    this.loadRoster = loadRoster;
  }

  private readonly loadRoster: () => Promise<string[]>;

  matchesHints(): boolean {
    return false;
  }

  async lookup(_query: OfficialLookupRequest): Promise<OfficialLookupResult | null> {
    const roster = await this.loadCachedRoster(this.loadRoster);
    return {
      profile: {
        name: roster[0] ?? "unknown",
      },
      sourceHints: [],
    };
  }
}

describe("BaseRosterOfficialAdapter", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("applies domain limits and reuses the cached roster within the same bucket", async () => {
    const setDomainLimit = vi.fn();
    const loadRoster = vi.fn(async () => ["Actor A"]);
    const adapter = new TestRosterAdapter(loadRoster, setDomainLimit);

    await adapter.lookup({
      queryNames: ["Actor A"],
      fallbackName: "Actor A",
    });
    await adapter.lookup({
      queryNames: ["Actor A"],
      fallbackName: "Actor A",
    });

    expect(setDomainLimit).toHaveBeenNthCalledWith(1, "studio.example.com", 1, 1);
    expect(setDomainLimit).toHaveBeenNthCalledWith(2, "images.example.com", 1, 1);
    expect(loadRoster).toHaveBeenCalledTimes(1);
  });

  it("clears the cached roster after the cache bucket rolls over", async () => {
    const nowSpy = vi.spyOn(Date, "now");
    const setDomainLimit = vi.fn();
    const loadRoster = vi.fn(async () => ["Actor A"]);
    const adapter = new TestRosterAdapter(loadRoster, setDomainLimit);

    nowSpy.mockReturnValue(0);
    await adapter.lookup({
      queryNames: ["Actor A"],
      fallbackName: "Actor A",
    });

    nowSpy.mockReturnValue(31 * 60 * 1000);
    await adapter.lookup({
      queryNames: ["Actor A"],
      fallbackName: "Actor A",
    });

    expect(loadRoster).toHaveBeenCalledTimes(2);

    nowSpy.mockReturnValue(29 * 60_000);
    const failure = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(["Recovered"]);
    const failingAdapter = new TestRosterAdapter(failure, setDomainLimit);
    const query = { queryNames: ["Actor A"], fallbackName: "Actor A" };
    await expect(failingAdapter.lookup(query)).rejects.toThrow("offline");
    await expect(failingAdapter.lookup(query)).rejects.toThrow("offline");
    expect(failure).toHaveBeenCalledTimes(1);
    nowSpy.mockReturnValue(30 * 60_000);
    await expect(failingAdapter.lookup(query)).resolves.toMatchObject({ profile: { name: "Recovered" } });
    expect(failure).toHaveBeenCalledTimes(2);

    nowSpy.mockReturnValue(31 * 60_000);
    const timedFailure = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(["Recovered"]);
    const timedAdapter = new TestRosterAdapter(timedFailure, setDomainLimit);
    await expect(timedAdapter.lookup(query)).rejects.toThrow("offline");
    nowSpy.mockReturnValue(35 * 60_000 + 59_999);
    await expect(timedAdapter.lookup(query)).rejects.toThrow("offline");
    expect(timedFailure).toHaveBeenCalledTimes(1);
    nowSpy.mockReturnValue(36 * 60_000);
    await expect(timedAdapter.lookup(query)).resolves.toMatchObject({ profile: { name: "Recovered" } });
    expect(timedFailure).toHaveBeenCalledTimes(2);

    const aborted = vi.fn().mockRejectedValueOnce(createAbortError()).mockResolvedValue(["Recovered"]);
    const abortedAdapter = new TestRosterAdapter(aborted, setDomainLimit);
    await expect(abortedAdapter.lookup(query)).rejects.toThrow("Operation aborted");
    await expect(abortedAdapter.lookup(query)).resolves.toMatchObject({ profile: { name: "Recovered" } });
    expect(aborted).toHaveBeenCalledTimes(2);

    let rejectOld!: (error: Error) => void;
    const oldRequest = new Promise<string[]>((_, reject) => {
      rejectOld = reject;
    });
    const racingLoad = vi.fn().mockReturnValueOnce(oldRequest).mockResolvedValue(["Fresh"]);
    const racingAdapter = new TestRosterAdapter(racingLoad, setDomainLimit);
    const stale = expect(racingAdapter.lookup(query)).rejects.toThrow("old failure");
    racingAdapter.clearCache();
    await expect(racingAdapter.lookup(query)).resolves.toMatchObject({ profile: { name: "Fresh" } });
    rejectOld(new Error("old failure"));
    await stale;
    await expect(racingAdapter.lookup(query)).resolves.toMatchObject({ profile: { name: "Fresh" } });
    expect(racingLoad).toHaveBeenCalledTimes(2);
  });
});
