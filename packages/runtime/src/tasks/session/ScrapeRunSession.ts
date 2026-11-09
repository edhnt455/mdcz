import { basename } from "node:path";
import type { DiscoveryProgress } from "@mdcz/shared/directoryTasks";
import { toErrorMessage } from "@mdcz/shared/error";
import type { ScrapeRunStage } from "@mdcz/shared/serverDtos";
import type { ScrapeResult, ScrapeResultStatus } from "@mdcz/shared/types";
import { runWithScrapeItem } from "../../network/networkExecution";
import type { PreparedMovieOutput } from "../../publication/movieArtifacts";
import type { MovieGroup } from "../../scrape/movieGroups";
import { ScrapeTargetConflictError } from "../../scrape/preflightScrapeTask";
import { isAbortError } from "../../scrape/utils/abort";
import { TaskExecutor } from "../executor";

export const MAX_LIVE_SCRAPE_LOGS = 200;

export type ScrapeRunLiveStatus =
  | "queued"
  | "discovering"
  | "running"
  | "paused"
  | "stopping"
  | "completed"
  | "failed"
  | "stopped"
  | "interrupted";
export type ScrapeRunItemStatus = "pending" | "processing" | "success" | "failed" | "skipped";

export interface ScrapeRunItem {
  id: string;
  rootId: string;
  relativePath: string;
  sourcePath: string;
  caseId?: string;
}

export type ScrapeRunItemSnapshot<TItem extends ScrapeRunItem = ScrapeRunItem> = TItem & {
  status: ScrapeRunItemStatus;
  error: string | null;
  result?: ScrapeResult;
};

export interface ScrapeRunProgress {
  percent: number | null;
  completedItems: number;
  totalItems: number | null;
}

export interface ScrapeRunStageSnapshot {
  stage: ScrapeRunStage;
  itemId: string | null;
  relativePath: string | null;
}

export interface ScrapeRunLogEntry {
  timestamp: Date;
  level: "debug" | "info" | "warn" | "error";
  message: string;
  itemId: string | null;
  relativePath: string | null;
}

export interface ScrapeRunSnapshot<TItem extends ScrapeRunItem = ScrapeRunItem> {
  runId: string;
  revision: number;
  status: ScrapeRunLiveStatus;
  progress: ScrapeRunProgress;
  discovery?: DiscoveryProgress;
  items: ScrapeRunItemSnapshot<TItem>[];
  latestStage: ScrapeRunStageSnapshot | null;
  logs: ScrapeRunLogEntry[];
  error: string | null;
}

export type ScrapePreparationResult<TPrepared> =
  | { status: "prepared"; prepared: TPrepared }
  | { status: "failed" | "skipped"; result: ScrapeResult };

export interface ScrapeRunExecution<TItem extends ScrapeRunItem = ScrapeRunItem, TPrepared = unknown> {
  concurrency: number;
  movieGroups: readonly MovieGroup<TItem>[];
  prepareGroup: (group: MovieGroup<TItem>, signal: AbortSignal) => Promise<ScrapePreparationResult<TPrepared>>;
  checkTargets: (groups: readonly { group: MovieGroup<TItem>; prepared: TPrepared }[]) => Promise<void>;
  executePreparedGroup: (
    group: {
      group: MovieGroup<TItem>;
      prepared: TPrepared;
    },
    signal: AbortSignal,
  ) => Promise<{
    results: readonly { itemId: string; result: ScrapeResult }[];
    output?: PreparedMovieOutput;
    release?: () => Promise<void>;
  }>;
  commitItems: (
    items: readonly { item: TItem; result?: ScrapeResult }[],
    output?: PreparedMovieOutput,
  ) => Promise<readonly { itemId: string; result: ScrapeResult }[]>;
}

export interface ScrapeRunSessionOptions<TItem extends ScrapeRunItem = ScrapeRunItem, TPrepared = unknown> {
  runId: string;
  totalItems: number | null;
  discover?: (signal: AbortSignal, report: (progress: DiscoveryProgress) => void) => Promise<void>;
  prepare: (signal: AbortSignal) => Promise<ScrapeRunExecution<TItem, TPrepared> | null>;
  onSnapshot: (snapshot: ScrapeRunSnapshot<TItem>) => void;
}

