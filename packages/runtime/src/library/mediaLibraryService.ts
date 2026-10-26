import { randomUUID } from "node:crypto";
import path from "node:path";
import { filesystemPathKey, isPathInside } from "@mdcz/media-store";
import { type LibraryStateRepository, PersistenceError, persistenceErrorCodes } from "@mdcz/persistence";
import type { Configuration, DeepPartial } from "@mdcz/shared/config";
import {
  type MediaLibraryDto,
  type MediaLibrarySettings,
  type MediaLibrarySettingsInput,
  mediaLibrarySettingsSchema,
  normalizeCloudPath,
  type PublicationTarget,
} from "@mdcz/shared/mediaLibrary";
import type { NamingPreviewItem } from "@mdcz/shared/types";
import type { LegacyConfigurationConversion } from "../config/legacyLibrary";
import { assertSymlinkSupport } from "../publication/outputFileSystem";
import { assertTargetLayout, FileOrganizer } from "../scrape/FileOrganizer";
import type { ConfiguredMediaRootService } from "./mediaRootService";

export type MediaLibrary = MediaLibrarySettings & { id: string; createdAt: Date; updatedAt: Date };

export const toPublicationTarget = (record: MediaLibrary): PublicationTarget => ({
  placement: record.placement,
  outputPath: record.outputPath,
  folderTemplate: record.folderTemplate,
  fileTemplate: record.fileTemplate,
});

export const toMediaLibraryDto = (record: MediaLibrary): MediaLibraryDto => ({
  ...record,
  createdAt: record.createdAt.toISOString(),
  updatedAt: record.updatedAt.toISOString(),
});

const preview = new FileOrganizer();

export class MediaLibrarySettingsError extends Error {}

export class MediaLibraryService {
  private writing: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly getConfiguration: () => Promise<Configuration>,
    private readonly updateConfiguration: (
      patch: DeepPartial<Configuration>,
      expected: Configuration,
    ) => Promise<unknown>,
    private readonly mediaRoots: ConfiguredMediaRootService,
    private readonly state: () => Promise<LibraryStateRepository>,
  ) {}

  async list(): Promise<MediaLibrary[]> {
    return (await this.getConfiguration()).libraries.map((library) => ({
      ...library,
      createdAt: new Date(library.createdAt),
      updatedAt: new Date(library.updatedAt),
    }));
  }

  async get(id: string): Promise<MediaLibrary> {
    const library = (await this.list()).find((library) => library.id === id);
    if (!library) throw new PersistenceError(persistenceErrorCodes.NotFound, `Library not found: ${id}`);
    return library;
  }

  async create(input: MediaLibrarySettingsInput): Promise<MediaLibrary> {
    return this.write(async () => {
      const configuration = await this.getConfiguration();
      const values = await this.validate(input);
      const library = { ...values, id: randomUUID(), createdAt: new Date(), updatedAt: new Date() };
      await this.updateConfiguration(
        { libraries: [...configuration.libraries, toMediaLibraryDto(library)] },
        configuration,
      );
      return library;
    });
  }

  async update(id: string, input: MediaLibrarySettingsInput): Promise<MediaLibrary> {
    return this.write(async () => {
      const configuration = await this.getConfiguration();
      const current = await this.get(id);
      const values = await this.validate(input, id);
      const library = { ...current, ...values, updatedAt: new Date() };
      if (current.sourcePath !== library.sourcePath) (await this.state()).deleteWatchSnapshot(id);
      await this.updateConfiguration(
        { libraries: configuration.libraries.map((entry) => (entry.id === id ? toMediaLibraryDto(library) : entry)) },
        configuration,
      );
      return library;
    });
  }

  async delete(id: string): Promise<void> {
    await this.write(async () => {
      const configuration = await this.getConfiguration();
      await this.get(id);
      await this.updateConfiguration(
        { libraries: configuration.libraries.filter((library) => library.id !== id) },
        configuration,
      );
      (await this.state()).removeLibrary(id);
    });
  }

  async previewNaming(input: MediaLibrarySettingsInput): Promise<NamingPreviewItem[]> {
    const settings = mediaLibrarySettingsSchema.parse(input);
    return preview.buildNamingPreview(await this.getConfiguration(), settings);
  }

  /** The library whose source directory most closely contains `hostPath`. */
  async findBySourcePath(hostPath: string): Promise<MediaLibrary | undefined> {
    return (await this.list())
      .filter((library) => isPathInside(library.sourcePath, hostPath))
      .sort((left, right) => right.sourcePath.length - left.sourcePath.length)[0];
  }

  /** Creates the library the old single-directory settings described, unless one already uses that directory. */
  async adoptLegacyConfiguration(conversion: LegacyConfigurationConversion): Promise<MediaLibrary | undefined> {
    const library = conversion.library;
    if (!library) return undefined;
    const key = filesystemPathKey(path.resolve(library.sourcePath));
    const existing = (await this.list()).find(
      (candidate) => filesystemPathKey(path.resolve(candidate.sourcePath)) === key,
    );
    if (existing) return existing;
    return this.create(library);
  }

  private write<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writing.then(operation);
    this.writing = result.catch(() => undefined);
    return result;
  }

  private async validate(input: MediaLibrarySettingsInput, id?: string): Promise<MediaLibrarySettings> {
    const settings = mediaLibrarySettingsSchema.parse(input);
    assertTargetLayout(await this.getConfiguration(), settings);
    for (const other of await this.list()) {
      if (other.id === id) continue;
      if (isPathInside(other.sourcePath, settings.sourcePath) || isPathInside(settings.sourcePath, other.sourcePath))
        throw new MediaLibrarySettingsError(`The source directory overlaps library "${other.name}"`);
    }
    // Registering the directories as media roots checks they exist and are reachable now, not at the first scrape.
    await this.mediaRoots.ensurePathRecord({ hostPath: settings.sourcePath });
    if (settings.placement !== "inPlace")
      await this.mediaRoots.prepareOutputDirectory({ hostPath: settings.outputPath });
    if (settings.placement === "symlink") await assertSymlinkSupport(settings.outputPath);
    return {
      ...settings,
      outputPath: settings.placement === "inPlace" ? "" : settings.outputPath,
      cloudPath: settings.discovery === "clouddrive" ? normalizeCloudPath(settings.cloudPath) : "",
    };
  }
}
