import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { filesystemPathKey, isPathInside } from "@mdcz/media-store";
import { type EmbyDeletionEventRow, type EmbyDeletionLibraryBinding, EmbyDeletionRepository } from "@mdcz/persistence";
import { type MediaLibraryService, mediaPathOwnership } from "@mdcz/runtime/library";
import {
  type EmbyDeletionNotification,
  type EmbyDeletionSettings,
  type EmbyDeletionStatus,
  embyDeletionNotificationSchema,
  embyDeletionSettingsSchema,
} from "@mdcz/shared/embyDeletion";
import { type MoviePilotSettings, moviePilotResourceIdentity, type StrmCloudBinding } from "@mdcz/shared/moviePilot";
import type { TaskEventBus } from "../taskEvents";
import { AuthenticationError } from "./authService";
import type { MaintenanceService } from "./maintenanceService";
import type { ServerPersistenceService } from "./persistenceService";
import type { RuntimeLogService } from "./runtimeLogService";
import { readMoviePilotConnection, readStrmBinding, StrmDeletionService } from "./strmDeletionService";

const MARKER_NAME = ".mdcz-library-id";
const CONFIRMATION_MS = 5_000;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

interface Dependencies {
  persistence: Pick<ServerPersistenceService, "getState">;
  libraries: Pick<MediaLibraryService, "list">;
  maintenance: Pick<MaintenanceService, "isBusy">;
  taskEvents: TaskEventBus;
  invalidateAvailability: () => void;
  logger: ReturnType<RuntimeLogService["getLogger"]>;
  now?: () => number;
  credentialsDirectory?: string;
  moviePilotFetch?: typeof fetch;
}

export class EmbyDeletionService {
  private timer?: ReturnType<typeof setTimeout>;
  private inFlight?: Promise<void>;
  private closed = false;
  private lastBindingAt = 0;
  private readonly now: () => number;
  private readonly strm: StrmDeletionService;

  constructor(private readonly deps: Dependencies) {
    this.now = deps.now ?? Date.now;
    this.strm = new StrmDeletionService(deps.credentialsDirectory, deps.moviePilotFetch);
  }

  private async repository(): Promise<EmbyDeletionRepository> {
    return new EmbyDeletionRepository((await this.deps.persistence.getState()).database);
  }

  async status(): Promise<EmbyDeletionStatus> {
    const repository = await this.repository();
    const settings = repository.settings();
    const activity = repository.status(this.now());
    return {
      moviePilot: readMoviePilotConnection(repository),
      associations: repository.associationCounts(readMoviePilotConnection(repository)?.id),
      settings: {
        mode: settings.mode,
        serverId: settings.serverId,
        libraryIds: settings.libraries.map((library) => library.id),
      },
      configured: Boolean(settings.secretHash),
      libraries: (await this.deps.libraries.list())
        .filter((library) => library.placement === "move" || library.placement === "copy")
        .map(({ id, name, outputPath }) => ({ id, name, outputPath })),
      counts: activity.counts,
      recent: activity.recent.map(({ snapshotJson, ...event }) => {
        const snapshot = snapshotJson ? (JSON.parse(snapshotJson) as StrmCloudBinding) : null;
        return {
          ...event,
          preview: snapshot
            ? {
                sourcePaths: [
                  ...new Set(
                    repository
                      .relatedBindings(snapshot.connectionId, snapshot.target.fileid)
                      .map((row) => row.sourcePath),
                  ),
                ],
                cloudPath: snapshot.target.path,
                fileId: snapshot.target.fileid,
              }
            : null,
        };
      }),
    };
  }

