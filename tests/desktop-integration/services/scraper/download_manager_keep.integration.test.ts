import { access, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { configurationSchema, defaultConfiguration } from "@main/services/config";
import type { RuntimeDownloadNetworkClient, RuntimeProbeResult } from "@mdcz/runtime";
import { PersistentCooldownStore } from "@mdcz/runtime/cooldown";
import { resolvePublicationAssetLayout } from "@mdcz/runtime/publication/assetLayout";
import { prepareMovieArtifacts } from "@mdcz/runtime/publication/movieArtifacts";
import { WriteOutput } from "@mdcz/runtime/publication/WriteOutput";
import {
  DirectoryInventory,
  DownloadManager,
  downloadCrawlerAssets,
  type ImageAlternatives,
  NfoGenerator,
} from "@mdcz/runtime/scrape";
import { resolveThumbToPosterCropRegion } from "@mdcz/runtime/scrape/download/assets/PosterImageDerivationService";
import { SceneImageAssetDownloader } from "@mdcz/runtime/scrape/download/assets/SceneImageAssetDownloader";
import { TrailerAssetDownloader } from "@mdcz/runtime/scrape/download/assets/TrailerAssetDownloader";
import * as imageUtils from "@mdcz/runtime/scrape/utils/image";
import { Website } from "@mdcz/shared/enums";
import type { CrawlerData } from "@mdcz/shared/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTempDirectory, type TempDirectoryHarness } from "../../../harness/tempDirectory";

const tempDirs: TempDirectoryHarness[] = [];
const sharp = createRequire(new URL("../../../../packages/runtime/package.json", import.meta.url))("sharp");
const createTempDir = async (): Promise<string> => {
  const directory = await createTempDirectory("download-manager");
  tempDirs.push(directory);
  return directory.path;
};

const createConfig = (overrides: Record<string, unknown> = {}) =>
  configurationSchema.parse({ ...defaultConfiguration, ...overrides });

const createCrawlerData = (overrides: Partial<CrawlerData> = {}): CrawlerData => ({
  title: "Sample",
  number: "ABC-123",
  actors: [],
  genres: [],
  scene_images: [],
  website: Website.DMM,
  ...overrides,
});

const dl = (overrides: Partial<typeof defaultConfiguration.download> = {}) =>
  createConfig({ download: { ...defaultConfiguration.download, ...overrides } });

const primaryOnly = () =>
  dl({
    keepThumb: false,
    keepPoster: false,
    downloadFanart: false,
    downloadSceneImages: false,
    downloadTrailer: false,
  });

const sceneOnly = (extra: Partial<typeof defaultConfiguration.download> = {}) =>
  dl({
    downloadThumb: false,
    downloadPoster: false,
    downloadFanart: false,
    downloadTrailer: false,
    ...extra,
  });

const sequentialSceneSet = (maxSceneImages: number) =>
  createConfig({
    download: {
      ...defaultConfiguration.download,
      downloadThumb: false,
      downloadPoster: false,
      downloadFanart: false,
      downloadTrailer: false,
      keepSceneImages: false,
      sceneImageConcurrency: 1,
    },
    aggregation: {
      ...defaultConfiguration.aggregation,
      behavior: { ...defaultConfiguration.aggregation.behavior, maxSceneImages },
    },
  });

const seedFiles = async (root: string, files: Record<string, string>): Promise<void> => {
  await Promise.all(
    Object.entries(files).map(async ([relativePath, content]) => {
      const filePath = join(root, relativePath);
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, content, "utf8");
    }),
  );
};

const writeDownloadedFile = async (outputPath: string, url: string): Promise<string> => {
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `downloaded:${url}`, "utf8");
  return outputPath;
};

const writeSvgImage = async (
  outputPath: string,
  options: { width: number; height: number; color: string; minBytes?: number },
): Promise<void> => {
  await mkdir(dirname(outputPath), { recursive: true });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${options.width}" height="${options.height}"><rect width="100%" height="100%" fill="${options.color}"/></svg>`;
  const padding = " ".repeat(Math.max(0, (options.minBytes ?? 0) - svg.length));
  await writeFile(outputPath, `${svg}${padding}`, "utf8");
};

class FakeNetworkClient {
  readonly download = vi.fn(async (url: string, outputPath: string) => await writeDownloadedFile(outputPath, url));
  readonly probe = vi.fn(
    async (url: string): Promise<RuntimeProbeResult> => ({
      ok: true,
      status: 200,
      contentLength: 1024,
      resolvedUrl: url,
    }),
  );
}

const createSubject = async (
  files: Record<string, string> = {},
  options: { imageHostCooldownStore?: PersistentCooldownStore } = {},
) => {
  const root = await createTempDir();
  await seedFiles(root, files);
  const networkClient = new FakeNetworkClient();
  const imageHostCooldownStore =
    options.imageHostCooldownStore ??
    new PersistentCooldownStore({
      filePath: join(root, "image-host-cooldowns.json"),
    });
  const logger = { info: vi.fn(), warn: vi.fn() };
  const manager = new DownloadManager(networkClient as unknown as RuntimeDownloadNetworkClient, {
    imageHostCooldownStore,
    logger,
  });
  return { root, networkClient, manager, logger };
};

const mockValid = (valid = true) =>
  vi
    .spyOn(imageUtils, "validateImage")
    .mockResolvedValue(
      valid ? { valid: true, width: 1, height: 1 } : { valid: false, width: 0, height: 0, reason: "parse_failed" },
    );

const mockResolutionAwarePrimaryValidation = () =>
  vi.spyOn(imageUtils, "validateImage").mockImplementation(async (filePath: string) => {
    const content = await readFile(filePath, "utf8");
    const table: Record<string, { width: number; height: number }> = {
      "thumb-tiny": { width: 400, height: 300 },
      "thumb-low": { width: 800, height: 600 },
      "thumb-high": { width: 1_600, height: 1_200 },
      "poster-tiny": { width: 300, height: 450 },
      "poster-low": { width: 600, height: 900 },
      "poster-high": { width: 1_200, height: 1_800 },
    };
    for (const [key, size] of Object.entries(table)) {
      if (content.includes(key)) return { valid: true, ...size };
    }
    return { valid: false, width: 0, height: 0, reason: "parse_failed" };
  });

