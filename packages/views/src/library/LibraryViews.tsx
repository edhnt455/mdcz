import type { LibraryEntryDto } from "@mdcz/shared";
import { toErrorMessage } from "@mdcz/shared/error";
import { formatBytes } from "@mdcz/shared/format";
import {
  LIBRARY_PAGE_SIZES,
  LIBRARY_SORT_FIELDS,
  LIBRARY_SORT_ORDERS,
  type LibraryPageSize,
  type LibrarySort,
} from "@mdcz/shared/libraryPagination";
import type { LibraryFileRemoveInput, LibraryRelinkInput } from "@mdcz/shared/serverDtos";
import {
  Badge,
  Button,
  Checkbox,
  cn,
  copyText,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@mdcz/ui";
import {
  AlertCircle,
  ChevronDown,
  Copy,
  Database,
  Layers,
  LayoutGrid,
  Link2,
  List,
  LoaderCircle,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { type ComponentType, type ReactNode, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useT } from "../i18n";
import { type LibraryBrowseControls, LibraryBrowsePanel } from "./LibraryBrowsePanel";
import { LibraryPosterWall } from "./LibraryPosterWall";

export interface LibraryIndexViewProps {
  className?: string;
  entries: LibraryEntryDto[];
  errorMessage?: string | null;
  getImageSrc?: (path: string, entry: LibraryEntryDto) => string;
  isLoading?: boolean;
  page: number;
  pageSize: LibraryPageSize;
  selectionKey: string;
  total: number;
  fileCount?: number;
  totalBytes?: number;
  linkComponent?: ComponentType<{ children: ReactNode; className?: string; entry: LibraryEntryDto }>;
  browse: LibraryBrowseControls;
  sort: LibrarySort;
  onSortChange: (sort: LibrarySort) => void;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: LibraryPageSize) => void;
  onSelectAll: () => Promise<LibraryEntryDto[]>;
  onEditEntries?: (entries: LibraryEntryDto[]) => void;
  onRefreshEntries?: (entries: LibraryEntryDto[]) => Promise<void>;
  refreshBlockedReason?: string;
  onDeleteEntries: (entries: LibraryEntryDto[]) => void;
  onRemoveFile?: (input: LibraryFileRemoveInput) => Promise<void>;
  onRelinkFile?: (input: LibraryRelinkInput) => Promise<void>;
}

export interface LibraryDeleteDialogProps {
  entries: LibraryEntryDto[];
  submitting?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export function LibraryIndexView({
  className,
  entries,
  errorMessage,
  getImageSrc = (path) => path,
  isLoading = false,
  page,
  pageSize,
  selectionKey,
  total,
  fileCount,
  totalBytes,
  linkComponent: LinkComponent,
  browse,
  sort,
  onSortChange,
  onPageChange,
  onPageSizeChange,
  onSelectAll,
  onDeleteEntries,
  onEditEntries,
  onRefreshEntries,
  refreshBlockedReason,
  onRemoveFile,
  onRelinkFile,
}: LibraryIndexViewProps) {
  const t = useT();
  const mainRef = useRef<HTMLElement>(null);
  const [selection, setSelection] = useState({
    key: selectionKey,
    entries: new Map<string, LibraryEntryDto>(),
  });
  const [selectingAll, setSelectingAll] = useState(false);
  const [acting, setActing] = useState(false);
  const selectionRequest = useRef(0);
  if (selection.key !== selectionKey) {
    selectionRequest.current += 1;
    setSelection({ key: selectionKey, entries: new Map() });
    setSelectingAll(false);
  }
  const totalSize = entries.reduce((size, entry) => size + (Number.isFinite(entry.size) ? entry.size : 0), 0);
  const resolvedFileCount = fileCount ?? entries.reduce((count, entry) => count + entry.fileRefs.length, 0);
  const summaryText = `${t.library.metrics.movies} ${total} · ${t.library.metrics.files} ${resolvedFileCount} · ${formatBytes(totalBytes ?? totalSize)}`;
  const listView = browse.view === "list";
  const selected = [...selection.entries.values()];
  const selectedOnPage = entries.filter((entry) => selection.entries.has(entry.id)).length;
  const allOnPageSelected = entries.length > 0 && selectedOnPage === entries.length;
  const selectionDisabled = selectingAll || acting;
  const actionsDisabled = !selected.length || selectionDisabled;
  const hasFilters = Object.values(browse.search).some((value) => value !== undefined);
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const pageNumbers = [...new Set([1, pageCount, page - 2, page - 1, page, page + 1, page + 2])]
    .filter((value) => value >= 1 && value <= pageCount)
    .sort((a, b) => a - b);
  const toggleSelected = (entry: LibraryEntryDto) =>
    setSelection((current) => {
      const next = new Map(current.entries);
      if (!next.delete(entry.id)) next.set(entry.id, entry);
      return { ...current, entries: next };
    });
  const togglePage = (checked: boolean) =>
    setSelection((current) => {
      const next = new Map(current.entries);
      for (const entry of entries) {
        if (checked) next.set(entry.id, entry);
        else next.delete(entry.id);
      }
      return { ...current, entries: next };
    });
  const selectAll = async () => {
    const request = ++selectionRequest.current;
    setSelectingAll(true);
    try {
      const matches = await onSelectAll();
      if (request === selectionRequest.current) {
        setSelection((current) => ({ ...current, entries: new Map(matches.map((entry) => [entry.id, entry])) }));
      }
    } catch (error) {
      if (request === selectionRequest.current) toast.error(toErrorMessage(error));
    } finally {
      if (request === selectionRequest.current) setSelectingAll(false);
    }
  };
  const runSelectionAction = async (action: (entries: LibraryEntryDto[]) => Promise<void>) => {
    setActing(true);
    try {
      await action(selected);
    } catch (error) {
      toast.error(toErrorMessage(error));
    } finally {
      setActing(false);
    }
  };
  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0 });
  }, [page, pageSize, selectionKey, sort.sortBy, sort.sortOrder]);

  return (
    <TooltipProvider>
      <main className={cn("h-full overflow-y-auto bg-surface-canvas text-foreground", className)} ref={mainRef}>
        <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-4 px-6 py-6 lg:px-12 lg:py-8">
          {errorMessage && (
            <div className="flex items-center gap-3 rounded-quiet border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive">
              <AlertCircle className="h-4 w-4 shrink-0" />
              {errorMessage}
            </div>
          )}

          <LibraryBrowsePanel browse={browse} />

          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            {listView && (
              <fieldset className="flex min-w-0 flex-wrap items-center gap-2">
                <legend className="sr-only">{t.library.bulk.label}</legend>
                {onRefreshEntries && (
                  <span title={refreshBlockedReason}>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={actionsDisabled || !!refreshBlockedReason}
                      onClick={() => void runSelectionAction(onRefreshEntries)}
                    >
                      <RefreshCw className="h-4 w-4" />
                      {t.library.bulk.rescrape}
                    </Button>
                  </span>
                )}
                {onEditEntries && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={actionsDisabled}
                    onClick={() => onEditEntries(selected)}
                  >
                    <Pencil className="h-4 w-4" />
                    {t.library.edit.action}
                  </Button>
                )}
                <Button
                  type="button"
                  size="sm"
                  variant="destructive"
                  disabled={actionsDisabled}
                  onClick={() => onDeleteEntries(selected)}
                >
                  <Trash2 className="h-4 w-4" />
                  {t.library.removeFromLibrary}
                </Button>
              </fieldset>
            )}
            <div className="ml-auto flex flex-wrap items-center gap-2">
              <select
                aria-label={t.library.sort.field}
                className="h-9 rounded-quiet border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                value={sort.sortBy}
                onChange={(event) => onSortChange({ ...sort, sortBy: event.target.value as LibrarySort["sortBy"] })}
              >
                {LIBRARY_SORT_FIELDS.map((field) => (
                  <option key={field} value={field}>
                    {t.library.sort.fields[field]}
                  </option>
                ))}
              </select>
              <select
                aria-label={t.library.sort.order}
                className="h-9 rounded-quiet border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                value={sort.sortOrder}
                onChange={(event) =>
                  onSortChange({ ...sort, sortOrder: event.target.value as LibrarySort["sortOrder"] })
                }
              >
                {LIBRARY_SORT_ORDERS.map((order) => (
                  <option key={order} value={order}>
                    {t.library.sort.orders[order]}
                  </option>
                ))}
              </select>
              <div className="inline-flex shrink-0 rounded-quiet bg-surface-low p-1 shadow-inner">
                {(["list", "wall"] as const).map((view) => (
                  <Button
                    aria-pressed={browse.view === view}
                    className={cn(
                      "h-7 gap-1.5 px-3 text-xs text-muted-foreground",
                      browse.view === view && "bg-surface text-foreground shadow-sm",
                    )}
                    key={view}
                    onClick={() => browse.onViewChange(view)}
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    {view === "list" ? <List className="h-4 w-4" /> : <LayoutGrid className="h-4 w-4" />}
                    {t.library.view[view]}
                  </Button>
                ))}
              </div>
            </div>
          </div>

          <section
            aria-busy={isLoading}
            aria-label={t.library.listAriaLabel}
            className={cn(listView && "overflow-hidden rounded-quiet-lg border border-border/50 bg-surface")}
          >
            {listView && (
              <div className="flex flex-wrap items-center gap-x-5 gap-y-1 border-b border-border/50 bg-surface-low px-3 py-1.5 text-xs lg:gap-x-6">
                <Checkbox
                  aria-label={t.library.bulk.selectPage}
                  checked={allOnPageSelected || (selectedOnPage > 0 ? "indeterminate" : false)}
                  disabled={!entries.length || isLoading || selectionDisabled}
                  onCheckedChange={(checked) => togglePage(checked === true)}
                />
                <div className="flex flex-1 flex-wrap items-center gap-x-4 gap-y-1">
                  <span className="font-semibold">{t.library.filters.entries}</span>
                  <span className="font-numeric text-muted-foreground" role="status">
                    {t.library.selectedCount(selected.length)}
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-xs"
                    disabled={!total || isLoading || selectionDisabled}
                    onClick={() => void selectAll()}
                  >
                    {selectingAll ? t.library.selectingAll : t.library.selectAllMatches(total)}
                  </Button>
                  {selected.length > 0 && (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2 text-xs"
                      disabled={selectionDisabled}
                      onClick={() => setSelection({ key: selectionKey, entries: new Map() })}
                    >
                      {t.library.bulk.clear}
                    </Button>
                  )}
                </div>
                <span className="font-numeric text-muted-foreground">{summaryText}</span>
              </div>
            )}
            {entries.length > 0 && !listView && (
              <LibraryPosterWall entries={entries} getImageSrc={getImageSrc} linkComponent={LinkComponent} />
            )}
            {listView && (
              <div className="divide-y divide-border/40">
                {entries.map((entry) => (
                  <LibraryEntryRow
                    key={entry.id}
                    entry={entry}
                    showAddedDate={sort.sortBy === "createdAt"}
                    getImageSrc={getImageSrc}
                    linkComponent={LinkComponent}
                    selectionDisabled={selectionDisabled || isLoading}
                    selected={selection.entries.has(entry.id)}
                    onDeleteEntries={onDeleteEntries}
                    onToggleSelected={() => toggleSelected(entry)}
                    onRemoveFile={onRemoveFile}
                    onRelinkFile={onRelinkFile}
                  />
                ))}
              </div>
            )}
            {entries.length === 0 && !errorMessage && (
              <div className="flex min-h-[300px] flex-col items-center justify-center rounded-quiet-xl border border-dashed border-border/60 bg-surface-low/30 text-center text-muted-foreground">
                <Database className="mb-3 h-10 w-10 text-muted-foreground/40" />
                {isLoading ? (
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <LoaderCircle className="h-4 w-4 animate-spin" />
                    {t.common.loading}
                  </div>
                ) : (
                  <p className="text-sm">{hasFilters ? t.library.noMatchingEntries : t.library.nothingIndexed}</p>
                )}
              </div>
            )}
          </section>

          <nav
            aria-label={t.library.pagination.label}
            className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground"
          >
            <span className="font-numeric">{t.library.pagination.summary(total, page, pageCount)}</span>
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-2">
                {t.library.pagination.pageSize}
                <select
                  aria-label={t.library.pagination.pageSize}
                  className="h-8 rounded-quiet border border-border bg-surface px-2 text-foreground"
                  disabled={isLoading}
                  value={pageSize}
                  onChange={(event) => onPageSizeChange(Number(event.target.value) as LibraryPageSize)}
                >
                  {LIBRARY_PAGE_SIZES.map((size) => (
                    <option key={size} value={size}>
                      {size}
                    </option>
                  ))}
                </select>
              </label>
              <Button
                disabled={isLoading || page <= 1}
                size="sm"
                variant="outline"
                onClick={() => onPageChange(page - 1)}
              >
                {t.library.pagination.previous}
              </Button>
              {pageNumbers.map((number, index) => (
                <span key={number} className="inline-flex items-center gap-2">
                  {index > 0 && number > pageNumbers[index - 1] + 1 ? <span aria-hidden="true">…</span> : null}
                  <Button
                    aria-label={t.library.pagination.goTo(number)}
                    aria-current={number === page ? "page" : undefined}
                    disabled={isLoading}
                    size="sm"
                    variant={number === page ? "default" : "outline"}
                    onClick={() => onPageChange(number)}
                  >
                    {number}
                  </Button>
                </span>
              ))}
              <Button
                disabled={isLoading || page >= pageCount}
                size="sm"
                variant="outline"
                onClick={() => onPageChange(page + 1)}
              >
                {t.library.pagination.next}
              </Button>
              <form
                key={`${page}:${pageCount}`}
                className="flex items-center gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  const value = Number(new FormData(event.currentTarget).get("page"));
                  if (Number.isInteger(value) && value >= 1 && value <= pageCount) onPageChange(value);
                }}
              >
                <Input
                  aria-label={t.library.pagination.jump}
                  name="page"
                  type="number"
                  min={1}
                  max={pageCount}
                  defaultValue={page}
                  disabled={isLoading}
                  className="h-8 w-16"
                />
                <Button type="submit" disabled={isLoading} size="sm" variant="outline">
                  {t.library.pagination.jump}
                </Button>
              </form>
            </div>
          </nav>
        </div>
      </main>
    </TooltipProvider>
  );
}

