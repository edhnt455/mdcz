import { describe, expect, it } from "vitest";
import { LIBRARY_PAGE_SIZES } from "./libraryPagination";
import { libraryListInputSchema } from "./serverDtos";

describe("library page requests", () => {
  it("defaults to the first page of ten movies and accepts each supported page size", () => {
    expect(libraryListInputSchema.parse({})).toEqual({ page: 1, pageSize: 10 });
    for (const pageSize of LIBRARY_PAGE_SIZES) {
      expect(libraryListInputSchema.parse({ page: 12, pageSize, issues: { missingSynopsis: true } })).toEqual({
        page: 12,
        pageSize,
        issues: { missingSynopsis: true },
      });
    }
  });

  it("rejects invalid page numbers and unsupported page sizes", () => {
    for (const page of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, "2"]) {
      expect(libraryListInputSchema.safeParse({ page }).success).toBe(false);
    }
    for (const pageSize of [0, 1, 15, 500, "10"]) {
      expect(libraryListInputSchema.safeParse({ pageSize }).success).toBe(false);
    }
  });
});
