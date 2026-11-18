import { toErrorMessage } from "@mdcz/shared/error";
import { Badge, Button, cn } from "@mdcz/ui";
import { useT } from "@mdcz/views/i18n";
import { keepPreviousData, skipToken, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { api } from "./client";
import { queryKeys } from "./lib/queryKeys";
import { SubtitleBatchRetry } from "./subtitleBatchRetry";

const PAGE_SIZE = 50;

export function SubtitleTasksPage({ selectedId, onSelect }: { selectedId?: string; onSelect: (id: string) => void }) {
  const t = useT();
  const labels = t.pending;
  const queue = labels.subtitleQueue;
  const client = useQueryClient();
  const [page, setPage] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const jobs = useQuery({
    queryKey: [...queryKeys.subtitleJobs, "list", page],
    queryFn: () => api.subtitleUpdates.list({ offset: page * PAGE_SIZE, limit: PAGE_SIZE }),
    placeholderData: keepPreviousData,
    refetchInterval: 2_000,
  });
  const detailId = selectedId?.startsWith("subtitle-update-") ? selectedId : null;
  const detail = useQuery({
    queryKey: [...queryKeys.subtitleJobs, "detail", detailId],
    queryFn: detailId ? () => api.subtitleUpdates.get({ id: detailId }) : skipToken,
    enabled: Boolean(detailId),
    refetchInterval: 2_000,
  });
  const items = jobs.data?.jobs ?? [];
  const selected =
    detailId && detail.data !== null ? (detail.data ?? items.find((item) => item.taskId === detailId)) : items[0];
  const counts = jobs.data?.counts;
  const pages = Math.max(1, Math.ceil((jobs.data?.total ?? 0) / PAGE_SIZE));
  if (jobs.data && !jobs.isPlaceholderData && page >= pages) setPage(pages - 1);
  const clearCompleted = useMutation({
    mutationFn: () => api.subtitleUpdates.clearCompleted(),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: queryKeys.subtitleJobs });
      setPage(0);
      toast.success(queue.cleared);
    },
    onError: (error) => toast.error(toErrorMessage(error)),
  });
  return (
    <main className="flex h-full min-h-0 flex-col bg-surface-canvas">
      <header className="space-y-2 border-b p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-lg font-bold">{labels.subtitleTasks}</h1>
          <div className="flex flex-wrap gap-2">
            <SubtitleBatchRetry
              disabled={!counts?.failed}
              onQueued={() => {
                setPage(0);
                setError(null);
                onSelect("subtitle-queue");
              }}
            />
            <Button
              variant="outline"
              size="sm"
              disabled={!counts?.completed || clearCompleted.isPending}
              onClick={() => clearCompleted.mutate()}
            >
              {clearCompleted.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
              {queue.clearCompleted}
            </Button>
          </div>
        </div>
        {counts ? <p>{queue.counts(counts.queued, counts.running, counts.completed, counts.failed)}</p> : null}
        <p className="text-sm text-muted-foreground">{jobs.data?.waitingForManual ? queue.waiting : queue.priority}</p>
        {jobs.error ? (
          <p role="alert" className="text-destructive">
            {toErrorMessage(jobs.error)}
          </p>
        ) : null}
      </header>
      <div className="grid min-h-0 flex-1 grid-cols-1 overflow-auto lg:grid-cols-[22rem_minmax(0,1fr)]">
        <section className="flex min-h-0 flex-col border-r">
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            {jobs.isLoading ? <p role="status">{t.common.loading}</p> : null}
            {!jobs.isLoading && !jobs.error && !items.length ? <p>{labels.taskEmpty}</p> : null}
            <ul className="space-y-2">
              {items.map((job) => (
                <li key={job.taskId}>
                  <button
                    type="button"
                    aria-pressed={selected?.taskId === job.taskId}
                    onClick={() => {
                      setError(null);
                      onSelect(job.taskId);
                    }}
                    className={cn(
                      "w-full rounded-lg border p-3 text-left",
                      selected?.taskId === job.taskId && "border-foreground/40 bg-surface-raised",
                    )}
                  >
                    <div className="break-all font-semibold">
                      {job.mediaPath.replaceAll("\\", "/").split("/").at(-1)}
                    </div>
                    <div className="mt-2 flex justify-between gap-2 text-xs text-muted-foreground">
                      <span>{queue.stages[job.stage]}</span>
                      <Badge>{labels.taskStatuses[job.status]}</Badge>
                    </div>
                    {job.notificationCount > 1 ? (
                      <p className="mt-1 text-xs text-muted-foreground">{queue.merged(job.notificationCount)}</p>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          </div>
          <div className="space-y-2 border-t p-3 text-sm">
            <p>{queue.page(page + 1, pages, jobs.data?.total ?? 0)}</p>
            <div className="flex gap-2">
              <Button
                variant="outline"
                disabled={page === 0 || jobs.isPlaceholderData}
                onClick={() => {
                  setPage(page - 1);
                  onSelect("subtitle-queue");
                }}
              >
                {queue.previous}
              </Button>
              <Button
                variant="outline"
                disabled={page + 1 >= pages || jobs.isPlaceholderData}
                onClick={() => {
                  setPage(page + 1);
                  onSelect("subtitle-queue");
                }}
              >
                {queue.next}
              </Button>
            </div>
          </div>
        </section>
        <section className="space-y-5 overflow-y-auto p-6">
          {detail.isLoading && detailId && !selected ? <p role="status">{t.common.loading}</p> : null}
          {detail.error ? (
            <p role="alert" className="text-destructive">
              {toErrorMessage(detail.error)}
            </p>
          ) : null}
          {selected ? (
            <>
              <h2 className="break-all text-xl font-bold">
                {selected.mediaPath.replaceAll("\\", "/").split("/").at(-1)}
              </h2>
              <p className="break-all font-mono text-xs text-muted-foreground">{selected.mediaPath}</p>
              <p>
                {labels.taskStatuses[selected.status]} · {queue.stages[selected.stage]}
              </p>
              <p role="status" className="flex items-center gap-2">
                {selected.status === "running" ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                {selected.progress || queue.stages[selected.stage]}
              </p>
              <p className="text-sm text-muted-foreground">
                {labels.attempts}：{selected.attempts} · {labels.updatedAt}：
                {new Date(selected.updatedAt).toLocaleString()}
              </p>
              {selected.notificationCount > 1 ? <p>{queue.merged(selected.notificationCount)}</p> : null}
              {selected.result ? (
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
                  <dt>{queue.metadata}</dt>
                  <dd>{selected.result.metadataUpdated ? queue.yes : queue.no}</dd>
                  <dt>{queue.badge}</dt>
                  <dd>{queue.badgeStatuses[selected.result.badgeStatus]}</dd>
                  <dt>{queue.notified}</dt>
                  <dd>{selected.result.mediaServerNotified ? queue.yes : queue.no}</dd>
                </dl>
              ) : null}
              {selected.warnings.length ? (
                <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                  {selected.warnings.map((warning, index) => (
                    <li key={`${index}-${warning}`}>{warning}</li>
                  ))}
                </ul>
              ) : null}
              {selected.error ? (
                <p className="whitespace-pre-wrap break-words text-destructive">{selected.error}</p>
              ) : null}
              {error ? (
                <p role="alert" className="text-destructive">
                  {error}
                </p>
              ) : null}
              {selected.status === "failed" ? (
                <Button
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    setError(null);
                    try {
                      const result = await api.subtitleUpdates.retry({ id: selected.taskId });
                      await client.invalidateQueries({ queryKey: queryKeys.subtitleJobs });
                      onSelect(result.taskId);
                    } catch (error) {
                      setError(toErrorMessage(error));
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  {busy ? labels.submitting : labels.retryTask}
                </Button>
              ) : null}
            </>
          ) : null}
        </section>
      </div>
    </main>
  );
}
