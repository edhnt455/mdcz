import { mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
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
  for (const mode of ["indexed", "batch", "batch-three", "batch-resolution"] as const) {
    const source = await realpath(await createTempRoot("duplicate-source"));
    const output = await realpath(await createTempRoot("duplicate-output"));
    const numbers = ["ABC-123", "XYZ-456"];
    const content = (version: string, number: string) =>
      `https://mp.test/api/v1/plugin/P115StrmHelper/redirect_url?pickcode=${version}-${number}\n`;
    const versions = mode === "batch-three" ? ["old", "new", "extra"] : ["old", "new"];
    const relativePath = (version: string, number: string) =>
      mode === "indexed"
        ? `${version}/${number}.strm`
        : version === "old"
          ? `${number}${mode === "batch-resolution" ? "-1080P" : ""}.strm`
          : version === "new"
            ? `489155.com@${number}-LTX${mode === "batch-resolution" ? "-1080P" : ""}.strm`
            : `${number}(2).strm`;
    for (const version of versions) {
      if (mode === "indexed") await mkdir(join(source, version));
      for (const number of numbers)
        await writeFile(join(source, relativePath(version, number)), content(version, number));
    }
    const cloudRoot: MoviePilotFile = { storage: "u115", type: "dir", path: "/AV/", name: "AV", fileid: "root" };
    const preferred = scenario === "incoming" ? "new" : "old";
    const other = preferred === "new" ? "old" : "new";
    let files: MoviePilotFile[] = versions.flatMap((version) =>
      numbers.map((number) => ({
        storage: "u115",
        type: "file" as const,
        path: `/AV/${version}-${number}.mp4`,
        name:
          number === numbers[1] &&
          ((scenario === "incoming" && version === "new") || (scenario === "existing" && version === "old"))
            ? `${version}-${number}-中文字幕.mp4`
            : `${version}-${number}.mp4`,
        fileid: `${version}-${number}`,
        pickcode: `${version}-${number}`,
        parent_fileid: "root",
        size:
          version === (number === numbers[0] ? preferred : other) && scenario !== "equal" ? 2 * 1024 ** 3 : 1024 ** 3,
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
    const start = (selected: string[]) =>
      services.scrape.start({
        executionMode: "batch",
        libraryId,
        refs: numbers.flatMap((number) =>
          selected.map((version) => ({ rootId, relativePath: relativePath(version, number) })),
        ),
      });
    if (mode === "indexed") {
      const original = await start(["old"]);
      await waitForScrapeRunStatus(fastify, token, original.task.id, "completed");
      await expect(services.embyDeletion.bindSources()).resolves.toEqual({ verified: 2, unverified: 0 });
    }
    const automatic = vi.spyOn(services.scrape.conflicts, "resolveAutomatically");
    const duplicate = await start(mode === "indexed" ? ["new"] : versions);
    await waitForScrapeRunStatus(fastify, token, duplicate.task.id, "failed");
    const duplicateCount = (mode === "batch-three" ? 2 : 1) * numbers.length;
    await vi.waitFor(() => expect(automatic).toHaveBeenCalledTimes(duplicateCount), { timeout: 10000 });
    const results = await Promise.allSettled(automatic.mock.results.map((result) => result.value));
    expect(results.map((result) => result.status)).toEqual(Array(duplicateCount).fill("fulfilled"));
    for (const result of results)
      if (result.status === "fulfilled" && result.value?.runId)
        await waitForScrapeRunStatus(fastify, token, result.value.runId, "completed");
    const snapshot = await services.scrape.snapshot({ taskId: duplicate.task.id });
    const expectedDeleted: string[] = [];
    for (const number of numbers) {
      const initial =
        mode === "indexed"
          ? "old"
          : versions.find((version) =>
              snapshot.items.some(
                (item) => item.status === "success" && item.relativePath === relativePath(version, number),
              ),
            );
      if (!initial) throw new Error(`No initial version was published for ${number} (${mode})`);
      const keep = scenario === "incoming" ? "new" : scenario === "existing" ? "old" : initial;
      if (scenario !== "off")
        expectedDeleted.push(
          ...versions.filter((version) => version !== keep).map((version) => `${version}-${number}`),
        );
      expect(await readFile(join(output, number, `${number}.strm`), "utf8")).toBe(content(keep, number));
      expect(await readFile(join(source, relativePath(keep, number)), "utf8")).toBe(content(keep, number));
      expect((await readdir(join(output, number))).filter((name) => name.endsWith(".strm"))).toEqual([
        `${number}.strm`,
      ]);
      for (const version of versions.filter((version) => version !== keep)) {
        if (scenario !== "off")
          await expect(stat(join(source, relativePath(version, number)))).rejects.toMatchObject({ code: "ENOENT" });
        else expect((await stat(join(source, relativePath(version, number)))).isFile()).toBe(true);
      }
    }
    expect(deleted.sort()).toEqual(expectedDeleted.sort());
    const pending = await state.repositories.pending.list();
    expect(pending).toHaveLength(scenario === "off" ? duplicateCount : 0);
    const entries = await state.repositories.library.listEntries();
    expect(entries).toHaveLength(numbers.length);
    expect(entries.every((entry) => entry.files.length === 1)).toBe(true);
    await closeTestServers();
    vi.restoreAllMocks();
  }
});
