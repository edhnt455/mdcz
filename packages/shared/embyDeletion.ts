import { z } from "zod";
import { type EmbyDeletionStep, type MoviePilotConnection, moviePilotFileSchema } from "./moviePilot";

export const embyDeletionSettingsSchema = z
  .object({
    mode: z.enum(["off", "observe", "delete"]),
    serverId: z.string().trim().max(128),
    libraryIds: z.array(z.string().min(1)).max(100),
  })
  .refine(
    (settings) => settings.mode === "off" || (Boolean(settings.serverId) && settings.libraryIds.length > 0),
    "Select an Emby server and at least one library",
  );

export const embyDeletionNotificationSchema = z.object({
  Event: z.string().max(128),
  Date: z.iso.datetime({ offset: true }).optional(),
  Description: z
    .string()
    .max(128 * 1024)
    .optional(),
  Server: z.object({ Id: z.string().min(1).max(128) }),
  Item: z
    .object({
      Id: z.string().min(1).max(128),
      Type: z.string().optional(),
      IsFolder: z.boolean().optional(),
      Path: z.string().min(1).max(4096).optional(),
    })
    .optional(),
});

export const embyDeletionLibraryBindingSchema = z.object({
  id: z.string().min(1),
  outputPath: z.string().min(1),
  realPath: z.string().min(1),
  marker: z.string().min(1),
  source: z
    .object({
      path: z.string().min(1),
      realPath: z.string().min(1),
      marker: z.string().min(1),
    })
    .optional(),
});

export const storedMoviePilotSchema = z.object({
  id: z.string().min(1),
  baseUrl: z.string().min(1),
  token: z.string().min(1),
  storage: z.literal("u115"),
  rootPath: z.string().min(1),
  root: moviePilotFileSchema,
});

export const embyDeletionConfigSchema = z.object({
  mode: z.enum(["off", "observe", "delete"]).default("off"),
  serverId: z.string().max(128).default(""),
  libraries: z.array(embyDeletionLibraryBindingSchema).max(100).default([]),
  secretHash: z.string().default(""),
  moviePilot: storedMoviePilotSchema.nullable().default(null),
});

export type EmbyDeletionSettings = z.infer<typeof embyDeletionSettingsSchema>;
export type EmbyDeletionConfig = z.infer<typeof embyDeletionConfigSchema>;
export type EmbyDeletionNotification = z.infer<typeof embyDeletionNotificationSchema>;
export type EmbyDeletionState = "pending" | "completed" | "ignored" | "needs_review";

export interface EmbyDeletionStatus {
  moviePilot: MoviePilotConnection | null;
  associations: { verified: number; blocked: number };
  settings: { mode: EmbyDeletionSettings["mode"]; serverId: string; libraryIds: string[] };
  configured: boolean;
  libraries: { id: string; name: string; outputPath: string }[];
  counts: Record<"pending" | "needs_review", number>;
  recent: {
    id: string;
    serverId: string;
    path: string | null;
    status: EmbyDeletionState;
    result: string | null;
    receivedAt: number;
    completedAt: number | null;
    attempts: number;
    step: EmbyDeletionStep;
    preview: { sourcePaths: string[]; cloudPath: string; fileId: string } | null;
  }[];
}
