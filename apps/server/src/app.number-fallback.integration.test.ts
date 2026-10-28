import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { NetworkClient } from "@mdcz/runtime/network";
import { ScrapeFailureError } from "@mdcz/runtime/scrape/scrapeFailure";
import { LlmRequestService } from "@mdcz/runtime/scrape/translate/engines/LlmRequestService";
import { defaultConfiguration } from "@mdcz/shared/config";
import { TranslateEngine, Website } from "@mdcz/shared/enums";
import { pendingDetailResponseSchema } from "@mdcz/shared/pending";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import {
  closeTestServers,
  createTempRoot,
  createTestAggregation,
  createTestLibrary,
  createTestServer,
  loginAsAdmin,
  waitForScrapeRunStatus,
} from "./app.testSupport";

afterEach(closeTestServers);

it.each([
  "missing",
  "miss",
  "still_missing",
  "unknown",
  "unchanged",
  "invalid_output",
  "request_failed",
  "disabled",
] as const)("publishes recovered metadata or leaves a manually repairable entry (%s)", async (scenario) => {
  const root = await createTempRoot("ai-number-fallback");
  const source = join(root, "ABC-123");
  await mkdir(source);
  const original =
    scenario === "missing" || scenario === "unknown" ? "recording" : scenario === "miss" ? "049-PROB" : "ZZZ-999";
  const recoveredNumber = scenario === "miss" ? "MIDV-049" : "ABC-123";
  const fileName = scenario === "miss" ? "www.98T.la@1midv049.restored_prob4.strm" : `${original}.mp4`;
  await writeFile(join(source, fileName), "video");
  const inner = createTestAggregation("https://unused.test/cover.jpg");
  const aggregate = vi.fn(async (number: string) => {
    if (number === "ZZZ-999" || scenario === "still_missing")
      throw new ScrapeFailureError("not_found", "Normal site response contains no movie", [], true);
    return await inner.aggregate(number);
  });
  const rawResponse =
    scenario === "invalid_output"
      ? "not JSON"
      : JSON.stringify({
          number: scenario === "unknown" ? null : scenario === "unchanged" ? "ZZZ-999" : recoveredNumber,
          evidence:
            scenario === "unknown"
              ? null
              : scenario === "unchanged"
                ? "ZZZ-999"
                : scenario === "miss"
                  ? "1midv049"
                  : recoveredNumber,
        });
  const recognize = vi.spyOn(LlmRequestService.prototype, "requestText").mockImplementation(async () => {
    if (scenario === "request_failed") throw new Error("AI service unavailable");
    return rawResponse;
  });
  onTestFinished(() => recognize.mockRestore());
  const networkClient = scenario === "miss" ? new NetworkClient() : undefined;
  const getText = networkClient
    ? vi.spyOn(networkClient, "getText").mockImplementation(async (url) => {
        const path = new URL(url).pathname + new URL(url).search;
        if (path === `/search?q=${original}`) return "<html><body>No results</body></html>";
        if (path === `/search?q=${recoveredNumber}`)
          return `<a class="box" href="/v/recovered"><div class="video-title"><strong>${recoveredNumber}</strong></div></a>`;
        if (path === "/v/recovered")
          return `<h2 class="title is-4"><strong class="current-title">Recovered title</strong></h2><a class="button is-white copy-to-clipboard" data-clipboard-text="${recoveredNumber}"></a><img class="video-cover" src="https://images.test/cover.jpg" />`;
        throw new Error(`Unexpected request: ${url}`);
      })
    : undefined;
  onTestFinished(() => getText?.mockRestore());
  const { fastify, services } = await createTestServer({
    networkClient,
    scrapeAggregation: networkClient ? undefined : { aggregate },
  });
  await services.config.update({
    scrape: {
      aiNumberFallback: scenario !== "disabled",
      sites: [Website.JAVDB],
      restDuration: 0,
      filenameIgnoreTokens: ["www.98T.la@", "restored"],
    },
    translate: { enableTranslation: false, engine: TranslateEngine.GOOGLE, llmApiKey: "test-key" },
    download: {
      downloadThumb: false,
      downloadPoster: false,
      downloadFanart: false,
      downloadSceneImages: false,
      downloadTrailer: false,
      generateNfo: true,
    },
  });
  const token = await loginAsAdmin(fastify);
  const { libraryId, rootId } = await createTestLibrary(fastify, token, source, {
    outputPath: join(root, "output"),
    folderTemplate: "{number}",
    fileTemplate: "{number}",
  });
  const headers = { authorization: `Bearer ${token}` };
  const response = await fastify.inject({
    method: "POST",
    url: "/trpc/scrape.start",
    headers,
    payload: { executionMode: "single", libraryId, refs: [{ rootId, relativePath: fileName }] },
  });
  expect(response.statusCode).toBe(200);
  const runId = response.json().result.data.runId;
  const success = scenario === "missing" || scenario === "miss";
  await waitForScrapeRunStatus(fastify, token, runId, success ? "completed" : "failed");
  expect(recognize).toHaveBeenCalledTimes(scenario === "disabled" ? 0 : 1);
  const pending = (await fastify.inject({ method: "GET", url: "/trpc/pending.list", headers })).json().result.data
    .items;
  const state = await services.persistence.getState();
  const movies = await state.repositories.library.listEntries();
  if (success) {
    expect(pending).toEqual([]);
    expect(movies).toHaveLength(1);
    expect(movies[0].number).toBe(recoveredNumber);
    expect(await readFile(join(root, "output", recoveredNumber, "movie.nfo"), "utf8")).toContain(recoveredNumber);
  } else {
    expect(movies).toEqual([]);
    expect(pending).toEqual([
      expect.objectContaining({
        kind: scenario === "unknown" ? "no_number" : "not_found",
        number: scenario === "unknown" ? null : scenario === "still_missing" ? "ABC-123" : "ZZZ-999",
      }),
    ]);
    expect(await readFile(join(source, fileName), "utf8")).toBe("video");
    const detail = await fastify.inject({
      method: "GET",
      url: `/trpc/pending.detail?input=${encodeURIComponent(JSON.stringify({ id: pending[0].id }))}`,
      headers,
    });
    expect(detail.statusCode).toBe(200);
    const diagnostic = pendingDetailResponseSchema.parse(detail.json().result.data).numberRecognition;
    expect(diagnostic).toMatchObject(
      scenario === "disabled"
        ? { status: "skipped", reason: "disabled" }
        : {
            status:
              scenario === "unknown"
                ? "no_number"
                : scenario === "unchanged"
                  ? "unchanged"
                  : scenario === "still_missing"
                    ? "recognized"
                    : "failed",
            previousNumber: original === "recording" ? null : original,
            rawResponse: scenario === "request_failed" ? null : rawResponse,
            fileName,
            parentDirectory: "ABC-123",
            trigger: "automatic",
          },
    );
    if (diagnostic?.status === "failed") expect(diagnostic.error).toBeTruthy();
    expect(JSON.stringify(diagnostic)).not.toContain("test-key");
  }
  if (getText) {
    const prompt = recognize.mock.calls[0]?.[1];
    expect(prompt).toContain(defaultConfiguration.translate.llmNumberRecognitionPrompt);
    expect(prompt).toContain('"previousNumber":"049-PROB"');
    expect(getText.mock.calls.map(([url]) => new URL(url).pathname + new URL(url).search)).toEqual([
      `/search?q=${original}`,
      `/search?q=${recoveredNumber}`,
      "/v/recovered",
    ]);
    return;
  }
  expect(aggregate.mock.calls.map(([number]) => number)).toEqual(
    scenario === "missing"
      ? ["ABC-123"]
      : scenario === "unknown"
        ? []
        : scenario === "miss" || scenario === "still_missing"
          ? ["ZZZ-999", "ABC-123"]
          : ["ZZZ-999"],
  );
});

