import type { Configuration } from "@mdcz/shared/config";
import type { LogEntryDto, TaskNotificationDto } from "@mdcz/shared/serverDtos";

export interface WorkerSnapshot {
  configuration: Configuration;
  queries: Record<string, unknown>;
  logs: LogEntryDto[];
  taskLogsClearedAt: string | null;
  processingDeletions: string[];
  processingDuplicates: string[];
  updatedAt: number;
}

export type ProcessMessage =
  | { kind: "boot" }
  | { kind: "ready" }
  | { kind: "snapshot"; snapshot: WorkerSnapshot }
  | { kind: "event"; event: TaskNotificationDto }
  | { kind: "touch-session"; token: string }
  | { kind: "inbox-changed" };

export const sendMessage = (message: ProcessMessage): void => {
  if (!process.connected) return;
  process.send?.(message, (error) => {
    if (error && process.connected) console.error("进程通信失败", error.message);
  });
};