  async configure(input: EmbyDeletionSettings): Promise<EmbyDeletionStatus> {
    const parsed = embyDeletionSettingsSchema.parse(input);
    const repository = await this.repository();
    const previous = repository.settings();
    if (parsed.mode === "off") {
      repository.configure({ mode: "off", serverId: parsed.serverId, libraries: previous.libraries });
      return await this.status();
    }
    if (!previous.secretHash) throw new Error("Generate the Emby webhook address before enabling deletion sync");
    const libraries = await this.deps.libraries.list();
    const bindings: EmbyDeletionLibraryBinding[] = [];
    for (const id of new Set(parsed.libraryIds)) {
      const library = libraries.find(
        (library) => library.id === id && (library.placement === "move" || library.placement === "copy"),
      );
      if (!library) throw new Error(`Move or copy library not found: ${id}`);
      if (library.placement === "copy" && !readMoviePilotConnection(repository))
        throw new Error("Configure MoviePilot before selecting a copy STRM library");
      const outputPath = filesystemPathKey(library.outputPath);
      const resolved = filesystemPathKey(await realpath(outputPath));
      const markerPath = path.join(outputPath, MARKER_NAME);
      let marker: string;
      try {
        marker = await readFile(markerPath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        if (previous.libraries.some((binding) => binding.id === id && binding.outputPath === outputPath))
          throw new Error(`Library identity marker is missing: ${outputPath}`);
        marker = `mdcz:${randomUUID()}`;
        await writeFile(markerPath, marker, { encoding: "utf8", flag: "wx", mode: 0o600 });
      }
      if (!/^mdcz:[\da-f-]{36}$/u.test(marker))
        throw new Error(`Library identity marker does not match: ${outputPath}`);
      const old = previous.libraries.find((binding) => binding.id === id && binding.outputPath === outputPath);
      if (old && (old.realPath !== resolved || old.marker !== marker))
        throw new Error(`Library mount identity changed: ${outputPath}`);
      const binding: EmbyDeletionLibraryBinding = { id, outputPath, realPath: resolved, marker };
      if (library.placement === "copy") {
        const sourcePath = filesystemPathKey(library.sourcePath);
        const sourceRealPath = filesystemPathKey(await realpath(sourcePath));
        const sourceMarkerPath = path.join(sourcePath, MARKER_NAME);
        let sourceMarker: string;
        try {
          sourceMarker = await readFile(sourceMarkerPath, "utf8");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          if (old?.source) throw new Error("STRM source identity marker is missing");
          sourceMarker = `mdcz:${randomUUID()}`;
          await writeFile(sourceMarkerPath, sourceMarker, { encoding: "utf8", flag: "wx", mode: 0o600 });
        }
        if (
          !/^mdcz:[\da-f-]{36}$/u.test(sourceMarker) ||
          (old?.source &&
            (old.source.path !== sourcePath ||
              old.source.realPath !== sourceRealPath ||
              old.source.marker !== sourceMarker))
        )
          throw new Error("STRM source mount identity changed");
        binding.source = { path: sourcePath, realPath: sourceRealPath, marker: sourceMarker };
      }
      bindings.push(binding);
    }
    repository.configure({ mode: parsed.mode, serverId: parsed.serverId, libraries: bindings });
    return await this.status();
  }

  async configureMoviePilot(input: MoviePilotSettings): Promise<EmbyDeletionStatus> {
    await this.strm.configure(await this.repository(), input);
    return await this.status();
  }

  async testMoviePilot(): Promise<{ storage: string }> {
    return await this.strm.test(await this.repository());
  }

  async bindSources(): Promise<{ verified: number; unverified: number }> {
    if (this.deps.maintenance.isBusy) throw new Error("Wait for maintenance tasks before binding STRM sources");
    return await this.strm.bind(await this.repository());
  }

  async retry(id: string): Promise<{ success: true }> {
    (await this.repository()).retry(id);
    return { success: true };
  }

  async rotateSecret(): Promise<{ token: string }> {
    const token = randomBytes(32).toString("base64url");
    (await this.repository()).setSecretHash(hash(token));
    return { token };
  }

  async assertToken(token: string): Promise<void> {
    const expected = (await this.repository()).settings().secretHash;
    if (!expected || !timingSafeEqual(Buffer.from(hash(token)), Buffer.from(expected)))
      throw new AuthenticationError("Invalid Emby webhook credential");
  }

  async accept(payload: unknown) {
    const notification = embyDeletionNotificationSchema.parse(payload);
    const repository = await this.repository();
    const settings = repository.settings();
    const now = this.now();
    const rawPath = notification.Item?.Path;
    const normalized =
      rawPath && path.isAbsolute(rawPath) && !rawPath.includes("\0") && !rawPath.split(/[\\/]/u).includes("..")
        ? filesystemPathKey(rawPath)
        : null;
    const binding = normalized
      ? settings.libraries
          .filter((binding) => normalized !== binding.outputPath && isPathInside(binding.outputPath, normalized))
          .sort((a, b) => b.outputPath.length - a.outputPath.length)[0]
      : undefined;
    const file = normalized && binding ? repository.findFile(normalized) : undefined;
    const cloudBinding = file && binding?.source ? readStrmBinding(repository, file.id) : undefined;
    const deep = notification.Event === "deep.delete";
    const mountPaths = notification.Description?.match(/(?:^|\r?\n)Mount Paths\s*:\s*([\s\S]*)/iu)?.[1]
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean);
    let reason: string | null = null;
    if (settings.mode === "off") reason = "sync_disabled";
    else if (notification.Server.Id !== settings.serverId) reason = "server_not_allowed";
    else if (notification.Event !== "library.deleted" && !deep) reason = "event_not_supported";
    else if (notification.Item?.Type !== "Movie" || notification.Item.IsFolder) reason = "item_not_a_movie_file";
    else if (!notification.Date) reason = "event_date_missing";
    else if (!binding) reason = "path_not_allowed";
    else if (!file) reason = "file_not_registered";
    else if (binding.source && !deep) reason = "deep_delete_required";
    else if (deep && !binding.source) reason = "deep_delete_requires_copy_strm";
    else if (
      deep &&
      (!cloudBinding?.source.resourceIdentity ||
        cloudBinding.fileUpdatedAt !== file.updatedAt.getTime() ||
        cloudBinding.connectionId !== readMoviePilotConnection(repository)?.id)
    )
      reason = "cloud_binding_unverified";
    else if (
      deep &&
      mountPaths &&
      (!mountPaths.length ||
        mountPaths.some(
          (entry) =>
            moviePilotResourceIdentity(entry) !== cloudBinding?.source.resourceIdentity &&
            entry !== cloudBinding?.source.sourcePath,
        ))
    )
      reason = "mount_paths_mismatch";
    else if (Date.parse(notification.Date) > now + 60_000) reason = "event_date_in_future";
    else if (Date.parse(notification.Date) < file.updatedAt.getTime() - 60_000) reason = "event_predates_file_record";
    const dedupKey = hash(
      JSON.stringify([
        notification.Server.Id,
        notification.Event,
        deep && file ? file.id : notification.Item?.Id,
        deep && file ? file.updatedAt.getTime() : (notification.Date ?? null),
        rawPath ?? null,
      ]),
    );
    const { event, duplicate } = repository.enqueue({
      dedupKey,
      serverId: notification.Server.Id,
      itemId: notification.Item?.Id ?? "",
      eventAt: notification.Date ? Date.parse(notification.Date) : null,
      receivedAt: now,
      path: normalized,
      libraryId: binding?.id,
      outputPath: binding?.outputPath,
      fileId: file?.id,
      movieId: file?.itemId,
      fileUpdatedAt: file?.updatedAt.getTime(),
      status: reason ? "ignored" : "pending",
      nextAttemptAt: now + CONFIRMATION_MS,
      result: reason,
      completedAt: reason ? now : null,
      eventType: notification.Event,
      snapshotJson: deep && cloudBinding ? JSON.stringify(cloudBinding) : null,
    });
    return { id: event.id, status: event.status, duplicate };
  }

