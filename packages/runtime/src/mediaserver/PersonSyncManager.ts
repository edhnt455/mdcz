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

const PERIOD_MS = 30 * 60_000;
const RETRY_MS = [10_000, 30_000, 60_000, 120_000, 300_000];
const SOURCE_COOLDOWN_MS = 6 * 60 * 60_000;

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
  #attempt = 0;
  #connection = "";
  #configurationKey = "";
  #pending = new Map<string, ActorSourceHint[]>();
  #cooldown = new Map<string, number>();
  #rerun = false;

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
    this.#schedule(5_000);
  }

  configurationChanged(configuration?: Configuration): void {
    if (!this.#active || this.#closed) return;
    if (configuration) {
      const key = JSON.stringify([configuration.emby, configuration.personSync, configuration.paths.actorPhotoFolder]);
      if (key === this.#configurationKey) return;
      this.#configurationKey = key;
    }
    this.#revision++;
    this.#attempt = 0;
    this.#pending.clear();
    this.#cooldown.clear();
    this.#automatic = { ...this.#automatic, error: null };
    this.#schedule(0);
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
    this.#attempt = 0;
    if (this.#automatic.status !== "blocked") this.#schedule(5_000);
  }

  start(input: PersonSyncStartInput): PersonSyncJobDto {
    if (this.#closed) throw new Error("Person sync is closing");
    if (this.#job?.status === "running") return this.#job;
    this.#cooldown.clear();
    this.deps.actorSourceProvider.clearCache();
    this.#revision++;
    this.#job = this.#createJob(input, "manual");
    this.#running = this.#execute(input).finally(() => {
      this.#running = undefined;
      if (this.#active && !this.#closed) this.#schedule(5_000);
    });
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

  #schedule(delay: number): void {
    if (this.#closed || !this.#active) return;
    clearTimeout(this.#timer);
    this.#automatic = {
      ...this.#automatic,
      status: this.#pending.size ? "waiting" : "scheduled",
      waitingActors: this.#pending.size,
      nextRunAt: new Date(Date.now() + delay).toISOString(),
    };
    this.#emit();
    this.#timer = setTimeout(() => {
      void this.#tick();
    }, delay);
    this.#timer.unref?.();
  }

  async #tick(): Promise<void> {
    if (this.#closed) return;
    if (this.#running) {
      this.#rerun = true;
      return;
    }
    this.#running = this.#automaticRun()
      .catch((error) => {
        this.deps.logger.error(`Automatic actor photo sync failed: ${toErrorMessage(error)}`);
        const status = error instanceof MediaServerServiceError ? error.status : getHttpStatus(error);
        const blocked = status === 401 || status === 403;
        this.#automatic = {
          ...this.#automatic,
          status: blocked ? "blocked" : "waiting",
          nextRunAt: null,
          error: toErrorMessage(error),
        };
        if (!blocked) this.#schedule(RETRY_MS[this.#attempt++] ?? PERIOD_MS);
        else this.#emit();
      })
      .finally(() => {
        this.#running = undefined;
        if (this.#rerun && !this.#closed) {
          this.#rerun = false;
          this.#schedule(5_000);
        }
      });
    await this.#running;
  }

  async #automaticRun(): Promise<void> {
    const configuration = await this.deps.getConfiguration();
    this.#configurationKey = JSON.stringify([
      configuration.emby,
      configuration.personSync,
      configuration.paths.actorPhotoFolder,
    ]);
    const { emby } = configuration;
    if (!emby.autoSyncActorPhotos || !emby.url.trim() || !emby.apiKey.trim()) {
      this.#automatic = {
        ...this.#automatic,
        status: !emby.autoSyncActorPhotos ? "disabled" : "unconfigured",
        nextRunAt: null,
        error: null,
      };
      this.#emit();
      return;
    }
    const connection = JSON.stringify([emby.url, emby.apiKey, emby.userId]);
    if (connection !== this.#connection) {
      this.#connection = connection;
      this.#cooldown.clear();
    }
    const revision = this.#revision;
    const canContinue = () => !this.#closed && revision === this.#revision;
    const hints = new Map(this.#pending);
    let personCount = 0;
    this.#automatic = { ...this.#automatic, status: "running", nextRunAt: null, error: null };
    const input: PersonSyncStartInput = { server: "emby", kind: "photo", mode: "missing" };
    this.#createJob(input, "automatic");
    const result = await this.#execute(input, configuration, {
      canContinue,
      shouldProcess: (id) => (this.#cooldown.get(id) ?? 0) <= Date.now(),
      sourceHints: (name) => hints.get(this.#actorKey(configuration, name)) ?? [],
      onPersons: (persons) => {
        if (!canContinue()) return;
        personCount = persons.length;
        for (const person of persons) this.#pending.delete(this.#actorKey(configuration, person.Name));
      },
      onOutcome: (id, outcome) => {
        if (outcome === "missing") this.#cooldown.set(id, Date.now() + SOURCE_COOLDOWN_MS);
        else this.#cooldown.delete(id);
      },
    });
    if (!canContinue()) return;
    this.#automatic = { ...this.#automatic, lastRunAt: new Date().toISOString(), error: null };
    const needsRetry = this.#pending.size > 0 || personCount === 0 || Boolean(result?.failedCount);
    if (!needsRetry) this.#attempt = 0;
    this.#schedule(needsRetry ? (RETRY_MS[this.#attempt++] ?? PERIOD_MS) : PERIOD_MS);
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
