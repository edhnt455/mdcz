import path from "node:path";
import { resolveRootRelativePath } from "@mdcz/media-store";
import type {
  LibraryRepository,
  PendingActionRepository,
  PendingItemRecord,
  PendingRepository,
  SiteResultRepository,
} from "@mdcz/persistence";
import type { Configuration, DeepPartial } from "@mdcz/shared/config";
import { toErrorMessage } from "@mdcz/shared/error";
import {
  type AmbiguousCandidate,
  ambiguousCandidateSchema,
  numberRecognitionAttemptSchema,
  type PendingActionJob,
  type PendingActionResponse,
  type PendingBatchInput,
  type PendingBatchResponse,
  type PendingConfirmUncensoredInput,
  type PendingDetailResponse,
  type PendingItemDto,
  type PendingListResponse,
  type PendingRetryInput,
  type PendingRetryResponse,
  pendingConfirmUncensoredInputSchema,
  pendingItemSchema,
  pendingSiteResultSchema,
} from "@mdcz/shared/pending";
import type { ScrapeStartInput } from "@mdcz/shared/serverDtos";
import { z } from "@mdcz/shared/zod";
import type { MaintenanceRuntime } from "../maintenance/MaintenanceRuntime";
import { committedMovieRows } from "../publication/committedMovie";
import type { NumberRecognitionService } from "../scrape/NumberRecognitionService";
import { runtimeLoggerService } from "../shared";
import { type MediaLibraryService, toPublicationTarget } from "./mediaLibraryService";
import type { ConfiguredMediaRootService } from "./mediaRootService";
import { PendingActionQueue } from "./PendingActionQueue";

export interface PendingServiceRepositories {
  pendingActions: PendingActionRepository;
  pending: PendingRepository;
  siteResults: SiteResultRepository;
  library: LibraryRepository;
}

export interface PendingServiceDependencies {
  libraries: Pick<MediaLibraryService, "list" | "get">;
  repositories: () => Promise<PendingServiceRepositories>;
  mediaRoots: ConfiguredMediaRootService;
  startScrape: (input: ScrapeStartInput) => Promise<{ taskId: string }>;
  getConfiguration: () => Promise<Configuration>;
  updateConfiguration: (patch: DeepPartial<Configuration>) => Promise<unknown>;
  maintenanceRuntime: Pick<MaintenanceRuntime, "applyLibraryEntry">;
  recognitionService: Pick<NumberRecognitionService, "recognize">;
  deleteFile: (id: string, progress: (message: string) => void) => Promise<void>;
  captureDelete: (id: string) => Promise<string | null>;
  isMediaBusy: () => Promise<boolean>;
  onChanged?: () => void;
  onProgress?: () => void;
  onLibraryChanged?: () => void;
}

const logger = runtimeLoggerService.getLogger("PendingService");

export class PendingService {
  private readonly queue: PendingActionQueue;

  constructor(private readonly deps: PendingServiceDependencies) {
    this.queue = new PendingActionQueue({
      repository: async () => (await deps.repositories()).pendingActions,
      busy: deps.isMediaBusy,
      changed: () => deps.onChanged?.(),
      progressed: () => deps.onProgress?.(),
      execute: async (job, progress) => {
        const { pending } = await deps.repositories();
        const current = pending.list().find((item) => item.id === job.itemId);
        if (!current) return;
        if (current.updatedAt.getTime() !== job.itemUpdatedAt) throw new Error("任务提交后条目已变化，请检查最新结果");
        if (job.action === "delete") {
          const input = JSON.parse(job.inputJson) as { fingerprint: string | null };
          if (
            !current.deletionJson &&
            input.fingerprint &&
            (await deps.captureDelete(job.itemId)) !== input.fingerprint
          )
            throw new Error("任务提交后 STRM 文件已变化，请检查后重新提交");
          await deps.deleteFile(job.itemId, progress);
        } else {
          progress("正在确认类型并更新文件、元数据及海报");
          await this.performConfirmUncensored(pendingConfirmUncensoredInputSchema.parse(JSON.parse(job.inputJson)));
        }
      },
    });
  }

  async start(): Promise<void> {
    await this.queue.start();
  }
  get isExecuting(): boolean {
    return this.queue.isExecuting;
  }
  async close(): Promise<void> {
    await this.queue.close();
  }
  async waitForIdle(): Promise<void> {
    await this.queue.waitForIdle();
  }

