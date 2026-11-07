import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { EmbyDeletionRepository } from "@mdcz/persistence";
import type { MoviePilotFile } from "@mdcz/shared/moviePilot";
import { afterEach, expect, it, vi } from "vitest";
import {
  closeTestServers,
  createTempRoot,
  createTestAggregation,
  createTestLibrary,
  createTestServer,
  loginAsAdmin,
  waitForScrapeRunStatus,
} from "./app.testSupport";
import { MoviePilotClient } from "./services/moviePilotClient";

afterEach(async () => {
  await closeTestServers();
  vi.restoreAllMocks();
});

it.each([
  "off",
  "incoming",
  "existing",
  "equal",
])("resolves batch duplicates after the scrape queue settles (%s)", async (scenario) => {
  const source = await createTempRoot("duplicate-source");
  const output = await createTempRoot("duplicate-output");
  const numbers = ["ABC-123", "XYZ-456"];
  const content = (version: string, number: string) =>
    `https://mp.test/api/v1/plugin/P115StrmHelper/redirect_url?pickcode=${version}-${number}\n`;
  for (const version of ["old", "new"]) {
    await mkdir(join(source, version));
    for (const number of numbers) await writeFile(join(source, version, `${number}.strm`), content(version, number));
  }
  const cloudRoot: MoviePilotFile = { storage: "u115", type: "dir", path: "/AV/", name: "AV", fileid: "root" };
  let files: MoviePilotFile[] = ["old", "new"].flatMap((version) =>
    numbers.map((number) => ({
      storage: "u115",
      type: "file" as const,
      path: `/AV/${version}-${number}.mp4`,
      name: `${version}-${number}.mp4`,
      fileid: `${version}-${number}`,
      pickcode: `${version}-${number}`,
      parent_fileid: "root",
      size: version === (scenario === "existing" ? "old" : "new") && scenario !== "equal" ? 2 * 1024 ** 3 : 1024 ** 3,
    })),
  );
  vi.spyOn(MoviePilotClient.prototype, "test").mockResolvedValue({ storage: "u115" });
  vi.spyOn(MoviePilotClient.prototype, "list").mockImplementation(async (directory) =>
    directory.fileid === "0" ? [cloudRoot] : files,
  );
  const { fastify, services } = await createTestServer({
    scrapeAggregation: createTestAggregation("https://unused.test/image.png"),
  });
  const state = await services.persistence.getState();
  const repository = new EmbyDeletionRepository(state.database);
  const deleted: string[] = [];
  vi.spyOn(MoviePilotClient.prototype, "deleteFile").mockImplementation(async (file) => {
    expect(repository.hasLiveScrapes()).toBe(false);
    expect((await services.scrape.liveRuns()).runs).toEqual([]);
    deleted.push(file.fileid);
    files = files.filter((candidate) => candidate.fileid !== file.fileid);
  });
  await services.config.update({
    scrape: { autoResolveDuplicates: scenario !== "off", restDuration: 0 },
    download: {
      downloadThumb: false,
      downloadPoster: false,
      downloadFanart: false,
      downloadSceneImages: false,
      downloadTrailer: false,
    },
  });
  const token = await loginAsAdmin(fastify);
  const { rootId, libraryId } = await createTestLibrary(fastify, token, source, {
    placement: "copy",
    outputPath: output,
    folderTemplate: "{number}",
  });
  await services.embyDeletion.configureMoviePilot({
    baseUrl: "https://mp.test",
    token: "test-token",
    storage: "u115",
    rootPath: "/AV",
  });
  await services.embyDeletion.configure({ mode: "off", serverId: "", libraryIds: [libraryId] });
  const start = (version: string) =>
    services.scrape.start({
      executionMode: "batch",
      libraryId,
      refs: numbers.map((number) => ({ rootId, relativePath: `${version}/${number}.strm` })),
    });
  const original = await start("old");
  await waitForScrapeRunStatus(fastify, token, original.task.id, "completed");
  await expect(services.embyDeletion.bindSources()).resolves.toEqual({ verified: 2, unverified: 0 });
  const automatic = vi.spyOn(services.scrape.conflicts, "resolveAutomatically");
  const duplicate = await start("new");
  await waitForScrapeRunStatus(fastify, token, duplicate.task.id, "failed");
  await vi.waitFor(() => expect(automatic).toHaveBeenCalledTimes(2), { timeout: 10000 });
  const results = await Promise.allSettled(automatic.mock.results.map((result) => result.value));
  expect(results.map((result) => result.status)).toEqual(
    scenario === "equal" ? ["rejected", "rejected"] : ["fulfilled", "fulfilled"],
  );
  if (scenario === "incoming") {
    for (const result of results)
      if (result.status === "fulfilled" && result.value?.runId)
        await waitForScrapeRunStatus(fastify, token, result.value.runId, "completed");
  }
  const keep = scenario === "incoming" ? "new" : "old";
  expect(deleted.sort()).toEqual(
    scenario === "incoming" || scenario === "existing"
      ? numbers.map((number) => `${keep === "new" ? "old" : "new"}-${number}`).sort()
      : [],
  );
  for (const number of numbers) {
    expect(await readFile(join(output, number, `${number}.strm`), "utf8")).toBe(content(keep, number));
    expect(await readFile(join(source, keep, `${number}.strm`), "utf8")).toBe(content(keep, number));
    if (scenario === "incoming" || scenario === "existing")
      await expect(stat(join(source, keep === "new" ? "old" : "new", `${number}.strm`))).rejects.toMatchObject({
        code: "ENOENT",
      });
    else expect((await stat(join(source, "new", `${number}.strm`))).isFile()).toBe(true);
  }
  const pending = await state.repositories.pending.list();
  expect(pending).toHaveLength(scenario === "off" || scenario === "equal" ? 2 : 0);
});
