import { rm } from "node:fs/promises";
import { join } from "node:path";
import { TRPCError } from "@trpc/server";
import { type BuildServerOptions, buildServer } from "../app";
import { appRouter } from "../routers";
import { ServerConfigValidationError } from "../services/configService";
import { type ProcessMessage, sendMessage } from "./protocol";
import { WebhookInbox } from "./webhookInbox";

export const startWorkerProcess = async (
  directory: string,
  inboxPath: string,
  options: BuildServerOptions = {},
): Promise<void> => {
  const { fastify, services } = buildServer({ ...options, webStaticDir: false });
  const inbox = new WebhookInbox(inboxPath);
  const socket = join(directory, "worker.sock");
  await rm(socket, { force: true });
  let closing = false;
  let snapshotRunning = false;
  let delivery: Promise<void> | undefined;
  let dirty = true;
  let prunedAt = 0;

  const publishSnapshot = async () => {
    if (snapshotRunning || closing || !dirty) return;
    snapshotRunning = true;
    dirty = false;
    try {
      const [configuration, liveRuns, history, maintenance, activity] = await Promise.all([
        services.config.get(),
        services.scrape.liveRuns(),
        services.scrape.history(),
        services.maintenance.getActiveSession(),
        services.activity.list(500),
      ]);
      sendMessage({
        kind: "snapshot",
        snapshot: {
          configuration,
          queries: {
            "scrape.liveRuns": liveRuns,
            "scrape.history": history,
            "maintenance.getActiveSession": maintenance,
            "library.edit.status": services.libraryEdit.status(),
            "tools.personSyncStatus": services.personSync.snapshot(),
            "activity.list": activity,
            "integrations.status": {
              cloudDrive: services.libraryWatch.cloudDriveActivity(),
              qbittorrent: services.qbittorrent.status(),
            },
          },
          logs: services.runtimeLogs.list().logs,
          taskLogsClearedAt: services.runtimeLogs.getTaskLogsClearedAt(),
          processingDeletions: [...services.embyDeletion.processing.keys()],
          processingDuplicates: services.scrape.conflicts.runningIds(),
          updatedAt: Date.now(),
        },
      });
    } finally {
      snapshotRunning = false;
    }
  };

  const drain = (): Promise<void> => {
    delivery ??= (async () => {
      // A bounded batch leaves CPU and I/O time for task controls and execution.
      for (let count = 0; count < 20 && !closing; count++) {
        const receipt = inbox.due();
        if (!receipt) break;
        try {
          const result = await services.embyDeletion.accept(JSON.parse(receipt.payload), receipt);
          inbox.delivered(receipt.id, result);
          sendMessage({ kind: "inbox-changed" });
        } catch (error) {
          inbox.retry(receipt, error);
          services.runtimeLogs.getLogger("WebhookInbox").error(`通知 ${receipt.id} 转交失败，将重试：${String(error)}`);
        }
      }
      if (Date.now() - prunedAt >= 60 * 60_000) {
        inbox.pruneDelivered();
        prunedAt = Date.now();
      }
    })().finally(() => {
      delivery = undefined;
    });
    return delivery;
  };

  services.taskEvents.subscribe((event) => {
    dirty = true;
    sendMessage({ kind: "event", event });
  });
  services.config.onChange(() => {
    dirty = true;
  });
  fastify.post<{ Body: { path: string; input: unknown; token?: string } }>(
    "/internal/procedure",
    async (request, reply) => {
      try {
        const caller = appRouter.createCaller({ services, token: request.body.token }) as unknown as Record<
          string,
          (input: unknown) => Promise<unknown>
        >;
        const procedure = caller[request.body.path];
        if (!procedure) throw new TRPCError({ code: "NOT_FOUND", message: "接口不存在" });
        const data = await procedure(request.body.input);
        dirty = true;
        await publishSnapshot().catch((error) => {
          dirty = true;
          console.error("任务状态广播失败", error);
        });
        return { data };
      } catch (error) {
        const failure =
          error instanceof TRPCError ? error : new TRPCError({ code: "INTERNAL_SERVER_ERROR", cause: error });
        return reply.code(200).send({
          error: {
            code: failure.code,
            message: failure.message,
            domainError: failure.cause instanceof ServerConfigValidationError ? failure.cause.domainError : undefined,
          },
        });
      }
    },
  );

  await fastify.listen({ path: socket });
  await publishSnapshot();
  sendMessage({ kind: "ready" });
  const timer = setInterval(() => {
    void drain().catch((error) => {
      console.error(error);
      process.exit(1);
    });
    void publishSnapshot().catch((error) => {
      console.error(error);
      process.exit(1);
    });
  }, 500);
  process.on("message", (message: ProcessMessage) => {
    if (message.kind === "inbox-changed")
      void drain().catch((error) => {
        console.error(error);
        process.exit(1);
      });
    if (message.kind === "touch-session")
      void services.auth.assertAuthenticated(message.token).catch((error) => {
        if (error instanceof Error && error.name === "AuthenticationError") return;
        console.error("会话续期失败", error);
      });
  });
  const shutdown = () => {
    if (closing) return;
    closing = true;
    clearInterval(timer);
    const deadline = setTimeout(() => process.exit(1), 25_000);
    deadline.unref();
    void (async () => {
      await delivery;
      await fastify.close();
      inbox.close();
    })().then(
      () => process.exit(0),
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
