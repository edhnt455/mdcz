import { basename, dirname, extname, join } from "node:path";
import { type AssetNamingMode, buildMovieAssetFileNames } from "@mdcz/shared/assetNaming";
import type { Configuration } from "@mdcz/shared/config";
import {
  type NormalizedCropRegion,
  normalizedCropToPixels,
  resolvePosterEditorCropRegion,
} from "@mdcz/shared/posterCrop";
import type { BadgeArtworkRecords } from "@mdcz/shared/types";
import sharp, { type Sharp } from "sharp";
import { type MovieLibrary, writePublishedMovie } from "../library/registeredMedia";
import { parseNfoSnapshot } from "../maintenance/nfoSnapshot";
import { withMovieTask } from "../publication/mediaTasks";
import { acquireOutputDirectories } from "../publication/outputMutex";
import { toRootFileRef } from "../publication/outputRefs";
import type { PublicationOutputPort } from "../publication/types";
import { WriteOutput } from "../publication/WriteOutput";
import { badgeBasePath, encodeBadgeArtwork, readManagedArtworkBase, resolveArtworkBadges } from "./badgeArtwork";
import { DirectoryInventory } from "./DirectoryInventory";
import { resolveExistingImageAsset } from "./download/assets/helpers";
import type { ImageWatermarkService } from "./ImageWatermarkService";
import { resolveFileInfoWithSubtitles } from "./media/fileInfoWithSubtitles";
import { NfoGenerator } from "./nfo";
import { newestNfosFirst } from "./selectLocalNfo";

const supportedExtensions = new Set([".avif", ".jpeg", ".jpg", ".png", ".webp"]);

const encodePoster = (pipeline: Sharp, extension: string): Sharp => {
  switch (extension) {
    case ".avif":
      return pipeline.avif({ quality: 90 });
    case ".png":
      return pipeline.png();
    case ".webp":
      return pipeline.webp({ quality: 95 });
    default:
      return pipeline.jpeg({ quality: 95, chromaSubsampling: "4:4:4" });
  }
};

export interface PosterCropSession {
  sourcePath: string;
  targetPath: string;
  width: number;
  height: number;
  initialCrop: NormalizedCropRegion;
  verifiedBase: boolean;
}

export const readPosterNfos = async (paths: readonly string[], inventory = new DirectoryInventory()) => {
  const nfos = await newestNfosFirst(paths, (path) => inventory.stats(path));
  return (await Promise.all(nfos.map(async (path) => ({ path, xml: await inventory.readNfo(path) })))).flatMap(
    ({ path, xml }) => (xml === undefined ? [] : [{ path, xml }]),
  );
};

export class PosterCropService {
  constructor(private readonly watermark?: Pick<ImageWatermarkService, "renderImage">) {}

  async prepare(
    videoPath: string,
    assetNamingMode: AssetNamingMode,
    assets?: { thumb?: string; poster?: string },
    badgeRecords?: BadgeArtworkRecords,
  ): Promise<PosterCropSession> {
    const outputDir = dirname(videoPath);
    const videoBaseName = basename(videoPath, extname(videoPath));
    const names = buildMovieAssetFileNames(videoBaseName, assetNamingMode);
    const thumbTargetPath = join(outputDir, names.thumb);
    const posterTargetPath =
      assets?.poster ??
      (assets?.thumb
        ? join(
            dirname(assets.thumb),
            /thumb(?=\.[^.]+$)/u.test(basename(assets.thumb))
              ? basename(assets.thumb).replace(/thumb(?=\.[^.]+$)/u, "poster")
              : names.poster,
          )
        : join(outputDir, names.poster));
    const inventory = new DirectoryInventory();
    const thumbPath = assets ? assets.thumb : await resolveExistingImageAsset(thumbTargetPath, inventory);
    const posterPath = assets ? assets.poster : await resolveExistingImageAsset(posterTargetPath, inventory);
    let sourcePath = thumbPath ?? posterPath;
    if (!sourcePath) throw new Error("没有可编辑的本地封面或海报");
    const record = badgeRecords?.[thumbPath ? "thumb" : "poster"];
    const verifiedBase = record ? Boolean(await readManagedArtworkBase(sourcePath, record)) : false;
    if (verifiedBase && record && record.sha256 !== record.baseSha256) {
      sourcePath = badgeBasePath(sourcePath);
    }

    const metadata = await sharp(sourcePath, { animated: false }).rotate().metadata();
    const width = metadata.width ?? 0;
    const height = metadata.height ?? 0;
    if (width <= 0 || height <= 0) throw new Error("无法读取海报来源图片的尺寸");
    return {
      sourcePath,
      targetPath: posterPath ?? posterTargetPath,
      width,
      height,
      initialCrop: resolvePosterEditorCropRegion(width, height),
      verifiedBase,
    };
  }

