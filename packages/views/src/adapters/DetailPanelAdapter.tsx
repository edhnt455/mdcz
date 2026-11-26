import { toErrorMessage } from "@mdcz/shared/error";
import type { NormalizedCropRegion } from "@mdcz/shared/posterCrop";
import { findScrapeResultGroup } from "@mdcz/shared/viewModels/scrapeResultGrouping";
import { selectScrapeResults, useScrapeStore } from "@mdcz/views/state/scrapeStore";
import { useUIStore } from "@mdcz/views/state/uiStore";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { confirmDialog } from "../common";
import { type DetailPanelCompareProps, DetailPanelView, toDetailViewItemFromScrapeResult } from "../detail";
import { buildDetailArtworkCandidates } from "../detail/imageCandidates";
import { type DetailViewItem, detailImageWidths, type ResolveImageCandidates } from "../detail/types";
import { getT, useT } from "../i18n";
import {
  createEmptyEditableNfoData,
  type EditableNfoData,
  getNfoChangedFields,
  type NfoValidationErrors,
  normalizeEditableNfoData,
  serializeEditableNfoData,
  validateEditableNfoData,
} from "../nfo";
import { ScrapeConflictDialog } from "../scrape/ScrapeConflictDialog";
import type { DetailActionPort, PosterCropEditSession } from "./ports";

const EMPTY_RESULTS: ReturnType<typeof selectScrapeResults> = [];

const getDirFromPath = (path: string): string => {
  const normalized = path.replace(/[\\/]+$/u, "");
  const index = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  return index >= 0 ? normalized.slice(0, index) : "";
};

const buildCandidateKey = (candidates: string[]): string => candidates.join("\u0000");
const readCandidateKey = (key: string): string[] => (key ? key.split("\u0000") : []);

function useResolvedArtworkSources(item: DetailViewItem | null, port: DetailActionPort, posterOverride: string) {
  const candidates = useMemo(() => buildDetailArtworkCandidates(item), [item]);
  const posterCandidateKey = buildCandidateKey(candidates.poster);
  const thumbCandidateKey = buildCandidateKey(candidates.thumb);
  const trailerCandidateKey = buildCandidateKey(
    [item?.trailerUrl, ...(item?.trailerFallbackUrls ?? [])].filter((value): value is string => Boolean(value)),
  );
  const baseDir = item?.outputPath ?? (item?.path ? getDirFromPath(item.path) : undefined);
  const [sources, setSources] = useState<[string[], string[], string[]]>([[], [], []]);
  const [posterIndex, setPosterIndex] = useState(0);
  const [thumbIndex, setThumbIndex] = useState(0);
  const [trailerIndex, setTrailerIndex] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const posterCandidates = readCandidateKey(posterCandidateKey);
    const thumbCandidates = readCandidateKey(thumbCandidateKey);
    const trailerCandidates = readCandidateKey(trailerCandidateKey);
    setPosterIndex(0);
    setThumbIndex(0);
    setTrailerIndex(0);

    const resolveSources = async () => {
      const resolved = await Promise.all([
        port.resolveImageCandidates(posterCandidates, baseDir, item, detailImageWidths.poster),
        port.resolveImageCandidates(thumbCandidates, baseDir, item, detailImageWidths.backdrop),
        port.resolveImageCandidates(trailerCandidates, baseDir, item),
      ]);

      if (!cancelled) setSources(resolved);
    };

    void resolveSources();

    return () => {
      cancelled = true;
    };
  }, [baseDir, posterCandidateKey, thumbCandidateKey, trailerCandidateKey, port, item]);

  const handlePosterError = useCallback(() => {
    setPosterIndex((currentIndex) => Math.min(currentIndex + 1, sources[0].length));
  }, [sources]);

  const handleThumbError = useCallback(() => {
    setThumbIndex((currentIndex) => Math.min(currentIndex + 1, sources[1].length));
  }, [sources]);

  const handleTrailerError = useCallback(() => {
    setTrailerIndex((currentIndex) => Math.min(currentIndex + 1, sources[2].length));
  }, [sources]);

  return {
    posterSrc: posterOverride || sources[0][posterIndex] || "",
    thumbSrc: sources[1][thumbIndex] ?? "",
    trailerSrc: sources[2][trailerIndex] ?? "",
    handlePosterError,
    handleThumbError,
    handleTrailerError,
  };
}

interface DetailPanelProps {
  port: DetailActionPort;
  item?: DetailViewItem | null;
  emptyMessage?: string;
  compare?: DetailPanelCompareProps;
}

