import { toErrorMessage } from "@mdcz/shared/error";
import type { LibraryEditJobDto, LibraryEditStartInput } from "@mdcz/shared/libraryEdit";
import {
  DEFAULT_LIBRARY_SORT,
  LIBRARY_SORT_FIELDS,
  LIBRARY_SORT_ORDERS,
  type LibraryPageSize,
  type LibrarySort,
} from "@mdcz/shared/libraryPagination";
import type { LibraryEntryDto, LibraryFacetInput } from "@mdcz/shared/serverDtos";
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
import { useUIStore } from "@mdcz/views/state/uiStore";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { api, getLibraryAssetSrc } from "../client";
import { requestScrapeLiveRunsRefresh } from "../hooks/useWebTaskSync";
import { queryKeys } from "../lib/queryKeys";
import { AppLink } from "../routeCommon";

export function LibraryPage() {
  const t = useT();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { sortBy, sortOrder, ...filters } = Route.useSearch();
  const sort: LibrarySort = {
    sortBy: sortBy ?? DEFAULT_LIBRARY_SORT.sortBy,
    sortOrder: sortOrder ?? DEFAULT_LIBRARY_SORT.sortOrder,
  };
  const libraryView = useLibraryView();
  const maintenanceStatus = useMaintenanceStore(selectMaintenanceExecutionStatus);
  const isScraping = useScrapeStore(selectIsScraping);
  const filterKey = JSON.stringify(filters);
  const listKey = JSON.stringify([filters, sort]);
  const [pagination, setPagination] = useState({ listKey, page: 1, pageSize: 20 as LibraryPageSize });
  const [selectionVersion, setSelectionVersion] = useState(0);
  if (pagination.listKey !== listKey) setPagination({ ...pagination, listKey, page: 1 });
  const page = pagination.listKey === listKey ? pagination.page : 1;
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
    queryKey: queryKeys.library.list(filters, sort, page, pagination.pageSize),
    queryFn: () => api.library.list({ ...filters, ...sort, page, pageSize: pagination.pageSize }),
    placeholderData: (previous, previousQuery) =>
      JSON.stringify(previousQuery?.queryKey.slice(2, 4)) === listKey ? previous : undefined,
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
      queryKey: [...queryKeys.library.availability, ids],
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
    const nextSearch = parseLibraryBrowseSearch(next);
    const firstPage = { queryKey: queryKeys.library.list(nextSearch, sort, 1, pagination.pageSize), exact: true };
    void queryClient.cancelQueries(firstPage);
    void queryClient.invalidateQueries(firstPage);
    const sameFilters = JSON.stringify(nextSearch) === filterKey;
    void queryClient.invalidateQueries({
      queryKey: queryKeys.library.availability,
      refetchType: sameFilters && page === 1 ? "active" : "none",
    });
    if (sameFilters && page !== 1) setPagination((current) => ({ ...current, page: 1 }));
    void navigate({ to: "/library", search: { ...nextSearch, sortBy, sortOrder } });
  };
  const refreshBlockedReason = maintenanceStatus !== "idle" ? t.workbench.taskConflict.maintenance : undefined;
  const blockedReason = isScraping ? t.workbench.taskConflict.scrape : refreshBlockedReason;
  const entries = mergeLibraryAvailability(
    pageEntries,
    availabilityQs.flatMap((availabilityQ) => availabilityQ.data ?? []),
  );

  return (
    <>
      <LibraryIndexView
        selectionKey={`${filterKey}:${selectionVersion}`}
        browse={{
          search: filters,
          libraries: librariesQ.data?.libraries ?? [],
          loadFacet,
          onApply: applyFilters,
          ...libraryView,
        }}
        refreshBlockedReason={refreshBlockedReason}
        onRefreshEntries={async (selected) => {
          const rootIds = new Set(selected.flatMap((entry) => entry.fileRefs.map((file) => file.rootId)));
          if (rootIds.size > 1) throw new Error(t.library.bulk.mixedRoots);
          const { runId } = await api.scrape.start({
            libraryId: filters.libraryId,
            refreshMovieIds: selected.map((entry) => entry.id),
          });
          requestScrapeLiveRunsRefresh();
          toast.success(t.library.bulk.rescrapeQueued(selected.length), {
            action: {
              label: t.library.bulk.viewRescrapeProgress,
              onClick: () => {
                void api.scrape
                  .snapshot({ taskId: runId })
                  .then((snapshot) => {
                    useScrapeStore.getState().setSnapshot(snapshot, true);
                    useUIStore.getState().setSelectedResultId(null);
                    useUIStore.getState().setWorkbenchMode("scrape");
                    void navigate({ to: "/workbench", search: {} });
                  })
                  .catch((error) => toast.error(toErrorMessage(error)));
              },
            },
          });
        }}
        entries={entries}
        errorMessage={libraryQ.error ? toErrorMessage(libraryQ.error) : null}
        getImageSrc={(path, entry) =>
          getLibraryAssetSrc({
            format: "webp",
            path,
            revision: entry.lastRefreshedAt ?? undefined,
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
        sort={sort}
        onSortChange={(next) =>
          void navigate({
            to: "/library",
            search: {
              ...filters,
              sortBy: next.sortBy === DEFAULT_LIBRARY_SORT.sortBy ? undefined : next.sortBy,
              sortOrder: next.sortOrder === DEFAULT_LIBRARY_SORT.sortOrder ? undefined : next.sortOrder,
            },
          })
        }
        onSelectAll={async () => (await api.library.matches(filters)).entries}
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

export const parseLibraryRouteSearch = (
  search: Record<string, unknown>,
): LibraryBrowseSearch & Partial<LibrarySort> => ({
  ...parseLibraryBrowseSearch(search),
  sortBy: LIBRARY_SORT_FIELDS.find((field) => field === search.sortBy),
  sortOrder: LIBRARY_SORT_ORDERS.find((order) => order === search.sortOrder),
});

export const Route = createFileRoute("/library")({
  validateSearch: parseLibraryRouteSearch,
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
