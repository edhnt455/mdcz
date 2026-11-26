import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { filesystemPathKey, resolveRootFile, resolveRootRelativePath } from "@mdcz/media-store";
import { parseNfoSnapshot } from "@mdcz/runtime/maintenance";
import { notifyMediaServersOfPublish } from "@mdcz/runtime/mediaserver";
import type { NetworkClient } from "@mdcz/runtime/network";
import { mediaTaskConflict, movieTaskKey, tryAcquireMediaTask } from "@mdcz/runtime/publication/mediaTasks";
import { outputDirectoryKeys } from "@mdcz/runtime/publication/outputMutex";
import { WriteOutput } from "@mdcz/runtime/publication/WriteOutput";
import {
  badgeBasePath,
  encodeBadgeArtwork,
  findSubtitleSidecars,
  ImageWatermarkService,
  NfoGenerator,
  readManagedArtworkBase,
  resolveArtworkBadges,
  resolveFileInfoWithSubtitles,
  resolvePosterBadgeDefinitions,
} from "@mdcz/runtime/scrape";
import { resolveThumbToPosterCropRegion } from "@mdcz/shared/posterCrop";
import type {
  FailedSubtitleJob,
  SubtitleJob,
  SubtitleJobBatchInput,
  SubtitleJobErrorType,
  SubtitleJobList,
  SubtitleJobListInput,
  SubtitleJobStage,
} from "@mdcz/shared/subtitleJobs";
import type { BadgeArtworkRecords } from "@mdcz/shared/types";
import { z } from "@mdcz/shared/zod";
import sharp from "sharp";
import type { TaskEventBus } from "../taskEvents";
import { resolveServerBundledMappingDirectory } from "../translationMappingStore";
import { applyPathMappings } from "./automationService";
import type { ServerConfigService } from "./configService";
import type { MediaRootService } from "./mediaRootService";
import type { ServerPersistenceService } from "./persistenceService";
import type { RuntimeLogService } from "./runtimeLogService";

export const subtitleUpdateInputSchema = z.object({
  eventId: z.string().uuid(),
  mediaPath: z.string().trim().min(1),
  subtitlePath: z.string().trim().min(1),
  language: z.string().trim().min(1).max(64),
});
type Input = z.infer<typeof subtitleUpdateInputSchema>;
type Row = {
  task_id: string;
  movie_key: string;
  inputs_json: string;
  bindings_json: string;
  status: SubtitleJob["status"];
  stage: SubtitleJobStage;
  progress: string;
  attempts: number;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
  notification_count: number;
  result_json: string | null;
  warnings_json: string;
  error: string | null;
};
const JOB_SELECT =
  "SELECT j.*, (SELECT count(*) FROM subtitle_update_events e WHERE e.task_id = j.task_id) AS notification_count FROM subtitle_update_jobs j";
const REQUEUE_FAILED_JOBS =
  "UPDATE subtitle_update_jobs SET status = 'queued', stage = 'queued', progress = '等待重试', result_json = NULL, warnings_json = '[]', error = NULL, updated_at = ?, completed_at = NULL WHERE status = 'failed' AND cleared_at IS NULL";

const failurePrefixes: [string, SubtitleJobErrorType][] = [
  ["资源目标重复：", "duplicateTarget"],
  ["ENOENT:", "missingFile"],
  ["未找到已登记的影片：", "unregisteredMovie"],
  ["字幕文件不属于指定影片", "subtitleMismatch"],
  ["影片没有已发布的 NFO", "missingNfo"],
];

function toJob(row: Row): SubtitleJob {
  return {
    taskId: row.task_id,
    mediaPath: (JSON.parse(row.inputs_json) as Input[])[0].mediaPath,
    notificationCount: row.notification_count,
    status: row.status,
    stage: row.stage,
    progress: row.progress,
    attempts: row.attempts,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    result: row.result_json ? JSON.parse(row.result_json) : null,
    warnings: JSON.parse(row.warnings_json),
    error: row.error,
  };
}

export class SubtitleUpdateService {
  private readonly blocked = new Map<string, string>();
  private closed = false;
  private timer?: ReturnType<typeof setTimeout>;
  private notificationTimer?: ReturnType<typeof setTimeout>;
  private worker?: Promise<void>;

  constructor(
    private readonly deps: {
      config: ServerConfigService;
      persistence: ServerPersistenceService;
      roots: MediaRootService;
      network: NetworkClient;
      events: TaskEventBus;
      logger: ReturnType<RuntimeLogService["getLogger"]>;
    },
  ) {}