const mockPrimaryProbe = (
  networkClient: FakeNetworkClient,
  options: { includeDimensions: boolean; withoutDimensions?: string[] },
) => {
  networkClient.probe.mockImplementation(async (url: string): Promise<RuntimeProbeResult> => {
    const variant = url.includes("-tiny.") ? "tiny" : url.includes("-low.") ? "low" : "high";
    const isThumb = url.includes("thumb");
    const dims = options.includeDimensions && !options.withoutDimensions?.includes(url);
    const size =
      variant === "high"
        ? isThumb
          ? [1_600, 1_200]
          : [1_200, 1_800]
        : variant === "low"
          ? isThumb
            ? [800, 600]
            : [600, 900]
          : isThumb
            ? [400, 300]
            : [300, 450];
    return {
      ok: true,
      status: 200,
      contentLength: variant === "high" ? 20_000 : variant === "low" ? 10_000 : 1_000,
      resolvedUrl: url,
      ...(dims ? { width: size[0], height: size[1] } : {}),
    };
  });
};

const scenePath = (root: string, index: number) => join(root, "extrafanart", `fanart${index}.jpg`);

const expectSceneImages = async (
  root: string,
  assets: Awaited<ReturnType<DownloadManager["downloadAll"]>>,
  expectedUrls: string[],
) => {
  const expectedPaths = expectedUrls.map((_, index) => scenePath(root, index + 1));
  expect(assets.sceneImages).toEqual(expectedPaths);
  await Promise.all(
    expectedUrls.map(async (url, index) => {
      const expectedPath = expectedPaths[index];
      if (!expectedPath) throw new Error(`Missing scene image path at index ${index}`);
      await expect(readFile(expectedPath, "utf8")).resolves.toBe(`downloaded:${url}`);
    }),
  );
};

const downloadPrimary = (
  manager: DownloadManager,
  root: string,
  data: Partial<CrawlerData>,
  alternatives: Partial<ImageAlternatives> = {},
) => manager.downloadAll(root, createCrawlerData(data), primaryOnly(), alternatives);

const expectPrimary = async (
  root: string,
  assets: Awaited<ReturnType<DownloadManager["downloadAll"]>>,
  thumbUrl: string,
  posterUrl: string,
) => {
  expect(assets.thumb).toBe(join(root, "thumb.jpg"));
  expect(assets.poster).toBe(join(root, "poster.jpg"));
  await expect(readFile(join(root, "thumb.jpg"), "utf8")).resolves.toBe(`downloaded:${thumbUrl}`);
  await expect(readFile(join(root, "poster.jpg"), "utf8")).resolves.toBe(`downloaded:${posterUrl}`);
};

