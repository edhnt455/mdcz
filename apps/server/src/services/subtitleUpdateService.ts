import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { filesystemPathKey, resolveRootFile, resolveRootRelativePath } from "@mdcz/media-store";
import { parseNfoSnapshot } from "@mdcz/runtime/maintenance";
import { notifyMediaServersOfPublish } from "@mdcz/runtime/mediaserver";
import type { NetworkClient } from "@mdcz/runtime/network";
import { acquireOutputDirectories } from "@mdcz/runtime/publication/outputMutex";
import { WriteOutput } from "@mdcz/runtime/publication/WriteOutput";
import {
  findSubtitleSidecars,
  ImageWatermarkService,
  NfoGenerator,
  resolveFileInfoWithSubtitles,
  resolvePosterBadgeDefinitions,
} from "@mdcz/runtime/scrape";
import { LibraryTaskConflictError, type LibraryTaskGate } from "@mdcz/runtime/tasks";
import { resolveThumbToPosterCropRegion } from "@mdcz/shared/posterCrop";
import type {
  FailedSubtitleJob,
  SubtitleJob,
  SubtitleJobBatchRetryInput,
  SubtitleJobErrorType,
  SubtitleJobList,
  SubtitleJobListInput,
  SubtitleJobStage,
} from "@mdcz/shared/subtitleJobs";
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
  private running = false;
  private closed = false;
  private timer?: ReturnType<typeof setTimeout>;
  private notificationTimer?: ReturnType<typeof setTimeout>;
  private worker?: Promise<void>;

  constructor(
    private readonly deps: {
      config: ServerConfigService;
      persistence: ServerPersistenceService;
      roots: MediaRootService;
      gate: LibraryTaskGate;
      network: NetworkClient;
      events: TaskEventBus;
      logger: ReturnType<RuntimeLogService["getLogger"]>;
    },
  ) {
    deps.gate.track("subtitle", () => this.running);
  }

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
      const index = inputs.findIndex(
        (value) => value.mediaPath === input.mediaPath && value.subtitlePath === input.subtitlePath,
      );
      if (index < 0) inputs.push(input);
      else inputs[index] = input;
      const now = Date.now();
      if (queued)
        database.sqlite
          .prepare("UPDATE subtitle_update_jobs SET inputs_json = ?, updated_at = ? WHERE task_id = ?")
          .run(JSON.stringify(inputs), now, id);
      else
        database.sqlite
          .prepare(
            "INSERT INTO subtitle_update_jobs (task_id, movie_key, inputs_json, status, stage, progress, created_at, updated_at) VALUES (?, ?, ?, 'queued', 'queued', '等待执行', ?, ?)",
          )
          .run(id, movieKey, JSON.stringify(inputs), now, now);
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
      waitingForManual: counts.queued > 0 && this.deps.gate.foregroundBusy,
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

  async retryBatch(input: SubtitleJobBatchRetryInput): Promise<{ queued: number }> {
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

  async retry(id: string): Promise<{ taskId: string }> {
    if (this.closed || this.deps.persistence.readOnly) throw new Error("服务不可写入字幕更新任务");
    const { database } = await this.deps.persistence.getState();
    const row = database.sqlite.prepare<[string], Row>("SELECT * FROM subtitle_update_jobs WHERE task_id = ?").get(id);
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
      const row = database.sqlite
        .prepare<[], Row>(
          "SELECT * FROM subtitle_update_jobs WHERE status = 'queued' ORDER BY created_at, rowid LIMIT 1",
        )
        .get();
      if (!row) return;
      try {
        this.deps.gate.assertAvailable("subtitle");
      } catch (error) {
        if (!(error instanceof LibraryTaskConflictError)) throw error;
        return;
      }
      this.running = true;
      database.sqlite
        .prepare(
          "UPDATE subtitle_update_jobs SET status = 'running', stage = 'scanning', progress = '核验影片与字幕', attempts = attempts + 1, updated_at = ? WHERE task_id = ?",
        )
        .run(Date.now(), row.task_id);
      this.changed();
      try {
        const progress = (stage: SubtitleJobStage, message: string) => {
          database.sqlite
            .prepare("UPDATE subtitle_update_jobs SET stage = ?, progress = ?, updated_at = ? WHERE task_id = ?")
            .run(stage, message, Date.now(), row.task_id);
          this.changed();
        };
        const { result, warnings } = await this.process(JSON.parse(row.inputs_json), progress);
        database.sqlite
          .prepare(
            "UPDATE subtitle_update_jobs SET status = 'completed', stage = 'completed', progress = '处理完成', result_json = ?, warnings_json = ?, error = NULL, updated_at = ?, completed_at = ? WHERE task_id = ?",
          )
          .run(JSON.stringify(result), JSON.stringify(warnings), Date.now(), Date.now(), row.task_id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.deps.logger.warn(`字幕更新失败：${message}`);
        database.sqlite
          .prepare(
            "UPDATE subtitle_update_jobs SET status = 'failed', error = ?, updated_at = ?, completed_at = ? WHERE task_id = ?",
          )
          .run(message, Date.now(), Date.now(), row.task_id);
      } finally {
        this.running = false;
        this.deps.gate.subtitleFinished();
        this.changed();
      }
    }
  }

  private async process(
    inputs: Input[],
    progress: (stage: SubtitleJobStage, message: string) => void,
  ): Promise<{ result: NonNullable<SubtitleJob["result"]>; warnings: string[] }> {
    const config = await this.deps.config.get();
    const mapped = inputs.map((input) => ({
      ...input,
      mediaPath: applyPathMappings(input.mediaPath, config.automation.pathMappings),
      subtitlePath: applyPathMappings(input.subtitlePath, config.automation.pathMappings),
    }));
    for (const input of mapped) {
      if (!path.isAbsolute(input.mediaPath) || !path.isAbsolute(input.subtitlePath))
        throw new Error("媒体和字幕路径必须为绝对路径");
      if (!(await stat(input.mediaPath)).isFile()) throw new Error("影片路径不是文件");
      if (!(await stat(input.subtitlePath)).isFile()) throw new Error("字幕路径不是文件");
    }
    const mediaPaths = [...new Set(mapped.map((input) => input.mediaPath))];
    const roots = await this.deps.roots.listRoots();
    const absolute = (rootId: string | null, relativePath: string | null): string => {
      const root = roots.find((candidate) => candidate.id === rootId);
      if (!root || !relativePath) throw new Error(`找不到已登记资源的根目录或路径：${rootId}`);
      return resolveRootRelativePath(root, relativePath);
    };
    for (const input of mapped) {
      resolveRootFile(roots, input.mediaPath);
      resolveRootFile(roots, input.subtitlePath);
    }
    const { repositories } = await this.deps.persistence.getState();
    const snapshot = repositories.library.publicationSnapshot({ paths: mediaPaths, includeOwners: true });
    const files = mediaPaths.map((mediaPath) => {
      const file = snapshot.files.find(
        (entry) => filesystemPathKey(absolute(entry.rootId, entry.relativePath)) === filesystemPathKey(mediaPath),
      );
      if (!file) throw new Error(`未找到已登记的影片：${mediaPath}`);
      return { ...file, mediaPath };
    });
    if (files.some((file) => file.itemId !== files[0].itemId))
      throw new Error("合并通知的影片归属已改变，请重新提交通知");
    const entry = await repositories.library.getEntryById(files[0].itemId);
    const nfos = [
      ...new Map(
        entry.assets
          .filter((asset) => asset.kind === "nfo" && asset.published && asset.rootId && asset.relativePath)
          .map((asset) => absolute(asset.rootId, asset.relativePath))
          .map((nfoPath) => [filesystemPathKey(nfoPath), nfoPath]),
      ).values(),
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
    const release = await acquireOutputDirectories([...nfos, ...targets.map((target) => target.path), ...mediaPaths]);
    const warnings: string[] = [];
    let badgeStatus: NonNullable<SubtitleJob["result"]>["badgeStatus"] = "skipped";
    try {
      progress("scanning", "重新扫描外挂字幕");
      const scans = await Promise.all(
        files.map(async (file) => {
          const sidecars = await findSubtitleSidecars(file.mediaPath, undefined, config.scrape);
          for (const input of mapped.filter((input) => input.mediaPath === file.mediaPath)) {
            if (!sidecars.some((sidecar) => filesystemPathKey(sidecar.path) === filesystemPathKey(input.subtitlePath)))
              throw new Error("字幕文件不属于指定影片");
          }
          const info = await resolveFileInfoWithSubtitles(file.mediaPath, {
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
      const nfo = parseNfoSnapshot(xmls[0].xml);
      const streams = nfo.localState?.fileinfo?.streamdetails as
        | { video?: { width?: string | number; height?: string | number } }
        | undefined;
      const videoMeta = {
        width: Number(streams?.video?.width) || undefined,
        height: Number(streams?.video?.height) || undefined,
      };
      const generator = new NfoGenerator();
      const artifacts: Array<{ targetPath: string; data: string | Buffer }> = xmls.map(({ path: targetPath, xml }) => ({
        targetPath,
        data: generator.mergeSubtitleTag(xml, chinese ? "中文字幕" : "字幕"),
      }));
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
          if ((await readFile(target.path)).equals(rendered)) unchanged++;
          else {
            artifacts.push({ targetPath: target.path, data: rendered });
            updated++;
          }
        }
        badgeStatus = updated + unchanged === targets.length ? (updated ? "updated" : "unchanged") : "skipped";
      }
      progress("publishing", "写入 NFO、图片与字幕记录");
      await new WriteOutput().install(artifacts, {
        protectedMediaFiles: snapshot.files.map((item) => absolute(item.rootId, item.relativePath)),
        commit: () =>
          repositories.library.writeEntry(
            { id: entry.id },
            scans.map(({ file, sidecars }) => ({
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
            })),
          ),
      });
      this.deps.events.invalidate("library");
    } finally {
      release();
    }
    progress("notifying", "通知媒体服务器刷新");
    const notified = await notifyMediaServersOfPublish(
      this.deps.network,
      config,
      [...new Set(inputs.map((input) => path.posix.dirname(input.mediaPath.replaceAll("\\", "/"))))],
      this.deps.logger,
    );
    warnings.push(...notified.warnings);
    if (!notified.notified && !notified.warnings.length) warnings.push("没有启用媒体服务器刷新通知");
    return { result: { metadataUpdated: true, badgeStatus, mediaServerNotified: notified.notified }, warnings };
  }
}
