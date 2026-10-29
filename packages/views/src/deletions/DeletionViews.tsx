import { type DeletionJob, type DeletionJobStep, isOpenDeletionJob } from "@mdcz/shared/deletions";
import { formatBytes } from "@mdcz/shared/format";
import { strmReferenceErrors } from "@mdcz/shared/moviePilot";
import { Badge, Button, cn } from "@mdcz/ui";
import { AlertCircle, CheckCircle2, Circle, Clock3, Loader2, Trash2 } from "lucide-react";
import { useState } from "react";
import { type Messages, useT } from "../i18n";

const date = (value: number) => new Date(value).toLocaleString();
const resultMessage = (value: string, t: Messages): string => {
  const reference = (Object.keys(strmReferenceErrors) as (keyof typeof strmReferenceErrors)[]).find((key) =>
    value.startsWith(`${strmReferenceErrors[key]}\n`),
  );
  return reference
    ? t.scrape.conflict.referenceErrors[reference](value.slice(strmReferenceErrors[reference].length + 1))
    : (t.settings.embyDeletion.results[value as keyof typeof t.settings.embyDeletion.results] ?? value);
};

export function DeletionQueueView({
  jobs,
  loading,
  error,
  onOpen,
}: {
  jobs: DeletionJob[];
  loading?: boolean;
  error?: string | null;
  onOpen: (id: string) => void;
}) {
  const t = useT();
  const open = jobs.filter(isOpenDeletionJob);
  return (
    <section className="h-full overflow-auto bg-surface-canvas p-4">
      <h1 className="text-lg font-bold">
        {t.deletions.pendingTitle} · {open.length}
      </h1>
      <p className="mt-1 text-sm text-muted-foreground">{t.deletions.description}</p>
      {error ? (
        <p role="alert" className="mt-4 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {loading ? (
        <p role="status" className="mt-6 text-sm">
          {t.common.loading}
        </p>
      ) : null}
      {!loading && !open.length && !error ? (
        <p className="py-16 text-center text-sm text-muted-foreground">{t.deletions.emptyPending}</p>
      ) : null}
      <ul className="mt-4 grid gap-3 xl:grid-cols-2">
        {open.map((job) => (
          <li key={job.id} className="space-y-3 rounded-lg border p-4">
            <div className="flex items-start justify-between gap-3">
              <h2 className="break-all font-semibold">{job.name}</h2>
              <Badge>{t.deletions.status[job.status]}</Badge>
            </div>
            <p className="text-xs text-muted-foreground">
              {job.libraryName} · {t.deletions.steps[job.step]}
            </p>
            {job.error ? (
              <p className="whitespace-pre-wrap break-all text-sm text-destructive">{resultMessage(job.error, t)}</p>
            ) : null}
            <Button variant="outline" size="sm" onClick={() => onOpen(job.id)}>
              {t.deletions.openWorkbench}
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function DeletionWorkbenchView({
  jobs,
  selected,
  loading,
  error,
  retrying,
  actionError,
  onSelect,
  onRetry,
  onRefresh,
  onOpenScrape,
}: {
  jobs: DeletionJob[];
  selected: DeletionJob | null;
  loading?: boolean;
  error?: string | null;
  retrying?: boolean;
  actionError?: string | null;
  onSelect: (id: string) => void;
  onRetry: (id: string) => void;
  onRefresh: () => void;
  onOpenScrape: (id: string) => void;
}) {
  const t = useT();
  const text = t.deletions;
  const [filter, setFilter] = useState<"all" | "unfinished" | "completed">("all");
  const filtered = jobs.filter(
    (job) => filter === "all" || (filter === "unfinished" ? isOpenDeletionJob(job) : !isOpenDeletionJob(job)),
  );
  const steps: DeletionJobStep[] = [
    "validating",
    ...(selected?.cloudPlanned ? (["deleting_cloud", "verifying_cloud", "cleaning_source"] as const) : []),
    ...(selected?.source === "emby" ? ["cleaning_records" as const] : []),
    ...(selected?.retryPlanned ? ["retrying" as const] : []),
    "completed",
  ];
  const current = selected ? steps.indexOf(selected.step) : -1;
  return (
    <main className="flex h-full min-h-0 flex-col bg-surface-canvas text-foreground">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b p-4">
        <div>
          <h1 className="text-lg font-bold">{text.title}</h1>
          <p className="text-xs text-muted-foreground">{text.description}</p>
        </div>
        <Button variant="outline" size="sm" onClick={onRefresh}>
          {text.refresh}
        </Button>
      </header>
      {error ? (
        <p role="alert" className="p-4 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="grid min-h-0 flex-1 grid-cols-1 overflow-auto lg:grid-cols-[21rem_minmax(0,1fr)] lg:overflow-hidden">
        <section aria-label={text.title} className="min-h-0 overflow-auto border-b p-3 lg:border-r lg:border-b-0">
          <div className="mb-3 flex gap-1">
            {(["all", "unfinished", "completed"] as const).map((value) => (
              <Button
                size="sm"
                variant={filter === value ? "secondary" : "ghost"}
                key={value}
                onClick={() => setFilter(value)}
              >
                {text[value]}
              </Button>
            ))}
          </div>
          {loading ? (
            <p role="status" className="p-4 text-sm">
              {t.common.loading}
            </p>
          ) : null}
          {!loading && !filtered.length ? <p className="p-4 text-sm text-muted-foreground">{text.empty}</p> : null}
          <ul className="space-y-2">
            {filtered.map((job) => (
              <li key={job.id}>
                <button
                  type="button"
                  aria-pressed={selected?.id === job.id}
                  onClick={() => onSelect(job.id)}
                  className={cn(
                    "w-full rounded-lg border p-3 text-left",
                    selected?.id === job.id && "border-primary bg-primary/5",
                  )}
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="break-all text-sm font-semibold">{job.name}</span>
                    <Badge variant="outline">{text.status[job.status]}</Badge>
                  </span>
                  <span className="mt-2 block text-xs text-muted-foreground">
                    {text.source[job.source]} · {text.steps[job.step]}
                  </span>
                  {job.error ? <span className="mt-1 block text-xs text-destructive">{text.failure}</span> : null}
                </button>
              </li>
            ))}
          </ul>
        </section>
        <section className="min-h-0 overflow-auto p-4 md:p-6">
          {!selected ? (
            <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
              <Trash2 className="h-5 w-5" />
              {text.select}
            </div>
          ) : (
            <div className="mx-auto max-w-4xl space-y-6">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="break-all text-xl font-bold">{selected.name}</h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {selected.libraryName || text.unknownLibrary} · {text.source[selected.source]}
                  </p>
                </div>
                <Badge>{text.status[selected.status]}</Badge>
              </div>
              {selected.status === "paused" ? (
                <p className="rounded-lg bg-muted p-3 text-sm">
                  {text.paused}{" "}
                  <a className="underline" href="/settings?section=mediaServer">
                    {text.settings}
                  </a>
                </p>
              ) : null}
              {selected.sharedResource ? (
                <p role="status" className="rounded-lg bg-muted p-3 text-sm">
                  {selected.source === "duplicate" ? text.sharedDuplicate : text.shared}
                </p>
              ) : null}
              {selected.cloudDeleted ? <p className="text-sm text-muted-foreground">{text.cloudAcknowledged}</p> : null}
              {selected.error || actionError ? (
                <div
                  role="alert"
                  className="whitespace-pre-wrap break-all rounded-lg bg-destructive/5 p-4 text-sm text-destructive"
                >
                  {resultMessage(actionError || selected.error || "", t)}
                </div>
              ) : null}
              <ol aria-label={text.openWorkbench} className="space-y-3">
                {steps.map((step, index) => {
                  const skipped =
                    selected.sharedResource &&
                    (["deleting_cloud", "verifying_cloud"].includes(step) ||
                      (selected.source === "emby" && step === "cleaning_source"));
                  const done = selected.status === "completed" || index < current;
                  const active = index === current && selected.status !== "completed" && selected.status !== "ignored";
                  const Icon =
                    skipped || done
                      ? CheckCircle2
                      : active && selected.error
                        ? AlertCircle
                        : active && selected.status === "running"
                          ? Loader2
                          : active
                            ? Clock3
                            : Circle;
                  return (
                    <li
                      key={step}
                      aria-current={active ? "step" : undefined}
                      className={cn(
                        "flex items-center gap-3 rounded-lg border p-3 text-sm",
                        active && "border-primary",
                        active && selected.error && "border-destructive",
                      )}
                    >
                      <Icon
                        className={cn("h-4 w-4 shrink-0", active && selected.status === "running" && "animate-spin")}
                      />
                      <span className="flex-1">{text.steps[step]}</span>
                      <span className="text-xs text-muted-foreground">
                        {skipped
                          ? text.skippedStep
                          : done
                            ? text.finishedStep
                            : active
                              ? text.currentStep
                              : text.pendingStep}
                      </span>
                    </li>
                  );
                })}
              </ol>
              {selected.canRetry ? (
                <Button disabled={retrying} onClick={() => onRetry(selected.id)}>
                  {retrying ? t.common.loading : selected.source === "duplicate" ? text.continue : text.retry}
                </Button>
              ) : null}
              {selected.retryRunId ? (
                <div className="space-y-2">
                  <p className="text-sm text-muted-foreground">{text.retrySubmitted}</p>
                  <Button variant="outline" onClick={() => onOpenScrape(selected.retryRunId ?? "")}>
                    {text.openScrape}
                  </Button>
                </div>
              ) : null}
              <section className="space-y-3 rounded-lg border p-4">
                <h3 className="font-semibold">{text.paths}</h3>
                <dl className="space-y-3 break-all text-sm">
                  {selected.linkPath ? (
                    <div>
                      <dt className="text-muted-foreground">{selected.cloudPlanned ? text.link : text.output}</dt>
                      <dd>{selected.linkPath}</dd>
                    </div>
                  ) : null}
                  {selected.sourcePaths.map((source) => (
                    <div key={source}>
                      <dt className="text-muted-foreground">{text.normal}</dt>
                      <dd>{source}</dd>
                    </div>
                  ))}
                  {selected.cloudPath ? (
                    <div>
                      <dt className="text-muted-foreground">{text.cloud}</dt>
                      <dd>
                        {selected.cloudPath}
                        {selected.cloudSize !== null ? ` · ${formatBytes(selected.cloudSize)}` : ""}
                      </dd>
                      <dd className="mt-1 text-xs text-muted-foreground">
                        {text.fileId} · {selected.cloudFileId}
                      </dd>
                    </div>
                  ) : null}
                </dl>
              </section>
              <dl className="flex flex-wrap gap-6 text-xs text-muted-foreground">
                <div>
                  <dt>{text.created}</dt>
                  <dd>{date(selected.createdAt)}</dd>
                </div>
                <div>
                  <dt>{text.attempts}</dt>
                  <dd>{selected.attempts}</dd>
                </div>
                {selected.nextAttemptAt && selected.status === "retrying" ? (
                  <div>
                    <dt>{text.nextAttempt}</dt>
                    <dd>{date(selected.nextAttemptAt)}</dd>
                  </div>
                ) : null}
              </dl>
              {selected.result && !selected.error ? (
                <p className="whitespace-pre-wrap break-all text-sm text-muted-foreground">
                  {resultMessage(selected.result, t)}
                </p>
              ) : null}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
