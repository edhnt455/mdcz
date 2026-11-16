import { type ChildProcess, fork } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { embyDeletionNotificationSchema } from "@mdcz/shared/embyDeletion";
import Fastify from "fastify";
import type { BuildServerOptions } from "../app";
import { parseHost, parsePort } from "../config";
import { createHealthPayload } from "../http/health";
import { resolveServerRuntimePaths } from "../services/configService";
import { proxyHttp } from "./httpProxy";
import type { ProcessMessage, WorkerSnapshot } from "./protocol";
import { WebhookInbox } from "./webhookInbox";

export const startContainer = async (workerOptions: BuildServerOptions = {}): Promise<void> => {
  const role = process.env.MDCZ_PROCESS_ROLE;
  const inboxPath = join(resolveServerRuntimePaths().dataDir, "webhook-inbox.sqlite");
  if (role === "worker" || role === "api") {
    const directory = process.env.MDCZ_PROCESS_DIRECTORY;
    if (!directory || !process.connected) throw new Error("子进程必须由 MDCz 入口启动");
    const disconnectedDuringStartup = () => process.exit(1);
    process.once("disconnect", disconnectedDuringStartup);
    if (role === "worker") {
      const { startWorkerProcess } = await import("./worker");
      await startWorkerProcess(directory, inboxPath, workerOptions);
    } else {
      const { startApiProcess } = await import("./api");
      await startApiProcess(directory, inboxPath);
    }
    process.off("disconnect", disconnectedDuringStartup);
    return;
  }
  if (role) throw new Error(`未知进程角色：${role}`);
  const directory = await mkdtemp(join(tmpdir(), "mdcz-"));
  const inbox = new WebhookInbox(inboxPath);
  const front = Fastify({ logger: false });
  const children = new Map<"api" | "worker", ChildProcess>();
  const ready = new Set<"api" | "worker">();
  const retries = { api: 0, worker: 0 };
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let snapshot: WorkerSnapshot | undefined;
  let closing = false;

  const send = (child: ChildProcess | undefined, message: ProcessMessage) => {
    if (!child?.connected) return;
    child.send(message, (error) => {
      if (error && child.connected) console.error("子进程通信失败", error.message);
    });
  };
  const launch = (role: "api" | "worker") => {
    if (closing || children.has(role)) return;
    const startedAt = Date.now();
    const entry = process.argv[1];
    if (!entry) throw new Error("缺少 MDCz 启动入口");
    const child = fork(entry, [], {
      env: { ...process.env, MDCZ_PROCESS_ROLE: role, MDCZ_PROCESS_DIRECTORY: directory },
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    });
    children.set(role, child);
    console.info(`MDCz ${role} 进程已启动 pid=${child.pid}`);
    child.on("message", (message: ProcessMessage) => {
      if (message.kind === "snapshot" && role === "worker") {
        snapshot = message.snapshot;
        send(children.get("api"), message);
      }
      if (message.kind === "event" || message.kind === "inbox-changed") send(children.get("api"), message);
      if (message.kind === "touch-session" && role === "api") send(children.get("worker"), message);
      if (message.kind === "boot" && role === "api" && snapshot) send(child, { kind: "snapshot", snapshot });
      if (message.kind === "ready") {
        ready.add(role);
        if (role === "worker" && !children.has("api")) launch("api");
      }
    });
    child.on("error", (error) => console.error(`${role} 进程异常`, error.message));
    child.once("close", (code, signal) => {
      children.delete(role);
      ready.delete(role);
      if (closing) return;
      retries[role] = Date.now() - startedAt >= 60_000 ? 0 : retries[role] + 1;
      const delay = Math.min(30_000, 500 * 2 ** Math.min(retries[role] - 1, 6));
      console.error(`${role} 进程退出（${code ?? signal}），${delay}ms 后恢复`);
      const timer = setTimeout(() => {
        timers.delete(timer);
        launch(role);
      }, delay);
      timers.add(timer);
    });
  };

  front.addHook("onRequest", async (request, reply) => {
    const path = request.url.split("?")[0];
    if (path === "/health" || path === "/ready" || /^\/api\/webhooks\/emby\/[^/]+$/u.test(path)) return;
    proxyHttp(join(directory, "api.sock"), request, reply);
  });
  front.get("/health", async () => createHealthPayload());
  front.get("/ready", async (_request, reply) => {
    if (closing || ready.size !== 2) return reply.code(503).send({ status: "unavailable" });
    const available = await new Promise<boolean>((resolve) => {
      const request = httpRequest({ socketPath: join(directory, "api.sock"), path: "/ready" }, (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode === 200));
        response.on("error", () => resolve(false));
      });
      request.setTimeout(1000, () => request.destroy(new Error("API 就绪检查超时")));
      request.on("error", () => resolve(false));
      request.end();
    });
    if (!available) return reply.code(503).send({ status: "unavailable" });
    return { status: "ready" };
  });
  front.post<{ Params: { token: string } }>(
    "/api/webhooks/emby/:token",
    { bodyLimit: 256 * 1024 },
    async (request, reply) => {
      const expected = snapshot?.configuration.embyDeletion.secretHash;
      if (!expected) return reply.code(503).send({ error: "通知入口尚未就绪" });
      const supplied = createHash("sha256").update(request.params.token).digest("hex");
      if (expected.length !== supplied.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(supplied)))
        return reply.code(401).send({ error: "Emby Webhook 凭证无效" });
      const input = embyDeletionNotificationSchema.safeParse(request.body);
      if (!input.success) return reply.code(400).send({ error: "Emby 通知无效" });
      try {
        const receipt = inbox.accept(input.data);
        send(children.get("worker"), { kind: "inbox-changed" });
        send(children.get("api"), { kind: "inbox-changed" });
        console.info(`Emby 通知已持久化：${receipt.id}，重复=${receipt.duplicate}`);
        return reply.code(receipt.duplicate ? 200 : 202).send(receipt);
      } catch (error) {
        console.error("Emby 通知持久化失败", error);
        return reply.code(503).send({ error: "通知暂未保存，请重试" });
      }
    },
  );
  front.all("/*", async (_request, reply) => reply.code(503).send({ error: "服务正在恢复" }));

  const shutdown = () => {
    if (closing) return;
    closing = true;
    for (const timer of timers) clearTimeout(timer);
    const deadline = setTimeout(() => {
      for (const child of children.values()) child.kill("SIGKILL");
      process.exit(1);
    }, 27_000);
    deadline.unref();
    const exits = [...children.values()].map(
      (child) =>
        new Promise<void>((resolve) => {
          child.once("exit", () => resolve());
          child.kill("SIGTERM");
        }),
    );
    void Promise.all([front.close(), ...exits]).then(
      async () => {
        inbox.close();
        await rm(directory, { recursive: true, force: true });
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
  try {
    await front.listen({ host: parseHost(process.env.MDCZ_HOST), port: parsePort(process.env.PORT) });
    launch("worker");
    console.info(`MDCz 通知入口正在监听端口 ${parsePort(process.env.PORT)}（单容器三进程）`);
  } catch (error) {
    await front.close();
    inbox.close();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
};
