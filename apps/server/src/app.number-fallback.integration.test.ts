import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { NumberRecognitionService } from "@mdcz/runtime/scrape/NumberRecognitionService";
import { ScrapeFailureError } from "@mdcz/runtime/scrape/scrapeFailure";
import { TranslateEngine } from "@mdcz/shared/enums";
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
] as const)("publishes recovered metadata or leaves a manually repairable entry (%s)", async (scenario) => {
  const root = await createTempRoot("ai-number-fallback");
  const source = join(root, "ABC-123");
  await mkdir(source);
  const original = scenario === "missing" || scenario === "unknown" ? "recording" : "ZZZ-999";
  const fileName = `${original}.mp4`;
  await writeFile(join(source, fileName), "video");
  const inner = createTestAggregation("https://unused.test/cover.jpg");
  const aggregate = vi.fn(async (number: string) => {
    if (number === "ZZZ-999" || scenario === "still_missing")
      throw new ScrapeFailureError("not_found", "Normal site response contains no movie", [], true);
    return await inner.aggregate(number);
  });
  const recognize = vi
    .spyOn(NumberRecognitionService.prototype, "recognize")
    .mockResolvedValue(scenario === "unknown" ? null : "ABC-123");
  onTestFinished(() => recognize.mockRestore());
  const { fastify, services } = await createTestServer({ scrapeAggregation: { aggregate } });
  await services.config.update({
    scrape: { aiNumberFallback: true },
    translate: { enableTranslation: false, engine: TranslateEngine.GOOGLE },
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
  expect(recognize).toHaveBeenCalledOnce();
  const pending = (await fastify.inject({ method: "GET", url: "/trpc/pending.list", headers })).json().result.data
    .items;
  const state = await services.persistence.getState();
  const movies = await state.repositories.library.listEntries();
  if (success) {
    expect(pending).toEqual([]);
    expect(movies).toHaveLength(1);
    expect(movies[0].number).toBe("ABC-123");
    expect(await readFile(join(root, "output", "ABC-123", "movie.nfo"), "utf8")).toContain("ABC-123");
  } else {
    expect(movies).toEqual([]);
    expect(pending).toEqual([
      expect.objectContaining({
        kind: scenario === "unknown" ? "no_number" : "not_found",
        number: scenario === "unknown" ? null : "ABC-123",
      }),
    ]);
    expect(await readFile(join(source, fileName), "utf8")).toBe("video");
  }
  expect(aggregate.mock.calls.map(([number]) => number)).toEqual(
    scenario === "missing" ? ["ABC-123"] : scenario === "unknown" ? [] : ["ZZZ-999", "ABC-123"],
  );
});
