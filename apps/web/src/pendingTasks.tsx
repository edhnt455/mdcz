import { toErrorMessage } from "@mdcz/shared/error";
import { Badge, Button, cn } from "@mdcz/ui";
import { useT } from "@mdcz/views/i18n";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useState } from "react";
import { api } from "./client";
import { queryKeys } from "./lib/queryKeys";

export function PendingTasksPage({ selectedId, onSelect }: { selectedId?: string; onSelect: (id: string) => void }) {
  const t = useT();
  const labels = t.pending;
  const client = useQueryClient();
  const jobs = useQuery({
    queryKey: queryKeys.pending.jobs,
    queryFn: () => api.pending.jobs(),
    refetchInterval: 1_000,
  });
  const items = jobs.data?.jobs ?? [];
  const selected = items.find((job) => job.id === selectedId) ?? items[0];
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <main className="grid h-full min-h-0 grid-cols-1 overflow-auto bg-surface-canvas lg:grid-cols-[22rem_minmax(0,1fr)]">
      <section className="overflow-y-auto border-r p-4">
        <h1 className="mb-4 text-lg font-bold">{labels.tasks}</h1>
        {jobs.isLoading ? <p role="status">{t.common.loading}</p> : null}
        {jobs.error ? (
          <p role="alert" className="text-destructive">
            {toErrorMessage(jobs.error)}
          </p>
        ) : null}
        {!jobs.isLoading && !jobs.error && !items.length ? <p>{labels.taskEmpty}</p> : null}
        <ul className="space-y-2">
          {items.map((job) => (
            <li key={job.id}>
              <button
                type="button"
                aria-pressed={selected?.id === job.id}
                onClick={() => {
                  setError(null);
                  onSelect(job.id);
                }}
                className={cn(
                  "w-full rounded-lg border p-3 text-left",
                  selected?.id === job.id && "border-foreground/40 bg-surface-raised",
                )}
              >
                <div className="break-all font-semibold">{job.item.fileName}</div>
                <div className="mt-2 flex justify-between gap-2 text-xs text-muted-foreground">
                  <span>{labels.actionNames[job.action]}</span>
                  <Badge>{labels.taskStatuses[job.status]}</Badge>
                </div>
              </button>
            </li>
          ))}
        </ul>
      </section>
      {selected ? (
        <section className="space-y-5 overflow-y-auto p-6">
          <h2 className="break-all text-xl font-bold">{selected.item.fileName}</h2>
          <p className="break-all font-mono text-xs text-muted-foreground">{selected.item.path}</p>
          <p>
            {labels.actionNames[selected.action]} · {labels.taskStatuses[selected.status]}
          </p>
          <p role="status" className="flex items-center gap-2">
            {selected.status === "running" ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {selected.progress}
          </p>
          <p className="text-sm text-muted-foreground">
            {labels.attempts}：{selected.attempts} · {labels.updatedAt}：{new Date(selected.updatedAt).toLocaleString()}
          </p>
          {selected.error ? <p className="whitespace-pre-wrap break-words text-destructive">{selected.error}</p> : null}
          {selected.nextAttemptAt ? (
            <p>
              {new Date(selected.nextAttemptAt).toLocaleString()} · {labels.taskStatuses.retrying}
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          ) : null}
          {selected.canRetry ? (
            <Button
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  const result = await api.pending.retryJob({ id: selected.id });
                  await client.invalidateQueries({ queryKey: queryKeys.pending.all });
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
        </section>
      ) : null}
    </main>
  );
}