  async start(): Promise<void> {
    const { database } = await this.deps.persistence.getState();
    database.sqlite
      .prepare(
        "UPDATE subtitle_update_jobs SET status = 'queued', stage = 'queued', progress = '服务重启，等待重新执行', updated_at = ? WHERE status = 'running'",
      )
      .run(Date.now());
    this.wake();
  }

  async close(): Promise<void> {
    this.closed = true;
    clearTimeout(this.timer);
    clearTimeout(this.notificationTimer);
    await this.worker;
  }

  async enqueue(input: Input): Promise<{ taskId: string; status: SubtitleJob["status"] }> {
    if (this.closed || this.deps.persistence.readOnly) throw new Error("服务不可写入字幕更新任务");
    const { database } = await this.deps.persistence.getState();
    const json = JSON.stringify(input);
    const config = await this.deps.config.get();
    const mediaPath = applyPathMappings(input.mediaPath, config.automation.pathMappings);
    const { repositories } = await this.deps.persistence.getState();
    const file = repositories.library.publicationSnapshot({ paths: [mediaPath] }).files.find((file) => file.itemId);
    const movieKey = file ? `movie:${file.itemId}` : filesystemPathKey(mediaPath);
    const row = database.sqlite.transaction(() => {
      const receipt = database.sqlite
        .prepare<[string], { task_id: string; input_json: string }>(
          "SELECT * FROM subtitle_update_events WHERE event_id = ?",
        )
        .get(input.eventId);
      if (receipt) {
        if (receipt.input_json !== json)
          throw Object.assign(new Error("eventId 已用于不同的通知内容"), { statusCode: 409 });
        return database.sqlite.prepare<[string], Row>(`${JOB_SELECT} WHERE j.task_id = ?`).get(receipt.task_id);
      }
      const queued = database.sqlite
        .prepare<[string], Row>(
          "SELECT * FROM subtitle_update_jobs WHERE movie_key = ? AND status = 'queued' ORDER BY created_at, rowid LIMIT 1",
        )
        .get(movieKey);
      const id = queued?.task_id ?? `subtitle-update-${randomUUID()}`;
      const inputs = queued ? (JSON.parse(queued.inputs_json) as Input[]) : [];
      const bindings: Record<string, string> = queued ? JSON.parse(queued.bindings_json) : {};
      if (file) bindings[input.mediaPath] = file.fileId;
      const index = inputs.findIndex(
        (value) => value.mediaPath === input.mediaPath && value.subtitlePath === input.subtitlePath,
      );
      if (index < 0) inputs.push(input);
      else inputs[index] = input;
      const now = Date.now();
      if (queued)
        database.sqlite
          .prepare(
            "UPDATE subtitle_update_jobs SET inputs_json = ?, bindings_json = ?, updated_at = ? WHERE task_id = ?",
          )
          .run(JSON.stringify(inputs), JSON.stringify(bindings), now, id);
      else
        database.sqlite
          .prepare(
            "INSERT INTO subtitle_update_jobs (task_id, movie_key, inputs_json, bindings_json, status, stage, progress, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', 'queued', '等待执行', ?, ?)",
          )
          .run(id, movieKey, JSON.stringify(inputs), JSON.stringify(bindings), now, now);
      database.sqlite
        .prepare("INSERT INTO subtitle_update_events (event_id, task_id, input_json) VALUES (?, ?, ?)")
        .run(input.eventId, id, json);
      return database.sqlite.prepare<[string], Row>(`${JOB_SELECT} WHERE j.task_id = ?`).get(id);
    })();
    if (!row) throw new Error("无法读取字幕更新任务");
    this.changed();
    this.wake();
    return { taskId: row.task_id, status: row.status };
  }

  async get(id: string, scope: "automation" | "workbench" = "automation"): Promise<SubtitleJob | null> {
    const { database } = await this.deps.persistence.getState();
    const row = database.sqlite
      .prepare<[string], Row>(
        `${JOB_SELECT} WHERE j.task_id = ?${scope === "workbench" ? " AND j.cleared_at IS NULL" : ""}`,
      )
      .get(id);
    return row ? toJob(row) : null;
  }