export function LibraryDeleteDialog({ entries, submitting = false, onCancel, onConfirm }: LibraryDeleteDialogProps) {
  const t = useT();
  return (
    <Dialog
      open={entries.length > 0}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          onCancel();
        }
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t.library.removeDialogTitle}</DialogTitle>
        </DialogHeader>
        <p>
          {entries.length
            ? t.library.removeDialogDescription(
                entries.length,
                entries.reduce((n, e) => n + e.fileRefs.length, 0),
                entries.reduce((n, e) => n + e.assets.length, 0),
              )
            : null}
        </p>
        <DialogFooter>
          <Button disabled={submitting} variant="outline" onClick={onCancel}>
            {t.common.cancel}
          </Button>
          <Button disabled={submitting} variant="destructive" onClick={onConfirm}>
            {submitting ? t.pending.submitting : t.library.confirmRemove}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function LibraryEntryRow({
  entry,
  showAddedDate,
  getImageSrc,
  linkComponent: LinkComponent,
  selectionDisabled,
  selected,
  onDeleteEntries,
  onToggleSelected,
  onRemoveFile,
  onRelinkFile,
}: {
  entry: LibraryEntryDto;
  showAddedDate: boolean;
  getImageSrc: (path: string, entry: LibraryEntryDto) => string;
  linkComponent?: ComponentType<{ children: ReactNode; className?: string; entry: LibraryEntryDto }>;
  selectionDisabled: boolean;
  selected: boolean;
  onDeleteEntries: LibraryIndexViewProps["onDeleteEntries"];
  onToggleSelected: () => void;
  onRemoveFile?: LibraryIndexViewProps["onRemoveFile"];
  onRelinkFile?: LibraryIndexViewProps["onRelinkFile"];
}) {
  const displayFile = entry.fileRefs.find((file) => file.id === entry.displayFileId);
  const id = entry.number || entry.crawlerData?.number || entry.mediaIdentity || displayFile?.fileName || entry.id;
  const title =
    entry.crawlerData?.title_zh || entry.title || entry.crawlerData?.title || displayFile?.fileName || entry.id;
  const date = showAddedDate ? entry.createdAt : latestEntryUpdate(entry);
  const t = useT();
  const [imageLoadFailed, setImageLoadFailed] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  const imageSrc = !imageLoadFailed && entry.thumbnailPath ? getImageSrc(entry.thumbnailPath, entry) : "";
  const detailClass = "font-bold text-foreground/60 transition-colors hover:text-foreground";
  const isMultiFile = entry.fileRefs.length > 1;
  const missingFileCount = entry.fileRefs.filter((file) => file.available === false).length;
  const fileActionProps = { entry, onRemoveFile, onRelinkFile };

  return (
    <div className={cn("group px-3 py-2.5 hover:bg-surface-low/50", selected && "bg-primary/5")}>
      <div className="relative flex flex-wrap items-center gap-x-5 gap-y-3 lg:flex-nowrap lg:gap-6">
        <Checkbox
          aria-label={t.library.selectEntry(id)}
          disabled={selectionDisabled}
          checked={selected}
          onCheckedChange={onToggleSelected}
        />
        <div className="relative h-[68px] w-12 shrink-0 overflow-hidden rounded-[var(--radius-quiet-sm)] bg-surface-low shadow-sm">
          {imageSrc ? (
            <img
              alt={title}
              className="h-full w-full object-cover"
              onError={() => setImageLoadFailed(true)}
              src={imageSrc}
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-surface-low to-surface-raised text-[10px] font-numeric font-bold text-muted-foreground">
              {id.slice(0, 2).toUpperCase()}
            </div>
          )}
        </div>
        <div className="flex min-w-0 flex-1 basis-40 flex-col justify-center">
          <div className="flex items-center gap-2.5">
            <span className="shrink-0 rounded bg-foreground/5 px-2 py-0.5 font-mono text-[11px] font-bold tracking-wider text-foreground/60">
              {id}
            </span>
            <span className="truncate text-base font-bold tracking-tight text-foreground">{title}</span>
          </div>
          <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1.5 text-[11px]">
            <ActorChips actors={entry.actors} />
            {isMultiFile && (
              <button
                aria-expanded={filesOpen}
                className={cn(
                  "inline-flex shrink-0 items-center gap-1 rounded-full border px-2.5 py-0.5 font-semibold transition-colors",
                  missingFileCount > 0
                    ? "border-amber-500/40 bg-amber-500/10 text-amber-700 hover:bg-amber-500/20 dark:text-amber-400"
                    : "border-border/80 bg-surface-low text-foreground/70 hover:text-foreground",
                )}
                onClick={() => setFilesOpen((open) => !open)}
                type="button"
              >
                <Layers className="h-3 w-3" />
                {missingFileCount > 0
                  ? t.library.partsMissing(missingFileCount, entry.fileRefs.length)
                  : t.library.parts(entry.fileRefs.length)}
                <ChevronDown className={cn("h-3 w-3 transition-transform", filesOpen && "rotate-180")} />
              </button>
            )}
            {displayFile && (
              <span
                className="truncate font-mono font-medium text-muted-foreground/70"
                title={[displayFile.rootDisplayName, displayFile.relativePath].filter(Boolean).join(" / ")}
              >
                {displayFile.fileName}
              </span>
            )}
          </div>
        </div>
        <div className="hidden shrink-0 items-center gap-6 font-numeric text-xs font-semibold text-muted-foreground lg:flex">
          <span className="text-foreground/75">{formatBytes(entry.size)}</span>
          <time
            className="min-w-24 text-right text-muted-foreground/80"
            dateTime={date}
            title={showAddedDate ? t.library.sort.fields.createdAt : t.library.updatedAt}
          >
            {formatDate(date)}
          </time>
        </div>
        <div className="ml-auto flex items-center gap-1.5 lg:pl-2">
          <StatusActionSlot available={entry.available} entry={entry} onDeleteEntries={onDeleteEntries} />
          <div className="flex items-center gap-1">
            {LinkComponent ? (
              <LinkComponent className={detailClass} entry={entry}>
                <Badge className="px-3 py-1 font-bold tracking-wide" variant="secondary">
                  {t.library.scrapeInfo}
                </Badge>
              </LinkComponent>
            ) : null}
            {!isMultiFile && displayFile ? (
              <LibraryFileActions file={displayFile} {...fileActionProps} />
            ) : (
              <div className="h-8 w-8" />
            )}
          </div>
        </div>
      </div>
      {isMultiFile && filesOpen && (
        <div className="ml-[106px] mt-3 flex flex-col border-t border-border/40 pt-2 lg:ml-[114px]">
          {entry.fileRefs.map((file) => (
            <LibraryFileRow file={file} key={file.id} {...fileActionProps} />
          ))}
        </div>
      )}
    </div>
  );
}

