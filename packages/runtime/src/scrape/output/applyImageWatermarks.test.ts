import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Configuration, configurationSchema } from "@mdcz/shared/config";
import { Website } from "@mdcz/shared/enums";
import type { CrawlerData, FileInfo } from "@mdcz/shared/types";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { badgeBasePath, readManagedArtworkBase } from "../badgeArtwork";
import { applyImageWatermarks } from "./applyImageWatermarks";

const fixtures = async (download: Partial<Configuration["download"]> = {}) => {
  const dataDir = await mkdtemp(join(tmpdir(), "mdcz-badge-artwork-"));
  onTestFinished(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });
  const poster = join(dataDir, "poster.jpg");
  const thumb = join(dataDir, "thumb.jpg");
  const fanart = join(dataDir, "fanart.jpg");
  const base = Buffer.from("clean poster");
  await Promise.all([writeFile(poster, base), writeFile(thumb, "clean thumb"), writeFile(fanart, "legacy fanart")]);
  return {
    assets: { poster, thumb, fanart, sceneImages: [], downloaded: [poster, thumb] },
    config: configurationSchema.parse({
      download: { tagBadges: true, tagBadgeTypes: ["subtitle", "fourK"], ...download },
    }),
    crawlerData: {
      title: "Sample",
      number: "ABC-123",
      actors: [],
      genres: [],
      scene_images: [],
      website: Website.DMM,
    } satisfies CrawlerData,
    dataDir,
    fileInfo: {
      filePath: join(dataDir, "ABC-123.mp4"),
      fileName: "ABC-123.mp4",
      extension: ".mp4",
      number: "ABC-123",
      isSubtitled: true,
      resolution: "2160P",
    } satisfies FileInfo,
    logger: { warn: vi.fn() },
    base,
  };
};

describe("applyImageWatermarks", () => {
  it("records the clean source and output of each newly badged image", async () => {
    const input = await fixtures({ tagBadgePosition: "bottomRight", tagBadgeTargets: ["poster", "thumb", "fanart"] });
    const renderImage = vi.fn(async (base: Buffer) => Buffer.concat([base, Buffer.from(" + badge")]));
    const result = await applyImageWatermarks({ ...input, watermarkService: { renderImage } });
    const record = result.badgeRecords?.poster;
    expect(record).toBeDefined();
    expect(record?.sha256).not.toBe(record?.baseSha256);
    expect(renderImage).toHaveBeenCalledTimes(2);
    expect(renderImage).toHaveBeenCalledWith(
      input.base,
      [expect.objectContaining({ label: "中字" }), expect.objectContaining({ label: "4K" })],
      expect.objectContaining({ tagBadgePosition: "bottomRight" }),
      expect.any(Function),
    );
    expect(await readFile(input.assets.poster, "utf8")).toBe("clean poster + badge");
    expect(await readFile(badgeBasePath(input.assets.poster))).toEqual(input.base);
    expect(await readFile(input.assets.fanart, "utf8")).toBe("legacy fanart");
    if (!record) throw new Error("missing poster record");
    await expect(readManagedArtworkBase(input.assets.poster, record)).resolves.toEqual(input.base);
    await writeFile(input.assets.poster, "replaced by hand");
    await expect(readManagedArtworkBase(input.assets.poster, record)).resolves.toBeUndefined();
  });

  it("records clean new images without rendering and leaves existing images untouched", async () => {
    const input = await fixtures({ tagBadges: false });
    const renderImage = vi.fn();
    const watermarkService = { renderImage };
    const result = await applyImageWatermarks({ ...input, watermarkService });
    expect(result.badgeRecords?.poster).toMatchObject({ stamp: "" });
    expect(result.badgeRecords?.poster?.sha256).toBe(result.badgeRecords?.poster?.baseSha256);
    expect(renderImage).not.toHaveBeenCalled();
    await expect(readFile(badgeBasePath(input.assets.poster))).rejects.toMatchObject({ code: "ENOENT" });
    const retained = { ...input.assets, downloaded: [] };
    await expect(applyImageWatermarks({ ...input, assets: retained, watermarkService })).resolves.toBe(retained);
  });

  it("keeps the source on rendering failure and finishes the other image", async () => {
    const input = await fixtures();
    const renderImage = vi
      .fn()
      .mockRejectedValueOnce(new Error("render failed"))
      .mockResolvedValue(Buffer.from("badge"));
    const result = await applyImageWatermarks({ ...input, watermarkService: { renderImage } });
    expect(input.logger.warn).toHaveBeenCalledWith(expect.stringContaining("render failed"));
    expect(result.badgeRecords?.poster).toBeNull();
    expect(result.badgeRecords?.thumb).toEqual(expect.objectContaining({ stamp: expect.any(String) }));
    expect(await readFile(input.assets.poster)).toEqual(input.base);
  });

  it("honors cancellation before rendering or during rendering", async () => {
    const input = await fixtures();
    const before = AbortSignal.abort();
    const after = new AbortController();
    const renderImage = vi.fn(async () => {
      after.abort();
      return Buffer.from("badge");
    });
    const watermarkService = { renderImage };
    await expect(applyImageWatermarks({ ...input, signal: before, watermarkService })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(renderImage).not.toHaveBeenCalled();
    await expect(applyImageWatermarks({ ...input, signal: after.signal, watermarkService })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(renderImage).toHaveBeenCalledOnce();
    expect(await readFile(input.assets.poster)).toEqual(input.base);
  });
});
