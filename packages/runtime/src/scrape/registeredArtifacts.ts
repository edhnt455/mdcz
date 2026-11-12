import { dirname } from "node:path";
import {
  type MediaRoot,
  readRootFile,
  resolveRootFile,
  resolveRootRelativePath,
  StorageError,
  storageErrorCodes,
} from "@mdcz/media-store";
import type { Configuration } from "@mdcz/shared/config";
import { applyLibraryEdit, type LibraryEdit } from "@mdcz/shared/libraryEdit";
import { applyNfoEditorChanges } from "@mdcz/shared/nfoEditor";
import type { CrawlerData, NfoEditorField } from "@mdcz/shared/types";
import { XMLValidator } from "fast-xml-parser";
import { type MovieLibrary, resolveRegisteredNfoPaths, writePublishedMovie } from "../library/registeredMedia";
import { buildMovieTags } from "../maintenance/movieTags";
import { parseNfoSnapshot } from "../maintenance/nfoSnapshot";
import { acquireOutputDirectories } from "../publication/outputMutex";
import { toRootFileRef } from "../publication/outputRefs";
import type { PublicationOutputPort } from "../publication/types";
import { WriteOutput } from "../publication/WriteOutput";
import { DirectoryInventory } from "./DirectoryInventory";
import {
  getNfoReadCandidates,
  getNfoWritePaths,
  isNfoEditorFieldEnabled,
  type NfoGenerator,
  nfoIgnoreFieldsToEnabledFields,
  resolveFilenameNfoPath,
} from "./nfo";