  async jobs(): Promise<{ jobs: PendingActionJob[] }> {
    const { pendingActions, pending } = await this.deps.repositories();
    const available = new Map(pending.listAvailable().map((item) => [item.id, item.taskId]));
    return {
      jobs: pendingActions.list().map(({ inputJson: _input, itemJson, itemUpdatedAt: _version, ...row }) => ({
        ...row,
        canRetry: row.status === "failed" && available.get(row.itemId) === row.id,
        item: pendingItemSchema.parse(JSON.parse(itemJson)),
      })),
    };
  }

  async retryJob(id: string): Promise<PendingActionResponse> {
    const { pendingActions, pending } = await this.deps.repositories();
    const job = pendingActions.list().find((row) => row.id === id);
    if (!job || job.status !== "failed") throw new Error("此任务当前无法重试");
    pending.assertAvailable(job.itemId);
    if (pending.get(job.itemId).taskId !== job.id) throw new Error("此任务已被新的处理结果替代，请检查最新条目");
    return job.action === "delete"
      ? this.delete(job.itemId)
      : this.confirmUncensored(pendingConfirmUncensoredInputSchema.parse(JSON.parse(job.inputJson)));
  }

  async list(newFiles = false): Promise<PendingListResponse> {
    const repositories = await this.deps.repositories();
    const roots = new Map((await this.deps.mediaRoots.listRoots()).map((root) => [root.id, root]));
    const libraries = new Map((await this.deps.libraries.list()).map((library) => [library.id, library.name]));
    return {
      items: repositories.pending
        .listAvailable()
        .filter((item) => (item.kind === "new_file") === newFiles)
        .map((item) => {
          const root = roots.get(item.rootId);
          return this.toDto(
            item,
            root ? resolveRootRelativePath(root, item.relativePath) : item.relativePath,
            libraries,
          );
        }),
    };
  }

  async detail(id: string): Promise<PendingDetailResponse> {
    const repositories = await this.deps.repositories();
    const item = repositories.pending.get(id);
    const root = await this.deps.mediaRoots.get(item.rootId);
    const libraries = new Map((await this.deps.libraries.list()).map((library) => [library.id, library.name]));
    return {
      item: this.toDto(item, resolveRootRelativePath(root, item.relativePath), libraries),
      numberRecognition: item.numberRecognitionJson
        ? numberRecognitionAttemptSchema.parse(JSON.parse(item.numberRecognitionJson))
        : null,
      siteResults: item.number
        ? repositories.siteResults
            .list(item.number)
            .map(({ data: _data, number: _number, updatedAt, ...result }) =>
              pendingSiteResultSchema.parse({ ...result, updatedAt: updatedAt.toISOString() }),
            )
        : [],
    };
  }

  async retry(input: PendingRetryInput): Promise<PendingRetryResponse> {
    const repositories = await this.deps.repositories();
    const item = repositories.pending.get(input.id);
    repositories.pending.assertAvailable(item.id);
    if (item.deletionJson) throw new Error("此文件的删除尚未完成，请继续删除");
    if (item.kind === "uncensored") throw new Error("此影片已发布，请改为确认影片类型");
    const libraryId = input.libraryId ?? item.libraryId;
    if (!libraryId) throw new Error("请选择刮削此文件的目标媒体库");
    const candidate = input.candidate === undefined ? undefined : this.candidates(item)[input.candidate];
    if (input.candidate !== undefined && !candidate) throw new Error("此条目中没有选中的作品");
    const manualUrl = candidate?.detailUrl ?? input.manualUrl;
    if (input.rule) await this.saveRule(input.rule, input.number);
    const { taskId } = await this.deps.startScrape({
      executionMode: "single",
      libraryId,
      refs: [{ rootId: item.rootId, relativePath: item.relativePath }],
      ...(manualUrl ? { manualUrl } : {}),
      ...(input.number ? { number: input.number } : {}),
    });
    return { taskId };
  }

  async retryNumberRecognition(id: string): Promise<PendingDetailResponse> {
    const repositories = await this.deps.repositories();
    const item = repositories.pending.get(id);
    repositories.pending.assertAvailable(item.id);
    if (item.deletionJson) throw new Error("此文件的删除尚未完成，请继续删除");
    if (item.kind === "uncensored") throw new Error("此影片已发布，请改为确认影片类型");
    const root = await this.deps.mediaRoots.get(item.rootId);
    const configuration = await this.deps.getConfiguration();
    const result = await this.deps.recognitionService.recognize(
      resolveRootRelativePath(root, item.relativePath),
      item.number ?? "",
      configuration,
    );
    repositories.pending.updateNumberRecognition(
      item.id,
      item.updatedAt,
      JSON.stringify({ ...result, trigger: "manual" }),
    );
    this.deps.onChanged?.();
    return await this.detail(id);
  }

