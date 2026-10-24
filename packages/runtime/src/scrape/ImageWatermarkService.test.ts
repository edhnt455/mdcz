import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  POSTER_TAG_BADGE_POSITION_OPTIONS,
  TAG_BADGE_LAYOUTS,
  type TagBadgeSettings,
  tagBadgeSettingsSchema,
} from "@mdcz/shared/posterBadges";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImageWatermarkService } from "./ImageWatermarkService";
import { POSTER_BADGE_DEFINITIONS } from "./posterBadges";
import { layoutWatermarkBadges } from "./watermarkLayout";

const roots: string[] = [];
const createRoot = async () => {
  const root = await mkdtemp(join(tmpdir(), "mdcz-watermark-"));
  roots.push(root);
  return root;
};
const settings = (overrides: Partial<TagBadgeSettings> = {}) => tagBadgeSettingsSchema.parse(overrides);
const sample = POSTER_BADGE_DEFINITIONS.filter((badge) => ["subtitle", "umr", "fourK"].includes(badge.id));
const background = () => sharp({ create: { width: 400, height: 600, channels: 3, background: "#eef1f6" } });

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("image watermark rendering", () => {
  it("renders both built-in styles and preserves image formats and dimensions", async () => {
    const service = new ImageWatermarkService({ dataDir: await createRoot() });
    for (const format of ["png", "jpeg", "webp"] as const) {
      const source = await background().toFormat(format).toBuffer();
      for (const style of ["mdcx", "ribbon"] as const) {
        const rendered = await service.renderImage(
          source,
          sample,
          settings({ tagBadgeStyle: style, tagBadgeResolutionStyle: style }),
        );
        expect(await sharp(rendered).metadata()).toMatchObject({ width: 400, height: 600, format });
        expect(await sharp(rendered).raw().toBuffer()).not.toEqual(await sharp(source).raw().toBuffer());
      }
    }
  });

  it("keeps previews identical to production rendering and isolates the show-all toggle", async () => {
    const service = new ImageWatermarkService({ dataDir: await createRoot() });
    const config = settings();
    const preview = await service.preview({ settings: config, target: "poster", showAll: false });
    const rendered = await service.renderImage(await background().png().toBuffer(), sample, config);
    expect(Buffer.from(preview.dataUrl.split(",")[1], "base64")).toEqual(rendered);
    const all = await service.preview({ settings: config, target: "thumb", showAll: true });
    expect(await sharp(Buffer.from(all.dataUrl.split(",")[1], "base64")).metadata()).toMatchObject({
      width: 640,
      height: 360,
    });
    expect(config.tagBadgeTypes).not.toContain("censored");
    expect(
      await service.preview({ settings: { ...config, tagBadgeTypes: [] }, target: "poster", showAll: false }),
    ).toEqual({
      dataUrl: `data:image/png;base64,${(await service.renderImage(await background().png().toBuffer(), [], config)).toString("base64")}`,
      warnings: [],
    });
  });

  it("uses the downloaded filename convention and preserves custom image proportions", async () => {
    const root = await createRoot();
    await sharp({ create: { width: 300, height: 100, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } } })
      .png()
      .toFile(join(root, "sub.png"));
    const result = await new ImageWatermarkService({ dataDir: root }).renderImage(
      await background().png().toBuffer(),
      [sample[0]],
      settings({
        tagBadgeImageOverrides: true,
        tagBadgeDirectory: root,
        tagBadgeScale: 10,
        tagBadgeOffsetX: 8,
        tagBadgeOffsetY: 12,
      }),
    );
    const { data, info } = await sharp(result).raw().toBuffer({ resolveWithObject: true });
    const pixel = (x: number, y: number) => [
      ...data.subarray((y * info.width + x) * info.channels, (y * info.width + x) * info.channels + 3),
    ];
    expect(pixel(8, 12)).toEqual([255, 0, 0]);
    expect(pixel(187, 71)).toEqual([255, 0, 0]);
    expect(pixel(188, 71)).not.toEqual([255, 0, 0]);
    expect(pixel(8, 72)).not.toEqual([255, 0, 0]);
  });

  it("leaves the original file intact on corrupt assets and cleans temporary output", async () => {
    const root = await createRoot();
    const path = join(root, "poster.png");
    const original = await background().png().toBuffer();
    await writeFile(path, original);
    await writeFile(join(root, "sub.png"), "broken image");
    const service = new ImageWatermarkService({ dataDir: root });
    await expect(
      service.applyTagBadges(path, [sample[0]], settings({ tagBadgeImageOverrides: true, tagBadgeDirectory: root })),
    ).rejects.toThrow();
    expect(await readFile(path)).toEqual(original);
    expect((await readdir(root)).some((name) => name.includes("tag-badges"))).toBe(false);
    await service.applyTagBadges(path, [], settings());
    expect(await readFile(path)).toEqual(original);
    await service.applyTagBadges(path, sample, settings());
    expect(await readFile(path)).not.toEqual(original);
    expect((await readdir(root)).some((name) => name.includes("tag-badges"))).toBe(false);
  });

  it("normalizes EXIF orientation before positioning watermarks", async () => {
    const source = await sharp({ create: { width: 600, height: 400, channels: 3, background: "white" } })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const rendered = await new ImageWatermarkService({ dataDir: await createRoot() }).renderImage(
      source,
      sample,
      settings(),
    );
    const metadata = await sharp(rendered).metadata();
    expect(metadata).toMatchObject({ width: 400, height: 600 });
    expect(metadata.orientation ?? 1).toBe(1);
  });

  it("reports margins that must be clamped", async () => {
    const onWarn = vi.fn();
    await new ImageWatermarkService({ dataDir: await createRoot() }).renderImage(
      await background().png().toBuffer(),
      [sample[0]],
      settings({ tagBadgeOffsetX: 1000, tagBadgeOffsetY: 1000 }),
      onWarn,
    );
    expect(onWarn).toHaveBeenCalledWith(expect.stringContaining("margins"));
  });
});

