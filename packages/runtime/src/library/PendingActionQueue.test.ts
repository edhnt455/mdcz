import { createMediaRoot } from "@mdcz/media-store";
import {
  MediaRootRepository,
  PendingActionRepository,
  PendingRepository,
  ScrapeRunRepository,
} from "@mdcz/persistence";
import { createTestPersistenceDatabase } from "@mdcz/persistence/test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PendingActionQueue } from "./PendingActionQueue";

let database: ReturnType<typeof createTestPersistenceDatabase>;
let pending: PendingRepository;
let actions: PendingActionRepository;
let queue: PendingActionQueue;

beforeEach(async () => {
  database = createTestPersistenceDatabase();
  await new MediaRootRepository(database).upsert(
    createMediaRoot({ id: "root", displayName: "Media", hostPath: "/media" }),
  );
  pending = new PendingRepository(database);
  actions = new PendingActionRepository(database);
});
afterEach(async () => {
  await queue?.close();
  database.close();
  vi.useRealTimers();
});

it("recovers durable jobs, preserves checkpoints and serializes file actions with atomic scrape admission", async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  for (const relativePath of ["first.strm", "second.strm"])
    pending.upsert({ kind: "failed", rootId: "root", relativePath });
  const items = pending.list().sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  const inputs = items.map((item) => ({
    itemId: item.id,
    itemUpdatedAt: item.updatedAt.getTime(),
    action: "delete" as const,
    inputJson: "{}",
    itemJson: "{}",
  }));
  const jobs = inputs.map((input) => actions.enqueue(input));
  pending.saveDeletion(items[0].id, items[0].updatedAt, '{"step":"verifying_cloud"}');
  expect(actions.claim()?.id).toBe(jobs[0].id);
  expect(actions.enqueue(inputs[0]).id).toBe(jobs[0].id);
  expect(() => actions.enqueue({ ...inputs[0], action: "confirm" })).toThrow("已有正在执行");
  const runs = new ScrapeRunRepository(database);
  await expect(
    runs.create({
      libraryId: "lib",
      rootId: "root",
      executionMode: "single",
      items: [{ ordinal: 0, rootId: "root", relativePath: items[0].relativePath }],
    }),
  ).rejects.toThrow("已有正在执行");
  expect(await runs.list()).toEqual([]);
  const executed: string[] = [];
  queue = new PendingActionQueue({
    repository: async () => actions,
    busy: async () => false,
    changed: vi.fn(),
    progressed: vi.fn(),
    execute: async (job, progress) => {
      executed.push(job.id);
      progress("正在确认删除结果");
      if (job.id === jobs[0].id) {
        expect(pending.get(job.itemId).deletionJson).toContain("verifying_cloud");
        await blocked;
      }
      pending.delete([job.itemId]);
    },
  });
  try {
    await queue.start();
    await expect.poll(() => executed.length).toBe(1);
    expect(pending.listAvailable()).toEqual([]);
    expect(pending.count()).toBe(0);
    expect(actions.list().find((job) => job.id === jobs[0].id)?.progress).toBe("正在确认删除结果");
  } finally {
    release();
  }
  await queue.waitForIdle();
  expect(executed).toEqual(jobs.map((job) => job.id));
  expect(actions.list().every((job) => job.status === "completed")).toBe(true);
  expect(pending.list()).toEqual([]);
});

it("keeps transient retries in the workbench and returns only exhausted failures to pending", async () => {
  vi.useFakeTimers();
  pending.upsert({ kind: "new_file", rootId: "root", relativePath: "new.strm" });
  const item = pending.list()[0];
  const job = actions.enqueue({
    itemId: item.id,
    itemUpdatedAt: item.updatedAt.getTime(),
    action: "delete",
    inputJson: "{}",
    itemJson: "{}",
  });
  const execute = vi.fn(async () => {
    throw new Error("MoviePilot request: HTTP 503");
  });
  queue = new PendingActionQueue({
    repository: async () => actions,
    busy: async () => false,
    execute,
    changed: vi.fn(),
    progressed: vi.fn(),
  });
  await queue.start();
  await queue.waitForIdle();
  expect(actions.list()[0]).toMatchObject({ status: "retrying", attempts: 1 });
  expect(pending.listAvailable()).toEqual([]);
  await vi.advanceTimersByTimeAsync(2_000);
  await queue.waitForIdle();
  expect(actions.list()[0]).toMatchObject({ status: "retrying", attempts: 2 });
  expect(pending.count()).toBe(0);
  await vi.advanceTimersByTimeAsync(4_000);
  await queue.waitForIdle();
  expect(execute).toHaveBeenCalledTimes(3);
  expect(actions.list()[0]).toMatchObject({ status: "failed", attempts: 3 });
  expect(pending.listAvailable()[0]).toMatchObject({
    kind: "failed",
    taskId: job.id,
    taskKind: "action",
    detail: expect.stringContaining("HTTP 503"),
  });
  expect(pending.count()).toBe(1);
});
