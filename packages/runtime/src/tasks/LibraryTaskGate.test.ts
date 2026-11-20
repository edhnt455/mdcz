import { expect, it } from "vitest";
import {
  acquireMediaTask,
  mediaTaskConflict,
  movieTaskKey,
  tryAcquireMediaTask,
  withMovieTask,
} from "../publication/mediaTasks";
import { LibraryTaskGate } from "./LibraryTaskGate";

it("serializes conflicting movies fairly while leaving independent work and paused sessions free", async () => {
  const gate = new LibraryTaskGate();
  let maintenance = true;
  gate.track("maintenance", () => maintenance);
  expect(() => gate.assertAvailable("scrape")).toThrow("维护任务");
  gate.assertAvailable("maintenance");
  maintenance = false;
  gate.assertAvailable("scrape");
  const a = movieTaskKey("a");
  const b = movieTaskKey("b");
  const release = await acquireMediaTask([a], "刮削当前影片");
  expect(mediaTaskConflict([a])).toBe("刮削当前影片");
  expect(tryAcquireMediaTask([a], "字幕更新")).toBeNull();
  const manual = acquireMediaTask([a], "编辑当前影片");
  const independent = tryAcquireMediaTask([b], "字幕更新");
  expect(independent).not.toBeNull();
  independent?.();
  const controller = new AbortController();
  const aborted = acquireMediaTask([a, b], "已取消任务", controller.signal);
  controller.abort(new Error("stopped"));
  await expect(aborted).rejects.toThrow("stopped");
  release();
  release();
  expect(tryAcquireMediaTask([a], "字幕更新")).toBeNull();
  (await manual)();
  expect(mediaTaskConflict([a])).toBeNull();
  await expect(
    withMovieTask("a", "编辑", async () => {
      await withMovieTask("a", "嵌套写入", async () => undefined);
      throw new Error("write failed");
    }),
  ).rejects.toThrow("write failed");
  expect(mediaTaskConflict([a])).toBeNull();
});
