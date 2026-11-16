import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type { DeletionJob } from "@mdcz/shared/deletions";
import { embyDeletionNotificationSchema } from "@mdcz/shared/embyDeletion";
import { activityListInputSchema, scrapeTaskControlInputSchema } from "@mdcz/shared/serverDtos";
import { type AnyTRPCProcedure, TRPCError } from "@trpc/server";
import { buildServer } from "../app";
import { appRouter } from "../routers";
import { ServerConfigService } from "../services/configService";
import type { TaskResource } from "../taskEvents";
import { proxyHttp } from "./httpProxy";
import { type ProcessMessage, sendMessage, type WorkerSnapshot } from "./protocol";
import { callWorker } from "./rpc";
import { WebhookInbox } from "./webhookInbox";

const localQueries = new Set([
  "auth.setup",
  "auth.status",
  "setup.status",
  "health.read",
  "system.about",
  "config.defaults",
  "config.read",
  "config.export",
  "apiKeys.list",
  "browser.list",
  "serverPaths.suggest",
  "crawler.listSites",
  "tools.catalog",
  "library.list",
  "library.summary",
  "library.detail",
  "library.availability",
  "overview.summary",
  "libraries.list",
  "pending.list",
  "pending.newFiles",
  "pending.detail",
  "pending.jobs",
  "deletions.list",
  "deletions.detail",
  "embyDeletion.status",
  "mediaRoots.list",
  "persistence.status",
  "scans.list",
  "scans.detail",
  "scans.events",
  "logs.list",
]);

