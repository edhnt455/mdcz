import { z } from "zod";

export const scrapeConflictSetupErrors = {
  moviePilotRequired: "scrape_conflict_moviepilot_required",
  copyLibraryRequired: "scrape_conflict_copy_library_required",
  libraryBindingRequired: "scrape_conflict_library_binding_required",
  libraryPathsChanged: "scrape_conflict_library_paths_changed",
} as const;

export const scrapeConflictReferenceErrors = {
  shared: "scrape_conflict_shared_reference",
  unverified: "scrape_conflict_unverified_reference",
} as const;

export const scrapeTargetConflictSchema = z.object({
  sourcePath: z.string().min(1),
  targetPath: z.string().min(1),
});
export type ScrapeTargetConflict = z.infer<typeof scrapeTargetConflictSchema>;

export const scrapeConflictInputSchema = z.object({ taskId: z.string().min(1), itemId: z.string().min(1) });
export type ScrapeConflictInput = z.infer<typeof scrapeConflictInputSchema>;
export const scrapeConflictResolveSchema = scrapeConflictInputSchema.extend({
  token: z.string().min(1),
  keep: z.enum(["existing", "incoming"]),
});
export type ScrapeConflictResolveInput = z.infer<typeof scrapeConflictResolveSchema>;

export interface ScrapeConflictVersion {
  name: string;
  size: number;
  cloudPath: string;
  normalPath: string;
  linkPath: string | null;
}
export interface ScrapeConflictPreview {
  token: string;
  existing: ScrapeConflictVersion;
  incoming: ScrapeConflictVersion;
  sameResource: boolean;
  keep: "existing" | "incoming" | null;
  step: string | null;
}
export interface ScrapeConflictResolution {
  runId: string | null;
}