type MutableScrapeRunItem<TItem extends ScrapeRunItem> = ScrapeRunItemSnapshot<TItem> & {
  progress: number;
};
type RuntimeMovieGroup<TItem extends ScrapeRunItem, TPrepared> = MovieGroup<MutableScrapeRunItem<TItem>> & {
  preparation?: ScrapePreparationResult<TPrepared>;
  targetsChecked?: boolean;
};
type ScrapeGroupExecution<TItem extends ScrapeRunItem> = {
  output?: PreparedMovieOutput;
  results: Array<{ item: MutableScrapeRunItem<TItem>; result?: ScrapeResult }>;
  release: () => Promise<void>;
};

class InactiveScrapeRunError extends Error {}

const isTerminalItemStatus = (status: ScrapeRunItemStatus): boolean =>
  status === "success" || status === "failed" || status === "skipped";

const toTerminalItemStatus = (status: ScrapeResultStatus): ScrapeRunItemStatus => {
  if (status === "success" || status === "failed" || status === "skipped") return status;
  throw new Error(`刮削提交返回了非结束状态：${status}`);
};

const createSkippedResult = <TItem extends ScrapeRunItem>(
  item: MutableScrapeRunItem<TItem>,
  error: string,
): ScrapeResult => ({
  fileId: item.id,
  rootId: item.rootId,
  relativePath: item.relativePath,
  fileName: basename(item.sourcePath),
  status: "skipped",
  error,
  assets: [],
});

const createFailedResult = <TItem extends ScrapeRunItem>(
  item: MutableScrapeRunItem<TItem>,
  error: string,
): ScrapeResult => ({
  fileId: item.id,
  rootId: item.rootId,
  relativePath: item.relativePath,
  fileName: basename(item.sourcePath),
  status: "failed",
  error,
  assets: [],
});

/**
 * A failed or skipped preparation carries the pending outcome (kind and candidates) the pending list needs; rebuilding
 * it from the message alone would drop that and file every failure as a generic one.
 */
const retargetPreparedResult = <TItem extends ScrapeRunItem>(
  result: ScrapeResult,
  item: MutableScrapeRunItem<TItem>,
): ScrapeResult => ({
  ...result,
  fileId: item.id,
  rootId: item.rootId,
  relativePath: item.relativePath,
  fileName: basename(item.sourcePath),
});

export class ScrapeRunSession<TItem extends ScrapeRunItem = ScrapeRunItem, TPrepared = unknown> {
  private movieGroups: RuntimeMovieGroup<TItem, TPrepared>[] = [];
  private itemsById = new Map<string, MutableScrapeRunItem<TItem>>();
  private executionConfig: ScrapeRunExecution<TItem, TPrepared> | null = null;
  private totalItems: number | null;
  private discovery?: DiscoveryProgress;
  private started = false;
  private readonly discoveryController = new AbortController();
  private readonly logs: ScrapeRunLogEntry[] = [];
  private revision = 0;
  private status: ScrapeRunLiveStatus = "queued";
  private latestStage: ScrapeRunStageSnapshot | null = null;
  private error: string | null = null;
  private targetCheck: Promise<void> = Promise.resolve();
  private readonly shutdownController = new AbortController();
  private executor: { pause(): void; stop(): void } | null = null;
  private runPromise: Promise<void> | null = null;
  private stopPromise: Promise<ScrapeRunSnapshot<TItem>> | null = null;

  constructor(private readonly options: ScrapeRunSessionOptions<TItem, TPrepared>) {
    if (!options.runId.trim()) throw new Error("刮削任务 ID 不能为空");
    this.totalItems = options.totalItems;
  }

  private get execution(): ScrapeRunExecution<TItem, TPrepared> {
    if (!this.executionConfig) throw new Error("刮削执行尚未准备完成");
    return this.executionConfig;
  }

  private get items(): MutableScrapeRunItem<TItem>[] {
    return this.movieGroups.flatMap((group) => group.members);
  }

