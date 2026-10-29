import { toErrorMessage } from "@mdcz/shared/error";
import { DeletionWorkbenchView } from "@mdcz/views/deletions";
import { useT } from "@mdcz/views/i18n";
import { beginScrapeTask, useScrapeStore } from "@mdcz/views/state/scrapeStore";
import { useUIStore } from "@mdcz/views/state/uiStore";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { api } from "./client";
import { useDeletionJobs } from "./hooks/useDeletionJobs";
import { queryKeys } from "./lib/queryKeys";

export function DeletionTasksPage({ selectedId, onSelect }: { selectedId?: string; onSelect: (id: string) => void }) {
  const t = useT();
  const navigate = useNavigate();
  const client = useQueryClient();
  const list = useDeletionJobs();
  const jobs = list.data?.jobs ?? [];
  const currentId = selectedId ?? jobs[0]?.id;
  const detail = useQuery({
    queryKey: queryKeys.deletions.detail(currentId ?? ""),
    queryFn: () => api.deletions.detail({ id: currentId ?? "" }),
    enabled: Boolean(currentId),
    retry: false,
    refetchInterval: 1_500,
  });
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const refresh = async () => client.invalidateQueries({ queryKey: queryKeys.deletions.all });
  const retry = async (id: string) => {
    if (busy.has(id)) return;
    setBusy((current) => new Set([...current, id]));
    setErrors((current) => ({ ...current, [id]: "" }));
    try {
      await api.deletions.retry({ id });
      toast.success(t.deletions.retryQueued);
    } catch (error) {
      setErrors((current) => ({ ...current, [id]: error instanceof Error ? error.message : toErrorMessage(error) }));
    } finally {
      setBusy((current) => {
        const next = new Set(current);
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
      selected={detail.data ?? jobs.find((job) => job.id === currentId) ?? null}
      loading={list.isLoading || (detail.isLoading && Boolean(currentId))}
      error={list.error || detail.error ? toErrorMessage(list.error ?? detail.error) : null}
      actionError={currentId ? errors[currentId] : null}
      retrying={currentId ? busy.has(currentId) : false}
      onSelect={onSelect}
      onRetry={(id) => void retry(id)}
      onRefresh={() => void refresh()}
      onOpenScrape={(id) => void openScrape(id)}
    />
  );
}
