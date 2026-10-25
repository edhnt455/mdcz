import { z } from "zod";

export const moviePilotSettingsSchema = z.object({
  baseUrl: z.url().refine((value) => {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
  }, "Use an HTTP(S) MoviePilot address without credentials or query parameters"),
  token: z.string().trim().min(1).max(4096).optional(),
  storage: z.literal("u115"),
  rootPath: z
    .string()
    .min(2)
    .max(4096)
    .refine(
      (value) =>
        value.startsWith("/") && !value.includes("\\") && !value.includes("\0") && !value.split("/").includes(".."),
      "Use an absolute cloud directory below the storage root",
    ),
});

export const moviePilotFileSchema = z.object({
  storage: z.string().min(1),
  type: z.enum(["file", "dir"]),
  path: z.string().min(1),
  name: z.string().nullable().optional(),
  fileid: z.string().min(1),
  parent_fileid: z.string().nullable().optional(),
  pickcode: z.string().nullable().optional(),
  size: z.number().int().nonnegative().nullable().optional(),
});

export const moviePilotEnvelopeSchema = z.object({ success: z.boolean(), message: z.string(), data: z.unknown() });
export const moviePilotOptionsSchema = z.array(z.object({ type: z.string() }));
export const moviePilotFilesSchema = z.array(moviePilotFileSchema);
export const deletionRetrySchema = z.object({ id: z.uuid() });

export type MoviePilotSettings = z.infer<typeof moviePilotSettingsSchema>;
export type MoviePilotFile = z.infer<typeof moviePilotFileSchema>;
export interface MoviePilotConnection extends Omit<MoviePilotSettings, "token"> {
  id: string;
  root: MoviePilotFile;
}

export interface StrmSourceSnapshot {
  sourcePath: string;
  sha256: string;
  resourceIdentity?: string;
}

export const moviePilotResourceIdentity = (target: string): string | undefined => {
  if (!URL.canParse(target)) return undefined;
  const url = new URL(target);
  const codes = url.searchParams.getAll("pickcode");
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !url.pathname.endsWith("/api/v1/plugin/P115StrmHelper/redirect_url") ||
    codes.length !== 1 ||
    !codes[0] ||
    url.username ||
    url.password
  )
    return undefined;
  return `${url.origin}${url.pathname}?pickcode=${encodeURIComponent(codes[0])}`;
};

export interface StrmCloudBinding {
  connectionId: string;
  fileUpdatedAt: number;
  source: StrmSourceSnapshot;
  target: MoviePilotFile;
  ancestors: MoviePilotFile[];
}

export const embyDeletionSteps = [
  "validating",
  "deleting_cloud",
  "verifying_cloud",
  "cleaning_source",
  "cleaning_records",
  "completed",
] as const;
export type EmbyDeletionStep = (typeof embyDeletionSteps)[number];
