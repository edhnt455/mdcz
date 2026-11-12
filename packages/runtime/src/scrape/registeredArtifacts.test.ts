import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createMediaRoot } from "@mdcz/media-store";
import { configurationSchema, defaultConfiguration } from "@mdcz/shared/config";
import { Website } from "@mdcz/shared/enums";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { NfoGenerator } from "./nfo";
import { registeredPosterCropContext, writeNfoPublication } from "./registeredArtifacts";

describe("registeredPosterCropContext", () => {
  it.each(
    [[], ["movie-a"], ["movie-a", "movie-b"]].map((owners) => ({ owners })),
  )("requires one distinct movie owner ($owners)", async ({ owners }) => {
    const library = {
      publicationSnapshot: vi.fn(() => ({
        files: owners.map((itemId) => ({ itemId, rootId: "root", relativePath: "video.mp4" })),
        assets: [],
      })),
      getEntryById: vi.fn(async () => ({ assets: [] })),
      writeEntry: vi.fn(() => "movie-a"),
    };
    const result = registeredPosterCropContext("/media/video.mp4", library, async () => ({
      id: "root",
      hostPath: "/media",
    }));
    if (new Set(owners).size === 1) {
      await expect(result).resolves.toMatchObject({ assets: {}, movieId: "movie-a" });
      expect(library.getEntryById).toHaveBeenCalledWith("movie-a");
    } else {
      await expect(result).rejects.toThrow(owners.length ? "被多个媒体库影片引用" : "未入库");
      expect(library.getEntryById).not.toHaveBeenCalled();
    }
  });

  it("updates only edited fields in every registered NFO and its library record", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mdcz-registered-nfo-"));
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const root = createMediaRoot({ id: "root", displayName: "Root", hostPath: directory });
    const paths = [join(directory, "video.nfo"), join(directory, "movie.nfo")];
    const generator = new NfoGenerator();
    const original = {
      title: "Old",
      number: "ABC-123",
      actors: ["Actor"],
      genres: ["Old genre"],
      scene_images: [],
      website: Website.JAVBUS,
    };
    for (const [index, path] of paths.entries()) {
      await writeFile(
        path,
        generator.buildXml(
          { ...original, studio: `Studio ${index}` },
          {
            localState: {
              dateAdded: "2020-01-01",
              foreignElements: { playcount: `00${index}`, custom: { "@_copy": `${index}`, "#text": "007" } },
            },
          },
        ),
      );
    }
    const stored = { ...original, studio: "Database studio", translation_failures: { plot: "keep failure" } };
    const writeEntry = vi.fn((_movie: { crawlerDataJson?: string }, _files: readonly unknown[]) => "movie-a");
    const library = {
      publicationSnapshot: vi.fn(() => ({
        files: [{ itemId: "movie-a", fileId: "file-a", rootId: root.id, relativePath: "video.mp4" }],
        assets: paths.map((path) => ({
          itemId: "movie-a",
          fileId: null,
          rootId: root.id,
          relativePath: basename(path),
          kind: "nfo" as const,
          published: true,
        })),
      })),
      publicationRoots: vi.fn(() => [{ id: root.id, hostPath: root.hostPath }]),
      getEntryById: vi.fn(async () => ({ assets: [], crawlerDataJson: JSON.stringify(stored) })),
      writeEntry,
    };
    const input = {
      nfoPath: paths[1],
      data: { ...original, title: "Edited", studio: "Stale editor value" },
      changedFields: ["title"] as const,
      configuration: defaultConfiguration,
      nfoGenerator: generator,
      publication: { roots: [root], outputs: library, library },
    };
    await writeNfoPublication(input);
    for (const [index, path] of paths.entries()) {
      const xml = await readFile(path, "utf8");
      expect(xml).toContain("<title>Edited</title>");
      expect(xml).toContain(`<studio>Studio ${index}</studio>`);
      expect(xml).toContain(`<playcount>00${index}</playcount>`);
      expect(xml).toContain("<dateadded>2020-01-01</dateadded>");
      expect(xml).toContain(`<custom copy="${index}">007</custom>`);
      expect(xml.match(/<\?xml/gu)).toHaveLength(1);
    }
    expect(JSON.parse(writeEntry.mock.calls[0]?.[0].crawlerDataJson ?? "{}")).toEqual({ ...stored, title: "Edited" });
    const before = await Promise.all(paths.map((path) => readFile(path, "utf8")));
    await expect(
      writeNfoPublication({
        ...input,
        changedFields: ["director"],
        configuration: configurationSchema.parse({
          ...defaultConfiguration,
          download: { ...defaultConfiguration.download, nfoIgnoreFields: ["director"] },
        }),
      }),
    ).rejects.toThrow("字段已在 NFO 设置中禁用");
    expect(await Promise.all(paths.map((path) => readFile(path, "utf8")))).toEqual(before);
    await writeFile(paths[0], "<movie><broken></movie>");
    await expect(writeNfoPublication(input)).rejects.toThrow("NFO XML 无效");
    expect(await readFile(paths[1], "utf8")).toBe(before[1]);
    expect(writeEntry).toHaveBeenCalledOnce();
  });
});
