import { mkdir, mkdtemp, readdir, readFile, rm, stat, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTaskEventBus } from "../taskEvents";
import { RuntimeLogService } from "./runtimeLogService";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("runtime log persistence", () => {
  it("persists all levels with time and source while keeping console, events and clearing independent", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mdcz-logs-"));
    directories.push(directory);
    const logDirectory = join(directory, "logs");
    const events = createTaskEventBus();
    const onEvent = vi.fn();
    events.subscribe(onEvent);
    const service = new RuntimeLogService(2, events, logDirectory);
    const logger = service.getLogger("Aggregation");
    for (const level of ["debug", "info", "warn", "error"] as const) {
      const output = vi.spyOn(console, level).mockImplementation(() => undefined);
      logger[level](`${level} 标题与图片来源`);
      expect(output).toHaveBeenCalledWith(`${level} 标题与图片来源`);
    }
    expect(service.list().logs.map((entry) => entry.type)).toEqual(["warn", "error"]);
    expect(onEvent).toHaveBeenCalledTimes(4);
    expect(service.clear()).toBe(2);
    expect(service.list().logs).toEqual([]);
    await service.close();
    const contents = await readFile(join(logDirectory, "mdcz.log"), "utf8");
    for (const level of ["debug", "info", "warn", "error"]) {
      expect(contents).toMatch(
        new RegExp(`\\d{4}-\\d{2}-\\d{2}T.* ${level.toUpperCase()} \\[Aggregation\\]: ${level} 标题与图片来源`),
      );
    }
  });

  it("rotates existing 10 MiB files across restarts and keeps only the current file and two archives", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const directory = await mkdtemp(join(tmpdir(), "mdcz-rotation-"));
    directories.push(directory);
    const logDirectory = join(directory, "logs");
    await mkdir(logDirectory);
    const limit = 10 * 1024 * 1024;
    const current = join(logDirectory, "mdcz.log");
    await writeFile(current, "oldest\n");
    for (let index = 0; index < 4; index += 1) {
      await truncate(current, limit);
      const service = new RuntimeLogService(2, undefined, logDirectory);
      service.getLogger("rotation").info(`generation-${index}`);
      await service.close();
    }
    expect((await readdir(logDirectory)).sort()).toEqual(["mdcz.log", "mdcz1.log", "mdcz2.log"]);
    expect(await readFile(current, "utf8")).toContain("generation-3");
    expect(await readFile(join(logDirectory, "mdcz1.log"), "utf8")).toContain("generation-2");
    expect(await readFile(join(logDirectory, "mdcz2.log"), "utf8")).toContain("generation-1");
    expect((await stat(join(logDirectory, "mdcz1.log"))).size).toBe(limit);
    expect((await stat(join(logDirectory, "mdcz2.log"))).size).toBe(limit);
  });

  it("rotates a burst of writes without losing the tail or retaining excess archives", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const directory = await mkdtemp(join(tmpdir(), "mdcz-log-burst-"));
    directories.push(directory);
    const service = new RuntimeLogService(2, undefined, directory);
    const payload = "图".repeat(90_000);
    for (let index = 0; index < 160; index += 1) {
      service.getLogger("burst").info(`record-${index} ${payload}`);
    }
    await service.close();
    const files = (await readdir(directory)).sort();
    expect(files).toEqual(["mdcz.log", "mdcz1.log", "mdcz2.log"]);
    const contents = await Promise.all(files.map((file) => readFile(join(directory, file), "utf8")));
    expect(contents.join("")).toContain("record-159 ");
    expect(contents.join("")).not.toContain("record-0 ");
    for (const file of files) {
      expect((await stat(join(directory, file))).size).toBeLessThanOrEqual(10 * 1024 * 1024);
    }
  });
});
