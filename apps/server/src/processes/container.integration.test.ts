import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { createTempDirectory } from "../../../../tests/harness/tempDirectory";

describe.skipIf(process.platform === "win32")("single-container process isolation", () => {
  it("serves reads and persists notifications while the worker is stopped, then recovers both children without duplicate delivery", async () => {
    const directory = await createTempDirectory("container-processes");
    const listener = createServer();
    listener.listen(0, "127.0.0.1");
    await once(listener, "listening");
    const address = listener.address();
    if (!address || typeof address === "string") throw new Error("Missing test port");
    await new Promise<void>((done) => listener.close(() => done()));
    const web = join(directory.path, "web");
    await mkdir(web);
    await writeFile(join(web, "index.html"), "<!doctype html><title>MDCz test</title>");
    const bundle = process.env.MDCZ_TEST_BUNDLE;
    const child = spawn(
      process.execPath,
      bundle
        ? [resolve(bundle)]
        : ["--import", resolve("apps/server/node_modules/tsx/dist/loader.mjs"), resolve("apps/server/src/index.ts")],
      {
        cwd: process.env.MDCZ_TEST_BUNDLE_CWD,
        env: {
          ...process.env,
          NODE_ENV: "production",
          MDCZ_HOME: directory.path,
          MDCZ_HOST: "127.0.0.1",
          PORT: String(address.port),
          MDCZ_ADMIN_PASSWORD: "test-password",
          MDCZ_WEB_DIST_DIR: web,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let logs = "";
    child.stdout.on("data", (chunk: Buffer) => {
      logs += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      logs += chunk.toString();
    });
    const base = `http://127.0.0.1:${address.port}`;
    let stoppedWorker: number | undefined;
    let stoppedApi: number | undefined;
    const wait = async (check: () => Promise<boolean>) => {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error(`Container exited: ${logs}`);
        if (await check().catch(() => false)) return;
        await delay(50);
      }
      throw new Error(`Process recovery timed out: ${logs}`);
    };
    const latestPid = (role: string) =>
      Number([...logs.matchAll(new RegExp(`MDCz ${role} 进程已启动 pid=(\\d+)`, "gu"))].at(-1)?.[1]);
    let token: string | undefined;
    const rpc = async (path: string, input?: unknown, mutation = false) => {
      const response = await fetch(
        `${base}/trpc/${path}${!mutation && input !== undefined ? `?input=${encodeURIComponent(JSON.stringify(input))}` : ""}`,
        {
          method: mutation ? "POST" : "GET",
          headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
          body: mutation ? JSON.stringify(input ?? null) : undefined,
          signal: AbortSignal.timeout(3000),
        },
      );
      const result = (await response.json()) as { result?: { data: unknown }; error?: unknown };
      if (!response.ok || result.error) throw new Error(`RPC ${path} failed: ${JSON.stringify(result)}`);
      return result.result?.data;
    };
    try {
      await wait(async () => (await fetch(`${base}/ready`)).ok);
      expect(await (await fetch(`${base}/`)).text()).toContain("MDCz test");
      const login = (await rpc("auth.login", { password: "test-password" }, true)) as { token: string };
      token = login.token;
      const invalid = await fetch(
        `${base}/trpc/activity.list?input=${encodeURIComponent(JSON.stringify({ limit: -1 }))}`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      expect(invalid.status).toBe(400);
      const secret = (await rpc("embyDeletion.rotateSecret", undefined, true)) as { token: string };
      const webhook = (id: string) =>
        fetch(`${base}/api/webhooks/emby/${secret.token}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            Event: "library.deleted",
            Date: "2026-11-16T00:00:00.000Z",
            Server: { Id: "test-emby" },
            Item: { Id: id, Type: "Movie", Path: `/isolated/${id}.strm` },
          }),
          signal: AbortSignal.timeout(2000),
        });
      stoppedWorker = latestPid("worker");
      expect(stoppedWorker).toBeGreaterThan(0);
      process.kill(stoppedWorker, "SIGSTOP");
      const streamController = new AbortController();
      const stream = await fetch(`${base}/events/tasks`, {
        headers: { authorization: `Bearer ${token}` },
        signal: streamController.signal,
      });
      expect(stream.status).toBe(200);
      const reader = stream.body?.getReader();
      expect(new TextDecoder().decode((await reader?.read())?.value)).toContain("notification");
      streamController.abort();
      await reader?.cancel().catch((error: Error) => {
        if (error.name !== "AbortError") throw error;
      });
      const receipts = await Promise.all([webhook("first"), webhook("second")]);
      expect(receipts.map((response) => response.status)).toEqual([202, 202]);
      const lock = new Database(join(directory.path, "data/webhook-inbox.sqlite"));
      try {
        lock.exec("BEGIN IMMEDIATE");
        expect((await webhook("not-committed")).status).toBe(503);
      } finally {
        lock.exec("ROLLBACK");
        lock.close();
      }
      expect((await webhook("first")).status).toBe(200);
      const started = performance.now();
      expect(await rpc("library.list", {})).toMatchObject({ entries: [] });
      expect(await rpc("deletions.list")).toMatchObject({
        jobs: [
          expect.objectContaining({ id: expect.stringMatching(/^inbox\//u) }),
          expect.objectContaining({ id: expect.stringMatching(/^inbox\//u) }),
        ],
      });
      expect(performance.now() - started).toBeLessThan(1500);
      const apiPid = latestPid("api");
      stoppedApi = apiPid;
      process.kill(apiPid, "SIGSTOP");
      expect((await fetch(`${base}/ready`, { signal: AbortSignal.timeout(2000) })).status).toBe(503);
      expect((await webhook("first")).status).toBe(200);
      process.kill(apiPid, "SIGCONT");
      stoppedApi = undefined;
      process.kill(apiPid, "SIGKILL");
      await wait(async () => latestPid("api") !== apiPid && (await fetch(`${base}/ready`)).ok);
      expect(await rpc("library.list", {})).toMatchObject({ entries: [] });
      process.kill(stoppedWorker, "SIGKILL");
      stoppedWorker = undefined;
      await wait(async () => {
        const result = (await rpc("deletions.list")) as { jobs: { id: string }[] };
        return result.jobs.length === 2 && result.jobs.every((job) => job.id.startsWith("emby/"));
      });
      expect((await webhook("first")).status).toBe(200);
      expect(await rpc("deletions.list")).toMatchObject({
        jobs: [expect.objectContaining({ status: "ignored" }), expect.objectContaining({ status: "ignored" })],
      });
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      const [code] = await exited;
      expect(code).toBe(0);
    } finally {
      if (stoppedApi) process.kill(stoppedApi, "SIGCONT");
      if (stoppedWorker) process.kill(stoppedWorker, "SIGCONT");
      if (child.exitCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGTERM");
        await exited;
      }
      await directory.cleanup();
    }
  }, 60_000);
});
