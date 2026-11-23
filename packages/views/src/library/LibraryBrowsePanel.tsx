import { toErrorMessage } from "@mdcz/shared/error";
import {
  LIBRARY_HEALTH_ISSUES,
  type LibraryFacetInput,
  type LibraryFacetKind,
  type LibraryFacetOption,
} from "@mdcz/shared/serverDtos";
import { Button, Checkbox, cn, Input, Popover, PopoverContent, PopoverTrigger } from "@mdcz/ui";
import { ChevronDown, Search } from "lucide-react";
import { type ReactNode, useEffect, useId, useState } from "react";
import { useT } from "../i18n";
import type { LibraryBrowseSearch, LibraryView } from "./libraryBrowse";

const controlClass =
  "h-9 w-full rounded-quiet border border-input bg-background px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

const FACETS = ["actors", "studios", "tags"] as const;
const FLAGS = ["missingActors", "missingSubtitles", "hasTranslation", ...LIBRARY_HEALTH_ISSUES] as const;

export interface LibraryBrowseControls {
  libraries: Array<{ id: string; name: string }>;
  search: LibraryBrowseSearch;
  loadFacet: (input: LibraryFacetInput) => Promise<LibraryFacetOption[]>;
  onApply: (search: LibraryBrowseSearch) => void;
  view: LibraryView;
  onViewChange: (view: LibraryView) => void;
}

export function LibraryBrowsePanel({ browse }: { browse: LibraryBrowseControls }) {
  const t = useT();
  const appliedKey = JSON.stringify(browse.search);
  const [draftKey, setDraftKey] = useState(appliedKey);
  const [draft, setDraft] = useState(browse.search);
  const id = useId();
  if (draftKey !== appliedKey) {
    setDraftKey(appliedKey);
    setDraft(browse.search);
  }

  return (
    <form
      aria-label={t.library.filters.label}
      className="grid grid-cols-1 items-end gap-x-4 gap-y-3 rounded-quiet-lg border border-border/50 bg-surface p-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
      onSubmit={(event) => {
        event.preventDefault();
        browse.onApply(draft);
      }}
    >
      <label className="grid min-w-0 gap-1.5 text-xs font-medium" htmlFor={`${id}-keyword`}>
        <span>{t.library.filters.keyword}</span>
        <Input
          aria-label={t.library.searchAriaLabel}
          id={`${id}-keyword`}
          className={controlClass}
          value={draft.query ?? ""}
          onChange={(event) => setDraft({ ...draft, query: event.target.value })}
          placeholder={t.library.searchPlaceholder}
        />
      </label>
      {(browse.libraries.length > 1 || draft.libraryId) && (
        <FilterSelect
          label={t.library.libraryAriaLabel}
          value={draft.libraryId ?? ""}
          onChange={(value) => setDraft({ ...draft, libraryId: value || undefined })}
        >
          <option value="">{t.library.allLibraries}</option>
          {browse.libraries.map((library) => (
            <option key={library.id} value={library.id}>
              {library.name}
            </option>
          ))}
        </FilterSelect>
      )}
      {FACETS.map((kind) => (
        <LibraryFacetSelect
          key={kind}
          id={`${id}-${kind}`}
          kind={kind}
          libraryId={draft.libraryId}
          selected={draft[kind] ?? []}
          loadFacet={browse.loadFacet}
          onChange={(names) => setDraft({ ...draft, [kind]: names.length ? names : undefined })}
        />
      ))}
      {FLAGS.map((flag) => {
        const isStatus = flag === "missingActors" || flag === "missingSubtitles" || flag === "hasTranslation";
        const value = isStatus ? draft[flag] : draft.issues?.[flag];
        return (
          <FilterSelect
            key={flag}
            label={isStatus ? t.library.filters[flag] : t.library.health.issues[flag]}
            value={value === undefined ? "" : String(value)}
            onChange={(value) => {
              const selected = value === "" ? undefined : value === "true";
              setDraft(
                isStatus ? { ...draft, [flag]: selected } : { ...draft, issues: { ...draft.issues, [flag]: selected } },
              );
            }}
          >
            <option value="">{t.library.all}</option>
            <option value="true">
              {flag === "hasTranslation" ? t.library.filters.withTranslation : t.library.filters.yes}
            </option>
            <option value="false">
              {flag === "hasTranslation" ? t.library.filters.withoutTranslation : t.library.filters.no}
            </option>
          </FilterSelect>
        );
      })}
      <div className="flex justify-end gap-2 sm:col-span-2 lg:col-span-3 xl:col-span-4">
        <Button type="button" variant="outline" onClick={() => setDraft({})}>
          {t.library.filters.reset}
        </Button>
        <Button type="submit">
          <Search className="h-4 w-4" />
          {t.library.filters.apply}
        </Button>
      </div>
    </form>
  );
}