  async list(input: SubtitleJobListInput): Promise<SubtitleJobList> {
    const { database } = await this.deps.persistence.getState();
    const counts: SubtitleJobList["counts"] = { queued: 0, running: 0, completed: 0, failed: 0 };
    for (const row of database.sqlite
      .prepare<[], { status: SubtitleJob["status"]; count: number }>(
        "SELECT status, count(*) AS count FROM subtitle_update_jobs WHERE cleared_at IS NULL GROUP BY status",
      )
      .all())
      counts[row.status] = row.count;
    const rows = database.sqlite
      .prepare<[number, number], Row>(
        `${JOB_SELECT} WHERE j.cleared_at IS NULL ORDER BY CASE j.status WHEN 'running' THEN 0 WHEN 'queued' THEN 1 ELSE 2 END, CASE WHEN j.status IN ('queued', 'running') THEN j.created_at END, CASE WHEN j.status IN ('queued', 'running') THEN j.rowid END, j.updated_at DESC, j.rowid DESC LIMIT ? OFFSET ?`,
      )
      .all(input.limit, input.offset);
    return {
      jobs: rows.map(toJob),
      counts,
      total: Object.values(counts).reduce((a, b) => a + b, 0),
      waitingForResources: this.blocked.size,
    };
  }

  async clearCompleted(): Promise<{ cleared: number }> {
    if (this.closed || this.deps.persistence.readOnly) throw new Error("服务不可写入字幕更新任务");
    const { database } = await this.deps.persistence.getState();
    const { changes } = database.sqlite
      .prepare("UPDATE subtitle_update_jobs SET cleared_at = ? WHERE status = 'completed' AND cleared_at IS NULL")
      .run(Date.now());
    if (changes > 0) this.changed();
    return { cleared: changes };
  }

  async listFailed(): Promise<FailedSubtitleJob[]> {
    const { database } = await this.deps.persistence.getState();
    return database.sqlite
      .prepare<[], Pick<Row, "task_id" | "attempts" | "error"> & { media_path: string }>(
        "SELECT task_id, attempts, error, json_extract(inputs_json, '$[0].mediaPath') AS media_path FROM subtitle_update_jobs WHERE status = 'failed' AND cleared_at IS NULL ORDER BY updated_at DESC, rowid DESC",
      )
      .all()
      .map((row) => ({
        taskId: row.task_id,
        attempts: row.attempts,
        mediaPath: row.media_path,
        errorType: failurePrefixes.find(([prefix]) => row.error?.startsWith(prefix))?.[1] ?? "other",
      }));
  }

  async retryBatch(input: SubtitleJobBatchInput): Promise<{ queued: number }> {
    if (this.closed || this.deps.persistence.readOnly) throw new Error("服务不可写入字幕更新任务");
    const { database } = await this.deps.persistence.getState();
    const { changes } = database.sqlite
      .prepare(
        `${REQUEUE_FAILED_JOBS} AND (task_id, attempts) IN (
          SELECT json_extract(value, '$.taskId'), json_extract(value, '$.attempts') FROM json_each(?)
        )`,
      )
      .run(Date.now(), JSON.stringify(input.jobs));
    if (changes > 0) {
      this.changed();
      this.wake();
    }
    return { queued: changes };
  }

  async ignoreBatch(input: SubtitleJobBatchInput): Promise<{ ignored: number }> {
    if (this.closed || this.deps.persistence.readOnly) throw new Error("服务不可写入字幕更新任务");
    const { database } = await this.deps.persistence.getState();
    const { changes } = database.sqlite
      .prepare(
        `UPDATE subtitle_update_jobs SET cleared_at = ?
          WHERE status = 'failed' AND cleared_at IS NULL AND (task_id, attempts) IN (
            SELECT json_extract(value, '$.taskId'), json_extract(value, '$.attempts') FROM json_each(?)
          )`,
      )
      .run(Date.now(), JSON.stringify(input.jobs));
    if (changes > 0) this.changed();
    return { ignored: changes };
  }

  async retry(id: string): Promise<{ taskId: string }> {
    if (this.closed || this.deps.persistence.readOnly) throw new Error("服务不可写入字幕更新任务");
    const { database } = await this.deps.persistence.getState();
    const row = database.sqlite
      .prepare<[string], Row>("SELECT * FROM subtitle_update_jobs WHERE task_id = ? AND cleared_at IS NULL")
      .get(id);
    if (!row || row.status !== "failed") throw new Error("只能重试失败的字幕更新任务");
    const active = database.sqlite
      .prepare<[string], Row>(
        "SELECT * FROM subtitle_update_jobs WHERE movie_key = ? AND status IN ('queued', 'running') LIMIT 1",
      )
      .get(row.movie_key);
    if (active) throw new Error("该影片已有处理任务，请等待其完成后重试");
    database.sqlite.prepare(`${REQUEUE_FAILED_JOBS} AND task_id = ?`).run(Date.now(), id);
    this.changed();
    this.wake();
    return { taskId: id };
  }