describe("watermark layout", () => {
  it("fits every layout, start corner and fixed position without overlaps or out-of-bounds coordinates", () => {
    const badges = POSTER_BADGE_DEFINITIONS.map((badge) => ({
      id: badge.id,
      width: badge.id === "fourK" ? 150 : 300,
      height: 100,
    }));
    for (const [width, height] of [
      [400, 600],
      [640, 360],
      [32, 32],
    ]) {
      for (const layout of TAG_BADGE_LAYOUTS) {
        for (const corner of POSTER_TAG_BADGE_POSITION_OPTIONS) {
          const config = settings({
            tagBadgeLayout: layout,
            tagBadgePosition: corner,
            tagBadgeOffsetX: 3,
            tagBadgeOffsetY: 4,
            tagBadgeGap: 7,
          });
          config.tagBadgePositions.fourK = "bottomRight";
          const placed = layoutWatermarkBadges(width, height, badges, config);
          expect(placed.map((badge) => badge.id)).toEqual(badges.map((badge) => badge.id));
          for (const [index, badge] of placed.entries()) {
            expect(badge.width).toBeGreaterThan(0);
            expect(badge.height).toBeGreaterThan(0);
            expect(badge.left).toBeGreaterThanOrEqual(3);
            expect(badge.top).toBeGreaterThanOrEqual(4);
            expect(badge.left + badge.width).toBeLessThanOrEqual(width - 3);
            expect(badge.top + badge.height).toBeLessThanOrEqual(height - 4);
            for (const other of placed.slice(index + 1)) {
              expect(
                badge.left + badge.width <= other.left ||
                  other.left + other.width <= badge.left ||
                  badge.top + badge.height <= other.top ||
                  other.top + other.height <= badge.top,
              ).toBe(true);
            }
          }
          const fourK = placed.find((badge) => badge.id === "fourK");
          if (!fourK) throw new Error("Missing 4K watermark");
          expect(fourK.left + fourK.width).toBe(width - 3);
          expect(fourK.top + fourK.height).toBe(height - 4);
        }
      }
    }
    expect(layoutWatermarkBadges(400, 600, [], settings())).toEqual([]);
    expect(() => layoutWatermarkBadges(1, 1, badges, settings())).toThrow("too small");
  });

  it("uses fixed positions before cycling automatic badges in the selected direction", () => {
    const badges = sample.map((badge) => ({ id: badge.id, width: 100, height: 50 }));
    const config = settings({ tagBadgeLayout: "counterclockwise", tagBadgePosition: "topRight", tagBadgeGap: 4 });
    config.tagBadgePositions.subtitle = "bottomRight";
    const placed = layoutWatermarkBadges(400, 600, badges, config);
    expect(placed[0].top).toBeGreaterThan(0);
    expect(placed[1].left).toBeGreaterThan(0);
    expect(placed[1].top).toBe(0);
    expect(placed[2].left).toBe(0);
    expect(placed[2].top).toBe(0);
  });
});