  async reconcile(): Promise<{ queued: number }> {
    const repository = await this.repository();
    const settings = repository.settings();
    if (settings.mode === "off") throw new Error("Enable observation or deletion sync first");
    const eventDate = new Date(this.now()).toISOString();
    let queued = 0;
    for (const { file, path: filePath } of repository.knownFiles(
      settings.libraries.filter((binding) => !binding.source),
    )) {
      const result = await this.accept({
        Event: "library.deleted",
        Date: eventDate,
        Server: { Id: settings.serverId },
        Item: { Id: `reconcile:${file.id}`, Type: "Movie", Path: filePath },
      } satisfies EmbyDeletionNotification);
      if (!result.duplicate && result.status === "pending") queued++;
    }
    return { queued };
  }

  start(): void {
    const tick = () => {
      if (this.closed) return;
      this.inFlight = this.runDue()
        .catch((error: unknown) => this.deps.logger.error(`Emby deletion worker failed: ${error}`))
        .finally(() => {
          this.inFlight = undefined;
          if (!this.closed) {
            this.timer = setTimeout(tick, 2_000);
            this.timer.unref();
          }
        });
    };
    this.timer = setTimeout(tick, 2_000);
    this.timer.unref();
  }

  async close(): Promise<void> {
    this.closed = true;
    clearTimeout(this.timer);
    await this.inFlight;
  }

