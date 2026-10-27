import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { configurationSchema, defaultConfiguration } from "@main/services/config";
import { loggerService } from "@main/services/LoggerService";
import type { DesktopPersistenceService } from "@main/services/persistence";
import { BatchTranslateToolService } from "@main/services/tools/BatchTranslateToolService";
import type { MediaRoot } from "@mdcz/media-store";
import type { ConfiguredMediaRootService } from "@mdcz/runtime/library";
import { buildMovieTags, parseNfoSnapshot, writePreparedNfo } from "@mdcz/runtime/maintenance";
import type { NetworkClient } from "@mdcz/runtime/network";
import { LlmApiClient, NfoGenerator } from "@mdcz/runtime/scrape";
import type { BatchNfoTranslatorDependencies } from "@mdcz/runtime/tools";
import { Website } from "@mdcz/shared/enums";
import type { BatchTranslateScanItem } from "@mdcz/shared/ipcTypes";
import type { LocalScanEntry } from "@mdcz/shared/types";
import { afterEach, describe, expect, it, vi } from "vitest";

const { sleepMock } = vi.hoisted(() => ({ sleepMock: vi.fn().mockResolvedValue(undefined) }));
vi.mock("node:timers/promises", () => ({ setTimeout: sleepMock }));

const tempDirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const createConfig = (overrides: Partial<ReturnType<typeof configurationSchema.parse>> = {}) =>
  configurationSchema.parse({
    ...defaultConfiguration,
    ...overrides,
    translate: {
      ...defaultConfiguration.translate,
      llmModelName: "gpt-5.2",
      llmApiKey: "test-key",
      targetLanguage: "zh-CN",
      ...(overrides.translate ?? {}),
    },
  });

type EntryOverrides = Omit<Partial<LocalScanEntry>, "assets" | "crawlerData" | "fileInfo"> & {
  assets?: Partial<LocalScanEntry["assets"]>;
  crawlerData?: Partial<NonNullable<LocalScanEntry["crawlerData"]>>;
  fileInfo?: Partial<LocalScanEntry["fileInfo"]>;
};

const createEntry = (overrides: EntryOverrides = {}): LocalScanEntry => {
  const nfoPath = overrides.nfoPath ?? "/library/ABC-123.nfo";
  return {
    fileId: "file-id",
    ref: { rootId: "test-root", relativePath: "test.mp4" },
    fileInfo: {
      filePath: "/library/ABC-123.mp4",
      fileName: "ABC-123.mp4",
      extension: ".mp4",
      number: "ABC-123",
      isSubtitled: false,
      ...overrides.fileInfo,
    },
    nfoPath,
    nfoPaths: [nfoPath],
    crawlerData: {
      title: "Original Title",
      title_zh: "Original Title",
      number: "ABC-123",
      actors: [],
      genres: [],
      plot: "Original Plot",
      plot_zh: "Original Plot",
      scene_images: [],
      website: Website.JAVDB,
      ...overrides.crawlerData,
    },
    nfoLocalState: overrides.nfoLocalState,
    scanError: overrides.scanError,
    assets: {
      sceneImages: [],
      actorPhotos: [],
      ...overrides.assets,
    },
    currentDir: overrides.currentDir ?? "/library",
    groupingDirectory: overrides.groupingDirectory ?? "/library",
  };
};