export function DetailPanelAdapter({ port, item: explicitItem, emptyMessage, compare }: DetailPanelProps) {
  const results = useScrapeStore((state) => (explicitItem === undefined ? selectScrapeResults(state) : EMPTY_RESULTS));
  const selectedResultId = useUIStore((state) => (explicitItem === undefined ? state.selectedResultId : null));

  const item = useMemo(
    () =>
      explicitItem !== undefined
        ? explicitItem
        : (() => {
            const selectedGroup = findScrapeResultGroup(results, selectedResultId);
            return selectedGroup ? toDetailViewItemFromScrapeResult(selectedGroup.display) : null;
          })(),
    [explicitItem, results, selectedResultId],
  );
  const [savedPosters, setSavedPosters] = useState<Record<string, string>>({});
  const resultId = item?.resultId;
  const updateSavedPoster = useCallback(
    (posterUrl: string) => {
      if (resultId) setSavedPosters((current) => ({ ...current, [resultId]: posterUrl }));
    },
    [resultId],
  );
  return (
    <SelectedDetailPanel
      key={JSON.stringify([item?.id, item?.resultId, Boolean(compare)])}
      item={item}
      port={port}
      emptyMessage={emptyMessage}
      compare={compare}
      savedPoster={resultId ? savedPosters[resultId] : undefined}
      updateSavedPoster={updateSavedPoster}
    />
  );
}

