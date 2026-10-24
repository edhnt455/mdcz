import { randomUUID } from "node:crypto";
import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, parse } from "node:path";
import { fileURLToPath } from "node:url";
import {
  POSTER_TAG_BADGE_IMAGE_EXTENSIONS,
  POSTER_TAG_BADGE_IMAGE_FILENAMES,
  type TagBadgeSettings,
  type WatermarkPreviewInput,
  type WatermarkPreviewResult,
  watermarkPreviewInputSchema,
} from "@mdcz/shared/posterBadges";
import sharp from "sharp";
import { POSTER_BADGE_DEFINITIONS, type PosterBadgeDefinition } from "./posterBadges";
import { resolveWatermarkDirectory } from "./watermarkDirectory";
import { layoutWatermarkBadges } from "./watermarkLayout";

const FONT_STACK = "'Microsoft YaHei', 'PingFang SC', 'Noto Sans CJK SC', sans-serif";
const BUILTIN_FILENAMES = {
  subtitle: "sub",
  censored: "youma",
  umr: "umr",
  leak: "leak",
  uncensored: "wuma",
  fourK: "4k",
  eightK: "8k",
} as const;

export class ImageWatermarkService {
  private readonly builtinDirectory: string;

  constructor(private readonly options: { dataDir: string; builtinDirectory?: string }) {
    this.builtinDirectory =
      options.builtinDirectory ?? fileURLToPath(new URL("../../resources/watermark", import.meta.url));
  }

  async renderImage(
    image: string | Buffer,
    badges: readonly PosterBadgeDefinition[],
    settings: TagBadgeSettings,
    onWarn?: (message: string) => void,
  ): Promise<Buffer> {
    const metadata = await sharp(image, { animated: false }).metadata();
    const { data, info } = await sharp(image, { animated: false })
      .rotate()
      .keepMetadata()
      .png()
      .toBuffer({ resolveWithObject: true });
    if (
      settings.tagBadgeImageOverrides &&
      settings.tagBadgeDirectory &&
      !(await stat(settings.tagBadgeDirectory)).isDirectory()
    ) {
      throw new Error("Custom watermark path must be a directory");
    }
    const sources: Array<{ id: PosterBadgeDefinition["id"]; input: Buffer; width: number; height: number }> = [];
    for (const badge of badges) {
      let input: Buffer | undefined;
      if (settings.tagBadgeImageOverrides) {
        const directory = settings.tagBadgeDirectory || resolveWatermarkDirectory(this.options.dataDir);
        for (const basename of POSTER_TAG_BADGE_IMAGE_FILENAMES[badge.id]) {
          for (const extension of POSTER_TAG_BADGE_IMAGE_EXTENSIONS) {
            const candidate = join(directory, `${basename}.${extension}`);
            try {
              if ((await stat(candidate)).isFile()) {
                input = await readFile(candidate);
                break;
              }
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            }
          }
          if (input) break;
        }
      }
      const resolutionBadge = ["fullHd", "fourK", "eightK"].includes(badge.id);
      const style = resolutionBadge ? settings.tagBadgeResolutionStyle : settings.tagBadgeStyle;
      if (!input && style === "mdcx" && badge.id !== "fullHd") {
        input = await readFile(join(this.builtinDirectory, `${BUILTIN_FILENAMES[badge.id]}.png`));
      }
      input ??= Buffer.from(`<svg width="120" height="60" viewBox="0 0 120 60" xmlns="http://www.w3.org/2000/svg">
        <defs><linearGradient id="fill" x2="1" y2="1">
          <stop stop-color="${badge.colorStart}"/><stop offset="1" stop-color="${badge.colorEnd}"/>
        </linearGradient></defs>
        <path d="M0 0H102L120 30L102 60H0Z" fill="url(#fill)"/>
        <path d="M102 0L120 30L102 60" stroke="${badge.accentColor}" stroke-opacity="0.5" stroke-width="2"/>
        <text x="51" y="41" text-anchor="middle" font-size="28" font-weight="800" fill="white" font-family="${FONT_STACK}">${badge.label}</text>
      </svg>`);
      const decoded = await sharp(input, { animated: false }).rotate().png().toBuffer({ resolveWithObject: true });
      sources.push({ id: badge.id, input: decoded.data, width: decoded.info.width, height: decoded.info.height });
    }
    const placements = layoutWatermarkBadges(info.width, info.height, sources, settings);
    if (settings.tagBadgeOffsetX * 2 >= info.width || settings.tagBadgeOffsetY * 2 >= info.height) {
      onWarn?.("Watermark margins were reduced to fit the image");
    }
    const overlays = await Promise.all(
      placements.map(async (placement, index) => ({
        input: await sharp(sources[index].input)
          .resize(placement.width, placement.height, { fit: "fill" })
          .png()
          .toBuffer(),
        left: placement.left,
        top: placement.top,
      })),
    );
    let pipeline = sharp(data).composite(overlays).keepMetadata();
    switch (metadata.format) {
      case "png":
        pipeline = pipeline.png();
        break;
      case "webp":
        pipeline = pipeline.webp({ quality: 95 });
        break;
      case "jpeg":
        pipeline = pipeline.jpeg({ quality: 95, chromaSubsampling: "4:4:4" });
        break;
      default:
        throw new Error(`Unsupported watermark image format: ${metadata.format}`);
    }
    return await pipeline.toBuffer();
  }

  async applyTagBadges(
    imagePath: string,
    badges: readonly PosterBadgeDefinition[],
    settings: TagBadgeSettings,
    onWarn?: (message: string) => void,
  ): Promise<void> {
    if (badges.length === 0) return;
    const parsed = parse(imagePath);
    const tempPath = join(parsed.dir, `${parsed.name}.tag-badges.${randomUUID()}${parsed.ext}`);
    try {
      const rendered = await this.renderImage(imagePath, badges, settings, onWarn);
      await writeFile(tempPath, rendered, { flag: "wx" });
      await rename(tempPath, imagePath);
    } finally {
      await rm(tempPath, { force: true });
    }
  }

  async preview(request: WatermarkPreviewInput): Promise<WatermarkPreviewResult> {
    const input = watermarkPreviewInputSchema.parse(request);
    const width = input.target === "poster" ? 400 : 640;
    const height = input.target === "poster" ? 600 : 360;
    const background = await sharp({ create: { width, height, channels: 3, background: "#eef1f6" } })
      .png()
      .toBuffer();
    const sample = new Set(["subtitle", "umr", "fourK"]);
    const badges = POSTER_BADGE_DEFINITIONS.filter(
      (badge) => input.showAll || (sample.has(badge.id) && input.settings.tagBadgeTypes.includes(badge.id)),
    );
    const warnings: string[] = [];
    const rendered = await this.renderImage(background, badges, input.settings, (message) => warnings.push(message));
    return { dataUrl: `data:image/png;base64,${rendered.toString("base64")}`, warnings };
  }
}
