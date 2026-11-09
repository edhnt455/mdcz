import { formatDuration } from "@mdcz/shared/format";
import type { ActivityEntryDto } from "@mdcz/shared/serverDtos";
import { Button, cn } from "@mdcz/ui";
import {
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleStop,
  LoaderCircle,
  type LucideIcon,
  Trash2,
} from "lucide-react";
import { useT } from "../i18n";

const MAX_VISIBLE_ERRORS = 10;

const ACTIVE_STATUSES: ReadonlySet<ActivityEntryDto["status"]> = new Set([
  "queued",
  "discovering",
  "running",
  "paused",
  "stopping",
]);

export const hasActiveActivity = (entries: readonly ActivityEntryDto[]): boolean =>
  entries.some((entry) => ACTIVE_STATUSES.has(entry.status));

const statusIcon = (status: ActivityEntryDto["status"]): { icon: LucideIcon; className: string } => {
  if (status === "completed") return { icon: CircleCheck, className: "text-emerald-500" };
  if (status === "failed") return { icon: CircleAlert, className: "text-destructive" };
  if (status === "stopped" || status === "interrupted") return { icon: CircleStop, className: "text-amber-500" };
  if (status === "queued" || status === "paused") return { icon: CircleDashed, className: "text-muted-foreground" };
  return { icon: LoaderCircle, className: "animate-spin text-primary" };
};

export interface ActivityTimelineCardProps {
  entries: readonly ActivityEntryDto[];
  /** The maintenance row is the server's current session, so it opens the workbench that shows it. */
  onOpenMaintenance?: () => void;
  onClearCompleted?: () => void;
  isClearing?: boolean;
}

/** One list for scans, scrape runs and maintenance, so what the server did is readable in one place. */
export function ActivityTimelineCard({
  entries,
  onOpenMaintenance,
  onClearCompleted,
  isClearing = false,
}: ActivityTimelineCardProps) {
  const t = useT();
  if (entries.length === 0) return null;

  return (
    <section className="col-span-12">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-xl font-bold tracking-tight">{t.overview.activity.title}</h2>
        {onClearCompleted ? (
          <Button
            variant="outline"
            size="sm"
            onClick={onClearCompleted}
            disabled={isClearing || entries.every((entry) => ACTIVE_STATUSES.has(entry.status))}
          >
            {isClearing ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
            {t.overview.activity.clearCompleted}
          </Button>
        ) : null}
      </div>
      <ol className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {entries.map((entry) => {
          const { icon: Icon, className } = statusIcon(entry.status);
          const errors = entry.error?.split(/\n\s*\n/).filter((error) => error.trim()) ?? [];
          const duration = entry.durationMs === null ? null : formatDuration(entry.durationMs);
          const details = [
            entry.counts
              ? t.overview.activity.counts(entry.counts.success, entry.counts.failed, entry.counts.skipped)
              : "",
            duration ?? "",
          ].filter(Boolean);
          const rowClassName =
            "flex h-full w-full items-start gap-3 rounded-quiet-lg border border-border/40 bg-surface-low/60 px-4 py-3 text-left";
          const row = (
            <>
              <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", className)} />
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-baseline justify-between gap-2">
                  <div className="flex min-w-0 items-baseline gap-1.5">
                    <span className="shrink-0 text-sm font-semibold">{t.overview.activity.kinds[entry.kind]}</span>
                    <span className="truncate text-sm text-muted-foreground" title={entry.target}>
                      {entry.target}
                    </span>
                  </div>
                  <time className="shrink-0 font-numeric text-[11px] text-muted-foreground" dateTime={entry.updatedAt}>
                    {new Date(entry.updatedAt).toLocaleString()}
                  </time>
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {[t.overview.activity.statuses[entry.status], ...details].join(" · ")}
                </div>
                {errors.length > 0 ? (
                  <div className="mt-1 text-xs text-destructive">
                    <div className="whitespace-pre-wrap break-words">
                      {errors.slice(0, MAX_VISIBLE_ERRORS).join("\n\n")}
                    </div>
                    {errors.length > MAX_VISIBLE_ERRORS ? (
                      <div className="mt-1 text-muted-foreground">
                        {t.overview.activity.hiddenErrors(errors.length - MAX_VISIBLE_ERRORS)}
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </>
          );
          return (
            <li key={`${entry.kind}:${entry.id}`}>
              {entry.kind === "maintenance" && onOpenMaintenance ? (
                <button
                  type="button"
                  className={cn(rowClassName, "transition-colors hover:border-border/80 hover:bg-surface-low")}
                  onClick={onOpenMaintenance}
                >
                  {row}
                </button>
              ) : (
                <div className={rowClassName}>{row}</div>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