it("retries AI extraction with current settings without scraping or changing the pending outcome", async () => {
  const root = await createTempRoot("retry-number-recognition");
  const source = join(root, "ABC-123");
  await mkdir(source);
  await writeFile(join(source, "ZZZ-999.mp4"), "video");
  const aggregate = vi.fn();
  const { fastify, services } = await createTestServer({ scrapeAggregation: { aggregate } });
  const token = await loginAsAdmin(fastify);
  const { rootId } = await createTestLibrary(fastify, token, source);
  const { pending, library } = (await services.persistence.getState()).repositories;
  pending.upsert({
    kind: "not_found",
    rootId,
    relativePath: "ZZZ-999.mp4",
    number: "ZZZ-999",
    detail: "Original lookup failed",
  });
  const original = pending.list()[0];
  const headers = { authorization: `Bearer ${token}` };
  const request = {
    method: "POST" as const,
    url: "/trpc/pending.retryNumberRecognition",
    headers,
    payload: { id: original.id },
  };
  expect((await fastify.inject({ ...request, headers: {} })).statusCode).toBe(401);
  const recognize = vi.spyOn(LlmRequestService.prototype, "requestText");
  onTestFinished(() => recognize.mockRestore());
  const startScrape = vi.spyOn(services.scrape, "start");
  onTestFinished(() => startScrape.mockRestore());
  for (const scenario of ["recognized", "unchanged", "no_number", "invalid", "request_failed"] as const) {
    const number = scenario === "no_number" ? null : scenario === "unchanged" ? "ZZZ-999" : "ABC-123";
    const rawResponse = scenario === "invalid" ? "not JSON" : JSON.stringify({ number, evidence: number });
    recognize.mockImplementation(async () => {
      if (scenario === "request_failed") throw new Error("AI service unavailable");
      return rawResponse;
    });
    await services.config.update({
      scrape: { aiNumberFallback: false },
      translate: {
        enableTranslation: false,
        engine: TranslateEngine.GOOGLE,
        llmApiKey: "test-key",
        llmModelName: `model-${scenario}`,
        llmSystemPrompt: `system-${scenario}`,
        llmNumberRecognitionPrompt: `prompt-${scenario}`,
      },
    });
    const response = await fastify.inject(request);
    expect(response.statusCode).toBe(200);
    const detail = pendingDetailResponseSchema.parse(response.json().result.data);
    expect(detail.item).toMatchObject({
      kind: original.kind,
      number: original.number,
      detail: original.detail,
      libraryId: null,
    });
    expect(detail.numberRecognition).toMatchObject({
      status: scenario === "invalid" || scenario === "request_failed" ? "failed" : scenario,
      trigger: "manual",
      model: `model-${scenario}`,
      previousNumber: "ZZZ-999",
      fileName: "ZZZ-999.mp4",
      parentDirectory: "ABC-123",
      rawResponse: scenario === "request_failed" ? null : rawResponse,
      prompt: expect.stringContaining(`prompt-${scenario}`),
      systemPrompt: `system-${scenario}`,
    });
    expect(JSON.parse(pending.get(original.id).numberRecognitionJson ?? "null")).toEqual(detail.numberRecognition);
    const [configuration, prompt] = recognize.mock.calls.at(-1) ?? [];
    expect(configuration?.llmModelName).toBe(`model-${scenario}`);
    expect(prompt).toContain(`prompt-${scenario}`);
  }
  expect(recognize).toHaveBeenCalledTimes(5);
  expect(aggregate).not.toHaveBeenCalled();
  expect(startScrape).not.toHaveBeenCalled();
  expect(await library.listEntries()).toEqual([]);
  expect(await readFile(join(source, "ZZZ-999.mp4"), "utf8")).toBe("video");
  pending.upsert({ kind: "uncensored", rootId, relativePath: original.relativePath });
  expect((await fastify.inject(request)).json().error.message).toContain("This movie is published");
  expect(recognize).toHaveBeenCalledTimes(5);
});

