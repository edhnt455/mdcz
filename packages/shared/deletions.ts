import { z } from "zod";
import type { EmbyDeletionStep } from "./moviePilot";

export const deletionJobInputSchema = z.object({ id: z.string().min(1) });
export type DeletionJobInput = z.infer<typeof deletionJobInputSchema>;
export type DeletionJobStep = EmbyDeletionStep | "retrying";
export type DeletionJobStatus =
  | "pending"
  | "running"
  | "retrying"
  | "paused"
  | "needs_review"
  | "completed"
  | "ignored";

export interface DeletionJob {
  id: string;
  source: "emby" | "duplicate";
  status: DeletionJobStatus;
  step: DeletionJobStep;
  name: string;
  libraryName: string;
  linkPath: string | null;
  sourcePaths: string[];
  cloudPath: string | null;
  cloudFileId: string | null;
  cloudSize: number | null;
  cloudDeleted: boolean;
  cloudPlanned: boolean;
  sharedResource: boolean;
  error: string | null;
  result: string | null;
  attempts: number;
  nextAttemptAt: number | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
  canRetry: boolean;
  retryRunId: string | null;
  retryPlanned: boolean;
}
export interface DeletionJobList {
  jobs: DeletionJob[];
}
export interface DeletionRetryResponse {
  runId: string | null;
}

export const isOpenDeletionJob = (job: DeletionJob): boolean => job.status !== "completed" && job.status !== "ignored";
