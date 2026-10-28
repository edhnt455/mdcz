import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createMediaRoot } from "@mdcz/media-store";
import { FetchGateway } from "@mdcz/runtime/crawler";
import { toCrawlerErrorResult } from "@mdcz/runtime/crawler/base/BaseCrawler";
import { type RuntimeNetworkClient, SiteError } from "@mdcz/runtime/network";
import { AggregationService, type CrawlerPort } from "@mdcz/runtime/scrape/aggregation";
import { DirectoryInventory } from "@mdcz/runtime/scrape/DirectoryInventory";
import { findSubtitleSidecars } from "@mdcz/runtime/scrape/media/subtitleSidecars";
import { admitScrapeGroups } from "@mdcz/runtime/scrape/movieGroups";
import { NumberRecognitionService } from "@mdcz/runtime/scrape/NumberRecognitionService";
import { createScrapeNumberResolver } from "@mdcz/runtime/scrape/resolveScrapeNumbers";
import { ScrapeFailureError } from "@mdcz/runtime/scrape/scrapeFailure";
import type { LlmApiClient } from "@mdcz/runtime/scrape/translate/engines/LlmApiClient";
import { LlmRequestService } from "@mdcz/runtime/scrape/translate/engines/LlmRequestService";
import { configurationSchema, defaultConfiguration } from "@mdcz/shared/config";
import { Website } from "@mdcz/shared/enums";
import type { NumberRecognitionResult } from "@mdcz/shared/pending";
import type { FailureReason } from "@mdcz/shared/siteResults";
import type { CrawlerData } from "@mdcz/shared/types";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createTempDirectory } from "../../../harness/tempDirectory";

const logger = { info: vi.fn(), warn: vi.fn() };
const recognitionResult = (overrides: Partial<NumberRecognitionResult> = {}): NumberRecognitionResult => ({
  status: "recognized",
  number: "ABC-123",
  evidence: "ABC-123",
  previousNumber: "ZZZ-999",
  fileName: "ZZZ-999.mp4",
  parentDirectory: "ABC-123",
  model: "test-model",
  prompt: "test-prompt",
  systemPrompt: "",
  rawResponse: '{"number":"ABC-123","evidence":"ABC-123"}',
  error: null,
  elapsedMs: 1,
  ...overrides,
});
const config = configurationSchema.parse({
  scrape: { aiNumberFallback: true, sites: [Website.JAVBUS, Website.JAV321], threadNumber: 2 },
  translate: { enableTranslation: false, engine: "google", llmApiKey: "test-key", llmMaxRequestsPerSecond: 100 },
});
const data = (number: string): CrawlerData => ({
  number,
  title: "Movie",
  actors: [],
  genres: [],
  scene_images: [],
  thumb_url: "https://images.test/cover.jpg",
});
type Outcome = FailureReason | "found" | "partial" | "unsupported" | "http_404";
const createAggregation = (outcomes: readonly Outcome[]) => {
  const gateway = new FetchGateway({
    getText: vi.fn(async (url: string) => {
      const site = url.includes(Website.JAV321) ? 1 : 0;
      const outcome = outcomes[site] ?? outcomes[0];
      if (outcome === "http_404") throw new SiteError("not_found", "HTTP 404", { httpStatus: 404 });
      if (!["found", "partial", "not_found", "parse_error", "ambiguous"].includes(outcome))
        throw new SiteError(outcome as FailureReason, outcome);
      return "<html>Normal search response</html>";
    }),
  } as unknown as RuntimeNetworkClient);
  const crawl = vi.fn<CrawlerPort["crawl"]>(async (input) => {
    const outcome = outcomes[input.site === Website.JAV321 ? 1 : 0] ?? outcomes[0];
    try {
      if (outcome !== "unsupported") await gateway.fetchHtml(`https://${input.site}.test/search`);
      if (outcome === "found" || outcome === "partial")
        return {
          input,
          elapsedMs: 1,
          result: {
            success: true,
            data: {
              ...data(input.number),
              thumb_url: outcome === "partial" ? undefined : data(input.number).thumb_url,
            },
          },
        };
      return {
        input,
        elapsedMs: 1,
        result: {
          success: false,
          reason: outcome === "unsupported" ? "not_found" : (outcome as FailureReason),
          error: outcome,
        },
      };
    } catch (error) {
      return { input, elapsedMs: 1, result: toCrawlerErrorResult(error) };
    }
  });
  const service = new AggregationService({ crawl, getSiteHealth: () => undefined }, { config });
  return { service, crawl };
};