function StatusActionSlot({
  available,
  entry,
  onDeleteEntries,
}: {
  available: LibraryEntryDto["available"];
  entry: LibraryEntryDto;
  onDeleteEntries: LibraryIndexViewProps["onDeleteEntries"];
}) {
  const t = useT();

  return (
    <div className="relative flex h-8 w-8 shrink-0 items-center justify-center">
      <div className="transition-opacity group-hover:opacity-0 group-focus-within:opacity-0">
        <StatusDot available={available} />
      </div>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            aria-label={t.library.removeFromLibrary}
            className="absolute inset-0 h-8 w-8 text-muted-foreground opacity-0 transition-all hover:bg-surface-raised hover:text-destructive group-hover:opacity-100 group-focus-within:opacity-100"
            onClick={() => onDeleteEntries([entry])}
            size="icon"
            type="button"
            variant="ghost"
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{t.library.removeFromLibrary}</TooltipContent>
      </Tooltip>
    </div>
  );
}

function StatusDot({ available }: { available: LibraryEntryDto["available"] }) {
  const t = useT();
  if (available === "unavailable" || available === "partial") {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="h-2 w-2 shrink-0 rounded-full bg-amber-500 shadow-[0_0_8px_rgba(245,158,11,0.5)]" />
        </TooltipTrigger>
        <TooltipContent>{t.library.availability[available]}</TooltipContent>
      </Tooltip>
    );
  }
  if (available === "unchecked") {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="h-2 w-2 shrink-0 rounded-full bg-muted-foreground/30" />
        </TooltipTrigger>
        <TooltipContent>{t.library.availabilityNotChecked}</TooltipContent>
      </Tooltip>
    );
  }
  return <div className="h-2 w-2 shrink-0 rounded-full bg-emerald-500/40" />;
}

