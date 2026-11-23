import { LIBRARY_HEALTH_ISSUES, type LibraryMatchesInput } from "@mdcz/shared/serverDtos";
import { useState } from "react";

export type LibraryBrowseSearch = Omit<LibraryMatchesInput, "rootId" | "health">;

const text = (value: unknown): string | undefined =>
  typeof value === "string" ? value.trim() || undefined : undefined;
const flag = (value: unknown): boolean | undefined => (typeof value === "boolean" ? value : undefined);

const names = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const selected = [...new Set(value.map(text).filter((name) => name !== undefined))].sort();
  return selected.length ? selected : undefined;
};

export const parseLibraryBrowseSearch = (search: Record<string, unknown>): LibraryBrowseSearch => {
  const issues: NonNullable<LibraryBrowseSearch["issues"]> = {};
  if (search.issues && typeof search.issues === "object") {
    const values = search.issues as Record<string, unknown>;
    for (const issue of LIBRARY_HEALTH_ISSUES) {
      const value = flag(values[issue]);
      if (value !== undefined) issues[issue] = value;
    }
  }
  return {
    query: text(search.query),
    libraryId: text(search.libraryId),
    issues: Object.keys(issues).length ? issues : undefined,
    actors: names(search.actors),
    studios: names(search.studios),
    tags: names(search.tags),
    missingActors: flag(search.missingActors),
    missingSubtitles: flag(search.missingSubtitles),
    ignored: search.ignored === true || undefined,
  };
};

export type LibraryView = "list" | "wall";

const VIEW_STORAGE_KEY = "mdcz.library.view";

export const useLibraryView = () => {
  const [view, setViewState] = useState<LibraryView>(() =>
    typeof localStorage !== "undefined" && localStorage.getItem(VIEW_STORAGE_KEY) === "wall" ? "wall" : "list",
  );
  const setView = (next: LibraryView) => {
    setViewState(next);
    localStorage.setItem(VIEW_STORAGE_KEY, next);
  };
  return { view, onViewChange: setView };
};
