import { CrawlerProvider, FetchGateway } from "@mdcz/runtime/crawler";
import type { CrawlerInput, CrawlerResponse } from "@mdcz/runtime/crawler/base/types";
import { getCrawlerExecutionSource, NetworkClient, runWithScrapeItem } from "@mdcz/runtime/network";
import { AggregationService } from "@mdcz/runtime/scrape";
import { noopRuntimeLogger } from "@mdcz/runtime/shared";
import { configurationSchema, defaultConfiguration } from "@mdcz/shared/config";
import { Website } from "@mdcz/shared/enums";
import type { FailureReason } from "@mdcz/shared/siteResults";
import type { CrawlerData } from "@mdcz/shared/types";
import { describe, expect, it, vi } from "vitest";

const makeCrawlerData = (overrides: Partial<CrawlerData> = {}): CrawlerData => ({
  title: "Test Title",
  number: "ABF-075",
  actors: ["Actor A"],
  genres: ["Genre A"],
  scene_images: [],
  website: Website.DMM,
  ...overrides,
});

const makeSiteResults = (...entries: ReadonlyArray<readonly [Website, Partial<CrawlerData>]>) =>
  new Map(entries.map(([website, overrides]) => [website, makeCrawlerData({ website, ...overrides })]));

const waitForDelay = async (delayMs: number, signal?: AbortSignal): Promise<void> => {
  if (delayMs <= 0) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);

    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };

    if (signal?.aborted) {
      onAbort();
      return;
    }

    signal?.addEventListener("abort", onAbort, { once: true });
  });
};

class MultiResultCrawlerProvider extends CrawlerProvider {
  private readonly siteResults: Map<Website, CrawlerData>;
  private readonly siteDelaysMs: Partial<Record<Website, number>>;
  private readonly siteFailures: Map<Website, { error: string; reason: FailureReason }>;
  readonly calledSites: Website[] = [];

  constructor(
    siteResults: Map<Website, CrawlerData>,
    siteDelaysMs: Partial<Record<Website, number>> = {},
    siteFailures: Map<Website, { error: string; reason: FailureReason }> = new Map(),
  ) {
    super({ fetchGateway: new FetchGateway(new NetworkClient()) });
    this.siteResults = siteResults;
    this.siteDelaysMs = siteDelaysMs;
    this.siteFailures = siteFailures;
  }

  override async crawl(input: CrawlerInput): Promise<CrawlerResponse> {
    this.calledSites.push(input.site);

    const delayMs = this.siteDelaysMs[input.site] ?? 0;
    await waitForDelay(delayMs, input.options?.signal);

    const failure = this.siteFailures.get(input.site);
    if (failure) {
      return {
        input,
        elapsedMs: 1,
        result: { success: false, error: failure.error, reason: failure.reason },
      };
    }

    const data = this.siteResults.get(input.site);
    if (!data) {
      return {
        input,
        elapsedMs: 1,
        result: { success: false, error: `No data for ${input.site}`, reason: "not_found" },
      };
    }

    return {
      input,
      elapsedMs: 1,
      result: { success: true, data },
    };
  }
}

class RecordingCrawlerProvider extends MultiResultCrawlerProvider {
  readonly calledNumbers: string[] = [];
  readonly calledInputs: CrawlerInput[] = [];

  override async crawl(input: CrawlerInput): Promise<CrawlerResponse> {
    this.calledNumbers.push(input.number);
    this.calledInputs.push(input);
    return super.crawl(input);
  }
}

