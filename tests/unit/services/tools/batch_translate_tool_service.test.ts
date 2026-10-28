import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { MediaRoot } from "@mdcz/media-store";
import { buildMovieTags, parseNfoSnapshot, writePreparedNfo } from "@mdcz/runtime/maintenance";
import { LlmApiClient, NfoGenerator } from "@mdcz/runtime/scrape";
import { runtimeLoggerService } from "@mdcz/runtime/shared";
import {
  applyBatchNfoTranslations,
  type BatchNfoTranslatorApplyOptions,
  type BatchNfoTranslatorDependencies,
  scanBatchNfoTranslations,
} from "@mdcz/runtime/tools";
import { configurationSchema, defaultConfiguration } from "@mdcz/shared/config";
import { Website } from "@mdcz/shared/enums";
import type { BatchTranslateMode, BatchTranslateScanItem } from "@mdcz/shared/toolTypes";
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
  const dependencies = { localScanService, llmApiClient, writeNfo, publication: { roots: [mediaRoot] } };
  const service = {
    scan: (directory: string, mode: BatchTranslateMode, config: ReturnType<typeof createConfig>) =>
      scanBatchNfoTranslations(directory, mode, config, dependencies),
    apply: (
      items: BatchTranslateScanItem[],
      config: ReturnType<typeof createConfig>,
      options: BatchNfoTranslatorApplyOptions,
    ) => applyBatchNfoTranslations(items, config, dependencies, options),
  };

  return {
    service,
    localScanService,
    llmApiClient,
    writeNfo,
  };
};