  private mountExecution(options: ScrapeRunExecution<TItem, TPrepared>): void {
    if (!Number.isSafeInteger(options.concurrency) || options.concurrency < 1) {
      throw new Error("刮削并发数必须是正整数");
    }

    const ids = new Set<string>();
    const paths = new Set<string>();
    this.movieGroups = options.movieGroups.map(
      (group): RuntimeMovieGroup<TItem, TPrepared> => ({
        movieId: group.movieId,
        error: group.error,
        assets: group.assets ?? [],
        members: group.members.map((member): MutableScrapeRunItem<TItem> => {
          if (!member.id.trim()) throw new Error("刮削条目 ID 不能为空");
          if (!member.rootId.trim()) throw new Error(`刮削条目的根目录 ID 不能为空：${member.id}`);
          if (!member.relativePath.trim()) throw new Error(`刮削条目的相对路径不能为空：${member.id}`);
          if (!member.sourcePath.trim()) throw new Error(`刮削条目的来源路径不能为空：${member.id}`);
          if (ids.has(member.id)) throw new Error(`刮削条目 ID 重复：${member.id}`);
          ids.add(member.id);
          const pathKey = `${member.rootId}\u0000${member.relativePath}`;
          if (paths.has(pathKey)) throw new Error(`刮削条目路径重复：${member.rootId}:${member.relativePath}`);
          paths.add(pathKey);
          return {
            ...member,
            status: "pending",
            error: null,
            progress: 0,
          };
        }),
      }),
    );
    this.itemsById = new Map(this.items.map((item) => [item.id, item]));
    this.totalItems = this.items.length;
    this.executionConfig = options;
    this.emitSnapshot();
  }

  async start(): Promise<void> {
    if (this.status !== "queued") throw new Error(`无法在 ${this.status} 状态下启动刮削任务`);
    this.setStatus("running");
    this.startDrain();
  }

  async pause(): Promise<ScrapeRunSnapshot<TItem>> {
    if (this.status === "paused") return this.snapshot();
    if (this.status === "discovering") throw new Error("扫描期间不支持暂停，请直接停止任务");
    if (this.status !== "queued" && this.status !== "running")
      throw new Error(`无法在 ${this.status} 状态下暂停刮削任务`);
    this.executor?.pause();
    this.setStatus("paused");
    return this.snapshot();
  }

  async resume(): Promise<void> {
    if (this.status === "queued" || this.status === "running") return;
    if (this.status !== "paused") throw new Error(`无法在 ${this.status} 状态下恢复刮削任务`);
    this.setStatus(this.runPromise ? "running" : "queued");
  }

  stop(): Promise<ScrapeRunSnapshot<TItem>> {
    this.stopPromise ??= this.finishStop();
    return this.stopPromise;
  }

  private async finishStop(): Promise<ScrapeRunSnapshot<TItem>> {
    if (this.isTerminalStatus()) return this.snapshot();
    this.setStatus("stopping");
    this.discoveryController.abort();
    this.executor?.stop();
    await this.waitForIdle();
    if (!this.started || !this.executionConfig) {
      this.setStatus("stopped");
      return this.snapshot();
    }
    try {
      await this.skipOutstandingItems("刮削已停止");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const terminalError = new AggregateError([error], `保存任务结束结果失败，刮削已中断：${message}`);
      this.error = terminalError.message;
      this.recordLog({ level: "error", message: terminalError.message });
      this.setStatus("interrupted");
      return this.snapshot();
    }
    this.setStatus("stopped");
    return this.snapshot();
  }

  async waitForIdle(): Promise<void> {
    while (this.runPromise) await this.runPromise;
  }
  async abortForShutdown(): Promise<void> {
    if (this.stopPromise) {
      await this.stopPromise;
      return;
    }
    if (this.isTerminalStatus()) return;
    this.setStatus("stopping");
    this.shutdownController.abort(new Error("服务关闭导致刮削任务中断"));
    this.discoveryController.abort(this.shutdownController.signal.reason);
    this.executor?.stop();
    await this.waitForIdle();
    this.setStatus("interrupted");
  }

  snapshot(): ScrapeRunSnapshot<TItem> {
    const completedItems = this.items.filter((item) => isTerminalItemStatus(item.status)).length;
    const totalItems = this.totalItems;
    const reportedPercent = Math.round(
      ((completedItems + this.items.reduce((total, item) => total + item.progress / 100, 0)) / (totalItems || 1)) * 100,
    );
    return {
      runId: this.options.runId,
      revision: this.revision,
      status: this.status,
      progress: {
        percent: totalItems === null ? null : completedItems === totalItems ? 100 : Math.min(99, reportedPercent),
        completedItems,
        totalItems,
      },
      ...(this.discovery ? { discovery: structuredClone(this.discovery) } : {}),
      items: this.items.map(({ progress: _progress, ...item }) => item as ScrapeRunItemSnapshot<TItem>),
      latestStage: this.latestStage ? { ...this.latestStage } : null,
      logs: this.logs.map((entry) => ({ ...entry, timestamp: new Date(entry.timestamp) })),
      error: this.error,
    };
  }

  recordDiscovery(progress: DiscoveryProgress): void {
    if (this.status !== "discovering") return;
    this.discovery = structuredClone(progress);
    this.emitSnapshot();
  }