it("does not overwrite changed pending outcomes or recreate ignored entries after extraction", async () => {
  const root = await createTempRoot("retry-number-recognition-race");
  const { fastify, services } = await createTestServer();
  const token = await loginAsAdmin(fastify);
  const { rootId } = await createTestLibrary(fastify, token, root);
  const { pending } = (await services.persistence.getState()).repositories;
  const recognize = vi.spyOn(LlmRequestService.prototype, "requestText");
  onTestFinished(() => recognize.mockRestore());
  await services.config.update({ translate: { llmApiKey: "test-key" } });
  for (const scenario of ["changed", "removed"] as const) {
    const input = { kind: "not_found" as const, rootId, relativePath: "ABC-123.mp4", number: "ABC-123" };
    pending.upsert(input);
    const original = pending.list()[0];
    recognize.mockImplementation(async () => {
      if (scenario === "removed") pending.delete([original.id]);
      else
        pending.upsert(
          { ...input, kind: "failed", detail: "Newer scrape outcome" },
          new Date(original.updatedAt.getTime() + 1000),
        );
      return '{"number":"ABC-123","evidence":"ABC-123"}';
    });
    const response = await fastify.inject({
      method: "POST",
      url: "/trpc/pending.retryNumberRecognition",
      headers: { authorization: `Bearer ${token}` },
      payload: { id: original.id },
    });
    expect(response.json().error.message).toContain("Pending item changed or was removed");
    if (scenario === "removed") expect(pending.list()).toEqual([]);
    else
      expect(pending.get(original.id)).toMatchObject({ detail: "Newer scrape outcome", numberRecognitionJson: null });
  }
});
