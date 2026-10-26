import { randomUUID } from "node:crypto";
import { normalizeActorName, resolveActorAliasCandidates } from "@mdcz/shared/actorAliases";
import type { Configuration } from "@mdcz/shared/config";
import type { PersonSyncResult } from "@mdcz/shared/ipcTypes";
import type {
  ActorPhotoAutoSyncStatus,
  PersonSyncJobDto,
  PersonSyncStartInput,
  PersonSyncStateDto,
} from "@mdcz/shared/serverDtos";
import type { CrawlerData } from "@mdcz/shared/types";
import type { ActorSourceProvider } from "../actorSource";
import { mergeActorSourceHints } from "../actorSource/sourceHints";
import type { ActorSourceHint } from "../actorSource/types";
import type { RuntimeNetworkClient } from "../network";
import { type RuntimeLogger, toErrorMessage } from "../shared";
import { EmbyActorInfoService, EmbyActorPhotoService } from "./emby";
import { getHttpStatus, MediaServerServiceError } from "./errors";
import { JellyfinActorInfoService, JellyfinActorPhotoService, type MediaServerSignalService } from "./jellyfin";
import { formatPersonSyncError } from "./personSync";
import type { PhotoSyncOptions } from "./photoSync";

/** Owns all person writes; background synchronization never depends on a mounted page. */
export class PersonSyncManager {
  #job: PersonSyncJobDto | null = null;
  #automatic: ActorPhotoAutoSyncStatus = {
    status: "unconfigured",
    nextRunAt: null,
    lastRunAt: null,
    waitingActors: 0,
    error: null,
  };
  #timer: ReturnType<typeof setTimeout> | undefined;
  #progressTimer: ReturnType<typeof setTimeout> | undefined;
  #running: Promise<unknown> | undefined;
  #active = false;
  #closed = false;
  #revision = 0;
  #configuration: Configuration | undefined;
  #configurationKey = "";
  #pending = new Map<string, ActorSourceHint[]>();
  #publicationAt: number | null = null;
  #dailyAt: number | null = null;
  #fullScanPending = false;

  constructor(
    private readonly deps: {
      getConfiguration: () => Promise<Configuration>;
      networkClient: RuntimeNetworkClient;
      actorSourceProvider: ActorSourceProvider;
      logger: RuntimeLogger;
      onChange?: (state: PersonSyncStateDto) => void;
    },
  ) {}

  status(): PersonSyncJobDto | null {
    return this.#job;
  }
  snapshot(): PersonSyncStateDto {
    return { job: this.#job, automatic: this.#automatic };
  }

  activate(): void {
    if (this.#active || this.#closed) return;
    this.#active = true;
    this.configurationChanged();
  }

  configurationChanged(configuration?: Configuration): void {
    if (!this.#active || this.#closed) return;
    if (configuration) {
      const key = JSON.stringify([configuration.emby, configuration.personSync, configuration.paths.actorPhotoFolder]);
      if (key === this.#configurationKey) return;
      this.#configurationKey = key;
    }
    const revision = ++this.#revision;
    clearTimeout(this.#timer);
    this.#pending.clear();
    this.#publicationAt = null;
    this.#dailyAt = null;
    this.#fullScanPending = false;
    this.#automatic = { ...this.#automatic, status: "idle", error: null, nextRunAt: null, waitingActors: 0 };
    void (async () => {
      const config = configuration ?? (await this.deps.getConfiguration());
      if (this.#closed || revision !== this.#revision) return;
      this.#configuration = config;
      this.#configurationKey = JSON.stringify([config.emby, config.personSync, config.paths.actorPhotoFolder]);
      this.#setNextDailyRun();
      this.#schedule();
    })().catch((error) => {
      if (this.#closed || revision !== this.#revision) return;
      this.deps.logger.error(`Failed to configure actor photo sync: ${toErrorMessage(error)}`);
      this.#automatic = { ...this.#automatic, status: "blocked", error: toErrorMessage(error) };
      this.#emit();
    });
  }

  published(configuration: Configuration, data: CrawlerData): void {
    if (
      !this.#active ||
      this.#closed ||
      !configuration.emby.autoSyncActorPhotos ||
      !configuration.emby.url.trim() ||
      !configuration.emby.apiKey.trim()
    )
      return;
    for (const name of data.actors) {
      const key = this.#actorKey(configuration, name);
      this.#pending.set(
        key,
        mergeActorSourceHints(this.#pending.get(key), [
          { website: data.website, studio: data.studio, publisher: data.publisher },
        ]),
      );
    }
    if (!this.#pending.size) return;
    this.#publicationAt = Date.now() + 5_000;
    this.#schedule();
  }

  start(input: PersonSyncStartInput): PersonSyncJobDto {
    if (this.#closed) throw new Error("Person sync is closing");
    if (this.#job?.status === "running") return this.#job;
    this.deps.actorSourceProvider.clearCache();
    if (input.server === "emby" && input.kind === "photo") {
      this.#pending.clear();
      this.#publicationAt = null;
      this.#fullScanPending = false;
    }
    this.#automatic = { ...this.#automatic, status: "idle", error: null };
    this.#job = this.#createJob(input, "manual");
    this.#running = this.#execute(input).finally(() => {
      this.#running = undefined;
      this.#schedule();
    });
    this.#schedule();
    return this.#job;
  }

  async run(input: PersonSyncStartInput): Promise<PersonSyncResult> {
    if (this.#running) throw new Error("A person synchronization is already running");
    this.start(input);
    await this.#running;
    if (this.#job?.error) throw new Error(this.#job.error);
    if (!this.#job?.result) throw new Error("Person synchronization returned no result");
    return this.#job.result;
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#revision++;
    clearTimeout(this.#timer);
    clearTimeout(this.#progressTimer);
    await this.#running;
  }

  #actorKey(configuration: Configuration, name: string): string {
    return normalizeActorName(
      resolveActorAliasCandidates(configuration.personSync.actorAliases, [name]).canonicalName || name,
    );
  }

  #createJob(input: PersonSyncStartInput, trigger: "manual" | "automatic"): PersonSyncJobDto {
    const job: PersonSyncJobDto = {
      ...input,
      trigger,
      id: randomUUID(),
      status: "running",
      current: 0,
      total: 0,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      result: null,
      error: null,
    };
    this.#job = job;
    this.#emit();
    return job;
  }

  #emit(): void {
    this.deps.onChange?.(this.snapshot());
  }

  #setNextDailyRun(): void {
    const time = this.#configuration?.emby.actorPhotoDailySyncTime;
    this.#dailyAt = null;
    if (!time) return;
    const [hour, minute] = time.split(":").map(Number);
    const next = new Date();
    next.setHours(hour, minute, 0, 0);
    if (next.getTime() <= Date.now()) next.setDate(next.getDate() + 1);
    this.#dailyAt = next.getTime();
  }

  #schedule(): void {
    if (this.#closed || !this.#active) return;
    clearTimeout(this.#timer);
    const emby = this.#configuration?.emby;
    let status: ActorPhotoAutoSyncStatus["status"] = "idle";
    let nextRunAt: number | null = null;
    if (!emby) return;
    if (!emby.autoSyncActorPhotos) status = "disabled";
    else if (!emby.url.trim() || !emby.apiKey.trim()) status = "unconfigured";
    else if (this.#automatic.status === "blocked") status = "blocked";
    else if (this.#running) status = "running";
    else {
      const next = Math.min(
        this.#fullScanPending ? Date.now() : Number.POSITIVE_INFINITY,
        this.#pending.size ? (this.#publicationAt ?? Date.now()) : Number.POSITIVE_INFINITY,
        this.#dailyAt ?? Number.POSITIVE_INFINITY,
      );
      if (Number.isFinite(next)) {
        nextRunAt = next;
        status = this.#pending.size ? "waiting" : "scheduled";
      }
    }
    this.#automatic = {
      ...this.#automatic,
      status,
      waitingActors: this.#pending.size,
      nextRunAt: nextRunAt === null ? null : new Date(nextRunAt).toISOString(),
    };
    this.#emit();
    if (nextRunAt === null) return;
    this.#timer = setTimeout(
      () => {
        if (this.#dailyAt !== null && this.#dailyAt <= Date.now()) {
          this.#fullScanPending = true;
          this.#setNextDailyRun();
        }
        void this.#tick();
      },
      Math.max(0, nextRunAt - Date.now()),
    );
    this.#timer.unref?.();
  }

  async #tick(): Promise<void> {
    if (this.#closed) return;
    if (this.#running) return;
    const revision = this.#revision;
    this.#running = this.#automaticRun()
      .catch((error) => {
        if (this.#closed || revision !== this.#revision) return;
        this.deps.logger.error(`Automatic actor photo sync failed: ${toErrorMessage(error)}`);
        const status = error instanceof MediaServerServiceError ? error.status : getHttpStatus(error);
        const blocked = status === 401 || status === 403;
        this.#automatic = {
          ...this.#automatic,
          status: blocked ? "blocked" : "idle",
          nextRunAt: null,
          error: toErrorMessage(error),
        };
      })
      .finally(() => {
        this.#running = undefined;
        this.#schedule();
      });
    await this.#running;
  }

  async #automaticRun(): Promise<void> {
    const configuration = this.#configuration;
    if (!configuration) return;
    const revision = this.#revision;
    const canContinue = () => !this.#closed && revision === this.#revision;
    const hints = new Map(this.#pending);
    const fullScan = this.#fullScanPending;
    this.#pending.clear();
    this.#publicationAt = null;
    this.#fullScanPending = false;
    this.#automatic = { ...this.#automatic, status: "running", nextRunAt: null, waitingActors: 0, error: null };
    const input: PersonSyncStartInput = { server: "emby", kind: "photo", mode: "missing" };
    this.#createJob(input, "automatic");
    await this.#execute(input, configuration, {
      canContinue,
      shouldProcess: (_id, name) => fullScan || hints.has(this.#actorKey(configuration, name)),
      sourceHints: (name) => hints.get(this.#actorKey(configuration, name)) ?? [],
    });
    if (!canContinue()) return;
    this.#automatic = { ...this.#automatic, lastRunAt: new Date().toISOString(), error: null };
  }

  async #execute(
    input: PersonSyncStartInput,
    configuration?: Configuration,
    options?: PhotoSyncOptions,
  ): Promise<PersonSyncResult | undefined> {
    const revision = this.#revision;
    const signalService: MediaServerSignalService = {
      resetProgress: () => this.#progress(0, 0),
      setProgress: (_percent, current = 0, total = 0) => this.#progress(current, total),
      showLogText: (message, level = "info") => this.deps.logger[level](message),
    };
    const deps = { ...this.deps, signalService };
    let config = configuration;
    try {
      config ??= await this.deps.getConfiguration();
      const result =
        input.server === "emby"
          ? input.kind === "photo"
            ? await new EmbyActorPhotoService(deps).run(config, input.mode, {
                canContinue: () => !this.#closed && revision === this.#revision,
                ...options,
              })
            : await new EmbyActorInfoService(deps).run(config, input.mode)
          : input.kind === "photo"
            ? await new JellyfinActorPhotoService(deps).run(config, input.mode)
            : await new JellyfinActorInfoService(deps).run(config, input.mode);
      this.#finish({ status: "completed", result });
      return result;
    } catch (error) {
      const message = formatPersonSyncError(error, config);
      this.deps.logger.error(`Person sync failed: ${message}`);
      this.#finish({ status: "failed", error: message });
      if (options)
        throw new MediaServerServiceError(
          error instanceof MediaServerServiceError ? error.code : "PERSON_SYNC_FAILED",
          message,
          error instanceof MediaServerServiceError ? error.status : getHttpStatus(error),
        );
    }
  }

  #progress(current: number, total: number): void {
    if (!this.#job) return;
    this.#job = { ...this.#job, current, total };
    this.#progressTimer ??= setTimeout(() => {
      this.#progressTimer = undefined;
      this.#emit();
    }, 250);
    this.#progressTimer.unref?.();
  }

  #finish(outcome: Partial<PersonSyncJobDto>): void {
    if (!this.#job) return;
    clearTimeout(this.#progressTimer);
    this.#progressTimer = undefined;
    this.#job = { ...this.#job, ...outcome, finishedAt: new Date().toISOString() };
    this.#emit();
  }
}
