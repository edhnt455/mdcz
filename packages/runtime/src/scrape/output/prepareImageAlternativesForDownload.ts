import type { Website } from "@mdcz/shared/enums";
import type { CrawlerData } from "@mdcz/shared/types";
import type { ImageAlternatives, SourceMap } from "../aggregation";
import { buildDmmAwsImageCandidates, isDmmImageUrl } from "../utils/dmmImage";

const normalizeUrl = (input?: string): string | null => {
  if (!input) {
    return null;
  }

  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    return trimmed;
  }

  return null;
};

const expandDmmPrimaryImageAlternatives = (
  primaryUrl: string | undefined,
  alternatives: string[] | undefined,
  rawNumber: string,
  imageSources: Record<string, Website>,
): string[] => {
  const seen = new Set<string>();
  const expanded: string[] = [];

  const append = (value?: string | null): void => {
    const normalized = normalizeUrl(value ?? undefined);
    if (!normalized || seen.has(normalized)) {
      return;
    }

    seen.add(normalized);
    expanded.push(normalized);
  };

  const normalizedPrimary = normalizeUrl(primaryUrl);
  if (normalizedPrimary) {
    seen.add(normalizedPrimary);
    for (const candidate of buildDmmAwsImageCandidates(normalizedPrimary, rawNumber)) {
      append(candidate);
      if (imageSources[normalizedPrimary]) imageSources[candidate] ??= imageSources[normalizedPrimary];
    }
  }

  for (const alternative of alternatives ?? []) {
    const normalized = normalizeUrl(alternative);
    if (!normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    expanded.push(normalized);
    for (const candidate of buildDmmAwsImageCandidates(normalized, rawNumber)) {
      append(candidate);
      if (imageSources[normalized]) imageSources[candidate] ??= imageSources[normalized];
    }
  }

  return expanded;
};

export const prepareImageAlternativesForDownload = (
  data: Pick<CrawlerData, "number" | "thumb_url" | "poster_url">,
  imageAlternatives: Partial<ImageAlternatives> = {},
  sources?: Pick<SourceMap, "thumb_url" | "poster_url" | "scene_images">,
): Partial<ImageAlternatives> => {
  const imageSources: NonNullable<ImageAlternatives["image_sources"]> = {};
  const prepared: Partial<ImageAlternatives> = {
    thumb_url: [...(imageAlternatives.thumb_url ?? [])],
    poster_url: [...(imageAlternatives.poster_url ?? [])],
    scene_images: (imageAlternatives.scene_images ?? []).map((urls) => [...urls]),
    scene_images_source: imageAlternatives.scene_images_source ?? sources?.scene_images,
    scene_image_sources: [...(imageAlternatives.scene_image_sources ?? [])],
    image_sources: imageSources,
  };

  for (const field of ["thumb_url", "poster_url"] as const) {
    const fieldSources = { ...imageAlternatives.image_sources?.[field] };
    const primary = normalizeUrl(data[field]);
    if (primary && sources?.[field]) fieldSources[primary] = sources[field];
    if (isDmmImageUrl(data[field])) {
      prepared[field] = expandDmmPrimaryImageAlternatives(
        data[field],
        imageAlternatives[field],
        data.number,
        fieldSources,
      );
    }
    imageSources[field] = fieldSources;
  }
  return prepared;
};