export async function writeNfoPublication(
  input: {
    nfoPath: string;
    videoPath?: string;

    configuration: Configuration;
    nfoGenerator: Pick<NfoGenerator, "mergeEditableXml" | "buildXml">;
    publication: {
      roots: readonly MediaRoot[];
      outputs?: PublicationOutputPort;
      library?: MovieLibrary;
    };
  } & (
    | { edit: LibraryEdit; data?: never; changedFields?: never }
    | { data: CrawlerData; changedFields: readonly NfoEditorField[]; edit?: never }
  ),
): Promise<{ path: string; changed: boolean; directories: string[] }> {
  const { nfoPath, videoPath, configuration, nfoGenerator, publication } = input;
  const changedFields: readonly NfoEditorField[] = input.edit ? [input.edit.field] : input.changedFields;
  const nfoNaming = configuration.download.nfoNaming;
  const enabledFields = nfoIgnoreFieldsToEnabledFields(configuration.download.nfoIgnoreFields);
  const excludedFields = changedFields.filter((field) => !isNfoEditorFieldEnabled(field, enabledFields));
  if (excludedFields.length) {
    throw new Error(`以下字段已在 NFO 设置中禁用：${excludedFields.join("、")}`);
  }
  const plannedPath = resolveFilenameNfoPath(nfoPath, videoPath);
  const paths = getNfoWritePaths(plannedPath, nfoNaming);
  const owned = publication.outputs
    ? await resolveRegisteredNfoPaths(nfoPath, publication.outputs, async (id) => {
        const root = publication.roots.find((root) => root.id === id);
        if (!root) throw new Error(`未找到发布根目录： ${id}`);
        return root;
      })
    : undefined;
  const library = publication.library;
  if (owned && !library) throw new Error("写入已登记的 NFO 需要同步更新媒体库");
  const targets = owned?.paths ?? paths.requiredPaths;
  if (input.edit && !owned) throw new Error("批量编辑需要已登记的 NFO");
  const result = { path: owned ? nfoPath : paths.canonicalPath, changed: false, directories: [] as string[] };
  if (!changedFields.length) return result;
  const candidates = owned?.paths ?? getNfoReadCandidates(nfoPath, nfoNaming, videoPath);
  const inventory = new DirectoryInventory();
  const release = await acquireOutputDirectories([...targets, ...candidates], (directory) =>
    inventory.canonicalDirectory(directory),
  );
  try {
    const existing = new Map<string, string>();
    for (const candidate of new Set([...targets, ...candidates])) {
      const { root, relativePath } = resolveRootFile(publication.roots, candidate);
      const content = await readRootFile(root, relativePath).catch((error: unknown) => {
        if (!owned && error instanceof StorageError && error.code === storageErrorCodes.MissingPath) return null;
        throw error;
      });
      if (content !== null) {
        const xml = content.toString("utf-8");
        const validation = XMLValidator.validate(xml);
        if (validation !== true) throw new Error(`NFO XML 无效： ${validation.err.msg}`);
        existing.set(candidate, xml);
      }
    }
    const fallback = candidates.map((candidate) => existing.get(candidate)).find((xml) => xml !== undefined);
    const sourceData = fallback === undefined ? input.data : parseNfoSnapshot(fallback).crawlerData;
    if (!sourceData) throw new Error("缺少 NFO 元数据");
    const artifacts = targets.flatMap((targetPath) => {
      const xml = existing.get(targetPath) ?? fallback;
      const snapshot = xml === undefined ? undefined : parseNfoSnapshot(xml);
      const options = {
        buildTags: buildMovieTags,
        localState: snapshot?.localState,
        enabledFields,
        nfoNaming,
        titleNaming: configuration.naming,
      };
      const data = input.edit
        ? applyLibraryEdit(snapshot?.crawlerData ?? sourceData, input.edit)
        : snapshot
          ? applyNfoEditorChanges(snapshot.crawlerData, input.data, changedFields)
          : input.data;
      if (!data) return [];
      return [
        {
          targetPath,
          data:
            xml === undefined || !snapshot
              ? nfoGenerator.buildXml(data, options)
              : nfoGenerator.mergeEditableXml(xml, data, changedFields, options, input.edit),
        },
      ];
    });
    if (input.edit && owned && library && !artifacts.length) {
      const entry = await library.getEntryById(owned.movieId);
      if (!applyLibraryEdit(entry.crawlerDataJson ? JSON.parse(entry.crawlerDataJson) : sourceData, input.edit))
        return result;
    }
    await new WriteOutput().install(artifacts, {
      protectedMediaFiles: owned?.mediaPaths ?? (videoPath ? [videoPath] : []),
      commit: async () => {
        if (!owned || !library) return;
        const entry = await library.getEntryById(owned.movieId);
        const currentData: CrawlerData = entry.crawlerDataJson ? JSON.parse(entry.crawlerDataJson) : sourceData;
        await writePublishedMovie(
          library,
          owned.movieId,
          artifacts.map((artifact) => {
            const ref = toRootFileRef(artifact.targetPath, publication.roots);
            return {
              kind: "nfo",
              uri: ref.relativePath,
              rootId: ref.rootId,
              relativePath: ref.relativePath,
              published: true,
            };
          }),
          input.edit
            ? (applyLibraryEdit(currentData, input.edit) ?? currentData)
            : applyNfoEditorChanges(currentData, input.data, changedFields),
        );
      },
    });
    result.changed = true;
    result.directories = [...new Set(targets.map((target) => dirname(target)))];
  } finally {
    release();
  }
  return result;
}

export async function registeredPosterCropContext(
  videoPath: string,
  library: MovieLibrary & Pick<PublicationOutputPort, "publicationSnapshot">,
  resolveRoot: (id: string) => Promise<Pick<MediaRoot, "id" | "hostPath">>,
) {
  const snapshot = library.publicationSnapshot({ paths: [videoPath] });
  const owners = [...new Set(snapshot.files.map((file) => file.itemId))];
  if (owners.length > 1) throw new Error("同一视频被多个媒体库影片引用，无法确定封面");
  if (!owners.length) throw new Error("当前视频未入库，无法读取已保存的封面");
  const movieId = owners[0];
  const entry = await library.getEntryById(movieId);
  const assets: { thumb?: string; poster?: string } = {};
  let root: Pick<MediaRoot, "id" | "hostPath"> | undefined;
  for (const kind of ["thumb", "poster"] as const) {
    const asset = entry.assets.find((asset) => asset.kind === kind && asset.rootId && asset.relativePath);
    if (!asset?.rootId || !asset.relativePath) continue;
    root = await resolveRoot(asset.rootId);
    assets[kind] = resolveRootRelativePath(root, asset.relativePath);
  }
  return { videoPath, assets, root, movieId };
}