  async save(
    videoPath: string,
    assetNamingMode: AssetNamingMode,
    crop: NormalizedCropRegion,
    assets?: { thumb?: string; poster?: string },
    movie?: {
      library: MovieLibrary & Pick<PublicationOutputPort, "publicationSnapshot">;
      movieId: string;
      roots: readonly { id: string; hostPath: string }[];
      nfoPaths?: readonly string[];
      configuration?: Configuration;
    },
  ): Promise<PosterCropSession & { revision: string }> {
    return await withMovieTask(movie?.movieId ?? videoPath, "保存当前影片海报", async () => {
      if (movie) {
        const current = movie.library.publicationSnapshot({ paths: [videoPath] });
        if (!current.files.some((file) => file.itemId === movie.movieId))
          throw new Error("影片资源位置已变化，请刷新后重试");
      }
      const inventory = new DirectoryInventory();
      const nfos = await readPosterNfos(movie?.nfoPaths ?? [], inventory);
      const snapshot = nfos[0] ? parseNfoSnapshot(nfos[0].xml) : undefined;
      const session = await this.prepare(videoPath, assetNamingMode, assets, snapshot?.localState?.badgeRecords);
      const extension = extname(session.targetPath).toLowerCase() || ".jpg";
      if (!supportedExtensions.has(extension)) throw new Error(`不支持的海报格式：${extension}`);
      await inventory.stats(session.sourcePath);
      const pixelCrop = normalizedCropToPixels(crop, session.width, session.height);
      const source = sharp(session.sourcePath, { animated: false }).rotate().extract(pixelCrop);
      const base = await encodePoster(source, extension).toBuffer();
      const artifacts: Array<{ targetPath: string; data: Buffer | string }> = [];
      const artworkPaths = [{ kind: "poster", path: session.targetPath }];
      let data: Buffer = base;
      if (
        snapshot &&
        movie?.configuration?.download.generateNfo &&
        this.watermark &&
        (session.verifiedBase || snapshot.localState?.badgeRecords?.poster)
      ) {
        const { download, scrape } = movie.configuration;
        const badgeRecords: BadgeArtworkRecords = { poster: null };
        if (session.verifiedBase) {
          const { fileInfo } = await resolveFileInfoWithSubtitles(videoPath, { inventory, filenameRules: scrape });
          const plan = resolveArtworkBadges("poster", snapshot.crawlerData, fileInfo, snapshot.localState, download);
          const rendered = await encodeBadgeArtwork(base, plan, download, this.watermark);
          badgeRecords.poster = rendered.record;
          data = rendered.data;
          if (data !== base) {
            const targetPath = badgeBasePath(session.targetPath);
            artifacts.push({ targetPath, data: base });
            artworkPaths.push({ kind: "poster-base", path: targetPath });
          }
        }
        const generator = new NfoGenerator();
        for (const nfo of nfos) {
          const xml = generator.mergeBadgeRecords(nfo.xml, badgeRecords);
          if (xml !== nfo.xml) artifacts.push({ targetPath: nfo.path, data: xml });
        }
      }
      artifacts.push({ targetPath: session.targetPath, data });
      const release = await acquireOutputDirectories(
        artifacts.map(({ targetPath }) => targetPath),
        (directory) => inventory.canonicalDirectory(directory),
      );
      try {
        if (movie) {
          const snapshot = movie.library.publicationSnapshot({ paths: artifacts.map(({ targetPath }) => targetPath) });
          if ([...snapshot.assets, ...snapshot.files].some((entry) => entry.itemId !== movie.movieId)) {
            throw new Error("其他影片仍在使用此海报或 NFO");
          }
        }
        await new WriteOutput().install(artifacts, {
          protectedMediaFiles: [videoPath],
          validate: () => inventory.assertUnchanged([session.sourcePath, ...nfos.map(({ path }) => path)]),
          commit: async () => {
            if (!movie) return;
            await writePublishedMovie(
              movie.library,
              movie.movieId,
              artworkPaths.map(({ kind, path }) => {
                const ref = toRootFileRef(path, movie.roots);
                return { kind, uri: ref.relativePath, ...ref, published: true };
              }),
            );
          },
        });
      } finally {
        release();
      }
      return { ...session, revision: String(Date.now()) };
    });
  }
}