const createService = (
  options: {
    scan?: (dirPath: string, sceneImagesFolder: string) => Promise<LocalScanEntry[]>;
    scanVideo?: (root: MediaRoot, videoPath: string, sceneImagesFolder: string) => Promise<LocalScanEntry>;
    generateText?: LlmApiClient["generateText"];
    writeNfo?: BatchNfoTranslatorDependencies["writeNfo"];
    rootPath?: string;
  } = {},
) => {
  const localScanService = {
    scan: vi.fn(options.scan ?? (async () => [])),
    scanVideo: vi.fn(options.scanVideo ?? (async () => createEntry())),
  };
  const llmApiClient = {
    generateText: options.generateText ?? vi.fn(),
  } as unknown as LlmApiClient;
  const writeNfo =
    options.writeNfo ??
    vi.fn(async ({ nfoPath }: { nfoPath?: string }) => {
      return nfoPath;
    });
  const mediaRoot = {
    id: "library",
    displayName: "library",
    hostPath: options.rootPath ?? "/library",
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
  const ensurePathRecord = vi.fn(async () => mediaRoot);
  const mediaRoots = {
    ensurePathRecord,
    listRoots: async () => [mediaRoot],
  } as unknown as ConfiguredMediaRootService;

  const service = new BatchTranslateToolService(
    {} as NetworkClient,
    {
      getState: async () => ({
        repositories: {
          mediaRoots: {
            list: async () => [mediaRoot],
            ensurePath: async () => mediaRoot,
            upsert: async () => undefined,
          },
        },
      }),
    } as unknown as DesktopPersistenceService,
    {
      localScanService,
      llmApiClient,
      writeNfo,
    },
    mediaRoots,
  );

  return {
    service,
    localScanService,
    llmApiClient,
    writeNfo,
    ensurePathRecord,
  };
};

describe("BatchTranslateToolService", () => {
  it("scans the titles and plots the chosen mode covers", async () => {
    const config = createConfig();

    const { service, localScanService } = createService({
      scan: async () => [
        createEntry({
          fileInfo: {
            filePath: "/library/AAA-001.mp4",
            fileName: "AAA-001.mp4",
            number: "AAA-001",
          },
          nfoPath: "/library/AAA-001.nfo",
          crawlerData: {
            title: "Same English Title",
            title_zh: "Same English Title",
            number: "AAA-001",
            plot: "English plot",
            plot_zh: "English plot",
          },
        }),
        createEntry({
          fileInfo: {
            filePath: "/library/BBB-002.mp4",
            fileName: "BBB-002.mp4",
            number: "BBB-002",
          },
          nfoPath: "/library/BBB-002.nfo",
          crawlerData: {
            title: "元のタイトル",
            title_zh: "中文标题",
            number: "BBB-002",
            plot: "中文简介",
            plot_zh: "中文简介",
          },
        }),
        createEntry({
          fileInfo: { filePath: "/library/CCC-003.mp4", number: "CCC-003" },
          nfoPath: "/library/CCC-003.nfo",
          crawlerData: {
            title: "純漢字原題",
            number: "CCC-003",
            title_zh: undefined,
            plot: "",
            plot_zh: undefined,
            genres: ["Drama"],
            translation_failures: { title: "content_filter", genres: "content_filter" },
          },
        }),
      ],
    });

    const scanRoot = resolve("/library");
    const untranslated = await service.scan(scanRoot, "untranslated", config);
    const all = await service.scan(scanRoot, "all", config);
    const restore = await service.scan(scanRoot, "restore", config);

    expect(localScanService.scan).toHaveBeenCalledWith(scanRoot, config.paths.sceneImagesFolder);
    expect(untranslated).toEqual<BatchTranslateScanItem[]>([
      expect.objectContaining({ number: "AAA-001", pendingFields: ["title", "plot"] }),
      expect.objectContaining({ number: "CCC-003", pendingFields: ["title", "genres"], reason: "task_failed" }),
    ]);
    expect(untranslated[0].reason).toBe("content");
    // A Chinese source needs no translation in either mode; a translated Japanese title is retranslated.
    expect(all).toEqual<BatchTranslateScanItem[]>([
      expect.objectContaining({ number: "AAA-001", pendingFields: ["title", "plot"] }),
      expect.objectContaining({ number: "BBB-002", pendingFields: ["title"] }),
      expect.objectContaining({ number: "CCC-003", pendingFields: ["title", "genres"], reason: "task_failed" }),
    ]);
    expect(restore).toEqual<BatchTranslateScanItem[]>([
      expect.objectContaining({ number: "BBB-002", pendingFields: ["title"] }),
    ]);
  });

  it("restores the source title and plot without calling the LLM", async () => {
    const root = await mkdtemp(join(tmpdir(), "mdcz-batch-restore-"));
    tempDirs.push(root);
    const entry = createEntry({
      fileInfo: { filePath: join(root, "CCC-003.mp4"), fileName: "CCC-003.mp4", number: "CCC-003" },
      nfoPath: join(root, "CCC-003.nfo"),
      currentDir: root,
      crawlerData: {
        title: "元のタイトル",
        title_zh: "中文标题",
        number: "CCC-003",
        plot: "元の説明",
        plot_zh: "中文简介",
      },
    });
    await writeFile(join(root, "CCC-003.nfo"), "<movie><title>中文标题</title></movie>");
    const generateText = vi.fn();
    const { service } = createService({
      scanVideo: async () => entry,
      generateText,
      writeNfo: writePreparedNfo,
      rootPath: root,
    });

    const [result] = await service.apply(
      [
        {
          filePath: entry.fileInfo.filePath,
          nfoPath: join(root, "CCC-003.nfo"),
          directory: root,
          number: "CCC-003",
          title: "中文标题",
          pendingFields: ["title", "plot"],
          reason: "content",
        },
      ],
      createConfig(),
      { mode: "restore" },
    );

    expect(generateText).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: true, translatedFields: ["title", "plot"] });
    const xml = await readFile(join(root, "CCC-003.nfo"), "utf8");
    expect(xml).toContain("<title>元のタイトル</title>");
    expect(xml).toContain("<plot>元の説明</plot>");
    expect(xml).not.toContain("中文");
  });

  it("batches unique texts, preserves published translations, and persists exhausted failures", async () => {
    const logger = loggerService.getLogger("BatchTranslateToolService");
    const logError = vi.spyOn(logger, "error").mockReturnValue(logger);
    vi.spyOn(loggerService, "getLogger").mockReturnValue(logger);
    const root = await mkdtemp(join(tmpdir(), "mdcz-batch-translation-"));
    tempDirs.push(root);
    const config = createConfig({
      translate: { ...defaultConfiguration.translate, llmMaxRequestsPerSecond: 100, llmApiKey: "test-key" },
      download: {
        ...defaultConfiguration.download,
        nfoIgnoreFields: ["director"],
      },
    });
    const emptyResponse = {
      ok: true,
      status: 200,
      statusText: "OK",
      resolvedUrl: "https://example.test/v1/responses",
      headers: new Headers(),
      data: { status: "completed", error: null, usage: { output_tokens: 0 } },
    };
    const postJsonDetailed = vi
      .fn()
      .mockResolvedValueOnce(emptyResponse)
      .mockResolvedValue({
        ...emptyResponse,
        data: { output_text: '{"translations":["相同标题","剧情一"]}' },
      });
    const client = new LlmApiClient({ postJsonDetailed });
    const generateText = vi.fn(client.generateText.bind(client));
    const writeNfo = vi.fn(writePreparedNfo);

    const entriesByPath = new Map<string, LocalScanEntry>([
      [
        "/library/AAA-001.mp4",
        createEntry({
          fileInfo: {
            filePath: "/library/AAA-001.mp4",
            fileName: "AAA-001.mp4",
            number: "AAA-001",
          },
          nfoPath: "/library/AAA-001.nfo",
          crawlerData: {
            title: "Same English Title",
            title_zh: "Same English Title",
            number: "AAA-001",
            plot: "Plot 1",
            plot_zh: "Plot 1",
          },
        }),
      ],
      [
        "/library/BBB-002.mp4",
        createEntry({
          fileInfo: {
            filePath: "/library/BBB-002.mp4",
            fileName: "BBB-002.mp4",
            number: "BBB-002",
          },
          nfoPath: "/library/BBB-002.nfo",
          crawlerData: {
            title: "Same English Title",
            title_zh: "Same English Title",
            number: "BBB-002",
            plot: "",
            plot_zh: "",
          },
        }),
      ],
    ]);
    for (const [key, entry] of [...entriesByPath]) {
      entriesByPath.delete(key);
      entry.fileInfo.filePath = key.replace("/library", root);
      entry.nfoPath = entry.nfoPath?.replace("/library", root);
      entry.currentDir = root;
      entriesByPath.set(entry.fileInfo.filePath, entry);
      if (!entry.nfoPath) throw new Error("Fixture NFO path is required");
      await writeFile(entry.nfoPath, "<movie><title>Original</title></movie>");
    }

    const { service, localScanService, ensurePathRecord } = createService({
      scanVideo: async (_root, videoPath) => {
        const matched = entriesByPath.get(videoPath);
        if (!matched) {
          throw new Error(`Unexpected scan path: ${videoPath}`);
        }
        return matched;
      },
      generateText,
      writeNfo,
      rootPath: root,
    });

    const items: BatchTranslateScanItem[] = [
      {
        filePath: "/library/AAA-001.mp4",
        nfoPath: "/library/AAA-001.nfo",
        directory: "/library",
        number: "AAA-001",
        title: "Same English Title",
        pendingFields: ["title", "plot"],
      },
      {
        filePath: "/library/BBB-002.mp4",
        nfoPath: "/library/BBB-002.nfo",
        directory: "/library",
        number: "BBB-002",
        title: "Same English Title",
        pendingFields: ["title"],
      },
    ].map((item) => ({
      ...item,
      filePath: item.filePath.replace("/library", root),
      nfoPath: item.nfoPath.replace("/library", root),
      directory: root,
      pendingFields: item.pendingFields as BatchTranslateScanItem["pendingFields"],
      reason: "content",
    }));
    sleepMock.mockClear();
    const results = await service.apply(items, config, { mode: "untranslated" });

    expect(localScanService.scanVideo).toHaveBeenCalledTimes(2);
    expect(ensurePathRecord).toHaveBeenCalledOnce();
    expect(ensurePathRecord).toHaveBeenCalledWith({ hostPath: root });
    expect(generateText).toHaveBeenCalledTimes(2);
    expect(sleepMock.mock.calls.map(([delay]) => delay)).toEqual([1000]);
    expect(generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining('"Same English Title"'),
      }),
      undefined,
    );
    expect(writeNfo).toHaveBeenCalledTimes(2);

    const firstWrite = writeNfo.mock.calls[0]?.[0] as {
      config: { download: { nfoIgnoreFields: string[] } };
      crawlerData: { title_zh?: string; plot_zh?: string };
    };
    expect(firstWrite.crawlerData.title_zh).toBe("相同标题");
    expect(firstWrite.crawlerData.plot_zh).toBe("剧情一");
    expect(firstWrite.config.download.nfoIgnoreFields).toEqual(["director"]);

    const secondWrite = writeNfo.mock.calls[1]?.[0] as { crawlerData: { title_zh?: string } };
    expect(secondWrite.crawlerData.title_zh).toBe("相同标题");
    expect(results.every(({ success }) => success)).toBe(true);
    expect(logError).not.toHaveBeenCalled();
    for (const number of ["AAA-001", "BBB-002"]) {
      expect(await readFile(join(root, `${number}.nfo`), "utf8")).toContain("相同标题");
    }

    const savedNfo = await readFile(items[0].nfoPath, "utf8");
    localScanService.scanVideo.mockImplementation(async (_root, videoPath) => {
      const entry = entriesByPath.get(videoPath);
      if (!entry?.nfoPath) throw new Error(`Missing fixture: ${videoPath}`);
      return { ...entry, crawlerData: parseNfoSnapshot(await readFile(entry.nfoPath, "utf8")).crawlerData };
    });
    for (const [index, failure] of (["empty", "invalid", "unauthorized", "refusal", "echo"] as const).entries()) {
      generateText.mockClear();
      sleepMock.mockClear();
      logError.mockClear();
      postJsonDetailed.mockResolvedValue({
        ...emptyResponse,
        ...(failure === "unauthorized" ? { ok: false, status: 401, statusText: "Unauthorized" } : {}),
        data:
          failure === "empty"
            ? emptyResponse.data
            : failure === "invalid"
              ? { output_text: '{"translations":["缺少简介"]}' }
              : failure === "refusal"
                ? { output_text: "抱歉，我无法翻译或处理" }
                : failure === "echo"
                  ? { output_text: '{"translations":["Same English Title","Plot 1"]}' }
                  : { error: { message: "invalid API key" } },
      });
      const failures = await service.apply(items, config, { mode: "all" });
      expect(generateText).toHaveBeenCalledTimes(failure === "empty" ? config.translate.llmMaxRetries + 1 : 1);
      expect(sleepMock.mock.calls.map(([delay]) => delay)).toEqual(failure === "empty" ? [1000, 2000, 4000] : []);
      expect(failures).toHaveLength(2);
      for (const result of failures) {
        expect(result).toMatchObject({ success: false, translatedFields: [] });
        expect(result.error).toContain(
          failure === "empty"
            ? "LLM response did not contain text"
            : failure === "invalid"
              ? "batch translation count"
              : failure === "refusal"
                ? "is not valid JSON"
                : failure === "echo"
                  ? "provider returned source text"
                  : "HTTP 401",
        );
      }
      expect(logError).toHaveBeenCalledTimes(failures.length);
      expect(
        logError.mock.calls.map(([message]) => JSON.parse(String(message).slice("[batch-nfo-translation] ".length))),
      ).toEqual(
        failures.map((result) => ({
          number: result.number,
          nfoPath: result.nfoPath,
          mode: "all",
          translatedFields: result.translatedFields,
          error: result.error,
        })),
      );
      expect(writeNfo).toHaveBeenCalledTimes(2 + (index + 1) * 2);
      const failedData = parseNfoSnapshot(await readFile(items[0].nfoPath, "utf8")).crawlerData;
      expect(failedData.title_zh).toBe(parseNfoSnapshot(savedNfo).crawlerData.title_zh);
      expect(failedData.translation_failures).toMatchObject({ title: expect.any(String), plot: expect.any(String) });
    }
  });

  it("forces flagged fields through translation and clears only fields that were repaired", async () => {
    const root = await mkdtemp(join(tmpdir(), "mdcz-translation-failures-"));
    tempDirs.push(root);
    const entry = createEntry({
      fileInfo: { filePath: join(root, "ABC-123.mp4") },
      nfoPath: join(root, "ABC-123.nfo"),
      currentDir: root,
      crawlerData: {
        title: "純漢字原題",
        title_zh: undefined,
        plot: "元の説明",
        plot_zh: undefined,
        genres: ["Drama", "Travel"],
        translation_failures: { title: "content_filter", plot: "content_filter", genres: "content_filter" },
      },
    });
    if (!entry.nfoPath || !entry.crawlerData) throw new Error("Missing fixture NFO");
    const nfoPath = entry.nfoPath;
    await writeFile(
      nfoPath,
      new NfoGenerator().buildXml(entry.crawlerData, {
        localState: { tags: ["保留标签"], lockedFields: ["Cast"] },
        buildTags: buildMovieTags,
      }),
    );
    const readEntry = async () => {
      const snapshot = parseNfoSnapshot(await readFile(nfoPath, "utf8"));
      return { ...entry, crawlerData: snapshot.crawlerData, nfoLocalState: snapshot.localState };
    };
    const generateText = vi
      .fn()
      .mockResolvedValueOnce('{"translations":["译名"]}')
      .mockRejectedValueOnce(new Error("provider unavailable"))
      .mockResolvedValueOnce('{"translations":["剧情"]}')
      .mockRejectedValueOnce(new Error("provider unavailable"));
    const { service } = createService({
      scan: async () => [await readEntry()],
      scanVideo: readEntry,
      generateText,
      writeNfo: writePreparedNfo,
      rootPath: root,
    });
    const config = createConfig();
    config.translate.llmMaxRequestsPerSecond = 100;
    const items = await service.scan(root, "untranslated", config);
    expect(items[0]).toMatchObject({ reason: "task_failed", pendingFields: ["title", "plot", "genres"] });
    const [partial] = await service.apply(items, config, { mode: "untranslated", maxBatchItems: 1 });
    expect(partial).toMatchObject({ success: false, translatedFields: ["title", "genres"] });
    const first = (await readEntry()).crawlerData;
    expect(first.translation_failures).toEqual({
      plot: expect.stringContaining("provider unavailable"),
      genres: expect.stringContaining("provider unavailable"),
    });
    expect(first.title_zh).toBe("译名");
    expect(first.genres).toEqual(["剧情", "Travel"]);
    expect((await readEntry()).nfoLocalState).toMatchObject({ tags: ["保留标签"], lockedFields: ["Cast"] });

    generateText.mockResolvedValue('{"translations":["补译成功"]}');
    const pending = await service.scan(root, "untranslated", config);
    expect(pending[0].pendingFields).toEqual(["plot", "genres"]);
    const [repaired] = await service.apply(pending, config, { mode: "untranslated", maxBatchItems: 1 });
    expect(repaired.success).toBe(true);
    expect((await readEntry()).crawlerData.translation_failures).toBeUndefined();
    expect(await service.scan(root, "untranslated", config)).toEqual([]);
  });
});