type LibraryFileActionProps = {
  entry: LibraryEntryDto;
  file: LibraryEntryDto["fileRefs"][number];
  onRemoveFile?: LibraryIndexViewProps["onRemoveFile"];
  onRelinkFile?: LibraryIndexViewProps["onRelinkFile"];
};

function LibraryFileRow(props: LibraryFileActionProps) {
  const { file } = props;
  const t = useT();
  const statusLabel =
    file.available === null
      ? t.library.fileStatus.unchecked
      : file.available
        ? t.library.fileStatus.available
        : t.library.fileStatus.unavailable;

  return (
    <div className="grid grid-cols-[2.5rem_minmax(0,1fr)_auto_auto_auto] items-center gap-x-4 rounded-[var(--radius-quiet-sm)] px-2 py-1.5 text-xs transition-colors hover:bg-surface-low">
      <span className="font-mono text-[11px] font-bold text-foreground/50">
        {file.partNumber ? `CD${file.partNumber}` : ""}
      </span>
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="truncate font-semibold text-foreground/90" title={file.fileName}>
          {file.fileName}
        </span>
        <span className="flex min-w-0 text-[11px]">
          <MiddleEllipsisPath rootDisplayName={file.rootDisplayName} relativePath={file.relativePath} />
        </span>
        {file.availabilityError && <span className="text-destructive">{file.availabilityError}</span>}
      </div>
      <span className="font-numeric text-muted-foreground">{file.resolution ?? ""}</span>
      <span className="font-numeric font-bold text-foreground/80">{formatBytes(file.size)}</span>
      <div className="flex items-center gap-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <div
              className={cn(
                "h-2 w-2 shrink-0 rounded-full",
                file.available === null
                  ? "bg-muted-foreground/30"
                  : file.available
                    ? "bg-emerald-500/40"
                    : "bg-amber-500 shadow-[0_0_8px_rgba(245,158,11,0.5)]",
              )}
            />
          </TooltipTrigger>
          <TooltipContent>{statusLabel}</TooltipContent>
        </Tooltip>
        <LibraryFileActions {...props} />
      </div>
    </div>
  );
}

