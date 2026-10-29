import { isOpenDeletionJob } from "@mdcz/shared/deletions";
import { toErrorMessage } from "@mdcz/shared/error";
import { Button } from "@mdcz/ui";
import { DeletionQueueView } from "@mdcz/views/deletions";
import { useT } from "@mdcz/views/i18n";
import { PendingView } from "@mdcz/views/pending";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "../client";
import { useDeletionJobs } from "../hooks/useDeletionJobs";
import { requestScrapeLiveRunsRefresh } from "../hooks/useWebTaskSync";
import { queryKeys } from "../lib/queryKeys";

export function PendingPage() {
  const t = useT();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [tab, setTab] = useState<"media" | "deletion">("media");
  const deletions = useDeletionJobs();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const listQ = useQuery({ queryKey: queryKeys.pending.all, queryFn: () => api.pending.list(), retry: false });
  const librariesQ = useQuery({ queryKey: queryKeys.libraries.all, queryFn: () => api.libraries.list(), retry: false });
  const items = listQ.data?.items ?? [];
  const activeId = selectedId && items.some((item) => item.id === selectedId) ? selectedId : (items[0]?.id ?? null);
  const detailQ = useQuery({
    queryKey: queryKeys.pending.detail(activeId ?? ""),
    queryFn: () => api.pending.detail({ id: activeId ?? "" }),
    enabled: Boolean(activeId),
    retry: false,
  });
  useEffect(() => {
    if (selectedId && !items.some((item) => item.id === selectedId)) setSelectedId(null);
  }, [items, selectedId]);
  const refresh = async () => await queryClient.invalidateQueries({ queryKey: queryKeys.pending.all });
  const act = async (action: () => Promise<unknown>, message: string) => {
    try {
      await action();
      toast.success(message);
      await refresh();
    } catch (error) {
      toast.error(toErrorMessage(error));
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <nav aria-label={t.pending.title} className="flex shrink-0 gap-2 border-b px-4 py-2">
        <Button size="sm" variant={tab === "media" ? "secondary" : "ghost"} onClick={() => setTab("media")}>
          {t.deletions.mediaPending} · {items.length}
        </Button>
        <Button size="sm" variant={tab === "deletion" ? "secondary" : "ghost"} onClick={() => setTab("deletion")}>
          {t.deletions.title} · {deletions.data?.jobs.filter(isOpenDeletionJob).length ?? 0}
        </Button>
      </nav>
      <div className="min-h-0 flex-1">
        {tab === "deletion" ? (
          <DeletionQueueView
            jobs={deletions.data?.jobs ?? []}
            loading={deletions.isLoading}
            error={deletions.error ? toErrorMessage(deletions.error) : null}
            onOpen={(jobId) => void navigate({ to: "/workbench", search: { intent: "deletion", jobId } })}
          />
        ) : (
          <PendingView
            items={items}
            loading={listQ.isLoading}
            errorMessage={listQ.error ? toErrorMessage(listQ.error) : null}
            selectedId={activeId}
            onSelect={setSelectedId}
            detail={activeId ? detailQ.data : null}
            detailLoading={detailQ.isLoading}
            libraries={librariesQ.data?.libraries ?? []}
            onRetry={async (input) =>
              await act(async () => {
                await api.pending.retry(input);
                requestScrapeLiveRunsRefresh();
              }, t.pending.submitted)
            }
            onRetryNumberRecognition={async (id) => {
              const detail = await api.pending.retryNumberRecognition({ id });
              queryClient.setQueryData(queryKeys.pending.detail(id), detail);
              await refresh();
            }}
            onConfirmUncensored={async (input) =>
              await act(() => api.pending.confirmUncensored(input), t.pending.confirmed)
            }
            onIgnore={async (id) => await act(() => api.pending.ignore({ id }), t.pending.ignored)}
            onBatch={async (input) => {
              const result = await api.pending.batch(input);
              if (input.action === "retry" && result.succeededIds.length) requestScrapeLiveRunsRefresh();
              await refresh();
              return result;
            }}
          />
        )}
      </div>
    </div>
  );
}

export const Route = createFileRoute("/pending")({
  component: PendingPage,
});