const createInput = async (names: string[], finish: (cleanup: () => Promise<void>) => void) => {
  const temp = await createTempDirectory("number-fallback");
  finish(temp.cleanup);
  const directory = join(temp.path, "ABC-123");
  await mkdir(directory);
  for (const name of names) await writeFile(join(directory, name), "video");
  const root = createMediaRoot({ id: "source", hostPath: directory, displayName: "Source" });
  const inventory = new DirectoryInventory();
  const groups = await admitScrapeGroups({
    refs: names.map((relativePath) => ({ rootId: root.id, relativePath })),
    resolveRoot: async () => root,
    inventory,
    configuration: config,
    expandParts: false,
  });
  return { groups, inventory, directory, root, configuration: structuredClone(config), logger };
};

describe("AI movie code fallback", () => {
  it.each([
    [["not_found", "not_found"], true],
    [["not_found", "timeout"], true],
    [["timeout", "network_error"], false],
    [["login_wall", "cloudflare"], false],
    [["http_error", "rate_limited"], false],
    [["http_404", "http_404"], false],
    [["unsupported", "parse_error"], false],
    [["not_found", "found"], false],
    [["not_found", "partial"], false],
    [["not_found", "ambiguous"], false],
  ] as const)("requires a real successful query with no movie (%j)", async (outcomes, shouldRecognize) => {
    const input = await createInput(["ZZZ-999.mp4"], onTestFinished);
    const { service, crawl } = createAggregation(outcomes);
    const recognize = vi.fn(async () => recognitionResult());
    const resolver = createScrapeNumberResolver({
      ...input,
      aggregationService: service,
      recognitionService: { recognize },
    });
    const groups = await resolver.resolveGroups(input.groups);
    expect(recognize).toHaveBeenCalledTimes(shouldRecognize ? 1 : 0);
    expect(groups[0].members[0].fileInfo.number).toBe(shouldRecognize ? "ABC-123" : "ZZZ-999");
    expect(groups[0].members[0].numberRecognition).toMatchObject(
      shouldRecognize
        ? { status: "recognized", number: "ABC-123", trigger: "automatic" }
        : {
            status: "skipped",
            reason: outcomes.some((outcome) => outcome === "found") ? "found" : "lookup_ineligible",
          },
    );
    await resolver.aggregationService.aggregate("ZZZ-999").catch(() => undefined);
    expect(crawl).toHaveBeenCalledTimes(2);
  });

  it("fills missing numbers, rebuilds multipart groups and shares the resolved number with subtitles", async ({
    onTestFinished,
  }) => {
    const input = await createInput(["recording-CD1.mp4", "recording-CD2.mp4"], onTestFinished);
    await writeFile(join(input.directory, "recording-CD1.zh.srt"), "subtitles");
    input.inventory = new DirectoryInventory();
    const aggregate = vi.fn(
      async (number: string) => ({ data: data(number) }) as Awaited<ReturnType<AggregationService["aggregate"]>>,
    );
    const recognize = vi.fn(async () => recognitionResult({ previousNumber: null }));
    const resolver = createScrapeNumberResolver({
      ...input,
      aggregationService: { aggregate },
      recognitionService: { recognize },
    });
    const groups = await resolver.resolveGroups(input.groups);
    expect(aggregate).not.toHaveBeenCalled();
    expect(recognize).toHaveBeenCalledTimes(2);
    expect(groups).toHaveLength(1);
    expect(groups[0].members.map((member) => member.fileInfo.part?.number)).toEqual([1, 2]);
    expect(
      (await findSubtitleSidecars(join(input.directory, "recording-CD1.mp4"), input.inventory, config.scrape)).map(
        (entry) => entry.path,
      ),
    ).toEqual([join(input.directory, "recording-CD1.zh.srt")]);
    await Promise.all([
      resolver.aggregationService.aggregate("ABC-123"),
      resolver.aggregationService.aggregate("ABC-123"),
    ]);
    expect(aggregate).toHaveBeenCalledOnce();
  });

  it.each([
    "disabled",
    "manual_number",
    "mapping",
    "manual_url",
    "source_pin",
  ] as const)("preserves explicit choices and disabled behavior (%s)", async (mode) => {
    const input = await createInput(["ZZZ-999.mp4"], onTestFinished);
    if (mode === "disabled") input.configuration.scrape.aiNumberFallback = false;
    if (mode === "mapping") input.configuration.scrape.numberMappings = { "ZZZ-999": "XYZ-789" };
    if (mode === "manual_number" || mode === "mapping")
      input.groups = await admitScrapeGroups({
        refs: [
          {
            rootId: input.root.id,
            relativePath: "ZZZ-999.mp4",
            number: mode === "manual_number" ? "XYZ-789" : undefined,
          },
        ],
        resolveRoot: async () => input.root,
        inventory: input.inventory,
        configuration: input.configuration,
        expandParts: false,
      });
    if (mode === "manual_url")
      input.groups[0].members[0].manualScrape = { site: Website.JAVBUS, detailUrl: "https://www.javbus.com/ZZZ-999" };
    if (mode === "source_pin") input.inventory = new DirectoryInventory();
    if (mode === "source_pin")
      vi.spyOn(input.inventory, "loadNfo").mockResolvedValue({
        localState: { sourcePin: { site: Website.JAVBUS, url: "https://www.javbus.com/ZZZ-999" } },
      } as Awaited<ReturnType<DirectoryInventory["loadNfo"]>>);
    if (mode === "source_pin") await writeFile(join(input.directory, "ZZZ-999.nfo"), "nfo");
    const aggregate = vi.fn();
    const recognize = vi.fn();
    const resolver = createScrapeNumberResolver({
      ...input,
      aggregationService: { aggregate },
      recognitionService: { recognize },
    });
    const resolved = await resolver.resolveGroups(input.groups);
    expect(aggregate).not.toHaveBeenCalled();
    expect(recognize).not.toHaveBeenCalled();
    expect(resolved[0].members[0].numberRecognition).toEqual({
      status: "skipped",
      reason: mode === "mapping" ? "manual_number" : mode,
    });
  });

  it.each([
    "same",
    "empty",
    "failed",
    "cancelled",
  ] as const)("does not loop or discard the original failure (%s)", async (mode) => {
    const input = await createInput(["ZZZ-999.mp4"], onTestFinished);
    const controller = new AbortController();
    const failure = new ScrapeFailureError("not_found", "Normal search found no movie", [], true);
    const aggregate = vi.fn().mockRejectedValue(failure);
    const recognize = vi.fn(async () => {
      if (mode === "cancelled") controller.abort();
      return recognitionResult({
        status: mode === "failed" ? "failed" : mode === "empty" ? "no_number" : "unchanged",
        number: mode === "empty" || mode === "failed" ? null : "ZZZ-999",
        error: mode === "failed" ? "AI timed out" : null,
      });
    });
    const resolver = createScrapeNumberResolver({
      ...input,
      aggregationService: { aggregate },
      recognitionService: { recognize },
    });
    const resolving = resolver.resolveGroups(input.groups, controller.signal);
    if (mode === "cancelled") {
      await expect(resolving).rejects.toMatchObject({ name: "AbortError" });
    } else {
      const groups = await resolving;
      expect(groups[0].members[0].fileInfo.number).toBe("ZZZ-999");
      expect(groups[0].members[0].numberRecognition).toMatchObject({
        status: mode === "failed" ? "failed" : mode === "empty" ? "no_number" : "unchanged",
      });
      await expect(resolver.aggregationService.aggregate("ZZZ-999")).rejects.toBe(failure);
    }
    expect(recognize).toHaveBeenCalledOnce();
    expect(aggregate).toHaveBeenCalledOnce();
  });

  it.each([
    ["ABC-123", "ABC-123", true],
    ["ABC-123", "abc00123", true],
    ["FC2-1234567", "FC2 PPV 1234567", true],
    ["XYZ-789", "ABC-123", false],
    ["ABC-123", "invented evidence", false],
    ["../../ABC-123", "ABC-123", false],
    [null, null, true],
  ])("accepts only source-grounded structured model output (%s / %s)", async (number, evidence, valid) => {
    const generateText = vi.fn<LlmApiClient["generateText"]>(async () => JSON.stringify({ number, evidence }));
    const requests = new LlmRequestService(logger, { generateText } as unknown as LlmApiClient);
    const service = new NumberRecognitionService(requests);
    const result = service.recognize(
      `/private/absolute/path/ABC-123/${evidence === "invented evidence" ? "recording" : (evidence ?? "recording")}.mp4`,
      "",
      {
        ...config,
        translate: {
          ...config.translate,
          llmSystemPrompt: "Shared context",
          llmNumberRecognitionPrompt: "Custom number extraction instructions",
        },
      },
    );
    await expect(result).resolves.toMatchObject({
      status: valid ? (number === null ? "no_number" : "recognized") : "failed",
      number: typeof number === "string" ? number.toUpperCase() : null,
      evidence,
      rawResponse: JSON.stringify({ number, evidence }),
      previousNumber: null,
      parentDirectory: "ABC-123",
      systemPrompt: "Shared context",
      error: valid ? null : expect.stringContaining("valid source evidence"),
    });
    const request = generateText.mock.calls[0]?.[0];
    expect(request.systemPrompt).toBe("Shared context");
    expect(request.model).toBe(config.translate.llmModelName);
    expect(request.prompt).toContain("Custom number extraction instructions");
    expect(request.prompt).toContain('"evidence"');
    expect(request.prompt).not.toContain("/private/absolute/path");
    expect(request.prompt).not.toContain(defaultConfiguration.translate.llmPrompt);
  });

  it("records request and decoding failures while propagating cancellation", async () => {
    for (const mode of ["invalid_json", "invalid_schema", "request_error", "missing_config", "cancelled"] as const) {
      const controller = new AbortController();
      const rawResponse = mode === "invalid_json" ? "not JSON" : '{"number":123,"evidence":"ABC-123"}';
      const generateText = vi.fn<LlmApiClient["generateText"]>(async () => {
        if (mode === "cancelled") controller.abort();
        if (mode === "request_error") throw new Error("Request rejected");
        return rawResponse;
      });
      const service = new NumberRecognitionService(
        new LlmRequestService(logger, { generateText } as unknown as LlmApiClient),
      );
      const result = service.recognize(
        "/media/ABC-123/recording.mp4",
        "",
        {
          ...config,
          translate: { ...config.translate, llmModelName: mode === "missing_config" ? "" : "test-model" },
        },
        controller.signal,
      );
      if (mode === "cancelled") {
        await expect(result).rejects.toMatchObject({ name: "AbortError" });
        continue;
      }
      await expect(result).resolves.toMatchObject({
        status: "failed",
        number: null,
        error: expect.any(String),
        rawResponse: mode === "request_error" || mode === "missing_config" ? null : rawResponse,
        fileName: "recording.mp4",
        parentDirectory: "ABC-123",
      });
      expect(generateText).toHaveBeenCalledTimes(mode === "missing_config" ? 0 : 1);
    }
  });
});