function FilterSelect({
  label,
  value,
  onChange,
  children,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
}) {
  return (
    <label className="grid min-w-0 gap-1.5 text-xs font-medium">
      <span>{label}</span>
      <span className="relative">
        <select
          className={cn(controlClass, "appearance-none pr-8")}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        >
          {children}
        </select>
        <ChevronDown aria-hidden="true" className="pointer-events-none absolute right-3 top-3 h-3.5 w-3.5 opacity-60" />
      </span>
    </label>
  );
}

function LibraryFacetSelect({
  id,
  kind,
  libraryId,
  selected,
  loadFacet,
  onChange,
}: {
  id: string;
  kind: LibraryFacetKind;
  libraryId?: string;
  selected: string[];
  loadFacet: LibraryBrowseControls["loadFacet"];
  onChange: (names: string[]) => void;
}) {
  const t = useT();
  const label = t.library.facets[kind];
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<{ options: LibraryFacetOption[]; error?: string }>();
  const normalizedQuery = query.trim();
  useEffect(() => {
    if (!open) return;
    let current = true;
    const timer = window.setTimeout(
      () => {
        void loadFacet({ kind, libraryId, query: normalizedQuery }).then(
          (options) => {
            if (current) setResult({ options });
          },
          (error: unknown) => {
            if (current) setResult({ options: [], error: toErrorMessage(error) });
          },
        );
      },
      normalizedQuery ? 200 : 0,
    );
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [kind, libraryId, loadFacet, normalizedQuery, open]);

  const options = result?.options ?? [];
  const selectedOptions = selected
    .filter((name) => !options.some((option) => option.name === name))
    .map((name) => ({ name, count: undefined }));
  return (
    <div className="grid min-w-0 gap-1.5 text-xs font-medium">
      <span id={id}>{label}</span>
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          setQuery("");
          setResult(undefined);
        }}
      >
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-labelledby={`${id} ${id}-value`}
            className={cn(controlClass, "flex min-w-0 items-center justify-between gap-2 text-left font-normal")}
          >
            <span id={`${id}-value`} className="truncate" title={selected.length ? selected.join(", ") : undefined}>
              {selected.length ? selected.join(", ") : t.library.all}
            </span>
            <ChevronDown aria-hidden="true" className="h-3.5 w-3.5 shrink-0 opacity-60" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[var(--radix-popover-trigger-width)] min-w-48 space-y-2 p-2">
          <Input
            aria-label={t.library.facets.search(label)}
            className="h-8"
            value={query}
            onChange={(event) => {
              if (event.target.value.trim() !== normalizedQuery) setResult(undefined);
              setQuery(event.target.value);
            }}
            placeholder={t.library.facets.search(label)}
          />
          <div className="max-h-60 overflow-y-auto">
            {[...selectedOptions, ...options].map(({ name, count }, index) => (
              <label
                key={name}
                htmlFor={`${id}-option-${index}`}
                className="flex cursor-pointer items-center gap-2 rounded-quiet px-2 py-1.5 text-sm hover:bg-surface-low"
              >
                <Checkbox
                  id={`${id}-option-${index}`}
                  checked={selected.includes(name)}
                  onCheckedChange={(checked) =>
                    onChange(checked ? [...selected, name] : selected.filter((value) => value !== name))
                  }
                />
                <span className="min-w-0 flex-1 break-words">{name}</span>
                {count !== undefined && (
                  <span aria-hidden="true" className="text-xs text-muted-foreground">
                    {count}
                  </span>
                )}
              </label>
            ))}
            {(!result || result.error || options.length === 0) && (
              <p role={result?.error ? "alert" : "status"} className="px-2 py-1.5 text-xs text-muted-foreground">
                {result?.error ?? (result ? t.library.facets.none : t.common.loading)}
              </p>
            )}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