  async confirmUncensored(input: PendingConfirmUncensoredInput): Promise<PendingActionResponse> {
    const { pending, pendingActions } = await this.deps.repositories();
    const item = pending.get(input.id);
    if (item.deletionJson) throw new Error("此文件的删除尚未完成，请继续删除");
    if (item.kind !== "uncensored" || !item.movieId) throw new Error("此条目没有需要确认的无码类型");
    if (!(await this.deps.getConfiguration()).download.generateNfo) throw new Error("NFO 生成已关闭，无法确认无码类型");
    const detail = await this.detail(item.id);
    const job = pendingActions.enqueue({
      itemId: item.id,
      itemUpdatedAt: item.updatedAt.getTime(),
      action: "confirm",
      inputJson: JSON.stringify(input),
      itemJson: JSON.stringify(detail.item),
    });
    this.deps.onChanged?.();
    this.queue.wake();
    return { taskId: job.id };
  }

  private async performConfirmUncensored(input: PendingConfirmUncensoredInput): Promise<void> {
    const repositories = await this.deps.repositories();
    const item = repositories.pending.get(input.id);
    if (item.deletionJson) throw new Error("此文件的删除尚未完成，请继续删除");
    if (item.kind !== "uncensored" || !item.movieId) throw new Error("此条目没有需要确认的无码类型");
    const configuration = await this.deps.getConfiguration();
    if (!configuration.download.generateNfo) throw new Error("NFO 生成已关闭，无法确认无码类型");
    const entry = await repositories.library.getEntryById(item.movieId);
    const library = item.libraryId ? await this.deps.libraries.get(item.libraryId) : undefined;
    // A library that placed the files reorganizes them under the new name; others only rewrite the NFO in place.
    const reorganize = library && ["move", "hardlink", "copy"].includes(library.placement);
    const roots = await this.deps.mediaRoots.listRoots();
    const root = roots.find((candidate) => candidate.id === entry.files[0]?.rootId);
    if (!root) throw new Error("影片缺少有效媒体文件");
    await this.deps.mediaRoots.assertRootIntegrity(
      new Set([...entry.files.map((file) => file.rootId), ...entry.assets.flatMap((asset) => asset.rootId ?? [])]),
    );
    const result = await this.deps.maintenanceRuntime.applyLibraryEntry({
      root,
      presetId: reorganize ? "local_organize" : "remerge",
      target: reorganize ? toPublicationTarget(library) : undefined,
      entry,
      localState: { uncensoredChoice: input.choice },
      publication: {
        library: repositories.library,
        roots,
        identity: {
          movieId: entry.id,
          assets: entry.assets.flatMap((asset) =>
            asset.rootId && asset.relativePath
              ? [
                  {
                    rootId: asset.rootId,
                    relativePath: asset.relativePath,
                    fileId: asset.fileId,
                    kind: asset.kind,
                    published: asset.published,
                  },
                ]
              : [],
          ),
        },
        commit: (movie) => {
          const rows = committedMovieRows(movie);
          repositories.pending.confirmUncensored(item.id, rows.movie, rows.files);
        },
      },
    });
    if (result.status === "failed") throw new Error(result.error);
    this.deps.onLibraryChanged?.();
    this.deps.onChanged?.();
  }

  async ignore(id: string): Promise<void> {
    const { pending } = await this.deps.repositories();
    pending.assertAvailable(id);
    if (pending.list().some((item) => item.id === id && item.deletionJson))
      throw new Error("此文件的删除尚未完成，请继续删除");
    pending.delete([id]);
    this.deps.onChanged?.();
  }

  async delete(id: string): Promise<PendingActionResponse> {
    const { pending, pendingActions } = await this.deps.repositories();
    const item = pending.get(id);
    const active = pendingActions
      .list()
      .find((row) => row.itemId === id && ["queued", "running", "retrying"].includes(row.status));
    if (active) {
      if (active.action !== "delete") throw new Error("此文件已有正在执行的操作");
      return { taskId: active.id };
    }
    if (path.extname(item.relativePath).toLowerCase() !== ".strm") throw new Error("仅支持删除 STRM 及其 115 源文件");
    const detail = await this.detail(id);
    const fingerprint = await this.deps.captureDelete(id);
    const job = pendingActions.enqueue({
      itemId: id,
      itemUpdatedAt: item.updatedAt.getTime(),
      action: "delete",
      inputJson: JSON.stringify({ id, fingerprint }),
      itemJson: JSON.stringify(detail.item),
    });
    this.deps.onChanged?.();
    this.queue.wake();
    return { taskId: job.id };
  }

