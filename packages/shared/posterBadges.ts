import { z } from "zod";

export const POSTER_TAG_BADGE_TYPE_OPTIONS = [
  "subtitle",
  "censored",
  "umr",
  "leak",
  "uncensored",
  "fullHd",
  "fourK",
  "eightK",
] as const;

export type PosterTagBadgeType = (typeof POSTER_TAG_BADGE_TYPE_OPTIONS)[number];

export const DEFAULT_POSTER_TAG_BADGE_TYPES: readonly PosterTagBadgeType[] = [
  "subtitle",
  "umr",
  "leak",
  "uncensored",
  "fourK",
  "eightK",
];

export const POSTER_TAG_BADGE_POSITION_OPTIONS = ["topLeft", "topRight", "bottomLeft", "bottomRight"] as const;

export type PosterTagBadgePosition = (typeof POSTER_TAG_BADGE_POSITION_OPTIONS)[number];

export const TAG_BADGE_TARGETS = ["poster", "thumb", "fanart"] as const;
export const TAG_BADGE_STYLES = ["mdcx", "ribbon"] as const;
export const TAG_BADGE_LAYOUTS = ["horizontal", "clockwise", "counterclockwise"] as const;
export const TAG_BADGE_FIXED_POSITIONS = ["auto", ...POSTER_TAG_BADGE_POSITION_OPTIONS] as const;

const fixedPosition = () => z.enum(TAG_BADGE_FIXED_POSITIONS).default("auto");

export const tagBadgeSettingsSchema = z.object({
  tagBadges: z.boolean().default(false),
  tagBadgeTypes: z
    .array(z.enum(POSTER_TAG_BADGE_TYPE_OPTIONS))
    .max(8)
    .default(() => [...DEFAULT_POSTER_TAG_BADGE_TYPES]),
  tagBadgeTargets: z.array(z.enum(TAG_BADGE_TARGETS)).max(3).default(["poster", "thumb"]),
  tagBadgePosition: z.enum(POSTER_TAG_BADGE_POSITION_OPTIONS).default("topLeft"),
  tagBadgeStyle: z.enum(TAG_BADGE_STYLES).default("mdcx"),
  tagBadgeResolutionStyle: z.enum(TAG_BADGE_STYLES).default("mdcx"),
  tagBadgeLayout: z.enum(TAG_BADGE_LAYOUTS).default("horizontal"),
  tagBadgeScale: z.number().min(2).max(100).default(9),
  tagBadgeOffsetX: z.number().int().min(0).max(10000).default(0),
  tagBadgeOffsetY: z.number().int().min(0).max(10000).default(0),
  tagBadgeGap: z.number().int().min(0).max(10000).default(0),
  tagBadgeImageOverrides: z.boolean().default(false),
  tagBadgeDirectory: z.string().trim().max(4096).default(""),
  tagBadgePositions: z
    .object({
      subtitle: fixedPosition(),
      censored: fixedPosition(),
      umr: fixedPosition(),
      leak: fixedPosition(),
      uncensored: fixedPosition(),
      fullHd: fixedPosition(),
      fourK: fixedPosition(),
      eightK: fixedPosition(),
    })
    .default(
      () =>
        ({
          subtitle: "auto",
          censored: "auto",
          umr: "auto",
          leak: "auto",
          uncensored: "auto",
          fullHd: "auto",
          fourK: "auto",
          eightK: "auto",
        }) as const,
    ),
});

export type TagBadgeSettings = z.infer<typeof tagBadgeSettingsSchema>;

export const watermarkPreviewInputSchema = z.object({
  settings: tagBadgeSettingsSchema,
  target: z.enum(TAG_BADGE_TARGETS),
  showAll: z.boolean(),
});

export type WatermarkPreviewInput = z.input<typeof watermarkPreviewInputSchema>;
export interface WatermarkPreviewResult {
  dataUrl: string;
  warnings: string[];
}

export const POSTER_TAG_BADGE_IMAGE_EXTENSIONS = ["png", "webp", "jpg", "jpeg"] as const;

export type PosterTagBadgeImageExtension = (typeof POSTER_TAG_BADGE_IMAGE_EXTENSIONS)[number];

// Chinese basenames are accepted file names for user-supplied badge images, not display text.
export const POSTER_TAG_BADGE_IMAGE_FILENAMES: Record<PosterTagBadgeType, readonly string[]> = {
  subtitle: ["sub", "subtitle", "中字"],
  censored: ["youma", "censored", "有码"],
  umr: ["umr", "破解"],
  leak: ["leak", "流出"],
  uncensored: ["wuma", "uncensored", "无码"],
  fullHd: ["fullHd", "1080P"],
  fourK: ["4k", "fourK", "4K"],
  eightK: ["8k", "eightK", "8K"],
};
