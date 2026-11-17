import { isOpenDeletionJob } from "@mdcz/shared/deletions";
import { toErrorMessage } from "@mdcz/shared/error";
import { DeletionWorkbenchView } from "@mdcz/views/deletions";
import { useT } from "@mdcz/views/i18n";
import { beginScrapeTask, useScrapeStore } from "@mdcz/views/state/scrapeStore";
import { useUIStore } from "@mdcz/views/state/uiStore";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { api } from "./client";
import { useDeletionJobs } from "./hooks/useDeletionJobs";
import { queryKeys } from "./lib/queryKeys";

export function DeletionTasksPage({ selectedId, onSelect }: { selectedId?: string; onSelect: (id?: string) => void }) {
  const t = useT();
  const navigate = useNavigate();
  const client = useQueryClient();
  const list = useDeletionJobs();
  const jobs = list.data?.jobs ?? [];
  const [filter, setFilter] = useState<"all" | "unfinished" | "completed">("all");
  const filtered = jobs.filter(
    (job) => filter === "all" || (filter === "unfinished" ? isOpenDeletionJob(job) : !isOpenDeletionJob(job)),
  );
  const currentId = filtered.some((job) => job.id === selectedId) ? selectedId : filtered[0]?.id;
  const detail = useQuery({
    queryKey: queryKeys.deletions.detail(currentId ?? ""),
    queryFn: () => api.deletions.detail({ id: currentId ?? "" }),
    enabled: Boolean(currentId),
    retry: false,
    refetchInterval: 1_500,
  });
  const [busy, setBusy] = useState<Map<string, number>>(new Map());
  const [errors, setErrors] = useState<Record<string, { version: number; message: string }>>({});
  const selected =
    (detail.data?.id === currentId ? detail.data : undefined) ?? filtered.find((job) => job.id === currentId) ?? null;
  const refresh = async () => client.invalidateQueries({ queryKey: queryKeys.deletions.all });
  const clearCompleted = useMutation({
    mutationFn: () => api.deletions.clearCompleted(),
    onSuccess: async () => {
      await client.cancelQueries({ queryKey: queryKeys.deletions.all });
      const remaining = await api.deletions.list();
      if (currentId && !remaining.jobs.some((job) => job.id === currentId)) {
        onSelect(remaining.jobs[0]?.id);
      }
      client.setQueryData(queryKeys.deletions.all, remaining);
      client.removeQueries({ queryKey: queryKeys.deletions.all, type: "inactive" });
      toast.success(t.deletions.cleared);
    },
    onError: (error) => toast.error(toErrorMessage(error)),
  });
  const manual = useMutation({
    mutationFn: (id: string) => api.deletions.resolveManually({ id }),
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: queryKeys.pending.all }),
        client.invalidateQueries({ queryKey: queryKeys.library.all }),
        client.invalidateQueries({ queryKey: queryKeys.overview.all }),
      ]);
      toast.success(t.deletions.manualSuccess);
    },
    onError: (error) => toast.error(toErrorMessage(error)),
  });
  const retry = async (id: string) => {
    const job = selected?.id === id ? selected : jobs.find((job) => job.id === id);
    if (!job?.canRetry || busy.get(id) === job.updatedAt) return;
    const version = job.updatedAt;
    setBusy((current) => new Map(current).set(id, version));
    setErrors((current) => ({ ...current, [id]: { version, message: "" } }));
    try {
      const result = await api.deletions.retry({ id });
      if (result.jobId) onSelect(result.jobId);
      toast.success(t.deletions.retryQueued);
    } catch (error) {
      setErrors((current) =>
        current[id]?.version === version ? { ...current, [id]: { version, message: toErrorMessage(error) } } : current,
      );
    } finally {
      setBusy((current) => {
        if (current.get(id) !== version) return current;
        const next = new Map(current);
        next.delete(id);
        return next;
      });
      await refresh();
    }
  };
  const openScrape = async (id: string) => {
    try {
      const snapshot = await api.scrape.snapshot({ taskId: id });
      beginScrapeTask(id);
      useScrapeStore.getState().setSnapshot(snapshot);
      useScrapeStore.getState().setPending(false);
      useUIStore.getState().setWorkbenchMode("scrape");
      await navigate({ to: "/workbench", search: {} });
    } catch (error) {
      toast.error(toErrorMessage(error));
    }
  };
  return (
    <DeletionWorkbenchView
      jobs={jobs}
      selected={selected}
      loading={list.isLoading || (detail.isLoading && Boolean(currentId))}
      error={list.error || detail.error ? toErrorMessage(list.error ?? detail.error) : null}
      actionError={
        selected && errors[selected.id]?.version === selected.updatedAt ? errors[selected.id]?.message : null
      }
      retrying={Boolean(selected && busy.get(selected.id) === selected.updatedAt)}
      clearing={clearCompleted.isPending}
      manualBusy={manual.isPending}
      onSelect={onSelect}
      onRetry={(id) => void retry(id)}
      onManual={async (id) => {
        try {
          await manual.mutateAsync(id);
          return true;
        } catch {
          return false;
        }
      }}
      onRefresh={() => void refresh()}
      onClearCompleted={() => clearCompleted.mutate()}
      onOpenScrape={(id) => void openScrape(id)}
      filter={filter}
      onFilterChange={setFilter}
    />
  );
}