describe("BatchNfoTranslator", () => {
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
      expect.objectContaining({ number: "CCC-003", pendingFields: ["title", "genres"], reason: "task_failed" }),
    ]);
    expect(all.find((item) => item.number === "BBB-002")).toMatchObject({ title: "中文标题", plot: "中文简介" });
    expect(all).toEqual<BatchTranslateScanItem[]>([
      expect.objectContaining({ number: "AAA-001", pendingFields: ["title", "plot"] }),
      expect.objectContaining({ number: "BBB-002", pendingFields: ["title"] }),
      expect.objectContaining({ number: "CCC-003", pendingFields: ["title", "genres"], reason: "task_failed" }),
    ]);
    expect(restore).toEqual<BatchTranslateScanItem[]>([
      expect.objectContaining({ number: "BBB-002", pendingFields: ["title"] }),
    ]);
  });

  it("uses the configured consecutive kana threshold consistently when scanning and applying untranslated fields", async () => {
    for (const { text, threshold = 5, expected, failed = false, field = "title" } of [
      { text: "中文标题 アリス", expected: false },
      { text: "あいうえ", expected: false },
      { text: "あいうえお", expected: true },
      { text: "中文あいうえおか中文", expected: true },
      { text: "アいうエオ", expected: true },
      { text: "ﾊﾋﾌﾍﾎ", expected: true },
      { text: "中文ﾊﾋﾌﾍﾎ中文", expected: true },
      { text: "ｶﾞｷﾞｸﾞｹﾞ", expected: false },
      { text: "ｶﾞｷﾞｸﾞｹﾞｺﾞ", expected: true },
      { text: "スーパーアイドル", expected: true },
      { text: "あいう、えおか", expected: false },
      { text: "あいう えおか", expected: false },
      { text: "あいう\nえおか", expected: false },
      { text: "あいう漢字えおか", expected: false },
      { text: "あいうABCえおか", expected: false },
      { text: "あいうえ😀おかきく", expected: false },
      { text: "𛀁𛀁𛀁𛀁", expected: false },
      { text: "𛀁𛀁𛀁𛀁𛀁", expected: true },
      { text: "中文𛀁𛀁𛀁𛀁𛀁中文", expected: true },
      { text: "純漢字原題", expected: false },
      { text: "繁體標題", expected: false },
      { text: "English title", expected: false },
      { text: "", expected: false },
      { text: "中文ア中文", threshold: 1, expected: true },
      { text: "中文アリス", threshold: 3, expected: true },
      { text: "あいうえお", threshold: 6, expected: false },
      { text: "中文あいうえお", field: "plot", expected: true },
      { text: "中文アリス", failed: true, expected: true },
      { text: "English title", failed: true, expected: true },
    ] satisfies { text: string; threshold?: number; expected: boolean; failed?: boolean; field?: "title" | "plot" }[]) {
      const entry = createEntry({
        crawlerData: {
          title: field === "title" ? text : "中文标题",
          title_zh: undefined,
          plot: field === "plot" ? text : "中文简介",
          plot_zh: undefined,
          translation_failures: failed ? { [field]: "provider unavailable" } : undefined,
        },
      });
      const { service, llmApiClient, writeNfo } = createService({
        scan: async () => [entry],
        scanVideo: async () => entry,
        generateText: vi.fn().mockResolvedValue('{"translations":["翻译完成"]}'),
      });
      const config = createConfig();
      config.translate.untranslatedJapaneseRunLength = threshold;
      const scanned = await service.scan("/library", "untranslated", config);
      expect(scanned, JSON.stringify({ text, threshold, failed })).toHaveLength(expected ? 1 : 0);
      if (expected)
        expect(scanned[0]).toMatchObject({ pendingFields: [field], reason: failed ? "task_failed" : "content" });
      const [result] = await service.apply(
        [
          {
            ...entry.fileInfo,
            nfoPath: entry.nfoPath ?? "",
            directory: entry.currentDir,
            title: text,
            plot: "",
            pendingFields: [field],
            reason: "content",
          },
        ],
        config,
        { mode: "untranslated" },
      );
      expect(result.success).toBe(expected);
      expect(llmApiClient.generateText).toHaveBeenCalledTimes(expected ? 1 : 0);
      expect(writeNfo).toHaveBeenCalledTimes(expected ? 1 : 0);
    }
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
          plot: "中文简介",
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
    const logger = runtimeLoggerService.getLogger("BatchNfoTranslator");
    const logError = vi.spyOn(logger, "error").mockReturnValue(undefined);
    vi.spyOn(runtimeLoggerService, "getLogger").mockReturnValue(logger);
    const root = await mkdtemp(join(tmpdir(), "mdcz-batch-translation-"));
    tempDirs.push(root);
    const config = createConfig({
      translate: {
        ...defaultConfiguration.translate,
        llmMaxRequestsPerSecond: 100,
        llmApiKey: "test-key",
        llmSystemPrompt: "Shared context",
        llmPrompt: "Custom translation to {lang}: {content}",
      },
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
        data: { output_text: '[N] {"translations":["相同标题","剧情一"]}' },
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

    const { service, localScanService } = createService({
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
        plot: "Plot 1",
        pendingFields: ["title", "plot"],
      },
      {
        filePath: "/library/BBB-002.mp4",
        nfoPath: "/library/BBB-002.nfo",
        directory: "/library",
        number: "BBB-002",
        title: "Same English Title",
        plot: "",
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
    const results = await service.apply(items, config, { mode: "all" });

    expect(localScanService.scanVideo).toHaveBeenCalledTimes(2);
    expect(generateText).toHaveBeenCalledTimes(2);
    expect(sleepMock.mock.calls.map(([delay]) => delay)).toEqual([1000]);
    expect(generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        systemPrompt: "Shared context",
        prompt: expect.stringContaining('Custom translation to 简体中文: ["Same English Title"'),
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

    for (const output of [
      '{"translations":["相同标题","剧情一"]}',
      '  ```json\n{"translations":["相同标题","剧情一"]}\n```  ',
      '<think>Inspect the input.</think>\n[Translator]\n```json\n{"translations":["相同标题","剧情一"]}\n```',
    ]) {
      postJsonDetailed.mockResolvedValue({ ...emptyResponse, data: { output_text: output } });
      const repaired = await service.apply(items, config, { mode: "all" });
      expect(repaired.every(({ success }) => success)).toBe(true);
    }
    const successfulWriteCount = writeNfo.mock.calls.length;
    const savedNfo = await readFile(items[0].nfoPath, "utf8");
    localScanService.scanVideo.mockImplementation(async (_root, videoPath) => {
      const entry = entriesByPath.get(videoPath);
      if (!entry?.nfoPath) throw new Error(`Missing fixture: ${videoPath}`);
      return { ...entry, crawlerData: parseNfoSnapshot(await readFile(entry.nfoPath, "utf8")).crawlerData };
    });
    const failureResponses = {
      empty: { data: emptyResponse.data, error: "LLM response did not contain text" },
      invalid: { data: { output_text: '{"translations":["缺少简介"]}' }, error: "batch translation count" },
      unauthorized: { data: { error: { message: "invalid API key" } }, error: "HTTP 401" },
      refusal: { data: { output_text: "抱歉，我无法翻译或处理" }, error: "is not valid JSON" },
      echo: {
        data: { output_text: '{"translations":["Same English Title","Plot 1"]}' },
        error: "provider returned source text",
      },
      truncated: { data: { output_text: '[N] {"translations":["标题"' }, error: "JSON" },
      multiple: {
        data: { output_text: '[N] {"translations":["标题","简介"]}\n{"translations":["另一标题","另一简介"]}' },
        error: "JSON",
      },
      array: { data: { output_text: '[{"translations":["标题","简介"]}]' }, error: "expected object" },
      extraFields: { data: { output_text: '[N] {"translations":["标题","简介"],"extra":true}' }, error: "extra" },
    };
    for (const [index, [failure, response]] of Object.entries(failureResponses).entries()) {
      generateText.mockClear();
      sleepMock.mockClear();
      logError.mockClear();
      postJsonDetailed.mockResolvedValue({
        ...emptyResponse,
        ...(failure === "unauthorized" ? { ok: false, status: 401, statusText: "Unauthorized" } : {}),
        data: response.data,
      });
      const failures = await service.apply(items, config, { mode: "all" });
      expect(generateText).toHaveBeenCalledTimes(failure === "empty" ? config.translate.llmMaxRetries + 1 : 1);
      expect(sleepMock.mock.calls.map(([delay]) => delay)).toEqual(failure === "empty" ? [1000, 2000, 4000] : []);
      expect(failures).toHaveLength(2);
      for (const result of failures) {
        expect(result).toMatchObject({ success: false, translatedFields: [] });
        expect(result.error).toContain(response.error);
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
      expect(writeNfo).toHaveBeenCalledTimes(successfulWriteCount + (index + 1) * 2);
      const failedData = parseNfoSnapshot(await readFile(items[0].nfoPath, "utf8")).crawlerData;
      expect(failedData.title_zh).toBe(parseNfoSnapshot(savedNfo).crawlerData.title_zh);
      expect(failedData.translation_failures).toMatchObject({ title: expect.any(String), plot: expect.any(String) });
      expect(failedData.translation_ignored).toBeUndefined();
    }
  });

  it("persists manually accepted fields without translating and reconsiders changed content or explicit retranslation", async () => {
    const root = await mkdtemp(join(tmpdir(), "mdcz-translation-ignore-"));
    tempDirs.push(root);
    const nfoPath = join(root, "ABC-123.nfo");
    const entry = createEntry({
      fileInfo: { filePath: join(root, "ABC-123.mp4") },
      nfoPath,
      currentDir: root,
      crawlerData: {
        title: "あいうえおのタイトル",
        title_zh: "已翻译的标题 アリスちゃん",
        plot: "あいうえおのあらすじ",
        plot_zh: "已经翻译的简介 アリスちゃん",
        genres: ["Drama"],
        translation_failures: { title: "source echoed", plot: "source echoed", genres: "source echoed" },
      },
    });
    if (!entry.crawlerData) throw new Error("Missing fixture metadata");
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
    const generateText = vi.fn().mockResolvedValue('{"translations":["重新翻译的标题","重新翻译的简介"]}');
    const writeNfo = vi.fn(writePreparedNfo);
    const { service } = createService({
      scan: async () => [await readEntry()],
      scanVideo: readEntry,
      generateText,
      writeNfo,
      rootPath: root,
    });
    const config = createConfig();
    config.translate.llmApiKey = "";
    config.translate.llmModelName = "";
    const items = await service.scan(root, "untranslated", config);
    expect(items[0]).toMatchObject({ title: entry.crawlerData.title_zh, plot: entry.crawlerData.plot_zh });
    const originalXml = await readFile(nfoPath, "utf8");
    writeNfo.mockRejectedValueOnce(new Error("Permission denied"));
    expect((await service.apply(items, config, { mode: "ignore" }))[0]).toMatchObject({
      success: false,
      error: "Permission denied",
    });
    expect(await readFile(nfoPath, "utf8")).toBe(originalXml);
    const titleOnly: BatchTranslateScanItem[] = [{ ...items[0], pendingFields: ["title"] }];
    expect((await service.apply(titleOnly, config, { mode: "ignore" }))[0]).toMatchObject({
      success: true,
      translatedFields: ["title"],
    });
    const remaining = await service.scan(root, "untranslated", config);
    expect(remaining[0].pendingFields).toEqual(["plot", "genres"]);
    expect((await service.apply(remaining, config, { mode: "ignore" }))[0].success).toBe(true);
    expect(generateText).not.toHaveBeenCalled();
    const accepted = await readEntry();
    expect(accepted.crawlerData).toMatchObject({
      title: "あいうえおのタイトル",
      title_zh: entry.crawlerData.title_zh,
      plot: "あいうえおのあらすじ",
      plot_zh: entry.crawlerData.plot_zh,
      genres: ["Drama"],
      translation_ignored: { title: expect.any(String), plot: expect.any(String), genres: expect.any(String) },
    });
    expect(accepted.crawlerData.translation_failures).toBeUndefined();
    expect(accepted.nfoLocalState).toMatchObject({ tags: ["保留标签"], lockedFields: ["Cast"] });
    expect(await service.scan(root, "untranslated", config)).toEqual([]);
    const acceptedXml = await readFile(nfoPath, "utf8");
    await writeFile(nfoPath, acceptedXml.replace("已经翻译的简介 アリスちゃん", "変更されたあらすじ"));
    expect((await service.scan(root, "untranslated", config))[0].pendingFields).toEqual(["plot"]);
    await writeFile(nfoPath, acceptedXml);
    const all = await service.scan(root, "all", config);
    expect(all[0].pendingFields).toEqual(["title", "plot"]);
    expect((await service.apply(all, createConfig(), { mode: "all" }))[0].success).toBe(true);
    expect((await readEntry()).crawlerData.translation_ignored).toEqual({
      title: expect.any(String),
      plot: expect.any(String),
      genres: expect.any(String),
    });
    await writeFile(nfoPath, acceptedXml);
    const restore = await service.scan(root, "restore", config);
    expect((await service.apply(restore, config, { mode: "restore" }))[0].success).toBe(true);
    expect((await readEntry()).crawlerData).toMatchObject({
      title: "あいうえおのタイトル",
      plot: "あいうえおのあらすじ",
    });
    expect((await service.scan(root, "untranslated", config))[0].pendingFields).toEqual(["title", "plot"]);
  });

  it("persists successful fields as complete and retries only unfinished fields", async () => {
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
      .mockResolvedValueOnce('{"translations":["已完成的译名 アリスちゃん"]}')
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
    expect(first.title_zh).toBe("已完成的译名 アリスちゃん");
    expect(first.translation_ignored).toEqual({ title: expect.any(String) });
    expect(first.genres).toEqual(["剧情", "Travel"]);
    expect((await readEntry()).nfoLocalState).toMatchObject({ tags: ["保留标签"], lockedFields: ["Cast"] });

    generateText.mockResolvedValue('{"translations":["补译成功 アリスちゃん"]}');
    const pending = await service.scan(root, "untranslated", config);
    expect(pending[0].pendingFields).toEqual(["plot", "genres"]);
    const [repaired] = await service.apply(pending, config, { mode: "untranslated", maxBatchItems: 1 });
    expect(repaired.success).toBe(true);
    expect((await readEntry()).crawlerData.translation_failures).toBeUndefined();
    expect((await readEntry()).crawlerData.translation_ignored).toEqual({
      title: expect.any(String),
      plot: expect.any(String),
      genres: expect.any(String),
    });
    expect(await service.scan(root, "untranslated", config)).toEqual([]);
    const all = await service.scan(root, "all", config);
    expect(all[0].pendingFields).toEqual(["title", "plot"]);
    await writeFile(
      nfoPath,
      (await readFile(nfoPath, "utf8")).replace("已完成的译名 アリスちゃん", "あいうえおのタイトル変更"),
    );
    expect((await service.scan(root, "untranslated", config))[0].pendingFields).toEqual(["title"]);
  });
});
