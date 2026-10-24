import { POSTER_TAG_BADGE_TYPE_OPTIONS, type PosterTagBadgeType } from "@mdcz/shared/posterBadges";
import type { CrawlerData, FileInfo, NfoLocalState, VideoMeta } from "@mdcz/shared/types";
import { buildMovieTags, normalizeNfoLocalState } from "../maintenance/movieTags";
import { classifyMovie, type MovieClassification } from "./utils/movieClassification";

export interface PosterBadgeDefinition {
  id: PosterTagBadgeType;
  label: string;
  colorStart: string;
  colorEnd: string;
  accentColor: string;
}

interface PosterBadgeMatchContext {
  classification: MovieClassification | undefined;
  fileInfo: FileInfo | undefined;
  tags: ReadonlySet<string>;
}
const matchesResolution = (fileInfo: FileInfo | undefined, candidates: readonly string[]): boolean => {
  const resolution = fileInfo?.resolution?.trim().toUpperCase();
  if (!resolution) {
    return false;
  }

  return candidates.includes(resolution);
};

export const POSTER_BADGE_DEFINITIONS: Array<
  PosterBadgeDefinition & { matches: (context: PosterBadgeMatchContext) => boolean }
> = [
  {
    id: "subtitle",
    label: "中字",
    colorStart: "#F04A3A",
    colorEnd: "#B91C1C",
    accentColor: "#FFD5D0",
    matches: ({ tags }) => ["中文字幕", "字幕", "中字"].some((candidate) => tags.has(candidate)),
  },
  {
    id: "censored",
    label: "有码",
    colorStart: "#0F766E",
    colorEnd: "#115E59",
    accentColor: "#CCFBF1",
    matches: ({ classification, fileInfo }) =>
      fileInfo !== undefined &&
      classification !== undefined &&
      !classification.uncensored &&
      !classification.umr &&
      !classification.leak,
  },
  {
    id: "umr",
    label: "破解",
    colorStart: "#E77A0C",
    colorEnd: "#B45309",
    accentColor: "#FDE5C2",
    matches: ({ tags }) => tags.has("破解"),
  },
  {
    id: "leak",
    label: "流出",
    colorStart: "#2B6CB0",
    colorEnd: "#1E3A5F",
    accentColor: "#D6E8FF",
    matches: ({ tags }) => tags.has("流出"),
  },
  {
    id: "uncensored",
    label: "无码",
    colorStart: "#505B67",
    colorEnd: "#1F2937",
    accentColor: "#E5E7EB",
    matches: ({ tags }) => tags.has("无码"),
  },
  {
    id: "fullHd",
    label: "1080P",
    colorStart: "#6D28D9",
    colorEnd: "#5B21B6",
    accentColor: "#E9D5FF",
    matches: ({ fileInfo }) => matchesResolution(fileInfo, ["1080P"]),
  },
  {
    id: "fourK",
    label: "4K",
    colorStart: "#166534",
    colorEnd: "#14532D",
    accentColor: "#DCFCE7",
    matches: ({ fileInfo }) => matchesResolution(fileInfo, ["4K", "2160P"]),
  },
  {
    id: "eightK",
    label: "8K",
    colorStart: "#7C2D12",
    colorEnd: "#9A3412",
    accentColor: "#FFEDD5",
    matches: ({ fileInfo }) => matchesResolution(fileInfo, ["8K", "4320P"]),
  },
];

export const resolvePosterBadgeDefinitions = (
  data: CrawlerData,
  fileInfo: FileInfo | undefined,
  localState: NfoLocalState | undefined,
  enabledTypes: readonly PosterTagBadgeType[] = POSTER_TAG_BADGE_TYPE_OPTIONS,
  videoMeta?: VideoMeta,
): PosterBadgeDefinition[] => {
  const tags = new Set(buildMovieTags(data, fileInfo, localState));
  const enabledTypeSet = new Set(enabledTypes);
  const normalizedLocalState = normalizeNfoLocalState(localState);
  const classification = fileInfo ? classifyMovie(fileInfo, data, normalizedLocalState) : undefined;

  const category = tags.has("破解") ? "umr" : tags.has("流出") ? "leak" : tags.has("无码") ? "uncensored" : "censored";
  let resolvedFileInfo = fileInfo;
  if (fileInfo && (videoMeta?.width || videoMeta?.height)) {
    const width = videoMeta.width ?? 0;
    const height = videoMeta.height ?? 0;
    const resolution =
      width >= 7680 || height >= 4320
        ? "8K"
        : width >= 3840 || height >= 2160
          ? "4K"
          : width >= 1920 || height >= 1080
            ? "1080P"
            : `${height}P`;
    resolvedFileInfo = { ...fileInfo, resolution };
  }
  return POSTER_BADGE_DEFINITIONS.filter(
    (definition) =>
      enabledTypeSet.has(definition.id) &&
      (!["censored", "umr", "leak", "uncensored"].includes(definition.id) || definition.id === category) &&
      definition.matches({ tags, fileInfo: resolvedFileInfo, classification }),
  ).map(({ matches: _matches, ...definition }) => definition);
};