  async runDue(): Promise<void> {
    const repository = await this.repository();
    if (repository.settings().mode === "off") return;
    repository.status(this.now());
    const settings = repository.settings();
    if (
      readMoviePilotConnection(repository) &&
      !repository.hasCloudWork() &&
      !repository.hasLiveScrapes() &&
      !this.deps.maintenance.isBusy &&
      this.now() - this.lastBindingAt >= 30_000 &&
      repository
        .knownFiles(settings.libraries.filter((binding) => binding.source))
        .some(
          ({ file, path: filePath }) =>
            path.extname(filePath).toLowerCase() === ".strm" &&
            readStrmBinding(repository, file.id)?.fileUpdatedAt !== file.updatedAt.getTime(),
        )
    ) {
      this.lastBindingAt = this.now();
      try {
        await this.bindSources();
      } catch (error) {
        this.deps.logger.warn(
          `STRM association verification failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    for (const event of repository.due(this.now())) {
      if (this.closed) return;
      let release: (() => void) | undefined;
      try {
        if (repository.hasLiveScrapes() || this.deps.maintenance.isBusy) {
          repository.update(event.id, {
            nextAttemptAt: this.now() + CONFIRMATION_MS,
            result: "waiting_for_media_tasks",
          });
          continue;
        }
        const snapshot = event.snapshotJson
          ? (JSON.parse(event.snapshotJson) as import("@mdcz/shared/moviePilot").StrmCloudBinding)
          : undefined;
        release = mediaPathOwnership.acquireAll([event.path ?? "", ...(snapshot ? [snapshot.source.sourcePath] : [])]);
        await this.process(repository, event);
      } catch (error) {
        const attempts = event.attempts + 1;
        const message = error instanceof Error ? error.message : String(error);
        if (attempts >= 8)
          repository.update(event.id, { status: "needs_review", attempts, result: message, completedAt: this.now() });
        else
          repository.update(event.id, {
            attempts,
            nextAttemptAt: this.now() + Math.min(300_000, CONFIRMATION_MS * 2 ** attempts),
            result: message,
          });
        this.deps.logger.warn(`Emby deletion ${event.id}: ${message}`);
      } finally {
        release?.();
      }
    }
  }

  private async process(repository: EmbyDeletionRepository, event: EmbyDeletionEventRow): Promise<void> {
    const settings = repository.settings();
    const moviePilotConnectionId = readMoviePilotConnection(repository)?.id;
    const binding = settings.libraries.find(
      (binding) => binding.id === event.libraryId && binding.outputPath === event.outputPath,
    );
    const library = (await this.deps.libraries.list()).find((library) => library.id === event.libraryId);
    if (
      settings.serverId !== event.serverId ||
      !binding ||
      !library ||
      (library.placement !== "move" &&
        !(
          library.placement === "copy" &&
          binding.source &&
          event.eventType === "deep.delete" &&
          filesystemPathKey(library.sourcePath) === binding.source.path
        )) ||
      filesystemPathKey(library.outputPath) !== binding.outputPath ||
      !event.path ||
      !isPathInside(binding.outputPath, event.path)
    ) {
      repository.finish(
        event.id,
        event.cloudDeletedAt !== null || event.step !== "validating" ? "needs_review" : "ignored",
        "library_binding_changed",
        this.now(),
      );
      return;
    }
    if (
      filesystemPathKey(await realpath(binding.outputPath)) !== binding.realPath ||
      (await readFile(path.join(binding.outputPath, MARKER_NAME), "utf8")) !== binding.marker
    )
      throw new Error("Library mount identity cannot be verified");
    const currentFile = repository.findFile(event.path);
    if (!currentFile || currentFile.id !== event.fileId || currentFile.updatedAt.getTime() !== event.fileUpdatedAt) {
      repository.finish(
        event.id,
        event.eventType === "deep.delete" ? "needs_review" : currentFile ? "ignored" : "completed",
        currentFile ? "file_record_changed" : "already_removed",
        this.now(),
      );
      return;
    }
    try {
      await lstat(event.path);
      repository.finish(event.id, "ignored", "file_still_exists", this.now());
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (event.missingSince === null) {
      repository.update(event.id, {
        missingSince: this.now(),
        nextAttemptAt: this.now() + CONFIRMATION_MS,
        result: "confirming_missing_file",
      });
      return;
    }
    if (this.now() - event.missingSince < CONFIRMATION_MS) return;
    if (
      (await readFile(path.join(binding.outputPath, MARKER_NAME), "utf8")) !== binding.marker ||
      filesystemPathKey(await realpath(binding.outputPath)) !== binding.realPath
    )
      throw new Error("Library mount identity cannot be verified");
    // The final check and transaction run without an await, so a new publication cannot start between them.
    if (this.closed || repository.settings().mode === "off") return;
    if (repository.hasLiveScrapes() || this.deps.maintenance.isBusy) {
      repository.update(event.id, { nextAttemptAt: this.now() + CONFIRMATION_MS, result: "waiting_for_media_tasks" });
      return;
    }
    if (event.eventType === "deep.delete") {
      const active = () => {
        const current = repository.settings();
        const currentBinding = current.libraries.find((candidate) => candidate.id === binding.id);
        const file = repository.findFile(event.path ?? "");
        return (
          !this.closed &&
          current.mode !== "off" &&
          (event.cloudDeletedAt === null || current.mode === "delete") &&
          current.serverId === event.serverId &&
          readMoviePilotConnection(repository)?.id === moviePilotConnectionId &&
          JSON.stringify(currentBinding) === JSON.stringify(binding) &&
          file?.id === event.fileId &&
          file.updatedAt.getTime() === event.fileUpdatedAt &&
          !repository.hasLiveScrapes() &&
          !this.deps.maintenance.isBusy
        );
      };
      if (!(await this.strm.process({ repository, event, library: binding, now: this.now, active }))) return;
      try {
        await lstat(event.path);
        throw new Error("Link STRM reappeared; record cleanup requires review");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (!active() || repository.settings().mode !== "delete") return;
    } else if (repository.settings().mode === "observe") {
      repository.finish(event.id, "ignored", "would_remove_records", this.now());
      return;
    }
    if (repository.clean(event, this.now())) {
      this.deps.invalidateAvailability();
      this.deps.taskEvents.invalidate("library", "pending");
      this.deps.logger.info(`Emby deletion ${event.id}: removed records for ${event.path}`);
    }
  }
}
