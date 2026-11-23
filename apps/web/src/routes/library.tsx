import { toErrorMessage } from "@mdcz/shared/error";
import type { LibraryEditJobDto, LibraryEditStartInput } from "@mdcz/shared/libraryEdit";
import type { LibraryPageSize } from "@mdcz/shared/libraryPagination";
import type { LibraryEntryDto, LibraryFacetInput } from "@mdcz/shared/serverDtos";
import { startLibraryRefresh } from "@mdcz/views/adapters";
import { useT } from "@mdcz/views/i18n";
import {
  chunkLibraryEntryIds,
  type LibraryBrowseSearch,
  LibraryDeleteDialog,
  LibraryEditDialog,
  LibraryIndexView,
  mergeLibraryAvailability,
  parseLibraryBrowseSearch,
  useLibraryView,
} from "@mdcz/views/library";
import { selectMaintenanceExecutionStatus, useMaintenanceStore } from "@mdcz/views/state/maintenanceStore";
import { selectIsScraping, useScrapeStore } from "@mdcz/views/state/scrapeStore";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { createWebWorkbenchPorts } from "../adapters/ports";
import { api, getLibraryAssetSrc } from "../client";
import { queryKeys } from "../lib/queryKeys";
import { AppLink } from "../routeCommon";

export function LibraryPage() {
  const t = useT();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const search = Route.useSearch();
  const libraryView = useLibraryView();
  const maintenanceStatus = useMaintenanceStore(selectMaintenanceExecutionStatus);
  const isScraping = useScrapeStore(selectIsScraping);
  const ports = useMemo(() => createWebWorkbenchPorts(), []);
  const filterKey = JSON.stringify(search);
  const [pagination, setPagination] = useState({ filterKey, page: 1, pageSize: 20 as LibraryPageSize });
  const [selectionVersion, setSelectionVersion] = useState(0);
  if (pagination.filterKey !== filterKey) setPagination({ ...pagination, filterKey, page: 1 });
  const page = pagination.filterKey === filterKey ? pagination.page : 1;
  const [deleteTargets, setDeleteTargets] = useState<LibraryEntryDto[]>([]);
  const [editOpen, setEditOpen] = useState(false);
  const [editTargets, setEditTargets] = useState<LibraryEntryDto[]>([]);
  const [editLoading, setEditLoading] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [showEditJob, setShowEditJob] = useState(true);
  const readEditStatus = async () => {
    const before = queryClient.getQueryData<LibraryEditJobDto | null>(queryKeys.libraryEdit);
    const response = await api.library.edit.status();
    const current = queryClient.getQueryData<LibraryEditJobDto | null>(queryKeys.libraryEdit);
    return current !== before && current !== undefined ? current : response;
  };
  const editStatusQ = useQuery({
    queryKey: queryKeys.libraryEdit,
    queryFn: readEditStatus,
    enabled: editOpen,
    refetchInterval: (query) => (query.state.data?.status === "running" ? 2_000 : false),
  });
  const configQ = useQuery({ queryKey: queryKeys.config.current, queryFn: () => api.config.read(), enabled: editOpen });
  const openEdit = async (selected: LibraryEntryDto[]) => {
    setEditOpen(true);
    setEditLoading(true);
    setEditError(null);
    setEditTargets(selected);
    setShowEditJob(true);
    try {
      await queryClient.fetchQuery({
        queryKey: queryKeys.libraryEdit,
        queryFn: readEditStatus,
        staleTime: 0,
      });
    } catch (error) {
      setEditError(toErrorMessage(error));
    } finally {
      setEditLoading(false);
    }
  };
  const editM = useMutation({
    mutationFn: (input: LibraryEditStartInput) => api.library.edit.start(input),
    onMutate: () => setEditError(null),
    onSuccess: async () => {
      setShowEditJob(true);
      await queryClient.invalidateQueries({ queryKey: queryKeys.libraryEdit });
    },
    onError: (error) => setEditError(toErrorMessage(error)),
  });
  const libraryQ = useQuery({
    queryKey: [...queryKeys.library.list(search), { page, pageSize: pagination.pageSize }],
    queryFn: () => api.library.list({ ...search, page, pageSize: pagination.pageSize }),
    placeholderData: (previous, previousQuery) =>
      JSON.stringify(previousQuery?.queryKey[2]) === filterKey ? previous : undefined,
    retry: false,
  });
  const notifyDeletionQueued = (taskIds: string[]) => {
    toast.success(t.pending.queued, {
      description: t.library.deletionQueued,
      action: {
        label: t.pending.viewWorkbench,
        onClick: () =>
          void navigate({ to: "/workbench", search: { intent: "deletion", jobId: `action/${taskIds[0]}` } }),
      },
    });
    void queryClient.invalidateQueries({ queryKey: queryKeys.pending.all });
    void queryClient.invalidateQueries({ queryKey: queryKeys.deletions.all });
  };
  const deleteLibraryM = useMutation({
    mutationFn: (entries: LibraryEntryDto[]) => api.library.delete({ ids: entries.map((entry) => entry.id) }),
    onSuccess: (result) => {
      setDeleteTargets([]);
      setSelectionVersion((version) => version + 1);
      notifyDeletionQueued(result.taskIds);
    },
    onError: (error) => {
      toast.error(toErrorMessage(error));
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.library.all });
    },
  });
  const pageEntries = libraryQ.isPlaceholderData ? [] : (libraryQ.data?.entries ?? []);
  const availabilityQs = useQueries({
    queries: chunkLibraryEntryIds(pageEntries.map((entry) => entry.id)).map((ids) => ({
      queryKey: ["library", "availability", ids],
      queryFn: async () => await api.library.availability({ ids }),
      retry: false,
      staleTime: 30_000,
    })),
  });
  const librariesQ = useQuery({ queryKey: queryKeys.libraries.all, queryFn: () => api.libraries.list(), retry: false });
  const loadFacet = useCallback(
    (input: LibraryFacetInput) =>
      queryClient.fetchQuery({
        queryKey: queryKeys.library.facet(input),
        queryFn: () => api.library.facet(input),
        staleTime: 30_000,
      }),
    [queryClient],
  );
  const applyFilters = (next: LibraryBrowseSearch) => {
    setPagination((current) => ({ ...current, page: 1 }));
    void navigate({ to: "/library", search: parseLibraryBrowseSearch(next) });
  };
  const blockedReason = isScraping
    ? t.workbench.taskConflict.scrape
    : maintenanceStatus !== "idle"
      ? t.workbench.taskConflict.maintenance
      : undefined;
  const entries = mergeLibraryAvailability(
    pageEntries,
    availabilityQs.flatMap((availabilityQ) => availabilityQ.data ?? []),
  );

  return (
    <>
      <LibraryIndexView
        selectionKey={`${filterKey}:${selectionVersion}`}
        browse={{
          search,
          libraries: librariesQ.data?.libraries ?? [],
          loadFacet,
          onApply: applyFilters,
          ...libraryView,
        }}
        refreshBlockedReason={blockedReason}
        onRefreshEntries={async (selected) => {
          await startLibraryRefresh({
            libraryId: search.libraryId,
            entries: selected,
            port: ports.maintenance,
            isScraping,
            toast,
            toErrorMessage,
          });
          void navigate({ to: "/workbench", search: { intent: "maintenance" } });
        }}
        onRestoreEntries={async (selected) => {
          const { ignored: _ignored, ...scope } = search;
          await api.library.restoreIgnored({ ...scope, ids: selected.map((entry) => entry.id) });
          setSelectionVersion((version) => version + 1);
          await queryClient.invalidateQueries({ queryKey: queryKeys.library.all });
        }}
        entries={entries}
        errorMessage={libraryQ.error ? toErrorMessage(libraryQ.error) : null}
        getImageSrc={(path, entry) =>
          getLibraryAssetSrc({
            format: "webp",
            path,
            rootId:
              entry.thumbnailRootId ?? entry.fileRefs.find((file) => file.id === entry.displayFileId)?.rootId ?? "",
            width: 160,
          })
        }
        isLoading={libraryQ.isFetching}
        linkComponent={LibraryEntryLink}
        page={libraryQ.isPlaceholderData ? page : (libraryQ.data?.page ?? page)}
        pageSize={pagination.pageSize}
        onPageChange={(page) => setPagination({ ...pagination, page })}
        onPageSizeChange={(pageSize) => setPagination({ ...pagination, page: 1, pageSize })}
        onSelectAll={async () => (await api.library.matches(search)).entries}
        onDeleteEntries={setDeleteTargets}
        onEditEntries={(entries) => void openEdit(entries)}
        onRemoveFile={async (input) => {
          const result = await api.library.removeFile(input);
          notifyDeletionQueued(result.taskIds);
          void queryClient.invalidateQueries({ queryKey: queryKeys.library.all });
        }}
        onRelinkFile={async (input) => {
          await api.library.relink(input);
          await queryClient.invalidateQueries({ queryKey: queryKeys.library.all });
        }}
        onRefresh={() => {
          void queryClient.invalidateQueries({ queryKey: queryKeys.library.all });
        }}
        total={libraryQ.data?.total ?? 0}
        fileCount={libraryQ.data?.fileCount ?? 0}
        totalBytes={libraryQ.data?.totalBytes ?? 0}
      />
      <LibraryEditDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        entries={editTargets}
        ignoredFields={configQ.data?.download.nfoIgnoreFields ?? []}
        submitting={editM.isPending}
        loading={editLoading || configQ.isLoading}
        error={
          editError ||
          (configQ.error ? toErrorMessage(configQ.error) : null) ||
          (editStatusQ.error ? toErrorMessage(editStatusQ.error) : null)
        }
        blockedReason={blockedReason ?? (configQ.error ? toErrorMessage(configQ.error) : undefined)}
        job={editStatusQ.data?.status === "running" || showEditJob ? (editStatusQ.data ?? null) : null}
        onSubmit={(input) => editM.mutate(input)}
        onNewEdit={() => {
          setEditError(null);
          setShowEditJob(false);
        }}
      />
      <LibraryDeleteDialog
        entries={deleteTargets}
        submitting={deleteLibraryM.isPending}
        onCancel={() => {
          if (!deleteLibraryM.isPending) setDeleteTargets([]);
        }}
        onConfirm={() => {
          if (!deleteLibraryM.isPending) deleteLibraryM.mutate(deleteTargets);
        }}
      />
    </>
  );
}

export const Route = createFileRoute("/library")({
  validateSearch: parseLibraryBrowseSearch,
  component: LibraryPage,
});

function LibraryEntryLink({
  children,
  className,
  entry,
}: {
  children: ReactNode;
  className?: string;
  entry: LibraryEntryDto;
}) {
  return (
    <AppLink className={className} to={`/scrape/${encodeURIComponent(entry.displayFileId)}`}>
      {children}
    </AppLink>
  );
}
