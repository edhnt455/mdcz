import type { CrawlerData } from "@mdcz/shared/types";

const toRemoteImageSourceUrl = (value: string | undefined): string | undefined => {
  const normalized = value?.trim();
  return normalized && /^https?:\/\//iu.test(normalized) ? normalized : undefined;
};

export const prepareCrawlerDataForNfo = (crawlerData: CrawlerData): CrawlerData => {
  const thumbSourceUrl = crawlerData.thumb_source_url ?? toRemoteImageSourceUrl(crawlerData.thumb_url);
  const posterSourceUrl = crawlerData.poster_source_url ?? toRemoteImageSourceUrl(crawlerData.poster_url);
  const fanartSourceUrl =
    crawlerData.fanart_source_url ??
    toRemoteImageSourceUrl(crawlerData.fanart_url) ??
    thumbSourceUrl ??
    toRemoteImageSourceUrl(crawlerData.thumb_url);
  const trailerSourceUrl = crawlerData.trailer_source_url ?? toRemoteImageSourceUrl(crawlerData.trailer_url);

  return {
    ...crawlerData,
    actor_profiles: crawlerData.actor_profiles?.map(({ photo_url: _photo, ...profile }) => profile),
    thumb_source_url: thumbSourceUrl,
    poster_source_url: posterSourceUrl,
    fanart_source_url: fanartSourceUrl,
    trailer_source_url: trailerSourceUrl,
  };
};
