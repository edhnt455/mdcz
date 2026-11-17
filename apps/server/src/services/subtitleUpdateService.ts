import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { resolveRootFile, resolveRootRelativePath } from "@mdcz/media-store";
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
type Job = {
  taskId: string;
  status: "queued" | "running" | "completed" | "failed";
  result: {
    metadataUpdated: boolean;
    badgeStatus: "updated" | "unchanged" | "skipped";
    mediaServerNotified: boolean;
  } | null;
  warnings: string[];
  error: string | null;
};
type Row = {
  task_id: string;
  event_id: string;
  input_json: string;
  status: Job["status"];
  result_json: string | null;
  warnings_json: string;
  error: string | null;
};

export class SubtitleUpdateService {
  private running = false;
  private closed = false;
  private timer?: ReturnType<typeof setTimeout>;
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
    database.sqlite.prepare("UPDATE subtitle_update_jobs SET status = 'queued' WHERE status = 'running'").run();
    this.wake();
  }

  async close(): Promise<void> {
    this.closed = true;
    clearTimeout(this.timer);
    await this.worker;
  }

  async enqueue(input: Input): Promise<{ taskId: string; status: Job["status"] }> {
    if (this.closed || this.deps.persistence.readOnly) throw new Error("服务不可写入字幕更新任务");
    const { database } = await this.deps.persistence.getState();
    const json = JSON.stringify(input);
    const id = `subtitle-update-${randomUUID()}`;
    database.sqlite
      .prepare(
        "INSERT INTO subtitle_update_jobs (task_id, event_id, input_json, status, created_at) VALUES (?, ?, ?, 'queued', ?) ON CONFLICT(event_id) DO NOTHING",
      )
      .run(id, input.eventId, json, Date.now());
    const row = database.sqlite
      .prepare<[string], Row>("SELECT * FROM subtitle_update_jobs WHERE event_id = ?")
      .get(input.eventId);
    if (!row) throw new Error("无法创建字幕更新任务");
    if (row.input_json !== json) throw Object.assign(new Error("eventId 已用于不同的通知内容"), { statusCode: 409 });
    this.wake();
    return { taskId: row.task_id, status: row.status };
  }

  async get(id: string): Promise<Job | null> {
    const { database } = await this.deps.persistence.getState();
    const row = database.sqlite.prepare<[string], Row>("SELECT * FROM subtitle_update_jobs WHERE task_id = ?").get(id);
    return row
      ? {
          taskId: row.task_id,
          status: row.status,
          result: row.result_json ? JSON.parse(row.result_json) : null,
          warnings: JSON.parse(row.warnings_json),
          error: row.error,
        }
      : null;
  }

  private wake(delay = 0): void {
    if (this.closed || this.timer || this.worker) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.worker = this.work()
        .catch((error) => {
          this.deps.logger.warn(`字幕更新队列失败：${error instanceof Error ? error.message : String(error)}`);
          this.worker = undefined;
          this.wake(1000);
        })
        .finally(() => {
          this.worker = undefined;
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
        this.worker = undefined;
        this.wake(1000);
        return;
      }
      this.running = true;
      database.sqlite.prepare("UPDATE subtitle_update_jobs SET status = 'running' WHERE task_id = ?").run(row.task_id);
      try {
        const { result, warnings } = await this.process(JSON.parse(row.input_json));
        database.sqlite
          .prepare(
            "UPDATE subtitle_update_jobs SET status = 'completed', result_json = ?, warnings_json = ?, error = NULL WHERE task_id = ?",
          )
          .run(JSON.stringify(result), JSON.stringify(warnings), row.task_id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.deps.logger.warn(`字幕更新失败：${message}`);
        database.sqlite
          .prepare("UPDATE subtitle_update_jobs SET status = 'failed', error = ? WHERE task_id = ?")
          .run(message, row.task_id);
      } finally {
        this.running = false;
      }
    }
  }

  private async process(input: Input): Promise<{ result: NonNullable<Job["result"]>; warnings: string[] }> {
    const config = await this.deps.config.get();
    const mediaPath = applyPathMappings(input.mediaPath, config.automation.pathMappings);
    const subtitlePath = applyPathMappings(input.subtitlePath, config.automation.pathMappings);
    if (!path.isAbsolute(mediaPath) || !path.isAbsolute(subtitlePath)) throw new Error("媒体和字幕路径必须为绝对路径");
    if (!(await stat(mediaPath)).isFile()) throw new Error("影片路径不是文件");
    if (!(await stat(subtitlePath)).isFile()) throw new Error("字幕路径不是文件");
    const roots = await this.deps.roots.listRoots();
    const absolute = (rootId: string | null, relativePath: string | null): string => {
      const root = roots.find((candidate) => candidate.id === rootId);
      if (!root || !relativePath) throw new Error(`找不到已登记资源的根目录或路径：${rootId}`);
      return resolveRootRelativePath(root, relativePath);
    };
    resolveRootFile(roots, mediaPath);
    const subtitleRef = resolveRootFile(roots, subtitlePath);
    const { repositories } = await this.deps.persistence.getState();
    const snapshot = repositories.library.publicationSnapshot({ paths: [mediaPath], includeOwners: true });
    const file = snapshot.files.find(
      (entry) => path.resolve(absolute(entry.rootId, entry.relativePath)) === path.resolve(mediaPath),
    );
    if (!file) throw new Error(`未找到已登记的影片：${mediaPath}`);
    const entry = await repositories.library.getEntryById(file.itemId);
    const nfos = entry.assets
      .filter((asset) => asset.kind === "nfo" && asset.published && asset.rootId && asset.relativePath)
      .map((asset) => absolute(asset.rootId, asset.relativePath));
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
    const release = await acquireOutputDirectories([...nfos, ...targets.map((target) => target.path), mediaPath]);
    const warnings: string[] = [];
    let badgeStatus: NonNullable<Job["result"]>["badgeStatus"] = "skipped";
    try {
      const sidecars = await findSubtitleSidecars(mediaPath, undefined, config.scrape);
      if (!sidecars.some((sidecar) => path.resolve(sidecar.path) === path.resolve(subtitlePath)))
        throw new Error("字幕文件不属于指定影片");
      const info = await resolveFileInfoWithSubtitles(mediaPath, {
        filenameRules: config.scrape,
        subtitleSidecars: sidecars,
      });
      const chinese = /^zh(?:-|$)/iu.test(input.language);
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
        for (const target of targets) {
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
      const subtitleAssets = sidecars.map((sidecar) => {
        const ref = resolveRootFile(roots, sidecar.path);
        return {
          kind: "subtitle",
          uri: ref.relativePath,
          rootId: ref.root.id,
          relativePath: ref.relativePath,
          published: true,
        };
      });
      if (
        !subtitleAssets.some(
          (asset) => asset.rootId === subtitleRef.root.id && asset.relativePath === subtitleRef.relativePath,
        )
      )
        throw new Error("字幕文件不属于指定影片");
      await new WriteOutput().install(artifacts, {
        protectedMediaFiles: snapshot.files.map((item) => absolute(item.rootId, item.relativePath)),
        commit: () =>
          repositories.library.writeEntry({ id: entry.id }, [
            {
              fileId: file.fileId,
              rootId: file.rootId,
              rootRelativePath: file.relativePath,
              assets: subtitleAssets,
            },
          ]),
      });
      this.deps.events.invalidate("library");
    } finally {
      release();
    }
    const notified = await notifyMediaServersOfPublish(
      this.deps.network,
      config,
      [path.posix.dirname(input.mediaPath.replaceAll("\\", "/"))],
      this.deps.logger,
    );
    warnings.push(...notified.warnings);
    if (!notified.notified && !notified.warnings.length) warnings.push("没有启用媒体服务器刷新通知");
    return { result: { metadataUpdated: true, badgeStatus, mediaServerNotified: notified.notified }, warnings };
  }
}