describe("DownloadManager keep flags", () => {
  it("does not enter scene or trailer downloaders when their download switches are off", async () => {
    const { root, manager, networkClient } = await createSubject();
    const sceneDownload = vi.spyOn(SceneImageAssetDownloader.prototype, "download");
    const trailerDownload = vi.spyOn(TrailerAssetDownloader.prototype, "download");

    const config = dl({
      downloadThumb: false,
      downloadPoster: false,
      downloadFanart: false,
      downloadSceneImages: false,
      downloadTrailer: false,
    });
    const crawlerData = createCrawlerData({
      scene_images: ["https://example.com/scene-001.jpg"],
      trailer_url: "https://example.com/trailer.mp4",
    });
    const assets = await downloadCrawlerAssets({
      config,
      crawlerData,
      downloadManager: manager,
      fileInfo: {
        filePath: join(root, "ABC-123.mp4"),
        fileName: "ABC-123.mp4",
        extension: ".mp4",
        number: "ABC-123",
        isSubtitled: false,
      },
      outputDir: root,
    });

    expect(assets.assets).toEqual({ sceneImages: [], downloaded: [] });
    expect(sceneDownload).not.toHaveBeenCalled();
    expect(trailerDownload).not.toHaveBeenCalled();
    expect(networkClient.probe).not.toHaveBeenCalled();
    expect(networkClient.download).not.toHaveBeenCalled();
    await expect(access(join(root, "extrafanart", "fanart1.jpg"))).rejects.toThrow();
    await expect(access(join(root, "trailer.mp4"))).rejects.toThrow();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(tempDirs.splice(0, tempDirs.length).map((directory) => directory.cleanup()));
  });

  it("names companion assets after the shared movie base when follow-video naming is enabled", async () => {
    const { root, manager } = await createSubject();
    mockValid();
    const assets = await manager.downloadAll(
      root,
      createCrawlerData({
        thumb_url: "https://example.com/thumb.jpg",
        poster_url: "https://example.com/poster.jpg",
        trailer_url: "https://example.com/trailer.mp4",
      }),
      createConfig({
        naming: { ...defaultConfiguration.naming, assetNamingMode: "followVideo" },
        download: {
          ...defaultConfiguration.download,
          keepThumb: false,
          keepPoster: false,
          keepFanart: false,
          keepTrailer: false,
          downloadSceneImages: false,
        },
      }),
      {},
      undefined,
      { movieBaseName: "ABC-123-CEN" },
    );

    for (const [name, url] of [
      ["ABC-123-CEN-thumb.jpg", "https://example.com/thumb.jpg"],
      ["ABC-123-CEN-poster.jpg", "https://example.com/poster.jpg"],
      ["ABC-123-CEN-trailer.mp4", "https://example.com/trailer.mp4"],
    ] as const) {
      expect(assets[name.includes("thumb") ? "thumb" : name.includes("poster") ? "poster" : "trailer"]).toBe(
        join(root, name),
      );
      await expect(readFile(join(root, name), "utf8")).resolves.toBe(`downloaded:${url}`);
    }
    expect(assets.fanart).toBe(join(root, "ABC-123-CEN-fanart.jpg"));
  });

  it("reuses existing sidecar assets when keep flags are enabled", async () => {
    const { root, manager, networkClient } = await createSubject({
      "thumb.jpg": "thumb",
      "poster.jpg": "poster",
      "fanart.jpg": "fanart",
      "trailer.mp4": "trailer",
      "extrafanart/fanart1.jpg": "scene",
    });
    const stagingDir = await createTempDir();
    const assets = await manager.downloadAll(
      stagingDir,
      createCrawlerData({
        thumb_url: "https://example.com/thumb.jpg",
        poster_url: "https://example.com/poster.jpg",
        fanart_url: "https://example.com/fanart.jpg",
        trailer_url: "https://example.com/trailer.mp4",
        scene_images: ["https://example.com/scene-001.jpg"],
      }),
      createConfig(),
      {},
      undefined,
      { existingAssetDir: root },
    );
    expect(assets).toMatchObject({
      thumb: join(root, "thumb.jpg"),
      poster: join(root, "poster.jpg"),
      fanart: join(root, "fanart.jpg"),
      trailer: join(root, "trailer.mp4"),
      sceneImages: [scenePath(root, 1)],
      downloaded: [],
    });
    expect(networkClient.probe).not.toHaveBeenCalled();
    expect(networkClient.download).not.toHaveBeenCalled();
  });

  it("applies maintenance trailer replacement decisions", async () => {
    for (const [trailerUrl, content, downloads] of [
      ["https://example.com/trailer-new.mp4", "downloaded:https://example.com/trailer-new.mp4", 1],
      [undefined, "old-trailer", 0],
    ] as const) {
      vi.restoreAllMocks();
      const { root, manager, networkClient } = await createSubject({ "trailer.mp4": "old-trailer" });
      const assets = await manager.downloadAll(
        root,
        createCrawlerData({ trailer_url: trailerUrl }),
        dl({
          downloadThumb: false,
          downloadPoster: false,
          downloadFanart: false,
          downloadSceneImages: false,
          keepTrailer: true,
        }),
        {},
        { assetDecisions: { trailer: "replace" } },
      );
      expect(assets.trailer).toBe(trailerUrl ? join(root, "trailer.mp4") : undefined);
      expect(assets.downloaded).toEqual(downloads ? [join(root, "trailer.mp4")] : []);
      await expect(readFile(join(root, "trailer.mp4"), "utf8")).resolves.toBe(content);
      expect(networkClient.download).toHaveBeenCalledTimes(downloads);
    }
  });

  it("keeps the first sample image for scene images when an existing fanart is reused", async () => {
    const { root, manager, networkClient } = await createSubject({ "fanart.jpg": "fanart" });
    mockValid();
    const sceneUrls = ["https://example.com/scene-001.jpg", "https://example.com/scene-002.jpg"];
    const assets = await manager.downloadAll(
      root,
      createCrawlerData({ scene_images: sceneUrls }),
      dl({ downloadThumb: false, downloadPoster: false, downloadTrailer: false }),
    );
    expect(assets.fanart).toBe(join(root, "fanart.jpg"));
    await expectSceneImages(root, assets, sceneUrls);
    expect(networkClient.download).toHaveBeenCalledTimes(2);
  });

  it("uses a smaller minimum byte threshold for scene images than primary artwork", async () => {
    const { root, manager } = await createSubject();
    vi.spyOn(imageUtils, "validateImage").mockImplementation(async (_filePath, minBytes = 8192) =>
      minBytes <= 4096
        ? { valid: true, width: 640, height: 360 }
        : { valid: false, width: 0, height: 0, reason: "file_too_small" },
    );
    const assets = await manager.downloadAll(
      root,
      createCrawlerData({ scene_images: ["https://example.com/scene-001.jpg"] }),
      sceneOnly(),
    );
    await expectSceneImages(root, assets, ["https://example.com/scene-001.jpg"]);
  });

  it("saves downloaded WebP scene images with WebP file extensions", async () => {
    const { root, manager } = await createSubject({ "extrafanart/fanart1.jpg": "old-scene" });
    vi.spyOn(imageUtils, "validateImage").mockResolvedValue({
      valid: true,
      width: 640,
      height: 360,
      format: "webp",
    });
    const assets = await manager.downloadAll(
      root,
      createCrawlerData({ scene_images: ["https://example.com/scene-001.jpg"] }),
      sceneOnly({ keepSceneImages: false }),
    );
    const webp = join(root, "extrafanart", "fanart1.webp");
    expect(assets.sceneImages).toEqual([webp]);
    expect(assets.downloaded).toEqual([webp]);
    await expect(readFile(webp, "utf8")).resolves.toBe("downloaded:https://example.com/scene-001.jpg");
    await expect(readFile(scenePath(root, 1), "utf8")).resolves.toBe("old-scene");
  });

  it("derives fanart from the landscape cover whether or not the thumb itself is downloaded", async () => {
    const cases = [
      {
        seed: { "thumb.jpg": "thumb" },
        data: createCrawlerData(),
        config: dl({ downloadTrailer: false, downloadSceneImages: false }),
        alternatives: {},
        setup: () => {},
        assert: async (
          root: string,
          assets: Awaited<ReturnType<DownloadManager["downloadAll"]>>,
          networkClient: FakeNetworkClient,
        ) => {
          expect(assets.thumb).toBe(join(root, "thumb.jpg"));
          expect(assets.poster).toBeUndefined();
          expect(assets.fanart).toBe(join(root, "fanart.jpg"));
          expect(assets.downloaded).toEqual([join(root, "fanart.jpg")]);
          await expect(readFile(join(root, "fanart.jpg"), "utf8")).resolves.toBe("thumb");
          expect(networkClient.download).not.toHaveBeenCalled();
        },
      },
      {
        seed: {},
        data: createCrawlerData({
          thumb_url: "https://example.com/thumb.jpg",
          scene_images: ["https://example.com/scene-001.jpg", "https://example.com/scene-002.jpg"],
        }),
        config: dl({ downloadThumb: false, downloadTrailer: false }),
        alternatives: { thumb_url: ["https://example.com/thumb-alt.jpg"] as string[] },
        setup: () => mockValid(),
        assert: async (
          root: string,
          assets: Awaited<ReturnType<DownloadManager["downloadAll"]>>,
          networkClient: FakeNetworkClient,
        ) => {
          expect(assets.thumb).toBeUndefined();
          expect(assets.fanart).toBe(join(root, "fanart.jpg"));
          await expect(readFile(join(root, "fanart.jpg"), "utf8")).resolves.toBe(
            "downloaded:https://example.com/thumb.jpg",
          );
          await expect(access(join(root, "thumb.jpg"))).rejects.toThrow();
          await expectSceneImages(root, assets, [
            "https://example.com/scene-001.jpg",
            "https://example.com/scene-002.jpg",
          ]);
          expect(networkClient.download).not.toHaveBeenCalledWith(
            "https://example.com/thumb-alt.jpg",
            expect.any(String),
          );
        },
      },
      {
        seed: {},
        data: createCrawlerData({
          scene_images: [
            "javascript:void(0)",
            "https://example.com/scene-001.jpg",
            "https://example.com/scene-002.jpg",
          ],
        }),
        config: dl({ downloadThumb: false, downloadPoster: false, downloadTrailer: false }),
        alternatives: {},
        setup: () => mockValid(),
        assert: async (
          root: string,
          assets: Awaited<ReturnType<DownloadManager["downloadAll"]>>,
          networkClient: FakeNetworkClient,
        ) => {
          expect(assets.fanart).toBeUndefined();
          await expectSceneImages(root, assets, [
            "https://example.com/scene-001.jpg",
            "https://example.com/scene-002.jpg",
          ]);
          expect(networkClient.download).not.toHaveBeenCalledWith("javascript:void(0)", expect.any(String));
        },
      },
      {
        seed: { "fanart.jpg": "fanart" },
        data: createCrawlerData(),
        config: dl({ downloadPoster: false, downloadSceneImages: false, downloadTrailer: false }),
        alternatives: {},
        setup: () => {},
        assert: async (
          root: string,
          assets: Awaited<ReturnType<DownloadManager["downloadAll"]>>,
          networkClient: FakeNetworkClient,
        ) => {
          expect(assets.fanart).toBe(join(root, "fanart.jpg"));
          expect(assets.thumb).toBeUndefined();
          await expect(access(join(root, "thumb.jpg"))).rejects.toThrow();
          expect(networkClient.download).not.toHaveBeenCalled();
        },
      },
    ] as const satisfies readonly {
      seed: Record<string, string>;
      data: CrawlerData;
      config: ReturnType<typeof dl>;
      alternatives: { thumb_url?: string[] };
      setup: () => void;
      assert: (
        root: string,
        assets: Awaited<ReturnType<DownloadManager["downloadAll"]>>,
        networkClient: FakeNetworkClient,
      ) => Promise<void>;
    }[];

    for (const testCase of cases) {
      vi.restoreAllMocks();
      const { root, manager, networkClient } = await createSubject({ ...testCase.seed });
      testCase.setup();
      await testCase.assert(
        root,
        await manager.downloadAll(root, testCase.data, testCase.config, testCase.alternatives),
        networkClient,
      );
    }
  });

  it("refreshes or preserves primary artwork according to keep flags, decisions, and validation", async () => {
    const cases = [
      {
        valid: true,
        keep: false,
        force: false,
        content: "downloaded:https://example.com/thumb-new.jpg",
        downloaded: true,
        probes: 1,
      },
      { valid: false, keep: false, force: false, content: "old-thumb", downloaded: false, probes: 1 },
      {
        valid: true,
        keep: true,
        force: true,
        content: "downloaded:https://example.com/thumb-new.jpg",
        downloaded: true,
        probes: 1,
      },
      {
        valid: true,
        keep: false,
        force: false,
        decision: "preserve",
        content: "old-thumb",
        downloaded: false,
        probes: 0,
      },
      {
        valid: true,
        keep: true,
        force: false,
        decision: "replace",
        content: "downloaded:https://example.com/thumb-new.jpg",
        downloaded: true,
        probes: 1,
      },
    ] as const;

    for (const testCase of cases) {
      vi.restoreAllMocks();
      const { root, manager, networkClient, logger } = await createSubject({ "thumb.jpg": "old-thumb" });
      mockValid(testCase.valid);
      const assets = await manager.downloadAll(
        root,
        createCrawlerData({ thumb_url: "https://example.com/thumb-new.jpg" }),
        dl({
          keepThumb: testCase.keep,
          downloadPoster: false,
          downloadFanart: false,
          downloadSceneImages: false,
          downloadTrailer: false,
        }),
        {},
        {
          forceReplace: testCase.force ? { thumb: true } : undefined,
          assetDecisions: "decision" in testCase ? { thumb: testCase.decision } : undefined,
        },
      );
      expect(assets.thumb).toBe(join(root, "thumb.jpg"));
      expect(assets.downloaded).toEqual(testCase.downloaded ? [join(root, "thumb.jpg")] : []);
      await expect(readFile(join(root, "thumb.jpg"), "utf8")).resolves.toBe(testCase.content);
      expect(networkClient.probe).toHaveBeenCalledTimes(testCase.probes);
      expect(networkClient.download).toHaveBeenCalledTimes(testCase.probes);
      const sourceLog = logger.info.mock.calls.find(([message]) => message.startsWith("[image-sources] "))?.[0];
      expect(JSON.parse(sourceLog?.slice("[image-sources] ".length) ?? "null")).toMatchObject({
        number: "ABC-123",
        fields: {
          thumb: [
            { status: testCase.downloaded ? "downloaded" : "local", source: testCase.downloaded ? "unknown" : "local" },
          ],
          poster: { status: "disabled" },
        },
      });
    }

    vi.restoreAllMocks();
    const { root, manager, networkClient } = await createSubject({
      "poster.jpg": "old-poster",
      "fanart.jpg": "old-fanart",
    });
    const stagingDir = await createTempDir();
    mockValid();
    const preserved = await manager.downloadAll(
      stagingDir,
      createCrawlerData({
        thumb_url: "https://example.com/thumb-new.jpg",
        poster_url: "https://example.com/poster-new.jpg",
      }),
      dl({
        keepThumb: false,
        keepPoster: false,
        keepFanart: false,
        downloadSceneImages: false,
        downloadTrailer: false,
      }),
      {},
      { assetDecisions: { poster: "preserve", fanart: "preserve" } },
      { existingAssetDir: root },
    );
    expect(preserved.poster).toBe(join(root, "poster.jpg"));
    expect(preserved.fanart).toBe(join(root, "fanart.jpg"));
    expect(networkClient.download.mock.calls.map(([url]) => url)).toEqual(["https://example.com/thumb-new.jpg"]);
    await expect(readFile(join(root, "poster.jpg"), "utf8")).resolves.toBe("old-poster");
    await expect(readFile(join(root, "fanart.jpg"), "utf8")).resolves.toBe("old-fanart");

    vi.restoreAllMocks();
    const replacement = await createSubject({ "poster.jpg": "old-poster", "fanart.jpg": "old-fanart" });
    const replacementStage = await createTempDir();
    mockValid();
    const replaced = await replacement.manager.downloadAll(
      replacementStage,
      createCrawlerData({ poster_url: "https://example.com/poster-new.jpg" }),
      dl({ downloadThumb: false, keepPoster: true, downloadSceneImages: false, downloadTrailer: false }),
      {},
      { assetDecisions: { poster: "replace", fanart: "preserve" } },
      { existingAssetDir: replacement.root },
    );
    expect(replaced.poster).toBe(join(replacementStage, "poster.jpg"));
    expect(replaced.fanart).toBe(join(replacement.root, "fanart.jpg"));
    expect(replacement.networkClient.download.mock.calls.map(([url]) => url)).toEqual([
      "https://example.com/poster-new.jpg",
    ]);
  });

  it("saves downloaded WebP artwork with WebP file extensions", async () => {
    const { root, manager } = await createSubject({ "thumb.jpg": "old-thumb", "fanart.jpg": "old-fanart" });
    vi.spyOn(imageUtils, "validateImage").mockResolvedValue({
      valid: true,
      width: 640,
      height: 360,
      format: "webp",
    });
    const assets = await manager.downloadAll(
      root,
      createCrawlerData({
        thumb_url: "https://example.com/thumb.jpg",
        poster_url: "https://example.com/poster.jpg",
      }),
      dl({
        keepThumb: false,
        keepPoster: false,
        keepFanart: false,
        downloadSceneImages: false,
        downloadTrailer: false,
      }),
    );
    expect(assets.thumb).toBe(join(root, "thumb.webp"));
    expect(assets.poster).toBe(join(root, "poster.webp"));
    expect(assets.fanart).toBe(join(root, "fanart.webp"));
    expect(assets.downloaded).toEqual([join(root, "thumb.webp"), join(root, "poster.webp"), join(root, "fanart.webp")]);
    await expect(readFile(join(root, "thumb.jpg"), "utf8")).resolves.toBe("old-thumb");
    await expect(readFile(join(root, "fanart.jpg"), "utf8")).resolves.toBe("old-fanart");
  });

  it("derives a missing poster from WebP artwork and releases its source for publication", async () => {
    const { root, manager, networkClient } = await createSubject();
    const webp = await sharp({ create: { width: 800, height: 439, channels: 3, background: "#4a8bd6" } })
      .webp()
      .toBuffer();
    networkClient.download.mockImplementation(async (url, outputPath) => {
      if (url.includes("thumb")) {
        await writeFile(outputPath, webp);
        return outputPath;
      }
      return writeDownloadedFile(outputPath, url);
    });
    const validateSpy = vi.spyOn(imageUtils, "validateImage").mockResolvedValue({
      valid: true,
      width: 800,
      height: 439,
      format: "webp",
    });
    const data = createCrawlerData({
      thumb_url: "https://example.com/thumb.jpg",
      thumb_source_url: "https://source.example.com/thumb.jpg",
      poster_url: undefined,
    });
    const onDerivedPosterSource = vi.fn();
    const assets = await manager.downloadAll(
      root,
      data,
      dl({
        keepThumb: false,
        keepPoster: false,
        downloadFanart: false,
        downloadSceneImages: false,
        downloadTrailer: false,
      }),
      {},
      { onDerivedPosterSource },
    );
    validateSpy.mockRestore();
    const cropRegion = resolveThumbToPosterCropRegion(800, 439);
    expect(cropRegion).not.toBeNull();
    expect(assets.thumb).toBe(join(root, "thumb.webp"));
    expect(assets.poster).toBe(join(root, "poster.jpg"));
    expect(assets.downloaded).toEqual([join(root, "thumb.webp"), join(root, "poster.jpg")]);
    expect(data.poster_source_url).toBeUndefined();
    expect(onDerivedPosterSource).toHaveBeenCalledWith("https://source.example.com/thumb.jpg");
    expect(await imageUtils.validateImage(join(root, "poster.jpg"), 1)).toMatchObject({
      valid: true,
      width: cropRegion?.width,
      height: cropRegion?.height,
    });
    expect(networkClient.download).toHaveBeenCalledTimes(1);
    await rename(join(root, "thumb.webp"), join(root, "published-thumb.webp"));
    expect(await readFile(join(root, "published-thumb.webp"))).toEqual(webp);
  });

  it("crops tiny posters and copies fanart from one cover download, with or without the thumb", async () => {
    for (const downloadThumb of [true, false]) {
      const { root, manager, networkClient, logger } = await createSubject();
      networkClient.download.mockImplementation(async (url, outputPath) => {
        if (url.includes("thumb")) {
          await writeSvgImage(outputPath, { width: 800, height: 500, color: "#4a8bd6" });
          return outputPath;
        }
        if (url.includes("poster")) {
          await writeSvgImage(outputPath, { width: 120, height: 180, color: "#d64a4a" });
          return outputPath;
        }
        return writeDownloadedFile(outputPath, url);
      });
      const validateSpy = vi.spyOn(imageUtils, "validateImage").mockResolvedValue({
        valid: true,
        width: 800,
        height: 500,
        format: "jpeg",
      });
      const data = createCrawlerData({
        thumb_url: "https://example.com/thumb.jpg",
        poster_url: "https://example.com/poster.jpg",
      });
      const onDerivedPosterSource = vi.fn();
      const config = dl({
        downloadThumb,
        keepThumb: false,
        keepPoster: false,
        downloadFanart: true,
        keepFanart: false,
        downloadSceneImages: false,
        downloadTrailer: false,
      });
      const assets = await manager.downloadAll(
        root,
        data,
        config,
        {
          image_sources: {
            thumb_url: { "https://example.com/thumb.jpg": Website.JAVBUS },
            poster_url: { "https://example.com/poster.jpg": Website.JAVDB },
          },
        },
        { onDerivedPosterSource },
      );
      validateSpy.mockRestore();
      const cropRegion = resolveThumbToPosterCropRegion(800, 500);
      expect(assets.poster).toBe(join(root, "poster.jpg"));
      expect(assets.thumb).toBe(downloadThumb ? join(root, "thumb.jpg") : undefined);
      expect(assets.fanart).toBe(join(root, "fanart.jpg"));
      expect(assets.downloaded).toEqual([
        ...(downloadThumb ? [join(root, "thumb.jpg")] : []),
        join(root, "poster.jpg"),
        join(root, "fanart.jpg"),
      ]);
      expect(networkClient.download.mock.calls.filter(([url]) => String(url).includes("thumb"))).toHaveLength(1);
      if (!downloadThumb) await expect(access(join(root, "thumb.jpg"))).rejects.toThrow();
      expect(data.poster_source_url).toBeUndefined();
      expect(onDerivedPosterSource).toHaveBeenCalledWith("https://example.com/thumb.jpg");
      const sourceLog = logger.info.mock.calls.find(([message]) => message.startsWith("[image-sources] "))?.[0];
      const fields = JSON.parse(sourceLog?.slice("[image-sources] ".length) ?? "null").fields;
      const derived = {
        status: "derived",
        source: Website.JAVBUS,
        host: "example.com",
        derivedFrom: downloadThumb ? "thumb" : "cover",
      };
      expect(fields.poster).toEqual([derived]);
      expect(fields.fanart).toEqual([derived]);
      expect(await imageUtils.validateImage(join(root, "poster.jpg"), 1)).toMatchObject({
        valid: true,
        width: cropRegion?.width,
        height: cropRegion?.height,
      });
    }
  });

  it("keeps a large poster and uses a portrait thumb as the poster", async () => {
    for (const testCase of [
      {
        seed: async (root: string) => {
          await writeSvgImage(join(root, "thumb.jpg"), { width: 800, height: 500, color: "#4a8bd6" });
          await writeSvgImage(join(root, "poster.jpg"), {
            width: 800,
            height: 1200,
            color: "#d64a4a",
            minBytes: 50_000,
          });
        },
      },
      {
        seed: async (root: string) => {
          await writeSvgImage(join(root, "thumb.jpg"), { width: 800, height: 1200, color: "#4a8bd6" });
        },
      },
    ]) {
      const { root, manager } = await createSubject();
      await testCase.seed(root);
      const data = createCrawlerData({ thumb_url: "https://example.com/thumb.jpg" });
      const assets = await manager.downloadAll(
        root,
        data,
        dl({
          keepThumb: true,
          keepPoster: true,
          downloadFanart: false,
          downloadSceneImages: false,
          downloadTrailer: false,
        }),
      );
      expect(assets.thumb).toBe(join(root, "thumb.jpg"));
      expect(data.poster_source_url).toBeUndefined();
      expect(assets.poster).toBe(join(root, "poster.jpg"));
    }
  });

  it("uses probe metadata to minimize primary artwork downloads", async () => {
    const cases = [
      {
        setup: (networkClient: FakeNetworkClient) => {
          mockResolutionAwarePrimaryValidation();
          networkClient.probe.mockImplementation(async (url) =>
            url.includes("-missing.")
              ? { ok: false, status: 404, contentLength: null, resolvedUrl: url }
              : { ok: true, status: 200, contentLength: 20_000, resolvedUrl: url },
          );
        },
        data: {
          thumb_url: "https://example.com/thumb-missing.jpg",
          poster_url: "https://example.com/poster-missing.jpg",
        },
        alternatives: {
          thumb_url: ["https://cdn.example.com/thumb-high.jpg"],
          poster_url: ["https://cdn.example.com/poster-high.jpg"],
        },
        expectedThumb: "https://cdn.example.com/thumb-high.jpg",
        expectedPoster: "https://cdn.example.com/poster-high.jpg",
        expectedDownloadCalls: ["https://cdn.example.com/thumb-high.jpg", "https://cdn.example.com/poster-high.jpg"],
        rejectedDownloads: ["https://example.com/thumb-missing.jpg", "https://example.com/poster-missing.jpg"],
      },
      {
        setup: (networkClient: FakeNetworkClient) => {
          mockPrimaryProbe(networkClient, { includeDimensions: false });
          mockResolutionAwarePrimaryValidation();
        },
        data: {
          thumb_url: "https://example.com/thumb-low.jpg",
          poster_url: "https://example.com/poster-low.jpg",
        },
        alternatives: {
          thumb_url: ["https://cdn.example.com/thumb-high.jpg"],
          poster_url: ["https://cdn.example.com/poster-high.jpg"],
        },
        expectedThumb: "https://cdn.example.com/thumb-high.jpg",
        expectedPoster: "https://cdn.example.com/poster-high.jpg",
        expectedProbeCalls: 4,
        expectedDownloadCalls: [
          "https://example.com/thumb-low.jpg",
          "https://cdn.example.com/thumb-high.jpg",
          "https://example.com/poster-low.jpg",
          "https://cdn.example.com/poster-high.jpg",
        ],
        rejectedDownloads: [] as string[],
      },
      {
        setup: (networkClient: FakeNetworkClient) => {
          mockPrimaryProbe(networkClient, {
            includeDimensions: true,
            withoutDimensions: ["https://cdn.example.com/thumb-high.jpg", "https://cdn.example.com/poster-high.jpg"],
          });
          mockResolutionAwarePrimaryValidation();
        },
        data: {
          thumb_url: "https://example.com/thumb-low.jpg",
          poster_url: "https://example.com/poster-low.jpg",
        },
        alternatives: {
          thumb_url: ["https://cdn.example.com/thumb-tiny.jpg", "https://cdn.example.com/thumb-high.jpg"],
          poster_url: ["https://cdn.example.com/poster-tiny.jpg", "https://cdn.example.com/poster-high.jpg"],
        },
        expectedThumb: "https://cdn.example.com/thumb-high.jpg",
        expectedPoster: "https://cdn.example.com/poster-high.jpg",
        expectedProbeCalls: 6,
        expectedDownloadCalls: [
          "https://example.com/thumb-low.jpg",
          "https://cdn.example.com/thumb-high.jpg",
          "https://example.com/poster-low.jpg",
          "https://cdn.example.com/poster-high.jpg",
        ],
        rejectedDownloads: ["https://cdn.example.com/thumb-tiny.jpg", "https://cdn.example.com/poster-tiny.jpg"],
      },
    ];

    for (const testCase of cases) {
      vi.restoreAllMocks();
      const { root, manager, networkClient, logger } = await createSubject();
      testCase.setup(networkClient);
      const assets = await downloadPrimary(manager, root, testCase.data, {
        ...testCase.alternatives,
        image_sources: {
          thumb_url: {
            [testCase.data.thumb_url]: Website.JAVBUS,
            [testCase.expectedThumb]: Website.JAVDB,
          },
          poster_url: {
            [testCase.data.poster_url]: Website.JAVBUS,
            [testCase.expectedPoster]: Website.JAVDB,
          },
        },
      });
      await expectPrimary(root, assets, testCase.expectedThumb, testCase.expectedPoster);
      const downloadedUrls = networkClient.download.mock.calls.map(([url]) => url);
      expect(downloadedUrls).toEqual(expect.arrayContaining(testCase.expectedDownloadCalls));
      for (const rejectedUrl of testCase.rejectedDownloads) {
        expect(downloadedUrls).not.toEqual(expect.arrayContaining([rejectedUrl]));
      }
      if ("expectedProbeCalls" in testCase && testCase.expectedProbeCalls !== undefined) {
        expect(networkClient.probe).toHaveBeenCalledTimes(testCase.expectedProbeCalls);
      }
      const sourceLog = logger.info.mock.calls.find(([message]) => message.startsWith("[image-sources] "))?.[0];
      expect(JSON.parse(sourceLog?.slice("[image-sources] ".length) ?? "null")).toMatchObject({
        number: "ABC-123",
        fields: {
          thumb: [{ status: "downloaded", source: Website.JAVDB, host: "cdn.example.com" }],
          poster: [{ status: "downloaded", source: Website.JAVDB, host: "cdn.example.com" }],
        },
      });
      expect(sourceLog).not.toContain("https://");
    }
  });

  it("updates active scene image sets without deleting old output files", async () => {
    const cases = [
      {
        seed: { "extrafanart/fanart1.jpg": "old-1", "extrafanart/fanart2.jpg": "old-2" },
        data: createCrawlerData({ scene_images: ["https://example.com/scene-new-1.jpg"] }),
        config: sceneOnly({ keepSceneImages: false }),
        options: undefined,
        setup: () => mockValid(),
        assert: async (root: string, assets: Awaited<ReturnType<DownloadManager["downloadAll"]>>) => {
          await expectSceneImages(root, assets, ["https://example.com/scene-new-1.jpg"]);
          expect(assets.downloaded).toEqual([scenePath(root, 1)]);
          await expect(readFile(scenePath(root, 2), "utf8")).resolves.toBe("old-2");
        },
      },
      {
        seed: { "extrafanart/fanart1.jpg": "old-1" },
        data: createCrawlerData({ scene_images: [] }),
        config: sceneOnly({ keepSceneImages: false }),
        options: undefined,
        setup: () => {},
        assert: async (root: string, assets: Awaited<ReturnType<DownloadManager["downloadAll"]>>) => {
          expect(assets.sceneImages).toEqual([scenePath(root, 1)]);
          expect(assets.downloaded).toEqual([]);
          await expect(readFile(scenePath(root, 1), "utf8")).resolves.toBe("old-1");
        },
      },
      {
        seed: { "extrafanart/fanart1.jpg": "old-1" },
        data: createCrawlerData({ scene_images: [] }),
        config: sceneOnly({ keepSceneImages: true }),
        options: { assetDecisions: { sceneImages: "replace" as const } },
        setup: () => {},
        assert: async (root: string, assets: Awaited<ReturnType<DownloadManager["downloadAll"]>>) => {
          expect(assets.sceneImages).toEqual([]);
          expect(assets.downloaded).toEqual([]);
          await expect(readFile(scenePath(root, 1), "utf8")).resolves.toBe("old-1");
        },
      },
      {
        seed: { "extrafanart/fanart1.jpg": "old-1" },
        data: createCrawlerData({ scene_images: ["https://example.com/scene-bad-1.jpg"] }),
        config: sceneOnly({ keepSceneImages: false }),
        options: undefined,
        setup: () => mockValid(false),
        assert: async (root: string, assets: Awaited<ReturnType<DownloadManager["downloadAll"]>>) => {
          expect(assets.sceneImages).toEqual([scenePath(root, 1)]);
          expect(assets.downloaded).toEqual([]);
          await expect(readFile(scenePath(root, 1), "utf8")).resolves.toBe("old-1");
        },
      },
    ];

    for (const testCase of cases) {
      vi.restoreAllMocks();
      const { root, manager } = await createSubject({ ...testCase.seed } as Record<string, string>);
      testCase.setup();
      await testCase.assert(
        root,
        await manager.downloadAll(root, testCase.data, testCase.config, {}, testCase.options),
      );
    }
  });

  it("publishes selected scene sets within declared destinations and keeps metadata aligned", async () => {
    const cases = [
      {
        preferred: 20,
        preferredSuccess: 14,
        fallback: 21,
        fallbackSuccess: 21,
        limit: 30,
        selected: "fallback",
        count: 21,
      },
      { preferred: 3, preferredSuccess: 2, fallback: 3, fallbackSuccess: 1, limit: 3, selected: "preferred", count: 2 },
      {
        preferred: 2,
        preferredSuccess: 1,
        fallback: 5,
        fallbackSuccess: 5,
        limit: 3,
        selected: "fallback",
        count: 3,
        folder: "scenes",
        format: "webp" as const,
      },
      { preferred: 0, preferredSuccess: 0, fallback: 3, fallbackSuccess: 3, limit: 4, selected: "fallback", count: 3 },
      { preferred: 2, preferredSuccess: 1, fallback: 3, fallbackSuccess: 3, limit: 0, selected: "none", count: 0 },
      {
        preferred: 2,
        preferredSuccess: 1,
        fallback: 3,
        fallbackSuccess: 3,
        limit: 4,
        selected: "none",
        count: 0,
        enabled: false,
      },
      { preferred: 0, preferredSuccess: 0, fallback: 0, fallbackSuccess: 0, limit: 4, selected: "none", count: 0 },
      {
        preferred: 2,
        preferredSuccess: 1,
        fallback: 3,
        fallbackSuccess: 3,
        limit: 4,
        selected: "existing",
        count: 1,
        preserve: true,
      },
    ];

    for (const testCase of cases) {
      vi.restoreAllMocks();
      const { root, manager, networkClient, logger } = await createSubject(
        testCase.preserve ? { "extrafanart/fanart1.jpg": "existing-scene" } : {},
      );
      const folder = testCase.folder ?? "extrafanart";
      const format = testCase.format ?? "jpeg";
      const extension = format === "webp" ? "webp" : "jpg";
      vi.spyOn(imageUtils, "validateImage").mockResolvedValue({ valid: true, width: 640, height: 360, format });
      networkClient.download.mockImplementation(async (url, outputPath) => {
        const successCount = url.includes("preferred") ? testCase.preferredSuccess : testCase.fallbackSuccess;
        if (Number.parseInt(url.split("/").at(-1) ?? "", 10) > successCount) throw new Error("Request timeout");
        return writeDownloadedFile(outputPath, url);
      });
      const urls = (source: string, count: number) =>
        Array.from({ length: count }, (_, index) => `https://${source}.example.com/${index + 1}.jpg`);
      const data = createCrawlerData({ scene_images: urls("preferred", testCase.preferred) });
      const config = sequentialSceneSet(testCase.limit);
      config.paths.sceneImagesFolder = folder;
      config.download.downloadSceneImages = testCase.enabled ?? true;
      const assetDecisions = testCase.preserve ? { sceneImages: "preserve" as const } : undefined;
      const sourcePath = join(root, "ABC-123.mp4");
      await writeFile(sourcePath, "video");
      const inventory = new DirectoryInventory();
      const layout = {
        mode: "preserve" as const,
        sourceVideoPath: sourcePath,
        targetVideoPath: sourcePath,
        outputDir: root,
        metadataDir: root,
        existingMetadataDir: root,
        nfoPath: join(root, "ABC-123.nfo"),
        sidecars: [],
      };
      const assetLayout = await resolvePublicationAssetLayout({
        layout,
        config,
        crawlerData: data,
        assetDecisions,
        inventory,
      });
      if (!config.download.downloadSceneImages || testCase.preserve || testCase.limit === 0) {
        expect(assetLayout.staged.size).toBe(0);
      } else {
        const lastName = join(
          folder,
          folder === "extrafanart"
            ? `fanart${testCase.limit}.${extension}`
            : `scene-${String(testCase.limit).padStart(3, "0")}.${extension}`,
        );
        expect(assetLayout.staged.get(lastName)).toBe(join(root, lastName));
      }
      const stagingDir = join(root, ".mdcz-staging-scenes");
      await mkdir(stagingDir);
      const downloaded = await downloadCrawlerAssets({
        config,
        crawlerData: data,
        downloadManager: manager,
        fileInfo: {
          filePath: sourcePath,
          fileName: "ABC-123",
          extension: ".mp4",
          number: "ABC-123",
          isSubtitled: false,
        },
        outputDir: stagingDir,
        existingAssetDir: root,
        inventory,
        sources: { scene_images: Website.JAVBUS },
        imageAlternatives: {
          scene_images: [urls("fallback", testCase.fallback)],
          scene_image_sources: [Website.JAVDB],
        },
        callbacks: { assetDecisions },
      });
      const expectedUrls =
        testCase.selected === "fallback" || testCase.selected === "preferred"
          ? urls(testCase.selected, testCase.count)
          : testCase.preserve
            ? data.scene_images
            : [];
      if (config.download.downloadSceneImages) expect(downloaded.crawlerData.scene_images).toEqual(expectedUrls);
      expect(downloaded.assets.sceneImages).toHaveLength(testCase.count);
      const sourceLog = logger.info.mock.calls.find(([message]) => message.startsWith("[image-sources] "))?.[0];
      const sceneSources = JSON.parse(sourceLog?.slice("[image-sources] ".length) ?? "null").fields.scene_images;
      expect(sceneSources).toEqual(
        testCase.count === 0
          ? { status: testCase.enabled === false ? "disabled" : "missing" }
          : Array.from({ length: testCase.count }, () =>
              testCase.preserve
                ? { status: "local", source: "local" }
                : {
                    status: "downloaded",
                    source: testCase.selected === "fallback" ? Website.JAVDB : Website.JAVBUS,
                    host: `${testCase.selected}.example.com`,
                  },
            ),
      );
      if (testCase.selected === "none" || testCase.preserve) expect(networkClient.download).not.toHaveBeenCalled();

      const publicationInput = {
        inventory,
        roots: [{ id: "root", hostPath: root }],
        members: [
          { source: { rootId: "root", relativePath: "ABC-123.mp4" }, fileId: "movie-file", layout, assetLayout },
        ],
        stagingDir,
        downloadedAssets: downloaded.assets,
        assetDecisions,
        nfoNaming: "filename" as const,
        remoteData: downloaded.crawlerData,
        writeNfo: async (
          assets: Awaited<ReturnType<DownloadManager["downloadAll"]>>,
          writeFile: (path: string, content: string) => Promise<void>,
        ) =>
          new NfoGenerator().writeNfo(layout.nfoPath, downloaded.crawlerData, {
            assets,
            nfoNaming: "filename",
            writeFile,
          }),
      };
      const publication = await prepareMovieArtifacts(publicationInput);
      const expectedPaths = Array.from({ length: testCase.count }, (_, index) =>
        join(
          root,
          folder,
          folder === "extrafanart"
            ? `fanart${index + 1}.${extension}`
            : `scene-${String(index + 1).padStart(3, "0")}.${extension}`,
        ),
      );
      expect(publication.assets.sceneImages).toEqual(expectedPaths);
      expect(publication.movieAssets.filter((asset) => asset.kind === "scene" && asset.type === "local")).toEqual(
        expectedPaths.map((path) => ({
          type: "local",
          kind: "scene",
          file: { rootId: "root", relativePath: relative(root, path).replaceAll("\\", "/") },
        })),
      );
      expect(publication.artifacts).toHaveLength(1 + (testCase.preserve ? 0 : testCase.count));
      const commit = vi.fn();
      await new WriteOutput().install(publication.artifacts, {
        commit,
        protectedMediaFiles: publication.protectedMediaFiles,
      });
      expect(commit).toHaveBeenCalledOnce();
      for (const [index, path] of expectedPaths.entries()) {
        await expect(readFile(path, "utf8")).resolves.toBe(
          testCase.preserve ? "existing-scene" : `downloaded:${expectedUrls[index]}`,
        );
      }
      if (testCase.count) expect(await readdir(join(root, folder))).toHaveLength(testCase.count);
      else await expect(access(join(root, folder))).rejects.toMatchObject({ code: "ENOENT" });
      expect(
        (await readdir(stagingDir, { recursive: true, withFileTypes: true })).filter((entry) => entry.isFile()),
      ).toEqual([]);
      const nfo = await readFile(layout.nfoPath, "utf8");
      for (const url of expectedUrls) expect(nfo).toContain(url);

      const undeclared = join(stagingDir, folder, "undeclared.jpg");
      await expect(
        prepareMovieArtifacts({
          ...publicationInput,
          downloadedAssets: { downloaded: [undeclared], sceneImages: [undeclared] },
        }),
      ).rejects.toThrow("Publication asset has no declared destination");
    }
  });

  it("persists image host failures and opens cooldown on the third retryable HTTP failure", async () => {
    const storeRoot = await createTempDir();
    const storePath = join(storeRoot, "image-host-cooldowns.json");
    const hostStore = new PersistentCooldownStore({
      filePath: storePath,
    });
    const { root, manager, networkClient } = await createSubject({}, { imageHostCooldownStore: hostStore });
    mockValid();
    networkClient.download.mockImplementation(async (url, outputPath) => {
      if (url.includes("blocked.example.com")) throw new Error("HTTP 503 Service Unavailable");
      return writeDownloadedFile(outputPath, url);
    });
    const config = sequentialSceneSet(1);
    const firstAssets = await manager.downloadAll(
      root,
      createCrawlerData({ scene_images: ["https://blocked.example.com/scene-001.jpg"] }),
      config,
      {
        scene_images: [["https://blocked.example.com/scene-002.jpg"], ["https://cdn.example.com/scene-004.jpg"]],
      },
    );
    expect(firstAssets.sceneImages).toEqual([scenePath(root, 1)]);
    expect(networkClient.download.mock.calls.map(([url]) => url)).toEqual([
      "https://blocked.example.com/scene-001.jpg",
      "https://blocked.example.com/scene-002.jpg",
      "https://cdn.example.com/scene-004.jpg",
    ]);
    await hostStore.flush();

    const secondRoot = await createTempDir();
    const reloadedManager = new DownloadManager(networkClient as unknown as RuntimeDownloadNetworkClient, {
      imageHostCooldownStore: new PersistentCooldownStore({
        filePath: storePath,
      }),
    });
    const before = networkClient.download.mock.calls.length;
    const secondAssets = await reloadedManager.downloadAll(
      secondRoot,
      createCrawlerData({ scene_images: ["https://blocked.example.com/scene-005.jpg"] }),
      config,
      { scene_images: [["https://cdn.example.com/scene-006.jpg"]] },
    );
    expect(secondAssets.sceneImages).toEqual([scenePath(secondRoot, 1)]);
    expect(networkClient.download).toHaveBeenCalledTimes(before + 2);
    expect(networkClient.download.mock.calls.slice(before).map(([url]) => url)).toEqual([
      "https://blocked.example.com/scene-005.jpg",
      "https://cdn.example.com/scene-006.jpg",
    ]);
  });
});
