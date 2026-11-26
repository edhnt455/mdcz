import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { format, parse } from "node:path";
import { type TagBadgeSettings, tagBadgeSettingsSchema } from "@mdcz/shared/posterBadges";
import type { BadgeArtworkRecord, CrawlerData, FileInfo, NfoLocalState, VideoMeta } from "@mdcz/shared/types";
import type { ImageWatermarkService } from "./ImageWatermarkService";
import { type PosterBadgeDefinition, resolvePosterBadgeDefinitions } from "./posterBadges";

const hash = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");

export const badgeBasePath = (path: string): string => {
  const { dir, name, ext } = parse(path);
  return format({ dir, name: `.${name}.mdcz-base`, ext });
};

export const resolveArtworkBadges = (
  kind: TagBadgeSettings["tagBadgeTargets"][number],
  data: CrawlerData,
  fileInfo: FileInfo,
  localState: NfoLocalState | undefined,
  settings: TagBadgeSettings,
  videoMeta?: VideoMeta,
): { badges: PosterBadgeDefinition[]; stamp: string } => {
  if (!settings.tagBadges || !settings.tagBadgeTargets.includes(kind)) return { badges: [], stamp: "" };
  const streams = localState?.fileinfo?.streamdetails as
    | { video?: { width?: string | number; height?: string | number } }
    | undefined;
  const dimensions = videoMeta ?? {
    width: Number(streams?.video?.width) || undefined,
    height: Number(streams?.video?.height) || undefined,
  };
  const badges = resolvePosterBadgeDefinitions(data, fileInfo, localState, settings.tagBadgeTypes, dimensions);
  if (!badges.length) return { badges, stamp: "" };
  const { tagBadges, tagBadgeTypes, tagBadgeTargets, ...appearance } = tagBadgeSettingsSchema.parse(settings);
  return { badges, stamp: hash(JSON.stringify([1, badges.map(({ id }) => id), appearance])) };
};

export const encodeBadgeArtwork = async (
  base: Buffer,
  plan: ReturnType<typeof resolveArtworkBadges>,
  settings: TagBadgeSettings,
  watermark: Pick<ImageWatermarkService, "renderImage">,
  warn?: (message: string) => void,
): Promise<{ data: Buffer; record: BadgeArtworkRecord }> => {
  const data = plan.badges.length ? await watermark.renderImage(base, plan.badges, settings, warn) : base;
  const baseSha256 = hash(base);
  return { data, record: { stamp: plan.stamp, sha256: data === base ? baseSha256 : hash(data), baseSha256 } };
};

export const readManagedArtworkBase = async (path: string, record: BadgeArtworkRecord): Promise<Buffer | undefined> => {
  const read = async (path: string) => {
    try {
      if ((await lstat(path)).isFile()) return await readFile(path);
      return undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  };
  const current = await read(path);
  if (!current || hash(current) !== record.sha256) return undefined;
  if (record.sha256 === record.baseSha256) return current;
  const base = await read(badgeBasePath(path));
  return base && hash(base) === record.baseSha256 ? base : undefined;
};
