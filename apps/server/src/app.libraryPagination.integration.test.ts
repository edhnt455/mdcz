import { LIBRARY_PAGE_SIZES } from "@mdcz/shared/libraryPagination";
import type { LibraryEntryDto, LibraryListResponse, LibraryMatchesInput } from "@mdcz/shared/serverDtos";
import { afterEach, expect, it } from "vitest";
import { closeTestServers, createTempRoot, createTestLibrary, createTestServer, loginAsAdmin } from "./app.testSupport";

afterEach(closeTestServers);

it("pages filtered movies and snapshots every match using the same scope without checking disk files", async () => {
  const { fastify, services } = await createTestServer();
  const token = await loginAsAdmin(fastify);
  const directory = await createTempRoot("library-pagination");
  const { libraryId, rootId } = await createTestLibrary(fastify, token, directory);
  const otherDirectory = await createTempRoot("other-library-pagination");
  const { rootId: otherRootId } = await createTestLibrary(fastify, token, otherDirectory);
  const { repositories } = await services.persistence.getState();
  for (let index = 0; index < 124; index += 1) {
    const id = `movie-${String(index).padStart(3, "0")}`;
    repositories.library.writeEntry(
      {
        id,
        title: `Matching ${id}`,
        number: id,
        actors: [index === 122 ? "Bob" : "Alice"],
        createdAt: new Date("2026-11-17T00:00:00Z"),
        crawlerDataJson: JSON.stringify({
          title: `Matching ${id}`,
          number: id,
          actors: ["Alice"],
          genres: ["Drama"],
          studio: "Studio",
          scene_images: [],
          ...(index === 120 ? { plot: "Synopsis" } : {}),
        }),
      },
      [{ fileId: id, rootId: index === 121 ? otherRootId : rootId, rootRelativePath: `${id}.mp4`, size: 1 }],
    );
  }
  repositories.library.ignoreHealth({ query: "movie-123", health: "missingSynopsis" });
  const scope: LibraryMatchesInput = {
    libraryId,
    query: "Matching",
    health: "missingSynopsis",
    actor: "Alice",
    studio: "Studio",
    tag: "Drama",
  };
  const headers = { authorization: `Bearer ${token}` };
  const read = async (
    page: number,
    pageSize: (typeof LIBRARY_PAGE_SIZES)[number] = 10,
  ): Promise<LibraryListResponse> => {
    const response = await fastify.inject({
      method: "POST",
      url: "/trpc/library.list",
      headers,
      payload: { ...scope, page, pageSize },
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json().result.data;
  };
  const expectedIds = Array.from({ length: 120 }, (_, index) => `movie-${String(119 - index).padStart(3, "0")}`);
  const pagedIds: string[] = [];
  for (let page = 1; page <= 12; page += 1) {
    const result = await read(page);
    expect(result).toMatchObject({ total: 120, page, pageSize: 10, fileCount: 120, totalBytes: 120 });
    expect(result.entries).toHaveLength(10);
    expect(result.entries.every((entry) => entry.available === "unchecked")).toBe(true);
    pagedIds.push(...result.entries.map((entry) => entry.id));
  }
  expect(pagedIds).toEqual(expectedIds);
  for (const pageSize of LIBRARY_PAGE_SIZES) {
    const result = await read(1, pageSize);
    expect(result.entries).toHaveLength(pageSize);
    expect(result.total).toBe(120);
  }
  expect(await read(999)).toMatchObject({ page: 12, total: 120 });
  const snapshotResponse = await fastify.inject({
    method: "POST",
    url: "/trpc/library.matches",
    headers,
    payload: scope,
  });
  expect(snapshotResponse.statusCode, snapshotResponse.body).toBe(200);
  const snapshot: LibraryEntryDto[] = snapshotResponse.json().result.data.entries;
  expect(snapshot.map((entry) => entry.id)).toEqual(expectedIds);
  expect(snapshot.every((entry) => entry.available === "unchecked")).toBe(true);
  repositories.library.writeEntry(
    {
      id: "new-match",
      title: "Matching new",
      actors: ["Alice"],
      crawlerDataJson: JSON.stringify({
        title: "New",
        number: "NEW",
        actors: ["Alice"],
        studio: "Studio",
        genres: ["Drama"],
        scene_images: [],
      }),
    },
    [{ fileId: "new-match", rootId, rootRelativePath: "new.mp4" }],
  );
  expect((await read(1)).total).toBe(121);
  expect(snapshot).toHaveLength(120);
  for (const payload of [{ page: 0 }, { page: 1.5 }, { pageSize: 15 }]) {
    const response = await fastify.inject({ method: "POST", url: "/trpc/library.list", headers, payload });
    expect(response.statusCode).toBe(400);
  }
  const unauthorized = await fastify.inject({ method: "POST", url: "/trpc/library.matches", payload: scope });
  expect(unauthorized.statusCode).toBe(401);
});
