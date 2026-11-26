import type { AssetRef, RootFileRef } from "@mdcz/shared/mediaRef";

export const detailImageWidths = { poster: 360, backdrop: 1200, scene: 480, diff: 720, diffScene: 240 } as const;
export type ResolveImageCandidates = (candidates: string[], baseDir?: string, width?: number) => Promise<string[]>;

export type DetailViewStatus = "success" | "failed" | "processing";

export interface DetailViewItem {
  scrapeConflict?: import("@mdcz/shared/scrapeConflict").ScrapeConflictInput;
  resultId?: string;
  id: string;
  status: DetailViewStatus;
  number: string;
  minimalErrorView?: boolean;
  title?: string;
  path?: string;
  fileRef?: RootFileRef;
  nfoRef?: RootFileRef;
  assets?: AssetRef[];
  nfoPath?: string;
  actors?: string[];
  plot?: string;
  genres?: string[];
  releaseDate?: string;
  durationSeconds?: number;
  resolution?: string;
  bitrate?: number;
  director?: string;
  series?: string;
  studio?: string;
  publisher?: string;
  rating?: number;
  posterUrl?: string;
  thumbUrl?: string;
  fanartUrl?: string;
  outputPath?: string;
  sceneImages?: string[];
  trailerUrl?: string;
  trailerFallbackUrls?: string[];
  errorMessage?: string;
}