  /**
   * The session is the sole progress authority; hosts must not maintain a
   * second counter with different units.
   */
  recordProgress(itemId: string, percent: number): void {
    const item = this.itemsById.get(itemId);
    if (!item || isTerminalItemStatus(item.status)) return;
    const nextPercent = Math.min(100, Math.max(0, Number.isFinite(percent) ? percent : 0));
    if (nextPercent <= item.progress) return;
    item.progress = nextPercent;
    this.emitSnapshot();
  }

  recordStage(stage: Omit<ScrapeRunStageSnapshot, "itemId" | "relativePath"> & { itemId?: string | null }): void {
    const item = stage.itemId ? this.itemsById.get(stage.itemId) : undefined;
    this.latestStage = {
      stage: stage.stage,
      itemId: stage.itemId ?? null,
      relativePath: item?.relativePath ?? null,
    };
    this.emitSnapshot();
  }

  recordLog(
    entry: Omit<ScrapeRunLogEntry, "timestamp" | "itemId" | "relativePath"> & {
      timestamp?: Date;
      itemId?: string | null;
    },
  ): void {
    const item = entry.itemId ? this.itemsById.get(entry.itemId) : undefined;
    this.logs.push({
      timestamp: entry.timestamp ?? new Date(),
      level: entry.level,
      message: entry.message,
      itemId: entry.itemId ?? null,
      relativePath: item?.relativePath ?? null,
    });
    if (this.logs.length > MAX_LIVE_SCRAPE_LOGS) this.logs.splice(0, this.logs.length - MAX_LIVE_SCRAPE_LOGS);
    this.emitSnapshot();
  }

  private startDrain(): void {
    if (this.runPromise || this.status !== "running") return;
    const run = Promise.resolve()
      .then(() => this.drain())
      .catch(async (error: unknown) => {
        if (error instanceof InactiveScrapeRunError) return;
        await this.handleFatalError(error);
      });
    const tracked = run.finally(() => {
      if (this.runPromise === tracked) this.runPromise = null;
      if (
        this.status === "running" &&
        (this.items.some((item) => item.status === "pending") ||
          this.items.every((item) => isTerminalItemStatus(item.status)))
      ) {
        this.startDrain();
      }
    });
    this.runPromise = tracked;
  }