  private changed(): void {
    if (this.closed || this.notificationTimer) return;
    this.notificationTimer = setTimeout(() => {
      this.notificationTimer = undefined;
      this.deps.events.invalidate("subtitle-jobs");
    }, 200);
    this.notificationTimer.unref();
  }

  private wake(delay = 0): void {
    if (this.closed || this.worker || (this.timer && delay > 0)) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.worker = this.work()
        .catch((error) => {
          this.deps.logger.warn(`字幕更新队列失败：${error instanceof Error ? error.message : String(error)}`);
        })
        .finally(() => {
          this.worker = undefined;
          this.wake(1000);
        });
    }, delay);
    this.timer.unref();
  }

  private async work(): Promise<void> {
    const { database } = await this.deps.persistence.getState();
    while (!this.closed) {
      const rows = database.sqlite
        .prepare<[], Row>("SELECT * FROM subtitle_update_jobs WHERE status = 'queued' ORDER BY created_at, rowid")
        .all();
      const seen = new Set<string>();
      let processed = false;
      for (const row of rows) {
        if (this.closed) return;
        if (seen.has(row.movie_key)) continue;
        seen.add(row.movie_key);
        const keys = [
          row.movie_key,
          ...Object.values(JSON.parse(row.bindings_json) as Record<string, string>).map((id) => `file:${id}`),
        ];
        const releases: Array<() => void> = [];
        const wait = (reason: string) => {
          const message = `等待${reason}完成，其他影片继续处理`;
          if (this.blocked.get(row.task_id) === reason) return;
          this.blocked.set(row.task_id, reason);
          database.sqlite
            .prepare("UPDATE subtitle_update_jobs SET progress = ?, updated_at = ? WHERE task_id = ?")
            .run(message, Date.now(), row.task_id);
          this.changed();
        };
        const releaseMovie = tryAcquireMediaTask(keys, "字幕更新当前影片");
        if (!releaseMovie) {
          wait(mediaTaskConflict(keys) ?? "相关影片任务");
          continue;
        }
        releases.push(releaseMovie);
        try {
          let job = await this.resolveJob(row);
          const movieKey = movieTaskKey(job.entry.id);
          if (row.movie_key !== movieKey && seen.has(movieKey)) continue;
          seen.add(movieKey);
          const extraKeys = [movieTaskKey(job.entry.id), ...job.files.map((file) => `file:${file.fileId}`)].filter(
            (key) => !keys.includes(key),
          );
          const releaseExtra = tryAcquireMediaTask(extraKeys, "字幕更新当前影片");
          if (!releaseExtra) {
            wait(mediaTaskConflict(extraKeys) ?? "相关影片任务");
            continue;
          }
          releases.push(releaseExtra);
          if (extraKeys.length) job = await this.resolveJob(row);
          const directories = await outputDirectoryKeys([
            ...job.nfos,
            ...job.targets.map((target) => target.path),
            ...job.mediaPaths,
          ]);
          const releaseDirectories = tryAcquireMediaTask(directories, "字幕更新当前影片");
          if (!releaseDirectories) {
            wait(mediaTaskConflict(directories) ?? "相关输出目录写入");
            continue;
          }
          releases.push(releaseDirectories);
          this.blocked.delete(row.task_id);
          database.sqlite
            .prepare(
              "UPDATE subtitle_update_jobs SET status = 'running', stage = 'scanning', progress = '核验影片与字幕', attempts = attempts + 1, updated_at = ? WHERE task_id = ?",
            )
            .run(Date.now(), row.task_id);
          this.changed();
          const progress = (stage: SubtitleJobStage, message: string) => {
            database.sqlite
              .prepare("UPDATE subtitle_update_jobs SET stage = ?, progress = ?, updated_at = ? WHERE task_id = ?")
              .run(stage, message, Date.now(), row.task_id);
            this.changed();
          };
          const { result, warnings } = await this.process(job, progress);
          database.sqlite
            .prepare(
              "UPDATE subtitle_update_jobs SET status = 'completed', stage = 'completed', progress = ?, result_json = ?, warnings_json = ?, error = NULL, updated_at = ?, completed_at = ? WHERE task_id = ?",
            )
            .run(
              result.metadataUpdated || result.badgeStatus === "updated" || result.mediaServerNotified
                ? "处理完成"
                : "已核验，当前结果无需更新",
              JSON.stringify(result),
              JSON.stringify(warnings),
              Date.now(),
              Date.now(),
              row.task_id,
            );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.blocked.delete(row.task_id);
          this.deps.logger.warn(`字幕更新失败：${message}`);
          database.sqlite
            .prepare(
              "UPDATE subtitle_update_jobs SET status = 'failed', attempts = attempts + CASE WHEN status = 'queued' THEN 1 ELSE 0 END, error = ?, updated_at = ?, completed_at = ? WHERE task_id = ?",
            )
            .run(message, Date.now(), Date.now(), row.task_id);
        } finally {
          for (const release of releases.reverse()) release();
        }
        this.changed();
        processed = true;
        break;
      }
      for (const id of this.blocked.keys()) if (!rows.some((row) => row.task_id === id)) this.blocked.delete(id);
      if (!processed) return;
    }
  }

  private async resolveJob(row: Row) {
    const config = await this.deps.config.get();
    const roots = await this.deps.roots.listRoots();
    const { repositories, database } = await this.deps.persistence.getState();
    const absolute = (rootId: string | null, relativePath: string | null): string => {
      const root = roots.find((candidate) => candidate.id === rootId);
      if (!root || !relativePath) throw new Error(`找不到已登记资源的根目录或路径：${rootId}`);
      return resolveRootRelativePath(root, relativePath);
    };
    const bindings: Record<string, string> = JSON.parse(row.bindings_json);
    const mapped = (JSON.parse(row.inputs_json) as Input[]).map((input) => {
      const originalMedia = applyPathMappings(input.mediaPath, config.automation.pathMappings);
      const originalSubtitle = applyPathMappings(input.subtitlePath, config.automation.pathMappings);
      const fileId = bindings[input.mediaPath];
      const file = fileId
        ? repositories.library.getFileById(fileId)
        : repositories.library.publicationSnapshot({ paths: [originalMedia] }).files[0];
      if (!file) return { ...input, mediaPath: originalMedia, subtitlePath: originalSubtitle };
      bindings[input.mediaPath] = fileId ?? ("id" in file ? file.id : file.fileId);
      const mediaPath = absolute(file.rootId, "rootRelativePath" in file ? file.rootRelativePath : file.relativePath);
      const relative = path.relative(path.dirname(originalMedia), originalSubtitle);
      if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`))
        throw new Error("字幕文件不属于指定影片");
      const oldStem = path.parse(originalMedia).name;
      const subtitleName = path.basename(relative);
      const newName = subtitleName.startsWith(`${oldStem}.`)
        ? `${path.parse(mediaPath).name}${subtitleName.slice(oldStem.length)}`
        : subtitleName;
      return { ...input, mediaPath, subtitlePath: path.join(path.dirname(mediaPath), path.dirname(relative), newName) };
    });
    const mediaPaths = [...new Set(mapped.map((input) => input.mediaPath))];
    const snapshot = repositories.library.publicationSnapshot({ paths: mediaPaths, includeOwners: true });
    const files = mediaPaths.map((mediaPath) => {
      const file = snapshot.files.find(
        (entry) => filesystemPathKey(absolute(entry.rootId, entry.relativePath)) === filesystemPathKey(mediaPath),
      );
      if (!file) throw new Error(`未找到已登记的影片：${mediaPath}`);
      return { ...file, mediaPath };
    });
    if (
      files.some((file) => file.itemId !== files[0].itemId) ||
      (row.movie_key.startsWith("movie:") && row.movie_key !== movieTaskKey(files[0].itemId))
    )
      throw new Error("合并通知的影片归属已改变，请重新提交通知");
    const entry = await repositories.library.getEntryById(files[0].itemId);
    const nfos = [
      ...new Set(
        entry.assets
          .filter((asset) => asset.kind === "nfo" && asset.published && asset.rootId && asset.relativePath)
          .map((asset) => absolute(asset.rootId, asset.relativePath)),
      ),
    ];
    if (!nfos.length) throw new Error("影片没有已发布的 NFO");
    const targets = entry.assets
      .filter(
        (asset) =>
          asset.published &&
          asset.rootId &&
          asset.relativePath &&
          config.download.tagBadgeTargets.includes(asset.kind as "poster" | "thumb" | "fanart"),
      )
      .map((asset) => ({
        kind: asset.kind as "poster" | "thumb" | "fanart",
        path: absolute(asset.rootId, asset.relativePath),
      }))
      .filter((target, index, all) => all.findIndex((candidate) => candidate.path === target.path) === index);
    database.sqlite
      .prepare("UPDATE subtitle_update_jobs SET bindings_json = ?, movie_key = ? WHERE task_id = ?")
      .run(JSON.stringify(bindings), movieTaskKey(entry.id), row.task_id);
    return {
      config,
      mapped,
      roots,
      absolute,
      repositories,
      database,
      mediaPaths,
      snapshot,
      files,
      entry,
      nfos,
      targets,
    };
  }

  private async process(
    job: Awaited<ReturnType<SubtitleUpdateService["resolveJob"]>>,
    progress: (stage: SubtitleJobStage, message: string) => void,
  ): Promise<{ result: NonNullable<SubtitleJob["result"]>; warnings: string[] }> {
    const { config, mapped, roots, absolute, repositories, database, mediaPaths, snapshot, entry, nfos, targets } = job;
    for (const input of mapped) {
      if (!path.isAbsolute(input.mediaPath) || !path.isAbsolute(input.subtitlePath))
        throw new Error("媒体和字幕路径必须为绝对路径");
      resolveRootFile(roots, input.mediaPath);
      resolveRootFile(roots, input.subtitlePath);
      if (!(await stat(input.mediaPath)).isFile()) throw new Error("影片路径不是文件");
      if (!(await stat(input.subtitlePath)).isFile()) throw new Error("字幕路径不是文件");
    }
    const warnings: string[] = [];
    let badgeStatus: NonNullable<SubtitleJob["result"]>["badgeStatus"] = "skipped";
    let metadataUpdated = false;
    progress("scanning", "重新扫描外挂字幕");
    const scans = await Promise.all(
      snapshot.files
        .filter((file) => file.itemId === entry.id)
        .map(async (file) => {
          const mediaPath = absolute(file.rootId, file.relativePath);
          const sidecars = await findSubtitleSidecars(mediaPath, undefined, config.scrape);
          for (const input of mapped.filter((input) => input.mediaPath === mediaPath)) {
            if (!sidecars.some((sidecar) => filesystemPathKey(sidecar.path) === filesystemPathKey(input.subtitlePath)))
              throw new Error("字幕文件不属于指定影片");
          }
          const info = await resolveFileInfoWithSubtitles(mediaPath, {
            filenameRules: config.scrape,
            subtitleSidecars: sidecars,
          });
          return { file, sidecars, info };
        }),
    );
    const info = scans[0].info;
    const chinese =
      mapped.some((input) => /^zh(?:-|$)/iu.test(input.language)) ||
      scans.some((scan) => scan.info.fileInfo.subtitleTag === "中文字幕");
    if (chinese) {
      info.fileInfo.isSubtitled = true;
      info.fileInfo.subtitleTag = "中文字幕";
    }
    const xmls = await Promise.all(
      nfos.map(async (nfoPath) => ({ path: nfoPath, xml: await readFile(nfoPath, "utf8") })),
    );
    const subtitlePaths = scans.flatMap(({ sidecars }) => sidecars.map((sidecar) => sidecar.path)).sort();
    const subtitleHash = createHash("sha256");
    for (const subtitlePath of subtitlePaths) subtitleHash.update(subtitlePath).update(await readFile(subtitlePath));
    const subtitleFingerprint = subtitleHash.digest("hex");
    const fingerprint = async () => {
      const hash = createHash("sha256").update(
        JSON.stringify({ download: config.download, chinese, subtitleFingerprint }),
      );
      const current = await repositories.library.getEntryById(entry.id);
      hash.update(
        JSON.stringify(
          current.assets
            .filter((asset) => asset.kind === "subtitle")
            .map((asset) => [asset.fileId, asset.rootId, asset.relativePath, asset.published])
            .sort(),
        ),
      );
      const paths = [...nfos, ...targets.map((target) => target.path)];
      if (config.download.tagBadgeImageOverrides) {
        const directory =
          config.download.tagBadgeDirectory || path.join(this.deps.config.runtimePaths.dataDir, "watermark");
        const names = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT" && !config.download.tagBadgeDirectory) return [];
          throw error;
        });
        paths.push(
          ...names
            .filter((name) => /\.(?:png|jpg|jpeg|webp|svg)$/iu.test(name))
            .map((name) => path.join(directory, name)),
        );
      }
      for (const filePath of [...new Set(paths)].sort()) {
        const content = await readFile(filePath).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
          return null;
        });
        hash.update(JSON.stringify([filePath, content !== null])).update(content ?? "");
      }
      return hash.digest("hex");
    };
    const cached = database.sqlite
      .prepare<[string], { fingerprint: string; subtitle_fingerprint: string; notify_pending: number }>(
        "SELECT * FROM subtitle_update_state WHERE movie_id = ?",
      )
      .get(entry.id);
    const notify = async (needed: boolean): Promise<boolean> => {
      if (!needed && !cached?.notify_pending) return false;
      progress("notifying", "通知媒体服务器刷新");
      const notified = await notifyMediaServersOfPublish(
        this.deps.network,
        config,
        [...new Set(mediaPaths.map((mediaPath) => path.dirname(mediaPath)))],
        this.deps.logger,
      );
      warnings.push(...notified.warnings);
      if (!notified.notified && !notified.warnings.length) warnings.push("没有启用媒体服务器刷新通知");
      database.sqlite
        .prepare("UPDATE subtitle_update_state SET notify_pending = ? WHERE movie_id = ?")
        .run(notified.warnings.length > 0 ? 1 : 0, entry.id);
      return notified.notified;
    };
    if (cached?.fingerprint === (await fingerprint())) {
      return {
        result: { metadataUpdated: false, badgeStatus: "unchanged", mediaServerNotified: await notify(false) },
        warnings,
      };
    }
    const nfo = parseNfoSnapshot(xmls[0].xml);
    const streams = nfo.localState?.fileinfo?.streamdetails as
      | { video?: { width?: string | number; height?: string | number } }
      | undefined;
    const videoMeta = {
      width: Number(streams?.video?.width) || undefined,
      height: Number(streams?.video?.height) || undefined,
    };
    const generator = new NfoGenerator();
    const artifacts: Array<{ targetPath: string; data: string | Buffer }> = [];
    const badgeRecords: BadgeArtworkRecords = {};
    const newBases: Array<{ kind: string; uri: string; rootId: string; relativePath: string; published: true }> = [];
    if (!config.download.tagBadges || !config.download.tagBadgeTypes.includes("subtitle")) {
      warnings.push("中文字幕角标未启用");
    } else if (!targets.length) {
      warnings.push("没有已登记的角标目标图片");
    } else {
      const watermark = new ImageWatermarkService({
        dataDir: this.deps.config.runtimePaths.dataDir,
        builtinDirectory: path.join(path.dirname(resolveServerBundledMappingDirectory()), "watermark"),
      });
      const badges = resolvePosterBadgeDefinitions(
        nfo.crawlerData,
        info.fileInfo,
        nfo.localState,
        config.download.tagBadgeTypes,
        videoMeta,
      );
      let updated = 0;
      let unchanged = 0;
      const sources = new Map<string, Promise<Uint8Array>>();
      for (const [index, target] of targets.entries()) {
        const kind = target.kind;
        const record = kind === "fanart" ? undefined : nfo.localState?.badgeRecords?.[kind];
        if (kind !== "fanart" && record) {
          const plan = resolveArtworkBadges(
            kind,
            nfo.crawlerData,
            info.fileInfo,
            nfo.localState,
            config.download,
            videoMeta,
          );
          if (plan.stamp === record.stamp && !config.download.tagBadgeImageOverrides) {
            unchanged++;
            continue;
          }
          const base = await readManagedArtworkBase(target.path, record);
          if (!base) {
            warnings.push(`${kind} 角标跳过：无法核验当前图片或无角标底图`);
            continue;
          }
          progress("rendering", `从已登记底图重绘 ${kind} 角标`);
          const rendered = await encodeBadgeArtwork(base, plan, config.download, watermark, (warning) =>
            warnings.push(warning),
          );
          if (rendered.record.sha256 === record.sha256 && rendered.record.stamp === record.stamp) {
            unchanged++;
            continue;
          }
          if (rendered.data !== base && record.baseSha256 === record.sha256) {
            const targetPath = badgeBasePath(target.path);
            const ref = resolveRootFile(roots, targetPath);
            newBases.push({
              kind: `${kind}-base`,
              uri: ref.relativePath,
              rootId: ref.root.id,
              relativePath: ref.relativePath,
              published: true,
            });
            artifacts.push({ targetPath, data: base });
          }
          badgeRecords[kind] = rendered.record;
          artifacts.push({ targetPath: target.path, data: rendered.data });
          updated++;
          continue;
        }
        progress("downloading", `下载 ${target.kind} 原图（${index + 1}/${targets.length}）`);
        let base: Buffer;
        try {
          const data = nfo.crawlerData;
          const url =
            target.kind === "poster"
              ? data.poster_source_url
              : target.kind === "thumb"
                ? data.thumb_source_url
                : (data.fanart_source_url ?? data.thumb_source_url);
          if (!url || !/^https?:\/\//iu.test(url)) throw new Error("缺少可用的原图来源");
          let source = sources.get(url);
          if (!source) {
            source = this.deps.network.getContent(url);
            sources.set(url, source);
          }
          const bytes = Buffer.from(await source);
          progress("rendering", `自动裁剪 ${target.kind} 并准备角标`);
          let image = sharp(bytes, { animated: false }).rotate();
          if (target.kind === "poster" && url === data.thumb_source_url) {
            const meta = await image.metadata();
            if (!meta.width || !meta.height) throw new Error("无法读取原图尺寸");
            const crop = resolveThumbToPosterCropRegion(meta.width, meta.height);
            if (crop) image = image.extract(crop);
          }
          const ext = path.extname(target.path).toLowerCase();
          if (![".jpg", ".jpeg", ".png", ".webp"].includes(ext)) throw new Error(`不支持的图片格式：${ext}`);
          base = await (ext === ".png" ? image.png() : ext === ".webp" ? image.webp() : image.jpeg()).toBuffer();
        } catch (error) {
          warnings.push(`${target.kind} 角标跳过：${error instanceof Error ? error.message : String(error)}`);
          continue;
        }
        progress("rendering", `裁剪并生成 ${target.kind} 角标`);
        const rendered = await watermark.renderImage(base, badges, config.download, (warning) =>
          warnings.push(warning),
        );
        const current = await readFile(target.path).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
          return null;
        });
        if (current?.equals(rendered)) unchanged++;
        else {
          artifacts.push({ targetPath: target.path, data: rendered });
          updated++;
        }
      }
      badgeStatus = updated + unchanged === targets.length ? (updated ? "updated" : "unchanged") : "skipped";
    }
    const nfoArtifacts = xmls.flatMap(({ path: targetPath, xml }) => {
      const tagged = generator.mergeSubtitleTag(xml, chinese ? "中文字幕" : "字幕");
      const data = Object.keys(badgeRecords).length ? generator.mergeBadgeRecords(tagged, badgeRecords) : tagged;
      return data === xml ? [] : [{ targetPath, data }];
    });
    metadataUpdated = nfoArtifacts.length > 0;
    artifacts.push(...nfoArtifacts);
    const members = scans.map(({ file, sidecars }) => ({
      fileId: file.fileId,
      rootId: file.rootId,
      rootRelativePath: file.relativePath,
      assets: sidecars.map((sidecar) => {
        const ref = resolveRootFile(roots, sidecar.path);
        return {
          kind: "subtitle",
          uri: ref.relativePath,
          rootId: ref.root.id,
          relativePath: ref.relativePath,
          published: true,
        };
      }),
    }));
    const registered = entry.assets
      .filter((asset) => asset.kind === "subtitle" && scans.some(({ file }) => file.fileId === asset.fileId))
      .map((asset) => JSON.stringify([asset.fileId, asset.rootId, asset.relativePath, Boolean(asset.published)]))
      .sort();
    const desired = members
      .flatMap((member) =>
        member.assets.map((asset) => JSON.stringify([member.fileId, asset.rootId, asset.relativePath, true])),
      )
      .sort();
    const registrationChanged = JSON.stringify(registered) !== JSON.stringify(desired);
    metadataUpdated ||= registrationChanged;
    const needsNotification =
      artifacts.length > 0 || registrationChanged || cached?.subtitle_fingerprint !== subtitleFingerprint;
    if (artifacts.length || registrationChanged) {
      progress("publishing", "写入 NFO、图片与字幕记录");
      await new WriteOutput().install(artifacts, {
        protectedMediaFiles: snapshot.files.map((item) => absolute(item.rootId, item.relativePath)),
        commit: () =>
          repositories.library.writeEntry(
            {
              id: entry.id,
              ...(newBases.length
                ? {
                    assets: [
                      ...entry.assets.filter(
                        (asset) =>
                          asset.fileId === null &&
                          !newBases.some(
                            (base) =>
                              base.kind === asset.kind &&
                              base.rootId === asset.rootId &&
                              base.relativePath === asset.relativePath,
                          ),
                      ),
                      ...newBases,
                    ],
                  }
                : {}),
            },
            members,
          ),
      });
      this.deps.events.invalidate("library");
    }
    const complete =
      badgeStatus !== "skipped" || !config.download.tagBadges || !config.download.tagBadgeTypes.includes("subtitle");
    database.sqlite
      .prepare(
        "INSERT INTO subtitle_update_state (movie_id, fingerprint, subtitle_fingerprint, notify_pending) VALUES (?, ?, ?, ?) ON CONFLICT(movie_id) DO UPDATE SET fingerprint = excluded.fingerprint, subtitle_fingerprint = excluded.subtitle_fingerprint, notify_pending = excluded.notify_pending",
      )
      .run(
        entry.id,
        complete ? await fingerprint() : "",
        subtitleFingerprint,
        needsNotification || cached?.notify_pending ? 1 : 0,
      );
    return { result: { metadataUpdated, badgeStatus, mediaServerNotified: await notify(needsNotification) }, warnings };
  }
}
