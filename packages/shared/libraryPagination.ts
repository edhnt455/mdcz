export const LIBRARY_PAGE_SIZES = [10, 20, 30, 50, 100] as const;
export type LibraryPageSize = (typeof LIBRARY_PAGE_SIZES)[number];