  private async drain(): Promise<void> {
    this.assertActive(["running"]);
    if (!this.started) {
      this.started = true;
      if (this.options.discover) {
        this.setStatus("discovering");
        this.recordStage({ stage: "discovering" });
        await this.options.discover(this.discoveryController.signal, (progress) => {
          this.recordDiscovery(progress);
        });
        this.assertActive(["discovering"]);
        this.discoveryController.signal.throwIfAborted();
        this.setStatus("running");
      }
      const execution = await this.options.prepare(this.discoveryController.signal);
      this.assertActive(["running", "discovering", "paused", "stopping"]);
      // Stop still needs the prepared execution to commit outstanding items.
      if (execution) this.mountExecution(execution);
      this.discoveryController.signal.throwIfAborted();
      if (!execution) this.totalItems = 0;
      if (this.items.length === 0) {
        this.recordStage({ stage: "completed" });
        this.setStatus("completed");
        return;
      }
      if (this.status === "discovering") this.setStatus("running");
    }
    if (this.status !== "running") return;
    if (this.items.every((item) => isTerminalItemStatus(item.status))) {
      this.completeLiveRunIfSettled();
      return;
    }
    const executionGroups = this.movieGroups.filter((group) => group.members.some((item) => item.status === "pending"));
    const executor = new TaskExecutor<RuntimeMovieGroup<TItem, TPrepared>, ScrapeGroupExecution<TItem> | null>({
      concurrency: this.execution.concurrency,
      gate: {
        beforeItem: async (group) => {
          this.assertActive(["running"]);
          for (const item of group.members) {
            if (item.status === "pending") {
              item.status = "processing";
              item.error = null;
            }
          }
          this.emitSnapshot();
        },
        beforeResult: async () => this.assertActive(["running", "paused", "stopping"]),
      },
      runItem: async (group, context) => {
        if (!group.preparation) {
          this.recordStage({ stage: "prepare", itemId: group.members[0].id });
          group.preparation = group.error
            ? { status: "failed", result: createFailedResult(group.members[0], group.error) }
            : await runWithScrapeItem(
                { caseId: group.members[0].caseId, execution: group },
                async () => await this.execution.prepareGroup(group, context.signal),
              );
        }
        context.signal.throwIfAborted();
        this.assertActive(["running", "paused"]);
        if (group.preparation.status === "prepared" && this.status === "running" && !group.targetsChecked) {
          // Reserve output paths in order before downloads can race, including paths of already committed movies.
          const previous = this.targetCheck;
          let releaseCheck!: () => void;
          this.targetCheck = new Promise<void>((resolve) => {
            releaseCheck = resolve;
          });
          await previous;
          try {
            context.signal.throwIfAborted();
            this.recordStage({ stage: "check-output", itemId: group.members[0].id });
            await this.execution.checkTargets([
              ...this.movieGroups.flatMap((checked) =>
                checked.targetsChecked && checked.preparation?.status === "prepared"
                  ? [{ group: checked, prepared: checked.preparation.prepared }]
                  : [],
              ),
              { group, prepared: group.preparation.prepared },
            ]);
            group.targetsChecked = true;
          } catch (error) {
            if (isAbortError(error) || context.signal.aborted) throw error;
            const conflicts =
              error instanceof ScrapeTargetConflictError
                ? error.conflicts.filter((conflict) => group.members.some((item) => item.id === conflict.itemId))
                : [];
            const message = conflicts.length ? new ScrapeTargetConflictError(conflicts).message : toErrorMessage(error);
            this.error = [this.error, message].filter(Boolean).join("\n\n");
            const conflict = conflicts.length === 1 && group.members.length === 1 ? conflicts[0] : undefined;
            group.preparation = {
              status: "failed",
              result: {
                ...createFailedResult(group.members[0], message),
                ...(conflict?.existingMovie
                  ? { conflict: { sourcePath: conflict.sourcePath, targetPath: conflict.targetPath } }
                  : {}),
              },
            };
          } finally {
            releaseCheck();
          }
        }
        if (group.preparation.status !== "prepared") {
          const result = group.preparation.result;
          return {
            results: group.members.map((item) => ({ item, result: retargetPreparedResult(result, item) })),
            release: async () => undefined,
          };
        }
        if (this.status === "paused") {
          for (const item of group.members) if (item.status === "processing") item.status = "pending";
          this.emitSnapshot();
          return null;
        }
        const entry = { group, prepared: group.preparation.prepared };
        this.recordStage({ stage: "execute", itemId: group.members[0].id });
        let release: (() => void | Promise<void>) | undefined;
        const releaseResources = async () => {
          const cleanup = release;
          release = undefined;
          if (cleanup) await cleanup();
        };
        try {
          this.assertActive(["running", "paused"]);
          const execution = await runWithScrapeItem(
            { caseId: entry.group.members[0].caseId, execution: entry.group },
            async () => await this.execution.executePreparedGroup(entry, context.signal),
          );
          release = execution.release;
          const groupedResults = new Map(execution.results.map(({ itemId, result }) => [itemId, result]));
          const eligibleIds = new Set(execution.output?.files.map((file) => file.scrape?.itemId) ?? []);
          const pendingItems = entry.group.members.filter((m) => m.status === "processing" || m.status === "pending");
          if (
            execution.results.length + eligibleIds.size !== pendingItems.length ||
            groupedResults.size !== execution.results.length
          ) {
            throw new Error("刮削组执行返回的结果不完整");
          }
          const results = pendingItems.map((item) => {
            const executed = groupedResults.get(item.id);
            if (!executed && !eligibleIds.has(item.id)) throw new Error(`刮削组执行遗漏了条目：${item.id}`);
            return { item, result: executed };
          });
          return {
            output: execution.output,
            results,
            release: releaseResources,
          };
        } catch (error) {
          try {
            await releaseResources();
          } catch (cleanupError) {
            const message = error instanceof Error ? error.message : String(error);
            const cleanupMessage = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
            throw new AggregateError([error, cleanupError], `${message}；清理资源失败：${cleanupMessage}`);
          }
          throw error;
        }
      },
      finalizeResult: async (_group, execution) => await execution?.release(),
      onFinalizeError: (group, releaseError) => {
        this.recordLog({
          level: "warn",
          message: `清理暂存资源失败：${releaseError instanceof Error ? releaseError.message : String(releaseError)}`,
          itemId: group.members[0]?.id,
        });
      },
      applyResult: async (_group, execution) => {
        if (!execution) return;
        this.assertActive(["running", "paused", "stopping"]);
        let committed: Awaited<ReturnType<typeof this.execution.commitItems>>;
        try {
          committed = await this.execution.commitItems(execution.results, execution.output);
        } catch (error) {
          // A publish failure belongs to this group: file it as a failed item so the pending list can explain and
          // repair it, instead of aborting the run and leaving the file only as skipped.
          if (isAbortError(error) || this.shutdownController.signal.aborted) throw error;
          this.assertActive(["running", "paused", "stopping"]);
          const message = toErrorMessage(error);
          this.error = [this.error, message].filter(Boolean).join("\n\n");
          committed = await this.execution.commitItems(
            execution.results.map(({ item }) => ({ item, result: createFailedResult(item, message) })),
          );
        }
        this.assertActive(["running", "paused", "stopping"]);
        this.applyCommittedResults(
          execution.results.map(({ item }) => item),
          committed,
        );
      },
    });
    this.executor = executor;
    try {
      await executor.execute(executionGroups, this.shutdownController.signal);
    } finally {
      if (this.executor === executor) this.executor = null;
    }
  }

