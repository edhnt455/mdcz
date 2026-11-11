import { needsDeletionReview } from "@mdcz/shared/deletions";
import { toErrorMessage } from "@mdcz/shared/error";
import type { PendingActionResponse, PendingListResponse } from "@mdcz/shared/pending";
import { Button } from "@mdcz/ui";
import { DeletionQueueView } from "@mdcz/views/deletions";
import { useT } from "@mdcz/views/i18n";
import { PendingView } from "@mdcz/views/pending";
import { beginScrapeTask, useScrapeStore } from "@mdcz/views/state/scrapeStore";
import { useUIStore } from "@mdcz/views/state/uiStore";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { api } from "../client";
import { pendingListQueryOptions } from "../hooks/pendingQueries";
import { useDeletionJobs } from "../hooks/useDeletionJobs";
import { requestScrapeLiveRunsRefresh } from "../hooks/useWebTaskSync";
import { queryKeys } from "../lib/queryKeys";

export function PendingPage({ newFiles = false }: { newFiles?: boolean } = {}) {
  const t = useT();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [tab, setTab] = useState<"media" | "deletion">("media");
  const deletions = useDeletionJobs();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const listQ = useQuery(pendingListQueryOptions(newFiles));
  const librariesQ = useQuery({ queryKey: queryKeys.libraries.all, queryFn: () => api.libraries.list(), retry: false });
  const items = listQ.data?.items ?? [];
  const activeId = selectedId && items.some((item) => item.id === selectedId) ? selectedId : (items[0]?.id ?? null);
  const detailQ = useQuery({
    queryKey: queryKeys.pending.detail(activeId ?? ""),
    queryFn: () => api.pending.detail({ id: activeId ?? "" }),
    enabled: Boolean(activeId),
    staleTime: 30_000,
    retry: false,
  });
  const refresh = async () => await queryClient.invalidateQueries({ queryKey: queryKeys.pending.all });
  const removeSubmitted = (ids: string[]) => {
    const remaining = items.filter((item) => !ids.includes(item.id));
    if (activeId && ids.includes(activeId)) {
      const index = items.findIndex((item) => item.id === activeId);
      setSelectedId(remaining[Math.min(index, remaining.length - 1)]?.id ?? null);
    }
    for (const key of [queryKeys.pending.all, queryKeys.pending.newFiles]) {
      queryClient.setQueryData<PendingListResponse>(
        key,
        (data) => data && { items: data.items.filter((item) => !ids.includes(item.id)) },
      );
    }
    for (const id of ids) {
      void queryClient.cancelQueries({ queryKey: queryKeys.pending.detail(id) });
      queryClient.removeQueries({ queryKey: queryKeys.pending.detail(id) });
    }
  };
  const openTask = async (id: string, kind: "scrape" | "action") => {
    try {
      if (kind === "action") {
        await navigate({ to: "/workbench", search: { intent: "actions", jobId: id } });
        return;
      }
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
  const submit = async (id: string, kind: "scrape" | "action", action: () => Promise<PendingActionResponse>) => {
    try {
      const task = await action();
      removeSubmitted([id]);
      if (kind === "scrape") requestScrapeLiveRunsRefresh();
      toast.success(t.pending.queued, {
        action: { label: t.pending.viewWorkbench, onClick: () => void openTask(task.taskId, kind) },
      });
      await refresh();
    } catch (error) {
      toast.error(toErrorMessage(error));
    }
  };
  return (
    <div className="flex h-full min-h-0 flex-col">
      {!newFiles ? (
        <nav aria-label={t.pending.title} className="flex shrink-0 gap-2 border-b px-4 py-2">
          <Button size="sm" variant={tab === "media" ? "secondary" : "ghost"} onClick={() => setTab("media")}>
            {t.deletions.mediaPending} · {items.length}
          </Button>
          <Button size="sm" variant={tab === "deletion" ? "secondary" : "ghost"} onClick={() => setTab("deletion")}>
            {t.deletions.title} · {deletions.data?.jobs.filter(needsDeletionReview).length ?? 0}
          </Button>
        </nav>
      ) : null}
      <div className="min-h-0 flex-1">
        {tab === "deletion" && !newFiles ? (
          <DeletionQueueView
            jobs={deletions.data?.jobs ?? []}
            loading={deletions.isLoading}
            error={deletions.error ? toErrorMessage(deletions.error) : null}
            onOpen={(jobId) => void navigate({ to: "/workbench", search: { intent: "deletion", jobId } })}
          />
        ) : (
          <PendingView
            title={newFiles ? t.pending.newFiles : undefined}
            items={items}
            loading={listQ.isLoading}
            errorMessage={listQ.error ? toErrorMessage(listQ.error) : null}
            selectedId={activeId}
            onSelect={setSelectedId}
            detail={activeId ? detailQ.data : null}
            detailLoading={detailQ.isLoading}
            detailErrorMessage={detailQ.error ? toErrorMessage(detailQ.error) : null}
            libraries={librariesQ.data?.libraries ?? []}
            onOpenTask={(item) => {
              if (item.taskId && item.taskKind) void openTask(item.taskId, item.taskKind);
            }}
            onRetry={async (input) => await submit(input.id, "scrape", () => api.pending.retry(input))}
            onRetryNumberRecognition={async (id) => {
              const detail = await api.pending.retryNumberRecognition({ id });
              queryClient.setQueryData(queryKeys.pending.detail(id), detail);
              await refresh();
            }}
            onConfirmUncensored={async (input) =>
              await submit(input.id, "action", () => api.pending.confirmUncensored(input))
            }
            onDelete={async (id) => await submit(id, "action", () => api.pending.delete({ id }))}
            onIgnore={async (id) => {
              try {
                await api.pending.ignore({ id });
                removeSubmitted([id]);
                toast.success(t.pending.ignored);
                await refresh();
              } catch (error) {
                toast.error(toErrorMessage(error));
              }
            }}
            onBatch={async (input) => {
              const result = await api.pending.batch(input);
              removeSubmitted(result.succeededIds);
              if (input.action === "retry" && result.succeededIds.length) requestScrapeLiveRunsRefresh();
              const task = result.tasks?.[0];
              if (task)
                toast.success(t.pending.queued, {
                  action: { label: t.pending.viewWorkbench, onClick: () => void openTask(task.id, task.kind) },
                });
              await refresh();
              return result;
            }}
          />
        )}
      </div>
    </div>
  );
}

export const Route = createFileRoute("/pending")({ component: () => <PendingPage /> });
