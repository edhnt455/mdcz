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
import type { TaskEventBus } from "../taskEvents";
import { AuthenticationError } from "./authService";
import type { MaintenanceService } from "./maintenanceService";
import type { ServerPersistenceService } from "./persistenceService";
import type { RuntimeLogService } from "./runtimeLogService";

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
}

export class EmbyDeletionService {
  private timer?: ReturnType<typeof setTimeout>;
  private inFlight?: Promise<void>;
  private closed = false;
  private readonly now: () => number;

  constructor(private readonly deps: Dependencies) {
    this.now = deps.now ?? Date.now;
  }

  private async repository(): Promise<EmbyDeletionRepository> {
    return new EmbyDeletionRepository((await this.deps.persistence.getState()).database);
  }

  async status(): Promise<EmbyDeletionStatus> {
    const repository = await this.repository();
    const settings = repository.settings();
    return {
      settings: {
        mode: settings.mode,
        serverId: settings.serverId,
        libraryIds: settings.libraries.map((library) => library.id),
      },
      configured: Boolean(settings.secretHash),
      libraries: (await this.deps.libraries.list())
        .filter((library) => library.placement === "move")
        .map(({ id, name, outputPath }) => ({ id, name, outputPath })),
      ...repository.status(this.now()),
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
      const library = libraries.find((library) => library.id === id && library.placement === "move");
      if (!library) throw new Error(`Move library not found: ${id}`);
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
      bindings.push({ id, outputPath, realPath: resolved, marker });
    }
    repository.configure({ mode: parsed.mode, serverId: parsed.serverId, libraries: bindings });
    return await this.status();
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
    let reason: string | null = null;
    if (settings.mode === "off") reason = "sync_disabled";
    else if (notification.Server.Id !== settings.serverId) reason = "server_not_allowed";
    else if (notification.Event !== "library.deleted") reason = "event_not_supported";
    else if (notification.Item?.Type !== "Movie" || notification.Item.IsFolder) reason = "item_not_a_movie_file";
    else if (!notification.Date) reason = "event_date_missing";
    else if (!binding) reason = "path_not_allowed";
    else if (!file) reason = "file_not_registered";
    else if (Date.parse(notification.Date) < file.updatedAt.getTime() - 60_000) reason = "event_predates_file_record";
    const dedupKey = hash(
      JSON.stringify([
        notification.Server.Id,
        notification.Event,
        notification.Item?.Id,
        notification.Date ?? null,
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
    });
    return { id: event.id, status: event.status, duplicate };
  }

  async reconcile(): Promise<{ queued: number }> {
    const repository = await this.repository();
    const settings = repository.settings();
    if (settings.mode === "off") throw new Error("Enable observation or deletion sync first");
    const eventDate = new Date(this.now()).toISOString();
    let queued = 0;
    for (const { file, path: filePath } of repository.knownFiles(settings.libraries)) {
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
        release = mediaPathOwnership.acquire(event.path ?? "");
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
    const binding = settings.libraries.find(
      (binding) => binding.id === event.libraryId && binding.outputPath === event.outputPath,
    );
    const library = (await this.deps.libraries.list()).find((library) => library.id === event.libraryId);
    if (
      settings.serverId !== event.serverId ||
      !binding ||
      !library ||
      library.placement !== "move" ||
      filesystemPathKey(library.outputPath) !== binding.outputPath ||
      !event.path ||
      !isPathInside(binding.outputPath, event.path)
    ) {
      repository.finish(event.id, "ignored", "library_binding_changed", this.now());
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
        currentFile ? "ignored" : "completed",
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
    if (repository.settings().mode === "observe") {
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