  async batch(input: PendingBatchInput): Promise<PendingBatchResponse> {
    const repositories = await this.deps.repositories();
    const ids = [...new Set(input.ids)];
    if (input.action === "ignore") {
      for (const id of ids) repositories.pending.assertAvailable(id);
      if (repositories.pending.list().some((item) => ids.includes(item.id) && item.deletionJson))
        throw new Error("所选文件包含未完成的删除，请先继续删除");
      repositories.pending.delete(ids);
      this.deps.onChanged?.();
      return { succeededIds: ids, failures: [] };
    }

    const result: PendingBatchResponse = { succeededIds: [], failures: [], tasks: [] };
    if (input.action === "confirm" || input.action === "delete") {
      for (const id of ids) {
        try {
          const task =
            input.action === "delete"
              ? await this.delete(id)
              : await this.confirmUncensored({ id, choice: input.choice });
          result.tasks?.push({ id: task.taskId, kind: "action" });
          result.succeededIds.push(id);
        } catch (error) {
          result.failures.push({ id, message: toErrorMessage(error) });
        }
      }
      return result;
    }
    const groups = new Map<string, PendingItemRecord[]>();
    for (const id of ids) {
      try {
        const item = repositories.pending.get(id);
        repositories.pending.assertAvailable(id);
        if (item.deletionJson) throw new Error("此文件的删除尚未完成，请继续删除");
        if (["uncensored", "ambiguous", "no_number"].includes(item.kind))
          throw new Error("此条目需要手动输入，请单独处理");
        const libraryId = input.libraryId ?? item.libraryId;
        if (!libraryId) throw new Error("请选择刮削此文件的目标媒体库");
        const group = groups.get(libraryId) ?? [];
        group.push(item);
        groups.set(libraryId, group);
      } catch (error) {
        result.failures.push({ id, message: toErrorMessage(error) });
      }
    }
    for (const [libraryId, items] of groups) {
      try {
        const task = await this.deps.startScrape({
          executionMode: "batch",
          libraryId,
          refs: items.map(({ rootId, relativePath }) => ({ rootId, relativePath })),
        });
        result.tasks?.push({ id: task.taskId, kind: "scrape" });
        result.succeededIds.push(...items.map((item) => item.id));
      } catch (error) {
        result.failures.push(...items.map(({ id }) => ({ id, message: toErrorMessage(error) })));
      }
    }
    return result;
  }

  private async saveRule(rule: NonNullable<PendingRetryInput["rule"]>, number: string | undefined): Promise<void> {
    const configuration = await this.deps.getConfiguration();
    if (rule.kind === "ignoreToken") {
      const tokens = configuration.scrape.filenameIgnoreTokens;
      if (!tokens.includes(rule.token))
        await this.deps.updateConfiguration({ scrape: { filenameIgnoreTokens: [...tokens, rule.token] } });
      return;
    }
    if (!number) throw new Error("保存番号映射需要提供修正后的番号");
    await this.deps.updateConfiguration({
      scrape: { numberMappings: { ...configuration.scrape.numberMappings, [rule.match]: number } },
    });
  }

  private candidates(item: PendingItemRecord): AmbiguousCandidate[] {
    if (!item.candidatesJson) return [];
    // Stored candidates outlive the schema (a site may be removed later); one unreadable entry must not fail the list.
    return z
      .array(z.unknown())
      .parse(JSON.parse(item.candidatesJson))
      .flatMap((candidate) => {
        const parsed = ambiguousCandidateSchema.safeParse(candidate);
        if (parsed.success) return [parsed.data];
        logger.warn(`已丢弃待处理条目 ${item.id} 中无法读取的候选项：${parsed.error.message}`);
        return [];
      });
  }

  private toDto(item: PendingItemRecord, absolutePath: string, libraries: ReadonlyMap<string, string>): PendingItemDto {
    return {
      taskId: item.taskId,
      deletionPending: Boolean(item.deletionJson),
      taskKind: item.taskKind,
      id: item.id,
      kind: item.kind,
      ref: { rootId: item.rootId, relativePath: item.relativePath },
      path: absolutePath,
      fileName: path.basename(item.relativePath),
      libraryId: item.libraryId,
      libraryName: item.libraryId ? (libraries.get(item.libraryId) ?? null) : null,
      movieId: item.movieId,
      number: item.number,
      detail: item.detail,
      candidates: this.candidates(item),
      createdAt: item.createdAt.toISOString(),
      updatedAt: item.updatedAt.toISOString(),
    };
  }
}
