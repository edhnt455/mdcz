export const LIBRARY_PAGE_SIZES = [10, 20, 30, 50, 100] as const;
export type LibraryPageSize = (typeof LIBRARY_PAGE_SIZES)[number];

export const LIBRARY_SORT_FIELDS = ["createdAt", "number", "title"] as const;
export const LIBRARY_SORT_ORDERS = ["asc", "desc"] as const;

export interface LibrarySort {
  sortBy: (typeof LIBRARY_SORT_FIELDS)[number];
  sortOrder: (typeof LIBRARY_SORT_ORDERS)[number];
}

export const DEFAULT_LIBRARY_SORT = { sortBy: "createdAt", sortOrder: "desc" } as const satisfies LibrarySort;