describe("AggregationService", () => {
  type AggregationOverrides = Omit<Partial<typeof defaultConfiguration.aggregation>, "behavior" | "fieldPriorities"> & {
    behavior?: Partial<typeof defaultConfiguration.aggregation.behavior>;
    fieldPriorities?: Partial<typeof defaultConfiguration.aggregation.fieldPriorities>;
  };

  const makeConfig = (
    overrides: {
      scrape?: Partial<typeof defaultConfiguration.scrape>;
      aggregation?: AggregationOverrides;
      download?: Partial<typeof defaultConfiguration.download>;
    } & Record<string, unknown> = {},
  ) => {
    const { scrape, aggregation, download, ...rest } = overrides;
    return configurationSchema.parse({
      ...defaultConfiguration,
      scrape: {
        ...defaultConfiguration.scrape,
        sites: [Website.DMM, Website.JAVDB, Website.JAVBUS],
        ...scrape,
      },
      aggregation: {
        ...defaultConfiguration.aggregation,
        ...aggregation,
        behavior: { ...defaultConfiguration.aggregation.behavior, ...aggregation?.behavior },
        fieldPriorities: {
          ...defaultConfiguration.aggregation.fieldPriorities,
          ...aggregation?.fieldPriorities,
        },
      },
      download: { ...defaultConfiguration.download, ...download },
      ...rest,
    });
  };

  it("retries a site's missing numeric-prefixed number once without repeating successful sites or cached lookups", async () => {
    const crawl = vi.fn<CrawlerProvider["crawl"]>(async (input) => ({
      input,
      elapsedMs: 1,
      result:
        input.site === Website.DMM || input.number === "MIUM-123"
          ? {
              success: true,
              data: makeCrawlerData({
                number: input.number,
                website: input.site,
                thumb_url: "https://images.test/cover.jpg",
              }),
            }
          : { success: false, reason: "not_found", error: "No matching movie" },
    }));
    const service = new AggregationService(
      { crawl, getSiteHealth: () => undefined },
      { config: makeConfig({ scrape: { sites: [Website.DMM, Website.JAVDB], aiNumberFallback: false } }) },
    );
    const result = await service.aggregate("300MIUM-123");
    expect(crawl.mock.calls.map(([input]) => [input.site, input.number])).toEqual([
      [Website.DMM, "300MIUM-123"],
      [Website.JAVDB, "300MIUM-123"],
      [Website.JAVDB, "MIUM-123"],
    ]);
    expect(result.stats).toMatchObject({ totalSites: 2, successCount: 2, failedCount: 0 });
    expect(result.stats.siteResults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ site: Website.DMM, data: expect.objectContaining({ number: "300MIUM-123" }) }),
        expect.objectContaining({ site: Website.JAVDB, data: expect.objectContaining({ number: "MIUM-123" }) }),
      ]),
    );
    await service.aggregate("300MIUM-123");
    expect(crawl).toHaveBeenCalledTimes(3);
  });

  it("only strips leading numeric prefixes after an explicit miss and never retries a manual detail URL", async () => {
    const scenarios: Array<{ number: string; reason: FailureReason; retry?: string; detailUrl?: string }> = [
      { number: "300MIUM-123", reason: "not_found", retry: "MIUM-123" },
      { number: "390JNT-073", reason: "not_found", retry: "JNT-073" },
      { number: "ABC-123", reason: "not_found" },
      { number: "FC2-1234567", reason: "not_found" },
      { number: "T28-123", reason: "not_found" },
      { number: "100524_001", reason: "not_found" },
      { number: "1PON-100524_001", reason: "not_found" },
      { number: "1PON-123", reason: "not_found" },
      { number: "10MU-123", reason: "not_found" },
      { number: "300MIUM-123", reason: "not_found", detailUrl: "https://javdb.com/v/manual" },
      ...(
        ["timeout", "network_error", "rate_limited", "login_wall", "cloudflare", "parse_error", "ambiguous"] as const
      ).map((reason) => ({ number: "300MIUM-123", reason })),
    ];
    for (const { number, reason, retry, detailUrl } of scenarios) {
      const crawl = vi.fn<CrawlerProvider["crawl"]>(async (input) => ({
        input,
        elapsedMs: 1,
        result: { success: false, reason, error: "Lookup failed" },
      }));
      const service = new AggregationService(
        { crawl, getSiteHealth: () => undefined },
        { config: makeConfig({ scrape: { sites: [Website.JAVDB] }, network: { javdbCookie: "test-cookie" } }) },
      );
      await expect(
        service.aggregate(number, detailUrl ? { manualScrape: { site: Website.JAVDB, detailUrl } } : undefined),
      ).rejects.toMatchObject({ kind: reason === "ambiguous" ? "ambiguous" : "not_found" });
      expect(crawl.mock.calls.map(([input]) => input.number)).toEqual(retry ? [number, retry] : [number]);
    }
  });

  it("keeps search and detail identity checks strict when a real crawler retries the unprefixed query", async () => {
    for (const mode of ["original", "retry", "wrong_number", "missing"] as const) {
      const client = new NetworkClient();
      const getText = vi.spyOn(client, "getText").mockImplementation(async (url) => {
        const target = new URL(url);
        const query = target.searchParams.get("q");
        const foundNumber = mode === "original" ? "300MIUM-123" : "MIUM-123";
        if (target.pathname === "/search") {
          if (mode === "missing" || query !== foundNumber) return "<html>No results</html>";
          return `<a class="box" href="/v/movie"><div class="video-title"><strong>${foundNumber}</strong></div></a>`;
        }
        if (target.pathname === "/v/movie") {
          return `<h2 class="title is-4"><strong class="current-title">Title</strong></h2><a class="button is-white copy-to-clipboard" data-clipboard-text="${mode === "wrong_number" ? "MIUM-124" : foundNumber}"></a><img class="video-cover" src="https://images.test/cover.jpg" />`;
        }
        throw new Error(`Unexpected request: ${url}`);
      });
      const service = new AggregationService(new CrawlerProvider({ fetchGateway: new FetchGateway(client) }), {
        config: makeConfig({ scrape: { sites: [Website.JAVDB] } }),
      });
      if (mode === "wrong_number" || mode === "missing") {
        await expect(service.aggregate("300MIUM-123")).rejects.toMatchObject({ kind: "not_found" });
      } else {
        await expect(service.aggregate("300MIUM-123")).resolves.toMatchObject({
          data: { number: mode === "original" ? "300MIUM-123" : "MIUM-123" },
        });
      }
      expect(getText.mock.calls.map(([url]) => new URL(url).pathname + new URL(url).search)).toEqual(
        mode === "original"
          ? ["/search?q=300MIUM-123", "/v/movie"]
          : mode === "missing"
            ? ["/search?q=300MIUM-123", "/search?q=MIUM-123"]
            : ["/search?q=300MIUM-123", "/search?q=MIUM-123", "/v/movie"],
      );
      getText.mockRestore();
    }
  });

  it("shares the original site's timeout budget with its retry and stops on cancellation", async () => {
    for (const mode of ["timeout", "cancelled"] as const) {
      const controller = new AbortController();
      const crawl = vi.fn<CrawlerProvider["crawl"]>(async (input) => {
        if (mode === "cancelled") controller.abort();
        if (input.number === "MIUM-123") {
          await new Promise<void>((resolve) =>
            input.options?.signal?.addEventListener("abort", () => resolve(), { once: true }),
          );
          throw input.options?.signal?.reason;
        }
        return { input, elapsedMs: 1, result: { success: false, reason: "not_found", error: "No result" } };
      });
      const config = makeConfig({ scrape: { sites: [Website.JAVDB] } });
      config.aggregation.perCrawlerTimeoutMs = 10;
      const recorded: unknown[] = [];
      const service = new AggregationService(
        { crawl, getSiteHealth: () => undefined },
        {
          config,
          signal: controller.signal,
          recordSiteResults: (_number, results) => {
            recorded.push(...results);
          },
        },
      );
      await expect(service.aggregate("300MIUM-123")).rejects.toMatchObject(
        mode === "cancelled" ? { name: "AbortError" } : { kind: "not_found", canRetryNumber: false },
      );
      expect(crawl.mock.calls.map(([input]) => input.number)).toEqual(
        mode === "cancelled" ? ["300MIUM-123"] : ["300MIUM-123", "MIUM-123"],
      );
      if (mode === "timeout") expect(recorded).toContainEqual(expect.objectContaining({ reason: "timeout" }));
    }
  });

  it("isolates each concurrent crawler in its Website source context", async () => {
    const provider = new MultiResultCrawlerProvider(
      makeSiteResults(
        [Website.DMM, { thumb_url: "https://dmm.example/thumb.jpg" }],
        [Website.JAVDB, { thumb_url: "https://javdb.example/thumb.jpg" }],
      ),
    );
    const observed: Website[] = [];
    const lateObserved: Array<ReturnType<typeof getCrawlerExecutionSource>> = [];
    let releaseLateReads!: () => void;
    const lateGate = new Promise<void>((resolve) => {
      releaseLateReads = resolve;
    });
    const lateReads: Promise<void>[] = [];
    const originalCrawl = provider.crawl.bind(provider);
    provider.crawl = async (input) => {
      await Promise.resolve();
      const source = getCrawlerExecutionSource();
      if (source) observed.push(source.website);
      lateReads.push(
        lateGate.then(() => {
          lateObserved.push(getCrawlerExecutionSource());
        }),
      );
      return await originalCrawl(input);
    };
    const config = makeConfig({ scrape: { sites: [Website.DMM, Website.JAVDB] } });

    await runWithScrapeItem(
      { caseId: "movie-case", execution: {} },
      async () => await new AggregationService(provider, { config }).aggregate("ABF-075"),
    );
    releaseLateReads();
    await Promise.all(lateReads);

    expect(observed).toEqual(expect.arrayContaining([Website.DMM, Website.JAVDB]));
    expect(lateObserved).toEqual([undefined, undefined]);
    expect(getCrawlerExecutionSource()).toBeUndefined();
  });

  it("records DMM blocked failures and uses avwikidb only when it is enabled", async () => {
    const siteResults = makeSiteResults([
      Website.AVWIKIDB,
      {
        title: "AVWikiDB Title",
        actors: ["Actor From AVWikiDB"],
        thumb_url: "https://avwikidb.example/thumb.jpg",
      },
    ]);
    const siteFailures = new Map<Website, { error: string; reason: FailureReason }>([
      [Website.DMM, { error: "DMM region blocked", reason: "region_blocked" }],
    ]);
    const provider = new MultiResultCrawlerProvider(siteResults, {}, siteFailures);
    const config = makeConfig({
      scrape: { sites: [Website.DMM, Website.AVWIKIDB] },
    });

    const result = await new AggregationService(provider, { config }).aggregate("ABF-075");

    expect(provider.calledSites).toEqual([Website.DMM, Website.AVWIKIDB]);
    expect(result).not.toBeNull();
    expect(result?.data.title).toBe("AVWikiDB Title");
    expect(result?.sources.title).toBe(Website.AVWIKIDB);
    expect(result?.stats.siteResults.find((siteResult) => siteResult.site === Website.DMM)?.reason).toBe(
      "region_blocked",
    );
  });

  it("tries sites of the other content type only when every admitted site misses", async () => {
    const config = makeConfig({ network: { ...defaultConfiguration.network, javdbCookie: "_jdb_session=ok" } });
    const thumb_url = "https://example.com/thumb.jpg";

    // A censored release whose number looks like an uncensored date sequence.
    const misclassified = new MultiResultCrawlerProvider(makeSiteResults([Website.DMM, { thumb_url }]));
    const fallback = await new AggregationService(misclassified, { config }).aggregate("100524_001");
    expect(misclassified.calledSites).toEqual([Website.JAVDB, Website.JAVBUS, Website.DMM]);
    expect(fallback.sources.title).toBe(Website.DMM);

    const uncensored = new MultiResultCrawlerProvider(makeSiteResults([Website.JAVBUS, { thumb_url }]));
    const found = await new AggregationService(uncensored, { config }).aggregate("100524_001");
    expect(uncensored.calledSites).toEqual([Website.JAVDB, Website.JAVBUS]);
    expect(found.stats.siteResults).toContainEqual({
      site: Website.DMM,
      status: "skipped",
      skipReason: "content_type",
      elapsedMs: 0,
    });
  });

  it("marks crawler budget overruns as timeout failures", async () => {
    const siteResults = makeSiteResults(
      [Website.DMM, { title: "Slow DMM Title", thumb_url: "https://dmm.example/thumb.jpg" }],
      [Website.JAVDB, { title: "Fast JAVDB Title", thumb_url: "https://javdb.example/thumb.jpg" }],
    );
    const provider = new MultiResultCrawlerProvider(siteResults, { [Website.DMM]: 30 });
    const config = makeConfig({
      scrape: { sites: [Website.DMM, Website.JAVDB] },
    });
    config.aggregation.maxParallelCrawlers = 2;
    config.aggregation.perCrawlerTimeoutMs = 5;
    config.aggregation.globalTimeoutMs = 1_000;

    const result = await new AggregationService(provider, { config }).aggregate("ABF-075");

    const dmmResult = result?.stats.siteResults.find((siteResult) => siteResult.site === Website.DMM);
    expect(dmmResult?.status).toBe("failed");
    expect(dmmResult?.detail).toContain("超出抓取时限");
    expect(dmmResult?.reason).toBe("timeout");
  });

  it("uses configured durationSeconds priority instead of completion order", async () => {
    const siteResults = makeSiteResults(
      [Website.AVBASE, { title: undefined, durationSeconds: 8_100, thumb_url: undefined }],
      [Website.DMM_TV, { durationSeconds: 7_200, thumb_url: "https://dmmtv.example/thumb.jpg" }],
    );

    const provider = new MultiResultCrawlerProvider(siteResults, {
      [Website.AVBASE]: 0,
      [Website.DMM_TV]: 30,
    });
    const config = makeConfig({
      scrape: {
        sites: [Website.AVBASE, Website.DMM_TV],
      },
      aggregation: {
        fieldPriorities: {
          durationSeconds: [Website.DMM_TV, Website.AVBASE],
        },
      },
    });

    const result = await new AggregationService(provider, { config }).aggregate("ABF-075");

    expect(result).not.toBeNull();
    expect(result?.data.durationSeconds).toBe(7_200);
    expect(result?.sources.durationSeconds).toBe(Website.DMM_TV);
  });

  it("prefers FC2HUB ahead of JAVDB for FC2 family metadata under the default priorities", async () => {
    const siteResults = makeSiteResults(
      [
        Website.FC2HUB,
        {
          title: "FC2HUB Title",
          number: "FC2-4515706",
          thumb_url: "https://fc2hub.example/thumb.jpg",
          studio: "Seller FC2HUB",
          publisher: "Seller FC2HUB",
          durationSeconds: 8_068,
          rating: 4.7,
        },
      ],
      [
        Website.JAVDB,
        {
          title: "JAVDB Title",
          number: "FC2-4515706",
          thumb_url: "https://javdb.example/thumb.jpg",
          studio: "Seller JAVDB",
          publisher: "Publisher JAVDB",
          durationSeconds: 7_200,
          rating: 4.1,
        },
      ],
    );

    const config = makeConfig({
      scrape: {
        sites: [Website.FC2HUB, Website.JAVDB],
      },
    });

    const result = await new AggregationService(new MultiResultCrawlerProvider(siteResults), { config }).aggregate(
      "FC2-4515706",
    );

    expect(result).not.toBeNull();
    expect(result?.data.title).toBe("FC2HUB Title");
    expect(result?.data.studio).toBe("Seller FC2HUB");
    expect(result?.data.publisher).toBe("Seller FC2HUB");
    expect(result?.data.durationSeconds).toBe(8_068);
    expect(result?.data.rating).toBe(4.7);
    expect(result?.sources.title).toBe(Website.FC2HUB);
    expect(result?.sources.studio).toBe(Website.FC2HUB);
    expect(result?.sources.publisher).toBe(Website.FC2HUB);
    expect(result?.sources.durationSeconds).toBe(Website.FC2HUB);
    expect(result?.sources.rating).toBe(Website.FC2HUB);
  });

  it("keeps official FC2 seller metadata ahead of FC2HUB seller fallback", async () => {
    const siteResults = makeSiteResults(
      [
        Website.FC2,
        {
          title: "Official FC2 Title",
          number: "FC2-2896877",
          actors: [],
          thumb_url: "https://fc2.example/thumb.jpg",
          studio: "趣味はめ",
          publisher: "趣味はめ",
        },
      ],
      [
        Website.FC2HUB,
        {
          title: "FC2HUB Title",
          number: "FC2-2896877",
          actors: [],
          thumb_url: "https://fc2hub.example/thumb.jpg",
          studio: "アビス",
          publisher: "アビス",
        },
      ],
    );

    const config = makeConfig({
      scrape: {
        sites: [Website.FC2, Website.FC2HUB],
      },
    });

    const result = await new AggregationService(new MultiResultCrawlerProvider(siteResults), { config }).aggregate(
      "FC2-2896877",
    );

    expect(result).not.toBeNull();
    expect(result?.data.title).toBe("FC2HUB Title");
    expect(result?.data.studio).toBe("趣味はめ");
    expect(result?.data.publisher).toBe("趣味はめ");
    expect(result?.sources.title).toBe(Website.FC2HUB);
    expect(result?.sources.studio).toBe(Website.FC2);
    expect(result?.sources.publisher).toBe(Website.FC2);
  });

  it("applies field priorities independently across DMM sources", async () => {
    const siteResults = makeSiteResults(
      [
        Website.DMM,
        {
          title: "DMM Title",
          plot: "DMM Plot",
          genres: ["DMM Genre"],
          studio: "DMM Studio",
          durationSeconds: 7_200,
          rating: 4.6,
          trailer_url: "https://dmm.example.com/trailer.mp4",
          thumb_url: "https://awsimgsrc.dmm.co.jp/dmm.jpg",
        },
      ],
      [
        Website.DMM_TV,
        {
          title: "DMM TV Title",
          genres: ["DMM TV Genre 1", "DMM TV Genre 2"],
          studio: "DMM TV Studio",
          durationSeconds: 5_400,
          rating: 3.2,
          trailer_url: "https://video.example.com/trailer.mp4",
          thumb_url: "https://video.example.com/thumb.jpg",
        },
      ],
    );

    const config = makeConfig({
      scrape: { sites: [Website.DMM, Website.DMM_TV] },
      aggregation: {
        fieldPriorities: {
          title: [Website.DMM_TV, Website.DMM],
          genres: [Website.DMM, Website.DMM_TV],
          studio: [Website.DMM, Website.DMM_TV],
          durationSeconds: [Website.DMM, Website.DMM_TV],
          rating: [Website.DMM, Website.DMM_TV],
          trailer_url: [Website.DMM, Website.DMM_TV],
        },
      },
    });

    const messages: string[] = [];
    const service = new AggregationService(new MultiResultCrawlerProvider(siteResults), {
      config,
      logger: { ...noopRuntimeLogger, info: (message) => messages.push(message) },
    });
    const result = await service.aggregate("ABF-075");

    expect(result?.data.title).toBe("DMM TV Title");
    expect(result?.data.genres).toEqual(["DMM Genre"]);
    expect(result?.data.studio).toBe("DMM Studio");
    expect(result?.data.durationSeconds).toBe(7_200);
    expect(result?.data.rating).toBe(4.6);
    expect(result?.data.trailer_url).toBe("https://dmm.example.com/trailer.mp4");
    expect(result?.sources.title).toBe(Website.DMM_TV);
    expect(result?.sources.genres).toBe(Website.DMM);
    expect(result?.sources.studio).toBe(Website.DMM);
    expect(result?.sources.durationSeconds).toBe(Website.DMM);
    expect(result?.sources.rating).toBe(Website.DMM);
    expect(result?.sources.trailer_url).toBe(Website.DMM);
    await service.aggregate("ABF-075");
    const sourceLogs = messages
      .filter((message) => message.startsWith("[metadata-sources] "))
      .map((message) => JSON.parse(message.slice("[metadata-sources] ".length)));
    expect(sourceLogs).toEqual([
      {
        number: "ABF-075",
        fields: {
          title: { source: Website.DMM_TV },
          plot: { source: Website.DMM },
          thumb_url: { source: Website.DMM },
          poster_url: { source: "absent" },
          scene_images: { source: "absent" },
        },
      },
      sourceLogs[0],
    ]);
  });

  it("uses PPVDATABANK as an FC2 fallback when higher-priority sources miss seller and image fields", async () => {
    const siteResults = makeSiteResults(
      [
        Website.FC2HUB,
        {
          title: "FC2HUB Title",
          number: "FC2-4663355",
          thumb_url: undefined,
          poster_url: undefined,
          studio: undefined,
          publisher: undefined,
          release_date: undefined,
          durationSeconds: undefined,
        },
      ],
      [
        Website.PPVDATABANK,
        {
          title: "PPVDATABANK Title",
          number: "FC2-4663355",
          thumb_url: "https://ppvdatabank.example/thumb.webp",
          poster_url: "https://ppvdatabank.example/thumb.webp",
          scene_images: ["https://ppvdatabank.example/pl1.webp"],
          studio: "ゆず故障",
          publisher: "ゆず故障",
          release_date: "2025-04-03",
          durationSeconds: 3_080,
        },
      ],
    );

    const config = makeConfig({
      scrape: {
        sites: [Website.FC2HUB, Website.PPVDATABANK],
      },
    });

    const result = await new AggregationService(new MultiResultCrawlerProvider(siteResults), { config }).aggregate(
      "FC2-4663355",
    );

    expect(result).not.toBeNull();
    expect(result?.data.title).toBe("FC2HUB Title");
    expect(result?.data.studio).toBe("ゆず故障");
    expect(result?.data.publisher).toBe("ゆず故障");
    expect(result?.data.release_date).toBe("2025-04-03");
    expect(result?.data.durationSeconds).toBe(3_080);
    expect(result?.data.thumb_url).toBe("https://ppvdatabank.example/thumb.webp");
    expect(result?.data.poster_url).toBe("https://ppvdatabank.example/thumb.webp");
    expect(result?.data.scene_images).toEqual(["https://ppvdatabank.example/pl1.webp"]);
    expect(result?.sources.title).toBe(Website.FC2HUB);
    expect(result?.sources.studio).toBe(Website.PPVDATABANK);
    expect(result?.sources.publisher).toBe(Website.PPVDATABANK);
    expect(result?.sources.release_date).toBe(Website.PPVDATABANK);
    expect(result?.sources.durationSeconds).toBe(Website.PPVDATABANK);
    expect(result?.sources.thumb_url).toBe(Website.PPVDATABANK);
    expect(result?.sources.poster_url).toBe(Website.PPVDATABANK);
    expect(result?.sources.scene_images).toBe(Website.PPVDATABANK);
  });

  it("throws when no result clears the aggregation threshold", async () => {
    const cases = [
      {
        provider: new MultiResultCrawlerProvider(new Map<Website, CrawlerData>()),
        config: makeConfig(),
      },
      {
        provider: new MultiResultCrawlerProvider(
          makeSiteResults([Website.DMM, { title: "Has title", thumb_url: undefined, poster_url: undefined }]),
        ),
        config: makeConfig(),
      },
    ];

    for (const { provider, config } of cases) {
      await expect(new AggregationService(provider, { config }).aggregate("ABF-075")).rejects.toThrow();
    }
  });

  it("coalesces in-flight requests and does not cache failures", async () => {
    const siteResults = makeSiteResults([Website.DMM, { thumb_url: "https://example.com/thumb.jpg" }]);
    const config = makeConfig({ scrape: { sites: [Website.DMM] } });
    const provider = new MultiResultCrawlerProvider(siteResults, { [Website.DMM]: 20 });
    const service = new AggregationService(provider, { config });

    const [first, second] = await Promise.all([service.aggregate("ABF-075"), service.aggregate("ABF-075")]);

    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(provider.calledSites.length).toBe(1);

    const failingProvider = new MultiResultCrawlerProvider(new Map());
    const failingService = new AggregationService(failingProvider, { config });
    await expect(failingService.aggregate("ABF-075")).rejects.toThrow();
    expect(failingProvider.calledSites.length).toBe(1);
    await expect(failingService.aggregate("ABF-075")).rejects.toThrow();
    expect(failingProvider.calledSites.length).toBe(2);
  });

  it("reuses successful results for the life of the service", async () => {
    const siteResults = makeSiteResults([Website.DMM, { thumb_url: "https://example.com/thumb.jpg" }]);
    const provider = new MultiResultCrawlerProvider(siteResults);
    const service = new AggregationService(provider, { config: makeConfig() });

    const first = await service.aggregate("ABF-075");
    const firstCallCount = provider.calledSites.length;
    first.data.title = "mutated";
    const second = await service.aggregate("ABF-075");

    expect(second.data.title).not.toBe("mutated");
    expect(provider.calledSites.length).toBe(firstCallCount);
  });

  it("keeps a shared in-flight lookup when one waiter aborts", async () => {
    const siteResults = makeSiteResults([Website.DMM, { thumb_url: "https://example.com/thumb.jpg" }]);
    const config = makeConfig({ scrape: { sites: [Website.DMM] } });
    const provider = new MultiResultCrawlerProvider(siteResults, { [Website.DMM]: 40 });
    const service = new AggregationService(provider, { config });
    const waiter = new AbortController();

    const first = service.aggregate("ABF-075", { signal: waiter.signal });
    const second = service.aggregate("ABF-075");
    await Promise.resolve();
    waiter.abort();

    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    await expect(second).resolves.toMatchObject({ data: { number: "ABF-075" } });
    expect(provider.calledSites.length).toBe(1);
  });

  it("stops launching lower-priority sites once minimum threshold is satisfied", async () => {
    const siteResults = makeSiteResults(
      [Website.DMM, { title: "Fast DMM Title", thumb_url: "https://thumb.jpg" }],
      [Website.JAVDB, { title: "Slower JAVDB Title", thumb_url: "https://javdb-thumb.jpg" }],
    );

    const config = makeConfig({
      aggregation: { maxParallelCrawlers: 1 },
      download: { downloadSceneImages: false, generateNfo: false },
    });

    const provider = new MultiResultCrawlerProvider(siteResults);
    await new AggregationService(provider, { config }).aggregate("ABF-075");

    expect(provider.calledSites).toEqual([Website.DMM]);
  });

  it("forces manual URL scrapes to the selected site only", async () => {
    const siteResults = makeSiteResults(
      [Website.DMM, { title: "DMM Title" }],
      [Website.DMM_TV, { title: "DMM TV Title", thumb_url: "https://video.example/thumb.jpg" }],
      [Website.JAVDB, { title: "JAVDB Title" }],
    );
    const provider = new RecordingCrawlerProvider(siteResults);
    const config = makeConfig({
      scrape: { sites: [Website.DMM, Website.DMM_TV, Website.JAVDB] },
    });

    const result = await new AggregationService(provider, { config }).aggregate("ABF-075", {
      manualScrape: { site: Website.DMM_TV },
    });

    expect(result?.data.website).toBe(Website.DMM_TV);
    expect(provider.calledSites).toEqual([Website.DMM_TV]);
    expect(provider.calledInputs[0]?.options?.detailUrl).toBeUndefined();
  });

  it("passes manual detail URLs to the forced crawler", async () => {
    const detailUrl = "https://video.dmm.co.jp/av/content/?id=1abf00075";
    const siteResults = makeSiteResults([
      Website.DMM_TV,
      { title: "DMM TV Title", thumb_url: "https://video.example/thumb.jpg" },
    ]);
    const provider = new RecordingCrawlerProvider(siteResults);

    await new AggregationService(provider, { config: makeConfig() }).aggregate("ABF-075", {
      manualScrape: { site: Website.DMM_TV, detailUrl },
    });

    expect(provider.calledSites).toEqual([Website.DMM_TV]);
    expect(provider.calledInputs[0]?.options?.detailUrl).toBe(detailUrl);
  });

  it("does not crawl Fantia without its required cookie", async () => {
    const provider = new RecordingCrawlerProvider(
      makeSiteResults([Website.DMM, { title: "DMM Title", thumb_url: "https://dmm.example/thumb.jpg" }]),
    );
    const config = makeConfig({
      scrape: { sites: [Website.FANTIA, Website.DMM] },
      network: { fantiaCookie: "" },
    });

    const result = await new AggregationService(provider, { config }).aggregate("ABF-075");

    expect(provider.calledSites).toEqual([Website.DMM]);
    expect(result?.stats.failedCount).toBe(0);
    expect(result?.stats.siteResults).toContainEqual({
      site: Website.FANTIA,
      status: "skipped",
      skipReason: "missing_credential",
      elapsedMs: 0,
    });
  });
});
