import type { Writable } from "node:stream";
import { finished } from "node:stream/promises";
import type { LogEntryDto, LogListInput, LogListResponse } from "@mdcz/shared/serverDtos";
import type { TaskEventBus } from "../taskEvents";
import { createRotatingLogStream } from "./rotatingLogStream";

type RuntimeLogLevel = NonNullable<LogEntryDto["level"]>;

const toTaskLevel = (type: string): RuntimeLogLevel => {
  if (type === "failed" || type === "item-failed") return "ERR";
  if (type === "paused" || type === "stopping") return "WARN";
  if (type === "queued") return "REQ";
  if (type === "completed" || type === "item-success") return "OK";
  return "INFO";
};

const toRuntimeLevel = (level: "debug" | "info" | "warn" | "error"): RuntimeLogLevel => {
  if (level === "error") return "ERR";
  if (level === "warn") return "WARN";
  return "INFO";
};

export const decorateTaskLog = (event: Omit<LogEntryDto, "source" | "level">): LogEntryDto => ({
  ...event,
  level: toTaskLevel(event.type),
  source: "task",
});

export class RuntimeLogService {
  private readonly entries: LogEntryDto[] = [];
  private taskLogsClearedAt: string | null = null;
  private readonly fileLog?: Writable;

  constructor(
    private readonly maxEntries = 1000,
    private readonly taskEvents?: TaskEventBus,
    logDirectory?: string,
  ) {
    if (logDirectory) this.fileLog = createRotatingLogStream(logDirectory);
  }

  getLogger(source: string) {
    const write = (level: "debug" | "info" | "warn" | "error", message: string): void => {
      this.append(source, level, message);
    };

    return {
      debug: (message: string) => write("debug", message),
      error: (message: string) => write("error", message),
      info: (message: string) => write("info", message),
      warn: (message: string) => write("warn", message),
    };
  }

  append(sourceName: string, level: "debug" | "info" | "warn" | "error", message: string): LogEntryDto {
    const createdAt = new Date().toISOString();
    const entry: LogEntryDto = {
      id: `runtime-${createdAt}-${this.entries.length}`,
      taskId: sourceName,
      type: level,
      message,
      createdAt,
      level: toRuntimeLevel(level),
      source: "runtime",
    };
    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) {
      this.entries.splice(0, this.entries.length - this.maxEntries);
    }
    this.echoToConsole(level, message);
    this.fileLog?.write(`${createdAt} ${level.toUpperCase()} [${sourceName}]: ${message}\n`);
    this.taskEvents?.log(entry);
    return entry;
  }

  private echoToConsole(level: "debug" | "info" | "warn" | "error", message: string): void {
    if (level === "error") {
      console.error(message);
    } else if (level === "warn") {
      console.warn(message);
    } else if (level === "debug") {
      console.debug(message);
    } else {
      console.info(message);
    }
  }

  list(input?: LogListInput): LogListResponse {
    const kind = input?.kind ?? "all";
    if (kind === "task") return { logs: [] };
    return { logs: [...this.entries] };
  }

  clear(): number {
    const count = this.entries.length;
    this.entries.length = 0;
    return count;
  }

  clearTaskLogs(): string {
    this.taskLogsClearedAt = new Date().toISOString();
    return this.taskLogsClearedAt;
  }

  getTaskLogsClearedAt(): string | null {
    return this.taskLogsClearedAt;
  }

  async close(): Promise<void> {
    if (!this.fileLog) return;
    const drained = finished(this.fileLog);
    this.fileLog.end();
    await drained;
  }
}
