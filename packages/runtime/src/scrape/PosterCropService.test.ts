import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configurationSchema } from "@mdcz/shared/config";
import { Website } from "@mdcz/shared/enums";
import sharp from "sharp";
import { expect, it, onTestFinished, vi } from "vitest";
import { parseNfoSnapshot } from "../maintenance/nfoSnapshot";
import { badgeBasePath, readManagedArtworkBase } from "./badgeArtwork";
import { ImageWatermarkService } from "./ImageWatermarkService";
import { NfoGenerator } from "./nfo";
import { applyImageWatermarks } from "./output/applyImageWatermarks";
import { PosterCropService } from "./PosterCropService";

it("crops the clean cover and publishes the exact selected framing for later redraws", async () => {
  const root = await mkdtemp(join(tmpdir(), "mdcz-crop-badge-base-"));
  onTestFinished(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const videoPath = join(root, "ABC-123.mp4");
  const thumb = join(root, "thumb.jpg");
  const poster = join(root, "poster.jpg");
  const nfoPaths = [join(root, "ABC-123.nfo"), join(root, "movie.nfo")];
  const config = configurationSchema.parse({
    download: {
      tagBadges: true,
      tagBadgeTargets: ["thumb", "poster"],
      tagBadgeTypes: ["censored"],
    },
  });
  const generator = new NfoGenerator();
  const watermark = new ImageWatermarkService({ dataDir: root });
  const service = new PosterCropService(watermark);
  const cover = await sharp(
    Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="600"><path fill="blue" d="M0 0h450v600H0z"/><path fill="red" d="M450 0h450v600H450z"/></svg>',
    ),
  )
    .jpeg()
    .toBuffer();
  await Promise.all([writeFile(videoPath, "video"), writeFile(thumb, cover)]);
  const crawlerData = {
    title: "ABC-123",
    number: "ABC-123",
    actors: [],
    genres: [],
    scene_images: [],
    website: Website.DMM,
  };
  const assets = await applyImageWatermarks({
    assets: { thumb, sceneImages: [], downloaded: [thumb] },
    config,
    crawlerData,
    dataDir: root,
    watermarkService: watermark,
    fileInfo: {
      filePath: videoPath,
      fileName: "ABC-123.mp4",
      number: "ABC-123",
      extension: ".mp4",
      isSubtitled: false,
    },
    logger: {
      warn: (message) => {
        throw new Error(message);
      },
    },
  });
  const xml = generator.buildXml(crawlerData, { assets });
  await Promise.all(nfoPaths.map((path) => writeFile(path, xml)));
  const library = {
    publicationSnapshot: () => ({
      files: [{ itemId: "movie", rootId: "root", relativePath: "ABC-123.mp4" }],
      assets: [],
    }),
    getEntryById: async () => ({ assets: [] }),
    writeEntry: vi.fn(() => "movie"),
  };
  const selection = { x: 0.5, y: 0, width: 4 / 9, height: 1 };
  const save = () =>
    service.save(
      videoPath,
      "fixed",
      selection,
      { thumb, poster },
      {
        library,
        movieId: "movie",
        roots: [{ id: "root", hostPath: root }],
        nfoPaths,
        configuration: config,
      },
    );
  const saved = await save();
  expect(saved.sourcePath).toBe(badgeBasePath(thumb));
  const cleanCrop = await readFile(badgeBasePath(poster));
  const record = parseNfoSnapshot(await readFile(nfoPaths[0], "utf8")).localState?.badgeRecords?.poster;
  if (!record) throw new Error("missing cropped poster record");
  expect(record.stamp).toBeTruthy();
  expect(parseNfoSnapshot(await readFile(nfoPaths[1], "utf8")).localState?.badgeRecords?.poster).toEqual(record);
  await expect(readManagedArtworkBase(poster, record)).resolves.toEqual(cleanCrop);
  const { data, info } = await sharp(cleanCrop).raw().toBuffer({ resolveWithObject: true });
  expect(info).toMatchObject({ width: 400, height: 600 });
  const center = (300 * 400 + 200) * info.channels;
  expect(data[center]).toBeGreaterThan(240);
  expect(data[center + 1]).toBeLessThan(10);
  expect(data[center + 2]).toBeLessThan(10);
  expect(library.writeEntry).toHaveBeenCalledWith(
    expect.objectContaining({
      assets: expect.arrayContaining([expect.objectContaining({ kind: "poster-base", published: true })]),
    }),
    [],
  );
  await rm(badgeBasePath(thumb));
  expect((await save()).sourcePath).toBe(thumb);
  for (const nfoPath of nfoPaths) {
    expect(parseNfoSnapshot(await readFile(nfoPath, "utf8")).localState?.badgeRecords?.poster).toBeUndefined();
  }
});