export const startApiProcess = async (directory: string, inboxPath: string): Promise<void> => {
  let snapshot = await new Promise<WorkerSnapshot>((resolve) => {
    const receive = (message: ProcessMessage) => {
      if (message.kind !== "snapshot") return;
      process.off("message", receive);
      resolve(message.snapshot);
    };
    process.on("message", receive);
    sendMessage({ kind: "boot" });
  });
  const config = new ServerConfigService();
  config.adoptSnapshot(snapshot.configuration);
  const inbox = new WebhookInbox(inboxPath, true);
  const touched = new Map<string, number>();
  const invalidations = new Set<TaskResource>();
  let invalidationTimer: ReturnType<typeof setTimeout> | undefined;
  const invalidate = (...resources: TaskResource[]) => {
    for (const resource of resources) invalidations.add(resource);
    invalidationTimer ??= setTimeout(() => {
      invalidationTimer = undefined;
      app.services.taskEvents.invalidate(...invalidations);
      invalidations.clear();
    }, 50);
    invalidationTimer.unref();
  };
  const app = buildServer({
    readOnly: true,
    services: { config },
    isDeletionRunning: (source, id) =>
      (source === "emby" ? snapshot.processingDeletions : snapshot.processingDuplicates).includes(id),
    dispatch: async ({ path, type, getRawInput, token }) => {
      const procedure = Reflect.get(appRouter._def.procedures, path) as AnyTRPCProcedure;
      const input = procedure._def.inputs.length ? await getRawInput() : undefined;
      if (type === "mutation" || (!localQueries.has(path) && !(path in snapshot.queries))) {
        const data = await callWorker(join(directory, "worker.sock"), { path, input, token });
        return { handled: true, data };
      }
      if (token) {
        const key = createHash("sha256").update(token).digest("hex");
        if (Date.now() - (touched.get(key) ?? 0) >= 10 * 60_000) {
          touched.set(key, Date.now());
          const oldest = touched.keys().next().value;
          if (touched.size > 1000 && oldest) touched.delete(oldest);
          sendMessage({ kind: "touch-session", token });
        }
      }
      if (path in snapshot.queries) {
        await app.services.auth.assertAuthenticated(token).catch((error: Error) => {
          throw new TRPCError({ code: "UNAUTHORIZED", message: error.message });
        });
        if (path === "activity.list") {
          const validation = activityListInputSchema.safeParse(input);
          if (!validation.success) throw new TRPCError({ code: "BAD_REQUEST", message: validation.error.message });
          const parsed = validation.data;
          const data = snapshot.queries[path] as { entries: unknown[] };
          return { handled: true, data: { entries: data.entries.slice(0, parsed?.limit ?? 20) } };
        }
        if (path === "scrape.history") {
          const validation = scrapeTaskControlInputSchema.optional().safeParse(input);
          if (!validation.success) throw new TRPCError({ code: "BAD_REQUEST", message: validation.error.message });
          const parsed = validation.data;
          const data = snapshot.queries[path] as { runs: { id: string }[]; results: { taskId: string }[] };
          return {
            handled: true,
            data: parsed?.taskId
              ? {
                  runs: data.runs.filter((run) => run.id === parsed.taskId),
                  results: data.results.filter((result) => result.taskId === parsed.taskId),
                }
              : data,
          };
        }
        return { handled: true, data: snapshot.queries[path] };
      }
      if (
        path === "deletions.list" ||
        (path === "deletions.detail" &&
          typeof (input as { id?: unknown })?.id === "string" &&
          (input as { id: string }).id.startsWith("inbox/"))
      ) {
        await app.services.auth.assertAuthenticated(token).catch((error: Error) => {
          throw new TRPCError({ code: "UNAUTHORIZED", message: error.message });
        });
        const { database } = await app.services.persistence.getState();
        const exists = database.sqlite.prepare("SELECT 1 FROM emby_notification_receipts WHERE id = ?");
        const receipts: DeletionJob[] = inbox
          .pending()
          .filter((receipt) => !exists.get(receipt.id))
          .map((receipt) => {
            const notification = embyDeletionNotificationSchema.parse(JSON.parse(receipt.payload));
            const path = notification.Item?.Path ?? null;
            return {
              id: `inbox/${receipt.id}`,
              source: "emby",
              status: receipt.attempts ? "retrying" : "pending",
              step: "validating",
              name: path ? basename(path, extname(path)) : (notification.Item?.Id ?? "Emby 通知"),
              libraryName: "",
              linkPath: path,
              sourcePaths: [],
              cloudPath: null,
              cloudFileId: null,
              cloudSize: null,
              cloudDeleted: false,
              cloudPlanned: false,
              sharedResource: false,
              error: receipt.error,
              result: "waiting_for_worker",
              attempts: receipt.attempts,
              nextAttemptAt: null,
              createdAt: receipt.receivedAt,
              updatedAt: receipt.receivedAt,
              completedAt: null,
              canRetry: false,
              retryRunId: null,
              retryPlanned: false,
            };
          });
        if (path === "deletions.detail") {
          const receipt = receipts.find((job) => job.id === (input as { id: string }).id);
          if (receipt) return { handled: true, data: receipt };
          const id = (input as { id: string }).id.slice(6);
          const delivered = inbox.database
            .prepare<unknown[], { result: string | null }>("SELECT result FROM webhook_inbox WHERE id = ?")
            .get(id);
          const transferred = database.sqlite
            .prepare<unknown[], { result: string }>(
              "SELECT result_json AS result FROM emby_notification_receipts WHERE id = ?",
            )
            .get(id);
          const savedResult = delivered?.result ?? transferred?.result;
          if (!savedResult) throw new TRPCError({ code: "NOT_FOUND", message: "通知正在转交，请刷新任务列表" });
          const result = JSON.parse(savedResult) as { id: string };
          return { handled: true, data: await app.services.deletions.detail(`emby/${result.id}`) };
        }
        const result = await app.services.deletions.list();
        return { handled: true, data: { jobs: [...receipts, ...result.jobs] } };
      }
      return { handled: false };
    },
  });
  app.fastify.addHook("onRequest", async (request, reply) => {
    if (request.url.startsWith("/api/") && !request.url.startsWith("/api/library/assets/"))
      proxyHttp(join(directory, "worker.sock"), request, reply);
  });
  const applySnapshot = (next: WorkerSnapshot) => {
    const configChanged = JSON.stringify(snapshot.configuration) !== JSON.stringify(next.configuration);
    const deletionsChanged =
      snapshot.processingDeletions.join() !== next.processingDeletions.join() ||
      snapshot.processingDuplicates.join() !== next.processingDuplicates.join();
    snapshot = next;
    config.adoptSnapshot(next.configuration);
    app.services.runtimeLogs.adoptLogs(next.logs, next.taskLogsClearedAt);
    app.services.library.invalidateAvailability();
    invalidate("scrape-live", "scrape-history", "maintenance", "activity");
    if (deletionsChanged) invalidate("pending");
    if (configChanged) invalidate("config", "library");
  };
  applySnapshot(snapshot);
  process.on("message", (message: ProcessMessage) => {
    if (message.kind === "snapshot") applySnapshot(message.snapshot);
    if (message.kind === "event") {
      if (message.event.kind === "invalidate") invalidate(...message.event.resources);
      else app.services.taskEvents.emit(message.event);
    }
    if (message.kind === "inbox-changed") invalidate("pending");
  });
  const socket = join(directory, "api.sock");
  await rm(socket, { force: true });
  await app.fastify.listen({ path: socket });
  sendMessage({ kind: "ready" });
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    clearTimeout(invalidationTimer);
    const deadline = setTimeout(() => process.exit(1), 25_000);
    deadline.unref();
    void app.fastify.close().then(
      () => {
        inbox.close();
        process.exit(0);
      },
      (error) => {
        console.error(error);
        process.exit(1);
      },
    );
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  process.once("disconnect", shutdown);
};