  private applyCommittedResult(item: MutableScrapeRunItem<TItem>, result: ScrapeResult): void {
    item.status = toTerminalItemStatus(result.status);
    item.progress = 0;
    item.error = result.error?.trim() || null;
    item.result = result;
    this.emitSnapshot();
    if (this.runPromise === null && this.status === "running") this.startDrain();
  }

  private applyCommittedResults(
    items: readonly MutableScrapeRunItem<TItem>[],
    committed: readonly { itemId: string; result: ScrapeResult }[],
  ): void {
    const results = new Map(committed.map(({ itemId, result }) => [itemId, result]));
    if (committed.length !== items.length || results.size !== items.length) throw new Error("刮削提交返回的结果不完整");
    for (const item of items) {
      const result = results.get(item.id);
      if (!result) throw new Error(`刮削提交遗漏了条目：${item.id}`);
      this.applyCommittedResult(item, result);
    }
  }

  private async skipOutstandingItems(message: string): Promise<void> {
    const terminalInputs = [];
    for (const item of this.items) {
      if (isTerminalItemStatus(item.status)) continue;
      terminalInputs.push({ item, result: createSkippedResult(item, message) });
    }
    const committed = terminalInputs.length ? await this.execution.commitItems(terminalInputs) : [];
    this.applyCommittedResults(
      terminalInputs.map(({ item }) => item),
      committed,
    );
  }

  private completeLiveRunIfSettled(): void {
    this.assertActive(["running"]);
    if (this.items.some((item) => !isTerminalItemStatus(item.status))) return;
    const hasSuccess = this.items.some((item) => item.status === "success");
    if (!hasSuccess && this.items.some((item) => item.status === "skipped")) {
      this.error ??= "所有文件均刮削失败";
    }
    this.setStatus(this.items.every((item) => item.status === "success") ? "completed" : "failed");
  }

  private async handleFatalError(error: unknown): Promise<void> {
    if (this.status === "stopping" || this.isTerminalStatus()) return;
    this.error = error instanceof Error ? error.message : String(error);
    this.recordLog({ level: "error", message: this.error });
    if (!this.executionConfig) {
      this.setStatus("failed");
      return;
    }
    try {
      await this.skipOutstandingItems("任务因错误而中止");
    } catch (commitError) {
      const commitMessage = commitError instanceof Error ? commitError.message : String(commitError);
      const originalMessage = error instanceof Error ? error.message : String(error);
      const terminalError = new AggregateError(
        [error, commitError],
        `${originalMessage}；保存任务结束结果失败：${commitMessage}`,
      );
      this.error = terminalError.message;
      this.recordLog({ level: "error", message: terminalError.message });
      this.setStatus("interrupted");
      return;
    }
    this.setStatus("failed");
  }

  private assertActive(allowedStatuses: readonly ScrapeRunLiveStatus[]): void {
    if (!allowedStatuses.includes(this.status)) {
      throw new InactiveScrapeRunError(`刮削结果已失效：${this.options.runId}`);
    }
  }

  private setStatus(status: ScrapeRunLiveStatus): void {
    if (this.status === status) return;
    this.status = status;
    if (this.isTerminalStatus()) {
      for (const group of this.movieGroups) delete group.preparation;
    }
    this.emitSnapshot();
  }

  private isTerminalStatus(): boolean {
    return (
      this.status === "completed" ||
      this.status === "failed" ||
      this.status === "stopped" ||
      this.status === "interrupted"
    );
  }

  private emitSnapshot(): void {
    this.revision += 1;
    this.options.onSnapshot(this.snapshot());
  }
}
