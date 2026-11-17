import { z } from "./zod";

export const subtitleJobListInputSchema = z.object({
  offset: z.number().int().nonnegative(),
  limit: z.number().int().min(1).max(100),
});
export type SubtitleJobListInput = z.infer<typeof subtitleJobListInputSchema>;
export type SubtitleJobStage =
  | "queued"
  | "scanning"
  | "downloading"
  | "rendering"
  | "publishing"
  | "notifying"
  | "completed";
export type SubtitleJob = {
  taskId: string;
  mediaPath: string;
  notificationCount: number;
  status: "queued" | "running" | "completed" | "failed";
  stage: SubtitleJobStage;
  progress: string;
  attempts: number;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
  result: {
    metadataUpdated: boolean;
    badgeStatus: "updated" | "unchanged" | "skipped";
    mediaServerNotified: boolean;
  } | null;
  warnings: string[];
  error: string | null;
};
export type SubtitleJobList = {
  jobs: SubtitleJob[];
  counts: Record<SubtitleJob["status"], number>;
  total: number;
  waitingForManual: boolean;
};
