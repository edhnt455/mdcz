import { toErrorMessage } from "@mdcz/shared/error";
import type { MediaLibraryDto } from "@mdcz/shared/mediaLibrary";
import type {
  AmbiguousCandidate,
  NumberRecognitionAttempt,
  PendingBatchInput,
  PendingBatchResponse,
  PendingConfirmUncensoredInput,
  PendingDetailResponse,
  PendingItemDto,
  PendingKindDto,
  PendingRetryInput,
  PendingSiteResultDto,
} from "@mdcz/shared/pending";
import { PENDING_KINDS } from "@mdcz/shared/pending";
import {
  Badge,
  Button,
  Checkbox,
  cn,
  Input,
  Label,
  quietPanelSurfaceClass,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@mdcz/ui";
import {
  AlertCircle,
  CheckCircle2,
  CircleDashed,
  FilePlus2,
  FileQuestion,
  Inbox,
  Layers,
  Loader2,
  type LucideIcon,
  RotateCcw,
  SearchX,
  Tag,
  Trash2,
  XCircle,
} from "lucide-react";
import { type ReactNode, useEffect, useId, useState } from "react";
import { confirmDialog } from "../common";
import { useT } from "../i18n";

const KIND_BADGE_META: Record<PendingKindDto, { className: string; icon: LucideIcon; iconClassName?: string }> = {
  uncensored: {
    className: "border-foreground bg-foreground text-background shadow-2xs",
    icon: Tag,
  },
  ambiguous: {
    className: "border-foreground/25 bg-surface text-foreground shadow-2xs",
    icon: Layers,
    iconClassName: "text-foreground/80",
  },
  new_file: {
    className: "border-border bg-surface text-foreground/85",
    icon: FilePlus2,
    iconClassName: "text-muted-foreground",
  },
  not_found: {
    className: "border-border/80 bg-surface-raised/75 text-foreground/85",
    icon: SearchX,
    iconClassName: "text-muted-foreground",
  },
  failed: {
    className: "border-border/80 bg-surface-raised/75 text-foreground/85",
    icon: AlertCircle,
    iconClassName: "text-muted-foreground",
  },
  no_number: {
    className: "border-border/60 bg-surface-low text-muted-foreground",
    icon: FileQuestion,
    iconClassName: "text-muted-foreground/75",
  },
};

const ACTION_ROW_CLASS = "grid grid-cols-1 gap-2.5 sm:grid-cols-[minmax(0,1fr)_8.5rem]";

export interface PendingViewProps {
  items: PendingItemDto[];
  loading?: boolean;
  errorMessage?: string | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
  detail?: PendingDetailResponse | null;
  detailLoading?: boolean;
  libraries: MediaLibraryDto[];
  onRetry: (input: PendingRetryInput) => Promise<void>;
  onRetryNumberRecognition: (id: string) => Promise<void>;
  onConfirmUncensored: (input: PendingConfirmUncensoredInput) => Promise<void>;
  onIgnore: (id: string) => Promise<void>;
  onBatch: (input: PendingBatchInput) => Promise<PendingBatchResponse>;
}

export function PendingView({
  items,
  loading = false,
  errorMessage,
  selectedId,
  onSelect,
  detail,
  detailLoading = false,
  libraries,
  onRetry,
  onRetryNumberRecognition,
  onConfirmUncensored,
  onIgnore,
  onBatch,
}: PendingViewProps) {
  const t = useT();
  const selectAllId = useId();
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set());
  const [batchAction, setBatchAction] = useState<PendingBatchInput["action"] | null>(null);
  const [kindFilter, setKindFilter] = useState<PendingKindDto | "all">("all");
  const [batchLibrary, setBatchLibrary] = useState("own");
  const [batchChoice, setBatchChoice] = useState<"uncensored" | "umr" | "leak">("uncensored");
  const [detailBusy, setDetailBusy] = useState(false);
  const [batchResult, setBatchResult] = useState<PendingBatchResponse | null>(null);
  const [resultAction, setResultAction] = useState<PendingBatchInput["action"] | null>(null);
  const [batchError, setBatchError] = useState<string | null>(null);
  const visibleItems = kindFilter === "all" ? items : items.filter((item) => item.kind === kindFilter);
  const selectedItems = visibleItems.filter((item) => checkedIds.has(item.id));
  const retryItems = selectedItems.filter((item) => !["uncensored", "ambiguous", "no_number"].includes(item.kind));
  const confirmItems = selectedItems.filter((item) => item.kind === "uncensored");
  const busy = batchAction !== null || detailBusy;
  useEffect(() => {
    const availableIds = new Set(items.map((item) => item.id));
    setCheckedIds((current) => {
      if ([...current].every((id) => availableIds.has(id))) return current;
      return new Set([...current].filter((id) => availableIds.has(id)));
    });
  }, [items]);
  const runBatch = async (action: PendingBatchInput["action"]) => {
    if (busy || !selectedItems.length) return;
    const ids = (action === "retry" ? retryItems : action === "confirm" ? confirmItems : selectedItems).map(
      (item) => item.id,
    );
    if (!ids.length) return;
    setBatchAction(action);
    try {
      if (
        action === "ignore" &&
        !(await confirmDialog({
          title: t.pending.batchIgnoreConfirm(ids.length),
          description: t.pending.batchIgnoreDescription,
          confirmLabel: t.pending.batchIgnore,
        }))
      )
        return;
      if (
        action === "confirm" &&
        !(await confirmDialog({
          title: t.pending.batchConfirmPrompt(ids.length),
          description: t.pending.batchConfirmDescription(t.pending.confirmTypes[batchChoice]),
          confirmLabel: t.pending.batchConfirm,
        }))
      )
        return;
      setBatchError(null);
      setBatchResult(null);
      const input: PendingBatchInput =
        action === "retry"
          ? { action, ids, ...(batchLibrary === "own" ? {} : { libraryId: batchLibrary }) }
          : action === "confirm"
            ? { action, ids, choice: batchChoice }
            : { action, ids };
      const result = await onBatch(input);
      setBatchResult(result);
      setResultAction(action);
      const succeeded = new Set(result.succeededIds);
      setCheckedIds((current) => new Set([...current].filter((id) => !succeeded.has(id))));
    } catch (error) {
      setBatchError(toErrorMessage(error));
    } finally {
      setBatchAction(null);
    }
  };
  if (!loading && items.length === 0 && !errorMessage && !batchResult && !batchError) {
    return (
      <main className="flex h-full min-h-0 flex-col bg-surface-canvas p-4 text-foreground">
        <h1 className="px-1 text-lg font-bold tracking-tight">{t.pending.title}</h1>
        <div className="flex flex-1 flex-col items-center justify-center gap-3 pb-16 text-sm text-muted-foreground">
          <Inbox className="h-10 w-10 text-muted-foreground/40" />
          {t.pending.empty}
        </div>
      </main>
    );
  }
  return (
    <main className="grid h-full min-h-0 grid-cols-1 gap-0 bg-surface-canvas text-foreground lg:grid-cols-[22rem_minmax(0,1fr)]">
      <section className="flex min-h-0 flex-col border-border/60 p-4 lg:border-r">
        <div className="mb-3 flex shrink-0 items-center justify-between px-1">
          <h1 className="text-lg font-bold tracking-tight">{t.pending.title}</h1>
          <span className="rounded-full bg-surface-low px-2.5 py-0.5 font-numeric text-xs font-bold text-muted-foreground">
            {items.length}
          </span>
        </div>
        <div className="mb-3 shrink-0 space-y-3 rounded-quiet-lg border border-border/60 bg-surface-low/60 p-3">
          <Select
            value={kindFilter}
            disabled={busy}
            onValueChange={(value) => {
              setKindFilter(value as PendingKindDto | "all");
              setCheckedIds(new Set());
            }}
          >
            <SelectTrigger aria-label={t.pending.kindFilter} className="h-8 w-full text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">
                {t.pending.allKinds} ({items.length})
              </SelectItem>
              {PENDING_KINDS.map((kind) => {
                const count = items.filter((item) => item.kind === kind).length;
                return count ? (
                  <SelectItem key={kind} value={kind}>
                    {t.pending.kinds[kind]} ({count})
                  </SelectItem>
                ) : null;
              })}
            </SelectContent>
          </Select>
          <div className="flex items-center justify-between gap-2 text-xs">
            <label htmlFor={selectAllId} className="flex cursor-pointer items-center gap-2">
              <Checkbox
                id={selectAllId}
                aria-label={t.pending.selectAll}
                checked={
                  selectedItems.length > 0 && selectedItems.length === visibleItems.length
                    ? true
                    : selectedItems.length > 0
                      ? "indeterminate"
                      : false
                }
                disabled={busy || loading || !visibleItems.length}
                onCheckedChange={(checked) =>
                  setCheckedIds(new Set(checked === true ? visibleItems.map((item) => item.id) : []))
                }
              />
              {t.pending.selectAll}
            </label>
            <span className="text-muted-foreground">{t.pending.selectedCount(selectedItems.length)}</span>
          </div>
          <Select value={batchLibrary} onValueChange={setBatchLibrary} disabled={busy}>
            <SelectTrigger aria-label={t.pending.batchLibrary} className="h-8 w-full text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="own">{t.pending.ownLibrary}</SelectItem>
              {libraries.map((library) => (
                <SelectItem key={library.id} value={library.id}>
                  {library.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="grid grid-cols-2 gap-2">
            <Button size="sm" disabled={busy || !retryItems.length} onClick={() => void runBatch("retry")}>
              {batchAction === "retry" ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <RotateCcw className="size-3.5" />
              )}
              {t.pending.batchRetry}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={busy || !selectedItems.length}
              onClick={() => void runBatch("ignore")}
            >
              {batchAction === "ignore" ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Trash2 className="size-3.5" />
              )}
              {t.pending.batchIgnore}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">{t.pending.batchRetryHint}</p>
          {confirmItems.length > 0 ? (
            <div className="flex gap-2">
              <Select
                value={batchChoice}
                onValueChange={(value) => setBatchChoice(value as typeof batchChoice)}
                disabled={busy}
              >
                <SelectTrigger aria-label={t.pending.batchConfirmType} className="h-8 min-w-0 flex-1 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(["uncensored", "umr", "leak"] as const).map((choice) => (
                    <SelectItem key={choice} value={choice}>
                      {t.pending.confirmTypes[choice]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button size="sm" disabled={busy} onClick={() => void runBatch("confirm")}>
                {batchAction === "confirm" ? <Loader2 className="size-3.5 animate-spin" /> : null}
                {t.pending.batchConfirmCount(confirmItems.length)}
              </Button>
            </div>
          ) : null}
        </div>
        {batchResult ? (
          <div role="status" className="mb-3 shrink-0 space-y-2 rounded-quiet border border-border/60 p-3 text-xs">
            <p>
              {(resultAction === "retry" ? t.pending.batchRetryResult : t.pending.batchResult)(
                batchResult.succeededIds.length,
                batchResult.failures.length,
              )}
            </p>
            {batchResult.failures.length > 0 ? (
              <ul className="max-h-36 space-y-1 overflow-y-auto text-destructive">
                {batchResult.failures.map(({ id, message }) => (
                  <li key={id} className="break-words">
                    {items.find((item) => item.id === id)?.fileName ?? id}: {message}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
        {batchError ? (
          <p role="alert" className="mb-3 text-xs text-destructive">
            {batchError}
          </p>
        ) : null}
        {errorMessage ? (
          <div className="mb-3 flex items-center gap-2 rounded-quiet border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            <AlertCircle className="h-4 w-4 shrink-0" />
            {t.pending.loadFailed(errorMessage)}
          </div>
        ) : null}
        <ul className="min-h-0 flex-1 space-y-2 overflow-y-auto p-1">
          {visibleItems.map((item) => {
            const active = item.id === selectedId;
            return (
              <li key={item.id} className="flex items-center gap-2">
                <Checkbox
                  aria-label={t.pending.selectItem(item.fileName)}
                  checked={checkedIds.has(item.id)}
                  disabled={busy}
                  onCheckedChange={(checked) =>
                    setCheckedIds((current) => {
                      const next = new Set(current);
                      if (checked === true) next.add(item.id);
                      else next.delete(item.id);
                      return next;
                    })
                  }
                />
                <button
                  type="button"
                  disabled={busy}
                  aria-pressed={active}
                  onClick={() => onSelect(item.id)}
                  className={cn(
                    quietPanelSurfaceClass,
                    "min-w-0 flex-1 rounded-quiet-lg px-3.5 py-3 text-left transition-all",
                    active
                      ? "border-foreground/35 bg-surface-floating shadow-sm ring-1 ring-foreground/10"
                      : "bg-surface/60 hover:border-border hover:bg-surface-floating/80",
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <KindBadge kind={item.kind} />
                    {item.number ? (
                      <span className="rounded border border-border/60 bg-surface-low/70 px-1.5 py-0.5 font-mono text-[11px] font-semibold tracking-tight text-muted-foreground">
                        {item.number}
                      </span>
                    ) : null}
                  </div>
                  <div className="mt-2 truncate text-sm font-semibold tracking-tight" title={item.path}>
                    {item.fileName}
                  </div>
                  <div className="mt-0.5 truncate text-xs text-muted-foreground">
                    {item.libraryName ?? t.pending.noLibrary} ·{" "}
                    {t.pending.updated(new Date(item.updatedAt).toLocaleString())}
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
        {!loading && items.length > 0 && !visibleItems.length ? (
          <p className="py-6 text-center text-sm text-muted-foreground">{t.pending.filterEmpty}</p>
        ) : null}
        {!loading && !items.length ? (
          <p className="py-6 text-center text-sm text-muted-foreground">{t.pending.empty}</p>
        ) : null}
      </section>
      <section className="min-h-0 overflow-y-auto p-6 lg:p-8">
        {detailLoading && !detail ? <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /> : null}
        {detail ? (
          <PendingDetail
            key={detail.item.id}
            detail={detail}
            libraries={libraries}
            onRetry={onRetry}
            onRetryNumberRecognition={onRetryNumberRecognition}
            onConfirmUncensored={onConfirmUncensored}
            onIgnore={onIgnore}
            busy={busy}
            onBusyChange={setDetailBusy}
          />
        ) : null}
      </section>
    </main>
  );
}

function KindBadge({ kind }: { kind: PendingKindDto }) {
  const t = useT();
  const { className, icon: Icon, iconClassName } = KIND_BADGE_META[kind];
  return (
    <Badge variant="outline" className={cn("gap-1.5 px-2.5 py-0.5 font-medium tracking-tight", className)}>
      <Icon className={cn("size-3 shrink-0", iconClassName)} />
      {t.pending.kinds[kind]}
    </Badge>
  );
}

function PendingDetail({
  detail,
  libraries,
  onRetry,
  onRetryNumberRecognition,
  onConfirmUncensored,
  onIgnore,
  busy,
  onBusyChange,
}: {
  detail: PendingDetailResponse;
  libraries: MediaLibraryDto[];
  onRetry: PendingViewProps["onRetry"];
  onRetryNumberRecognition: PendingViewProps["onRetryNumberRecognition"];
  onConfirmUncensored: PendingViewProps["onConfirmUncensored"];
  onIgnore: PendingViewProps["onIgnore"];
  busy: boolean;
  onBusyChange: (busy: boolean) => void;
}) {
  const t = useT();
  const { item, siteResults } = detail;
  const [recognitionRunning, setRecognitionRunning] = useState(false);
  const [recognitionError, setRecognitionError] = useState<string | null>(null);
  const [libraryId, setLibraryId] = useState(item.libraryId ?? libraries[0]?.id ?? "");
  useEffect(() => setLibraryId(item.libraryId ?? libraries[0]?.id ?? ""), [item.libraryId, libraries]);
  const run = async (action: () => Promise<void>) => {
    onBusyChange(true);
    try {
      await action();
    } finally {
      onBusyChange(false);
    }
  };
  const retry = (input: Omit<PendingRetryInput, "id" | "libraryId">) =>
    run(() => onRetry({ id: item.id, ...(libraryId ? { libraryId } : {}), ...input }));
  const retryNumberRecognition = async () => {
    if (busy || recognitionRunning) return;
    setRecognitionError(null);
    setRecognitionRunning(true);
    try {
      await run(() => onRetryNumberRecognition(item.id));
    } catch (error) {
      setRecognitionError(toErrorMessage(error));
    } finally {
      setRecognitionRunning(false);
    }
  };
  const scrapable = item.kind !== "uncensored";
  const showIgnoreToken = item.kind === "no_number" || item.kind === "not_found";

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <header className={cn(quietPanelSurfaceClass, "space-y-3 rounded-quiet-xl p-5")}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <KindBadge kind={item.kind} />
              {item.number ? (
                <span className="rounded border border-border/60 bg-surface-low/70 px-2 py-0.5 font-mono text-xs font-semibold tracking-tight text-muted-foreground">
                  {item.number}
                </span>
              ) : null}
            </div>
            <h2 className="break-words text-lg font-bold tracking-tight">{item.fileName}</h2>
            <div className="break-words font-mono text-xs text-muted-foreground">{item.path}</div>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="h-8 shrink-0 gap-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
            disabled={busy}
            onClick={async () => {
              if (await confirmDialog({ title: t.pending.ignoreConfirm, confirmLabel: t.pending.ignore }))
                await run(() => onIgnore(item.id));
            }}
          >
            <Trash2 className="h-3.5 w-3.5" />
            {t.pending.ignore}
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">{t.pending.kindDescriptions[item.kind]}</p>
        {item.detail && item.kind !== "ambiguous" ? (
          <p className="rounded-quiet border border-border/50 bg-surface-low/80 px-3 py-2 font-mono text-xs break-words text-foreground/85">
            {item.detail}
          </p>
        ) : null}
        {item.kind === "uncensored" ? (
          <div className="flex flex-wrap gap-2 pt-1">
            {(["uncensored", "umr", "leak"] as const).map((choice) => (
              <Button
                key={choice}
                disabled={busy}
                onClick={() => void run(() => onConfirmUncensored({ id: item.id, choice }))}
              >
                {t.pending.confirmTypes[choice]}
              </Button>
            ))}
          </div>
        ) : null}
      </header>

      {scrapable ? (
        <NumberRecognitionBlock
          attempt={detail.numberRecognition}
          currentNumber={item.number}
          busy={busy}
          running={recognitionRunning}
          error={recognitionError}
          onRetry={() => void retryNumberRecognition()}
          canApply={Boolean(libraryId) && !busy}
          onApply={(number) => void retry({ number })}
        />
      ) : null}

      {item.candidates.length > 0 ? (
        <Block title={t.pending.candidatesTitle}>
          <CandidateGroups
            candidates={item.candidates}
            disabled={busy || !libraryId}
            onChoose={(index) => void retry({ candidate: index })}
          />
        </Block>
      ) : null}

      {scrapable ? (
        <Block title={t.pending.retry}>
          <div className="divide-y divide-border/40">
            <div className="pb-4">
              {libraries.length > 0 ? (
                <LabeledRow label={t.pending.chooseLibrary}>
                  {(id) => (
                    <div className={ACTION_ROW_CLASS}>
                      <Select value={libraryId} onValueChange={setLibraryId}>
                        <SelectTrigger id={id} className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {libraries.map((library) => (
                            <SelectItem key={library.id} value={library.id}>
                              {library.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Button
                        variant="outline"
                        className="w-full justify-center"
                        disabled={busy || !libraryId}
                        onClick={() => void retry({})}
                      >
                        <RotateCcw className="h-4 w-4" />
                        {item.kind === "new_file" ? t.pending.scrape : t.pending.retry}
                      </Button>
                    </div>
                  )}
                </LabeledRow>
              ) : (
                <Button variant="outline" disabled={busy || !libraryId} onClick={() => void retry({})}>
                  <RotateCcw className="h-4 w-4" />
                  {item.kind === "new_file" ? t.pending.scrape : t.pending.retry}
                </Button>
              )}
            </div>
            <div className="py-4">
              <NumberRetry item={item} disabled={busy || !libraryId} onRetry={(input) => void retry(input)} />
            </div>
            <div className={cn("py-4", !showIgnoreToken && "pb-0")}>
              <UrlRetry disabled={busy || !libraryId} onRetry={(manualUrl) => void retry({ manualUrl })} />
            </div>
            {showIgnoreToken ? (
              <div className="pt-4">
                <IgnoreTokenRetry
                  disabled={busy || !libraryId}
                  onRetry={(token) => void retry({ rule: { kind: "ignoreToken", token } })}
                />
              </div>
            ) : null}
          </div>
        </Block>
      ) : null}

      {item.number ? (
        <Block title={t.pending.siteResultsTitle}>
          {siteResults.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t.pending.noSiteResults}</p>
          ) : (
            <ul className="divide-y divide-border/40">
              {siteResults.map((result) => (
                <SiteResultRow key={result.site} result={result} />
              ))}
            </ul>
          )}
        </Block>
      ) : null}
    </div>
  );
}

function NumberRecognitionBlock({
  attempt,
  currentNumber,
  busy,
  running,
  error,
  onRetry,
  canApply,
  onApply,
}: {
  attempt: NumberRecognitionAttempt | null;
  currentNumber: string | null;
  busy: boolean;
  running: boolean;
  error: string | null;
  onRetry: () => void;
  canApply: boolean;
  onApply: (number: string) => void;
}) {
  const t = useT();
  const labels = t.pending.recognition;
  const suggestedNumber = attempt?.status === "recognized" && attempt.number !== currentNumber ? attempt.number : null;
  return (
    <Block title={labels.title}>
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="outline" disabled={busy} onClick={onRetry}>
          {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
          {running ? labels.retrying : labels.retry}
        </Button>
        <p className="text-xs text-muted-foreground">{labels.retryHint}</p>
      </div>
      {error ? (
        <p role="alert" className="break-words text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <p className="text-xs text-muted-foreground">{labels.hint}</p>
      {!attempt ? (
        <p className="text-sm text-muted-foreground">{labels.noRecord}</p>
      ) : (
        <>
          <p className="text-xs font-medium text-muted-foreground">
            {labels.triggers[attempt.status === "skipped" ? "automatic" : (attempt.trigger ?? "unknown")]}
          </p>
          <p className="text-sm font-semibold">{labels.statuses[attempt.status]}</p>
          {attempt.status === "skipped" ? (
            <p className="text-sm text-muted-foreground">{labels.skipReasons[attempt.reason]}</p>
          ) : (
            <>
              {suggestedNumber ? (
                <div className="space-y-2 rounded-quiet border border-border/60 bg-surface-low/50 p-3">
                  <p className="text-sm text-muted-foreground">{labels.notApplied(currentNumber, suggestedNumber)}</p>
                  <Button variant="outline" disabled={!canApply} onClick={() => onApply(suggestedNumber)}>
                    <RotateCcw className="h-4 w-4" />
                    {labels.apply}
                  </Button>
                </div>
              ) : null}
              <dl className="grid grid-cols-1 gap-x-4 gap-y-2 text-sm sm:grid-cols-[auto_minmax(0,1fr)]">
                {[
                  [labels.previousNumber, attempt.previousNumber],
                  [labels.number, attempt.number],
                  [labels.evidence, attempt.evidence],
                  [labels.fileName, attempt.fileName],
                  [labels.parentDirectory, attempt.parentDirectory],
                  [labels.model, attempt.model],
                  [labels.elapsed, `${(attempt.elapsedMs / 1000).toFixed(1)}s`],
                ].map(([label, value]) => (
                  <div key={label} className="contents">
                    <dt className="text-muted-foreground">{label}</dt>
                    <dd className="min-w-0 break-words font-mono text-xs">{value || labels.none}</dd>
                  </div>
                ))}
              </dl>
              {attempt.error ? <p className="break-words text-sm text-destructive">{attempt.error}</p> : null}
              <details className="text-xs">
                <summary className="cursor-pointer text-muted-foreground">{labels.rawResponse}</summary>
                <pre className="mt-2 max-h-64 overflow-y-auto rounded-quiet bg-surface-low p-3 whitespace-pre-wrap break-words">
                  {attempt.rawResponse ?? labels.noResponse}
                </pre>
              </details>
              <details className="text-xs">
                <summary className="cursor-pointer text-muted-foreground">{labels.prompt}</summary>
                <div className="mt-2 max-h-64 space-y-2 overflow-y-auto rounded-quiet bg-surface-low p-3">
                  <p className="text-muted-foreground">{labels.systemPrompt}</p>
                  <pre className="whitespace-pre-wrap break-words">{attempt.systemPrompt || labels.none}</pre>
                  <p className="text-muted-foreground">{labels.userPrompt}</p>
                  <pre className="whitespace-pre-wrap break-words">{attempt.prompt}</pre>
                </div>
              </details>
            </>
          )}
        </>
      )}
    </Block>
  );
}

function SiteResultRow({ result }: { result: PendingSiteResultDto }) {
  const t = useT();
  const seconds = `${(result.elapsedMs / 1000).toFixed(1)}s`;
  const reason = result.reason ? t.domain.failureReasons[result.reason] : "";
  const outcome =
    result.status === "success"
      ? t.pending.siteResult.success
      : result.status === "skipped"
        ? t.pending.siteResult.skipped(
            result.skipReason
              ? reason
                ? `${t.pending.skipReasons[result.skipReason]} (${reason})`
                : t.pending.skipReasons[result.skipReason]
              : reason,
          )
        : t.pending.siteResult.failed(reason || (result.detail ?? ""));

  const Icon = result.status === "success" ? CheckCircle2 : result.status === "failed" ? XCircle : CircleDashed;
  const iconClass = result.status === "success" ? "text-foreground/80" : "text-muted-foreground";

  return (
    <li
      aria-label={`${result.site}: ${outcome} (${seconds})`}
      className="flex items-center justify-between gap-3 py-2.5 text-xs first:pt-1 last:pb-0"
    >
      <div className="flex min-w-0 items-center gap-2">
        <Icon className={cn("h-3.5 w-3.5 shrink-0", iconClass)} />
        <span className="shrink-0 font-mono font-bold text-foreground">{result.site}</span>
        <span className="truncate text-muted-foreground">{outcome}</span>
      </div>
      <span className="shrink-0 font-mono text-[11px] text-muted-foreground/70">{seconds}</span>
    </li>
  );
}

/** Sites disagree on details such as release dates, so works stay grouped by the site that listed them. */
function CandidateGroups({
  candidates,
  disabled,
  onChoose,
}: {
  candidates: AmbiguousCandidate[];
  disabled: boolean;
  onChoose: (index: number) => void;
}) {
  const t = useT();
  const sites = [...new Set(candidates.map((candidate) => candidate.site))];
  return (
    <div className="space-y-4">
      {sites.map((site) => (
        <div key={site} className="space-y-2">
          <div className="text-xs font-semibold text-muted-foreground uppercase">{site}</div>
          <div className="grid gap-3 sm:grid-cols-2">
            {candidates.map((candidate, index) =>
              candidate.site === site ? (
                <div
                  key={candidate.detailUrl}
                  className="flex gap-3.5 rounded-quiet-lg border border-border/60 bg-surface-low/40 p-3.5"
                >
                  {candidate.coverUrl ? (
                    <img
                      src={candidate.coverUrl}
                      alt=""
                      referrerPolicy="no-referrer"
                      className="h-24 w-16 shrink-0 rounded object-cover"
                    />
                  ) : null}
                  <div className="flex min-w-0 flex-1 flex-col justify-between gap-2">
                    <div className="space-y-1">
                      <div className="line-clamp-2 text-sm font-semibold">{candidate.title}</div>
                      <div className="text-xs text-muted-foreground">
                        {[candidate.studio, candidate.releaseDate ? t.pending.released(candidate.releaseDate) : ""]
                          .filter(Boolean)
                          .join(" · ")}
                      </div>
                      <a
                        href={candidate.detailUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="block truncate text-xs text-primary underline-offset-2 hover:underline"
                      >
                        {candidate.detailUrl}
                      </a>
                    </div>
                    <Button size="sm" className="self-start" disabled={disabled} onClick={() => onChoose(index)}>
                      {t.pending.choose}
                    </Button>
                  </div>
                </div>
              ) : null,
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function NumberRetry({
  item,
  disabled,
  onRetry,
}: {
  item: PendingItemDto;
  disabled: boolean;
  onRetry: (input: Pick<PendingRetryInput, "number" | "rule">) => void;
}) {
  const t = useT();
  const id = useId();
  const [number, setNumber] = useState(item.number ?? "");
  const [remember, setRemember] = useState(false);
  const [match, setMatch] = useState(item.fileName.replace(/\.[^.]+$/u, ""));
  return (
    <div className="space-y-2.5">
      <LabeledRow label={t.pending.number}>
        {(inputId) => (
          <div className={ACTION_ROW_CLASS}>
            <Input
              id={inputId}
              className="w-full font-mono"
              placeholder={t.pending.numberPlaceholder}
              value={number}
              onChange={(event) => setNumber(event.target.value)}
            />
            <Button
              variant="outline"
              className="w-full justify-center"
              disabled={disabled || !number.trim() || (remember && !match.trim())}
              onClick={() =>
                onRetry({
                  number: number.trim(),
                  ...(remember ? { rule: { kind: "numberMapping", match: match.trim() } } : {}),
                })
              }
            >
              {t.pending.retryWithNumber}
            </Button>
          </div>
        )}
      </LabeledRow>
      <div className="flex flex-wrap items-center gap-1.5 pt-0.5 pl-0.5 text-xs text-muted-foreground">
        <Checkbox id={id} checked={remember} onCheckedChange={(checked) => setRemember(checked === true)} />
        <label htmlFor={id} className="cursor-pointer select-none">
          {t.pending.rememberMapping}
        </label>
        <input
          type="text"
          aria-label={t.pending.rememberMappingMatch}
          className="h-5 max-w-[16rem] min-w-[5rem] border-b border-dashed border-muted-foreground/45 bg-transparent px-1 font-mono text-xs text-foreground transition-colors hover:border-foreground/60 focus:border-solid focus:border-foreground focus:outline-none"
          style={{ width: `${Math.max(match.length + 2, 8)}ch` }}
          value={match}
          onChange={(event) => {
            setMatch(event.target.value);
            if (!remember && event.target.value.trim()) setRemember(true);
          }}
        />
        <span>{t.pending.rememberMappingHint}</span>
      </div>
    </div>
  );
}

function UrlRetry({ disabled, onRetry }: { disabled: boolean; onRetry: (url: string) => void }) {
  const t = useT();
  const [url, setUrl] = useState("");
  return (
    <LabeledRow label={t.pending.manualUrl}>
      {(id) => (
        <div className={ACTION_ROW_CLASS}>
          <Input
            id={id}
            className="w-full"
            placeholder={t.pending.manualUrlPlaceholder}
            value={url}
            onChange={(event) => setUrl(event.target.value)}
          />
          <Button
            variant="outline"
            className="w-full justify-center"
            disabled={disabled || !url.trim()}
            onClick={() => onRetry(url.trim())}
          >
            {t.pending.scrapeUrl}
          </Button>
        </div>
      )}
    </LabeledRow>
  );
}

function IgnoreTokenRetry({ disabled, onRetry }: { disabled: boolean; onRetry: (token: string) => void }) {
  const t = useT();
  const [token, setToken] = useState("");
  return (
    <LabeledRow label={t.pending.ignoreToken}>
      {(id) => (
        <div className={ACTION_ROW_CLASS}>
          <Input
            id={id}
            className="w-full font-mono"
            placeholder={t.pending.ignoreTokenPlaceholder}
            value={token}
            onChange={(event) => setToken(event.target.value)}
          />
          <Button
            variant="outline"
            className="w-full justify-center"
            disabled={disabled || !token.trim()}
            onClick={() => onRetry(token.trim())}
          >
            {t.pending.saveIgnoreToken}
          </Button>
        </div>
      )}
    </LabeledRow>
  );
}

function LabeledRow({ label, children }: { label: string; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children(id)}
    </div>
  );
}

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className={cn(quietPanelSurfaceClass, "space-y-3 rounded-quiet-xl p-5")}>
      <h3 className="text-sm font-bold tracking-tight">{title}</h3>
      {children}
    </section>
  );
}