function SelectedDetailPanel({
  port,
  item,
  emptyMessage,
  compare,
  savedPoster,
  updateSavedPoster,
}: DetailPanelProps & { savedPoster?: string; updateSavedPoster: (posterUrl: string) => void }) {
  const t = useT();
  const artwork = useResolvedArtworkSources(compare ? null : (item ?? null), port, savedPoster ?? "");
  const resolveImageCandidates = useCallback<ResolveImageCandidates>(
    (candidates, baseDir, width) => port.resolveImageCandidates(candidates, baseDir, item, width),
    [item, port],
  );

  const [nfoOpen, setNfoOpenRaw] = useState(false);
  const [nfoPath, setNfoPath] = useState("");
  const [nfoData, setNfoData] = useState<EditableNfoData>(createEmptyEditableNfoData);
  const [nfoInitialSnapshot, setNfoInitialSnapshot] = useState("");
  const [nfoValidationErrors, setNfoValidationErrors] = useState<NfoValidationErrors>({});
  const [nfoLoading, setNfoLoading] = useState(false);
  const [nfoSaving, setNfoSaving] = useState(false);
  const [posterDraft, setPosterDraft] = useState<{ session: PosterCropEditSession; crop: NormalizedCropRegion } | null>(
    null,
  );
  const [posterWork, setPosterWork] = useState<"loading" | "saving" | null>(null);
  const pendingPosterWork = useRef<"loading" | "saving" | null>(null);
  const canEditPoster =
    !compare &&
    item?.status === "success" &&
    Boolean(item.resultId) &&
    (item.assets?.some((asset) => asset.type === "local" && (asset.kind === "poster" || asset.kind === "thumb")) ??
      true);
  const nfoDirty = nfoOpen && serializeEditableNfoData(nfoData) !== nfoInitialSnapshot;
  useLayoutEffect(
    () => () => {
      pendingPosterWork.current = null;
    },
    [],
  );

  const openNfoEditor = useCallback(
    async (path: string) => {
      if (!item) {
        toast.info(getT().scrape.selectItemFirst);
        return;
      }
      try {
        setNfoLoading(true);
        const response = await port.readNfo(item, path);
        const editableData = normalizeEditableNfoData(response.crawlerData ?? {});
        setNfoPath(response.path);
        setNfoData(editableData);
        setNfoInitialSnapshot(serializeEditableNfoData(editableData));
        setNfoValidationErrors({});
        setNfoOpenRaw(true);
      } catch (error) {
        toast.error(getT().scrape.loadNfoFailed(toErrorMessage(error)));
      } finally {
        setNfoLoading(false);
      }
    },
    [item, port],
  );

  const handleSaveNfo = useCallback(async () => {
    if (!item) return;
    const validation = validateEditableNfoData(nfoData);
    setNfoValidationErrors(validation.errors);
    if (!validation.valid || !validation.data) {
      const firstMessage = Object.values(validation.errors)[0] ?? getT().scrape.checkFormContent;
      toast.error(firstMessage);
      return;
    }

    try {
      setNfoSaving(true);
      await port.writeNfo(
        item,
        nfoPath,
        validation.data,
        getNfoChangedFields(
          JSON.parse(nfoInitialSnapshot) as EditableNfoData,
          normalizeEditableNfoData(validation.data),
        ),
      );
      toast.success(getT().scrape.nfoSaved);
      setNfoInitialSnapshot(serializeEditableNfoData(normalizeEditableNfoData(validation.data)));
      setNfoOpenRaw(false);
    } catch (error) {
      toast.error(getT().scrape.saveNfoFailed(toErrorMessage(error)));
    } finally {
      setNfoSaving(false);
    }
  }, [item, nfoData, nfoInitialSnapshot, nfoPath, port]);

  const setNfoOpen = useCallback(
    async (open: boolean) => {
      if (open) {
        setNfoOpenRaw(true);
        return;
      }
      if (nfoSaving) return;
      if (nfoDirty && !(await confirmDialog({ title: getT().scrape.discardNfoChanges, destructive: true }))) return;
      setNfoOpenRaw(false);
      setNfoValidationErrors({});
    },
    [nfoDirty, nfoSaving],
  );

  const handleOpenNfo = useCallback(async () => {
    const path = item?.nfoPath ?? item?.path;
    if (!path) {
      toast.info(getT().scrape.selectItemFirst);
      return;
    }
    await openNfoEditor(path);
  }, [item?.nfoPath, item?.path, openNfoEditor]);

  const runPosterWork = async (crop?: NormalizedCropRegion) => {
    if (!canEditPoster || !item || pendingPosterWork.current) return;
    const work = crop ? "saving" : "loading";
    pendingPosterWork.current = work;
    setPosterWork(work);
    try {
      if (crop) {
        const { posterUrl } = await port.savePosterCrop(item, crop);
        if (pendingPosterWork.current !== work) return;
        updateSavedPoster(posterUrl);
        setPosterDraft(null);
        toast.success(getT().scrape.coverSaved);
      } else {
        const session = await port.preparePosterCrop(item);
        if (pendingPosterWork.current !== work) return;
        setPosterDraft({ session, crop: session.initialCrop });
      }
    } catch (error) {
      if (pendingPosterWork.current === work) {
        const message = work === "loading" ? getT().scrape.loadCoverFailed : getT().scrape.saveCoverFailed;
        toast.error(message(toErrorMessage(error)));
      }
    } finally {
      if (pendingPosterWork.current === work) {
        pendingPosterWork.current = null;
        setPosterWork(null);
      }
    }
  };

  const setPosterEditorOpen = async (open: boolean) => {
    if (open || !posterDraft || pendingPosterWork.current) return;
    const dirty = JSON.stringify(posterDraft.crop) !== JSON.stringify(posterDraft.session.initialCrop);
    if (dirty && !(await confirmDialog({ title: getT().scrape.discardPosterChanges, destructive: true }))) return;
    setPosterDraft(null);
  };

  useEffect(() => {
    const listener = (event: Event) => {
      const custom = event as CustomEvent<{ path?: string }>;
      const path = custom.detail?.path || item?.nfoPath || item?.path;
      if (!path) return;
      void openNfoEditor(path);
    };
    window.addEventListener("app:open-nfo", listener);
    return () => window.removeEventListener("app:open-nfo", listener);
  }, [item?.nfoPath, item?.path, openNfoEditor]);

  return (
    <DetailPanelView
      conflictAction={
        item?.scrapeConflict ? (
          <ScrapeConflictDialog
            key={`${item.scrapeConflict.taskId}:${item.scrapeConflict.itemId}`}
            input={item.scrapeConflict}
            port={port}
          />
        ) : undefined
      }
      item={item}
      emptyMessage={emptyMessage ?? t.scrape.emptyMessage}
      compare={compare}
      posterSrc={artwork.posterSrc}
      thumbSrc={artwork.thumbSrc}
      trailerSrc={artwork.trailerSrc}
      nfo={{
        open: nfoOpen,
        data: nfoData,
        dirty: nfoDirty,
        errors: nfoValidationErrors,
        loading: nfoLoading,
        saving: nfoSaving,
        onOpenChange: setNfoOpen,
        onDataChange: setNfoData,
        onSave: handleSaveNfo,
      }}
      onOpenNfo={handleOpenNfo}
      onPosterError={savedPoster ? () => updateSavedPoster("") : artwork.handlePosterError}
      onThumbError={artwork.handleThumbError}
      onTrailerError={artwork.handleTrailerError}
      resolveImageCandidates={resolveImageCandidates}
      posterEditor={{
        available: canEditPoster,
        loading: posterWork === "loading",
        open: Boolean(posterDraft),
        session: posterDraft?.session ?? null,
        crop: posterDraft?.crop ?? null,
        saving: posterWork === "saving",
        onCropChange: (crop) => setPosterDraft((draft) => (draft ? { ...draft, crop } : null)),
        onOpen: () => void runPosterWork(),
        onOpenChange: setPosterEditorOpen,
        onSave: () => {
          if (posterDraft) void runPosterWork(posterDraft.crop);
        },
      }}
    />
  );
}

export { DetailPanelAdapter as DetailPanel };