function LibraryFileActions({ entry, file, onRemoveFile, onRelinkFile }: LibraryFileActionProps) {
  const t = useT();
  const [menuOpen, setMenuOpen] = useState(false);
  const [action, setAction] = useState<"remove" | "relink" | null>(null);
  const [relativePath, setRelativePath] = useState(file.relativePath);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const path = file.lastKnownPath ?? file.relativePath;
  // Single-file entries already expose removal on the card itself.
  const isMultiFile = entry.fileRefs.length > 1;
  const menuItemClass = "h-8 w-full justify-start gap-2 px-2 text-xs font-medium";
  const openDialog = (next: "remove" | "relink") => {
    setMenuOpen(false);
    setError(null);
    setRelativePath(file.relativePath);
    setAction(next);
  };

  return (
    <>
      <Popover open={menuOpen} onOpenChange={setMenuOpen}>
        <PopoverTrigger asChild>
          <Button
            aria-label={t.library.fileActions}
            className="h-8 w-8 text-muted-foreground transition-all hover:bg-surface-raised hover:text-foreground"
            size="icon"
            type="button"
            variant="ghost"
          >
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="flex w-44 flex-col p-1">
          <Button
            className={menuItemClass}
            onClick={() => {
              setMenuOpen(false);
              copyText(path).catch((cause) => toast.error(String(cause)));
            }}
            type="button"
            variant="ghost"
          >
            <Copy className="h-3.5 w-3.5" />
            {t.library.copyPath}
          </Button>
          {onRelinkFile && (
            <Button className={menuItemClass} onClick={() => openDialog("relink")} type="button" variant="ghost">
              <Link2 className="h-3.5 w-3.5" />
              {t.library.relink}
            </Button>
          )}
          {isMultiFile && onRemoveFile && (
            <Button
              className={cn(menuItemClass, "text-destructive hover:text-destructive")}
              onClick={() => openDialog("remove")}
              type="button"
              variant="ghost"
            >
              <Trash2 className="h-3.5 w-3.5" />
              {t.library.removeFile}
            </Button>
          )}
        </PopoverContent>
      </Popover>
      <Dialog
        open={action !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setAction(null);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{action === "remove" ? t.library.removeFile : t.library.relinkFileTitle}</DialogTitle>
          </DialogHeader>
          <p className="break-all font-mono text-xs text-muted-foreground">{path}</p>
          {action === "remove" ? (
            <p>{t.library.removeFileDescription}</p>
          ) : (
            <label className="grid gap-2 text-sm" htmlFor={`relink-path-${file.id}`}>
              <span className="text-muted-foreground">{t.library.mediaFolderLabel(file.rootDisplayName)}</span>
              {t.library.newRelativePath}
              <Input
                id={`relink-path-${file.id}`}
                value={relativePath}
                onChange={(event) => setRelativePath(event.target.value)}
              />
            </label>
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button disabled={busy} onClick={() => setAction(null)} variant="outline">
              {t.common.cancel}
            </Button>
            <Button
              disabled={busy}
              variant={action === "remove" ? "destructive" : "default"}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  if (action === "remove") await onRemoveFile?.({ fileId: file.id });
                  else await onRelinkFile?.({ fileId: file.id, rootId: file.rootId, relativePath });
                  setAction(null);
                } catch (cause) {
                  setError(cause instanceof Error ? cause.message : String(cause));
                } finally {
                  setBusy(false);
                }
              }}
            >
              {action === "remove" ? (busy ? t.pending.submitting : t.library.confirmRemove) : t.library.confirm}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function ActorChips({ actors }: { actors: string[] }) {
  return (
    <div className="hidden shrink-0 items-center gap-1.5 sm:flex">
      {actors.slice(0, 3).map((actor) => (
        <span
          className="rounded-full border border-border/80 bg-surface-low px-2.5 py-0.5 text-[11px] font-semibold text-foreground/80"
          key={actor}
        >
          {actor}
        </span>
      ))}
      {actors.length > 3 && (
        <span className="font-numeric text-[11px] font-bold text-muted-foreground/40">+{actors.length - 3}</span>
      )}
    </div>
  );
}

function MiddleEllipsisPath({ rootDisplayName, relativePath }: { rootDisplayName: string; relativePath: string }) {
  const normalizedRoot = rootDisplayName.trim();
  const normalizedRelative = relativePath.trim().replace(/^[\\/]+/u, "");
  const fullPath = [normalizedRoot, normalizedRelative].filter(Boolean).join(" / ");

  return (
    <span
      className="flex min-w-0 flex-1 items-center overflow-hidden font-mono font-medium text-muted-foreground/70"
      title={fullPath}
    >
      <span className="min-w-0 truncate">{normalizedRoot}</span>
      {normalizedRelative ? (
        <>
          <span className="shrink-0 px-1">/</span>
          <span className="min-w-0 truncate text-right [direction:rtl]">
            <span className="[unicode-bidi:plaintext]">{normalizedRelative}</span>
          </span>
        </>
      ) : null}
    </span>
  );
}

const formatDate = (value: string | null | undefined): string =>
  value ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(value)) : "-";

const latestEntryUpdate = (entry: Pick<LibraryEntryDto, "createdAt" | "lastRefreshedAt" | "fileRefs">): string =>
  [entry.createdAt, entry.lastRefreshedAt, ...entry.fileRefs.map((file) => file.modifiedAt)]
    .filter((value): value is string => Boolean(value))
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? entry.createdAt;
