import { DEFAULT_FILENAME_KEYWORDS } from "@mdcz/shared/filenameKeywords";
import { LIBRARY_PAGE_SIZES } from "@mdcz/shared/libraryPagination";
import type { LibraryEntryDto, LibraryListResponse, LibraryMatchesInput } from "@mdcz/shared/serverDtos";
import { afterEach, expect, it } from "vitest";
import { closeTestServers, createTempRoot, createTestLibrary, createTestServer, loginAsAdmin } from "./app.testSupport";

afterEach(closeTestServers);

it("filters movies without a nonblank actor name before counting, paging, and selecting matches", async () => {
  const { fastify, services } = await createTestServer();
  const token = await loginAsAdmin(fastify);
  const headers = { authorization: `Bearer ${token}` };
  const directory = await createTempRoot("library-actor-filter");
  const { libraryId, rootId } = await createTestLibrary(fastify, token, directory);
  const { repositories } = await services.persistence.getState();
  const actorLists = [undefined, [], ["", " \t\n", "\u3000"], ...Array.from({ length: 9 }, () => [])];
  const expectedIds = actorLists.map((_, index) => `missing-${index}`);
  const fixtures = [
    ...actorLists.map((actors, index) => ({ id: expectedIds[index], actors, subtitled: false })),
    { id: "with-actor", actors: ["", "Alice"], subtitled: false },
    { id: "subtitled", actors: [], subtitled: true },
  ];
  for (const { id, actors, subtitled } of fixtures) {
    repositories.library.writeEntry({ id, actors }, [
      { fileId: id, rootId, rootRelativePath: `${id}${subtitled ? "-C" : ""}.mp4`, size: 2 },
    ]);
  }

  const scope = { libraryId, missingActors: true, missingSubtitles: true, health: "missingSynopsis" } as const;
  const read = async (procedure: "list" | "matches", input: LibraryMatchesInput & { page?: number }) => {
    const response = await fastify.inject({
      method: "POST",
      url: `/trpc/library.${procedure}`,
      headers,
      payload: input,
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json().result.data;
  };
  const first = (await read("list", { ...scope, page: 1 })) as LibraryListResponse;
  const second = (await read("list", { ...scope, page: 2 })) as LibraryListResponse;
  expect(first).toMatchObject({ page: 1, total: 12, fileCount: 12, totalBytes: 24 });
  expect(first.entries).toHaveLength(10);
  expect(second).toMatchObject({ page: 2, total: 12 });
  expect([...first.entries, ...second.entries].map(({ id }) => id).sort()).toEqual(expectedIds.toSorted());
  const snapshot = await read("matches", scope);
  expect(snapshot.entries.map(({ id }: LibraryEntryDto) => id).sort()).toEqual(expectedIds.toSorted());
  expect(await read("list", { ...scope, missingActors: undefined })).toMatchObject({ total: 13 });
  expect(await read("list", { ...scope, missingActors: false })).toMatchObject({ total: 1 });

  const ignoreScope = { libraryId, missingActors: true, missingSubtitles: true };
  await services.library.ignoreHealth({ ...ignoreScope, health: "missingSynopsis" });
  expect(await read("list", scope)).toMatchObject({ total: 0 });
  expect(await read("list", { libraryId, health: "missingSynopsis" })).toMatchObject({ total: 2 });
  await services.library.restoreIgnored(ignoreScope);
  expect(await read("list", scope)).toMatchObject({ total: 12 });
  repositories.library.writeEntry({ id: "missing-0", actors: ["Alice"] }, [
    { fileId: "missing-0", rootId, rootRelativePath: "missing-0.mp4" },
  ]);
  expect(await read("list", scope)).toMatchObject({ total: 11 });
});

it("filters movies with any unsubtitled file using filename rules and file-scoped subtitle registrations", async () => {
  const { fastify, services } = await createTestServer();
  const token = await loginAsAdmin(fastify);
  const headers = { authorization: `Bearer ${token}` };
  const directory = await createTempRoot("library-subtitle-filter");
  const { libraryId, rootId } = await createTestLibrary(fastify, token, directory);
  const other = await createTempRoot("other-subtitle-filter");
  const { rootId: otherRootId } = await createTestLibrary(fastify, token, other);
  const { repositories } = await services.persistence.getState();
  const cases = [
    { id: "plain", paths: ["ABC-101.mp4"], missing: true },
    { id: "marked", paths: ["ABC-102-C.mp4"], missing: false },
    { id: "umr", paths: ["ABC-103-C-U.mp4"], missing: true },
    { id: "umr-subtitled", paths: ["ABC-104-C-U-C.mp4"], missing: false },
    { id: "english", paths: ["ABC-105.mp4"], sidecars: [0], missing: false },
    { id: "partial", paths: ["ABC-106-CD1.mp4", "ABC-106-CD2.mp4"], sidecars: [0], missing: true },
    { id: "complete", paths: ["ABC-107-CD1-C.mp4", "ABC-107-CD2.mp4"], sidecars: [1], missing: false },
    { id: "versions", paths: ["ABC-108-C.mp4", "ABC-108-4K.mp4"], missing: true },
    { id: "directory-marker", paths: ["中文字幕/ABC-109.mp4"], missing: false },
    { id: "custom", paths: ["ABC-110-SUB.mp4"], missing: true },
  ];
  for (const fixture of cases) {
    repositories.library.writeEntry(
      {
        id: fixture.id,
        number: fixture.id,
        title: "Subtitle fixture",
        actors: ["Alice"],
        crawlerDataJson: JSON.stringify({ studio: "Studio", genres: ["Drama"] }),
      },
      fixture.paths.map((rootRelativePath, index) => ({
        fileId: `${fixture.id}-${index}`,
        rootId,
        rootRelativePath,
        size: 1,
        assets: fixture.sidecars?.includes(index)
          ? [
              {
                kind: "subtitle",
                uri: `${rootRelativePath}.en.srt`,
                rootId,
                relativePath: `${rootRelativePath}.en.srt`,
              },
            ]
          : [],
      })),
    );
  }
  repositories.library.writeEntry({ id: "other-library", title: "Subtitle fixture", actors: ["Alice"] }, [
    { fileId: "other-file", rootId: otherRootId, rootRelativePath: "XYZ-123.mp4" },
  ]);
  const scope: LibraryMatchesInput = {
    libraryId,
    query: "Subtitle fixture",
    actors: ["Alice"],
    studios: ["Studio"],
    tags: ["Drama"],
    missingSubtitles: true,
  };
  const read = async (input: LibraryMatchesInput = scope, page = 1): Promise<LibraryListResponse> => {
    const response = await fastify.inject({
      method: "POST",
      url: "/trpc/library.list",
      headers,
      payload: { ...input, page },
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json().result.data;
  };
  const expectedIds = cases
    .filter(({ missing }) => missing)
    .map(({ id }) => id)
    .sort();
  const result = await read();
  expect(result.entries.map(({ id }) => id).sort()).toEqual(expectedIds);
  expect(result).toMatchObject({ total: 5, fileCount: 7, totalBytes: 7 });
  expect(result.entries.every(({ available }) => available === "unchecked")).toBe(true);
  expect(await read({ ...scope, health: "missingSynopsis" })).toMatchObject({ total: 5 });
  expect(await read({ ...scope, actors: ["Bob"] })).toMatchObject({ total: 0, fileCount: 0, totalBytes: 0 });
  expect(await read({ ...scope, missingSubtitles: undefined })).toMatchObject({ total: 10 });
  expect(await read({ ...scope, missingSubtitles: false })).toMatchObject({ total: 5 });
  const snapshot = await fastify.inject({ method: "POST", url: "/trpc/library.matches", headers, payload: scope });
  expect(snapshot.statusCode, snapshot.body).toBe(200);
  expect(
    snapshot
      .json()
      .result.data.entries.map(({ id }: LibraryEntryDto) => id)
      .sort(),
  ).toEqual(expectedIds);

  await services.config.update({
    scrape: { subtitleKeywords: [...DEFAULT_FILENAME_KEYWORDS.subtitleKeywords, "SUB"] },
  });
  expect((await read()).entries.map(({ id }) => id).sort()).toEqual(expectedIds.filter((id) => id !== "custom"));
  await services.config.update({ scrape: { subtitleKeywords: [] } });
  expect(await read()).toMatchObject({ total: 9 });
  await services.config.update({ scrape: { subtitleKeywords: [...DEFAULT_FILENAME_KEYWORDS.subtitleKeywords] } });

  repositories.library.writeEntry({ id: "partial" }, [
    {
      fileId: "partial-1",
      rootId,
      rootRelativePath: "ABC-106-CD2.mp4",
      assets: [{ kind: "subtitle", uri: "ABC-106-CD2.srt", rootId, relativePath: "ABC-106-CD2.srt" }],
    },
  ]);
  expect((await read()).entries.map(({ id }) => id).sort()).toEqual(expectedIds.filter((id) => id !== "partial"));
  repositories.library.writeEntry({ id: "partial" }, [
    {
      fileId: "partial-1",
      rootId,
      rootRelativePath: "ABC-106-CD2.mp4",
      assets: [],
    },
  ]);
  expect((await read()).entries.map(({ id }) => id).sort()).toEqual(expectedIds);

  for (let index = 0; index < 12; index += 1) {
    repositories.library.writeEntry({ id: `extra-${index}` }, [
      { fileId: `extra-${index}`, rootId, rootRelativePath: `EXTRA-${index}.mp4`, size: 2 },
    ]);
  }
  const paginatedScope = { libraryId, missingSubtitles: true };
  const first = await read(paginatedScope);
  const second = await read(paginatedScope, 2);
  expect(first).toMatchObject({ total: 17, fileCount: 19, totalBytes: 31, page: 1 });
  expect(second).toMatchObject({ total: 17, fileCount: 19, totalBytes: 31, page: 2 });
  expect(first.entries).toHaveLength(10);
  expect(second.entries).toHaveLength(7);
  expect(new Set([...first.entries, ...second.entries].map(({ id }) => id)).size).toBe(17);
});

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
        actors: [index === 122 ? "Other actor" : index === 123 ? "Bob" : "Alice"],
        createdAt: new Date("2026-11-17T00:00:00Z"),
        crawlerDataJson: JSON.stringify({
          title: `Matching ${id}`,
          number: id,
          actors: ["Alice"],
          genres: [index === 123 ? "Comedy" : "Drama"],
          studio: index === 123 ? "Another studio" : "Studio",
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
    issues: { missingSynopsis: true, noNfo: true, duplicate: false },
    actors: ["Alice", "Bob"],
    studios: ["Studio", "Another studio"],
    tags: ["Comedy", "Drama"],
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
  const expectedIds = [
    "movie-123",
    ...Array.from({ length: 120 }, (_, index) => `movie-${String(119 - index).padStart(3, "0")}`),
  ];
  const pagedIds: string[] = [];
  for (let page = 1; page <= 13; page += 1) {
    const result = await read(page);
    expect(result).toMatchObject({ total: 121, page, pageSize: 10, fileCount: 121, totalBytes: 121 });
    expect(result.entries).toHaveLength(page === 13 ? 1 : 10);
    expect(result.entries.every((entry) => entry.available === "unchecked")).toBe(true);
    pagedIds.push(...result.entries.map((entry) => entry.id));
  }
  expect(pagedIds).toEqual(expectedIds);
  for (const pageSize of LIBRARY_PAGE_SIZES) {
    const result = await read(1, pageSize);
    expect(result.entries).toHaveLength(pageSize);
    expect(result.total).toBe(121);
  }
  expect(await read(999)).toMatchObject({ page: 13, total: 121 });
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
  expect((await read(1)).total).toBe(122);
  expect(snapshot).toHaveLength(121);
  for (const payload of [{ page: 0 }, { page: 1.5 }, { pageSize: 15 }]) {
    const response = await fastify.inject({ method: "POST", url: "/trpc/library.list", headers, payload });
    expect(response.statusCode).toBe(400);
  }
  const options = await fastify.inject({
    method: "GET",
    url: "/trpc/library.facet",
    headers,
    query: { input: JSON.stringify({ libraryId, kind: "actors", query: "BO" }) },
  });
  expect(options.statusCode, options.body).toBe(200);
  expect(options.json().result.data).toEqual([{ name: "Bob", count: 1 }]);
  const unauthorized = await fastify.inject({ method: "POST", url: "/trpc/library.matches", payload: scope });
  expect(unauthorized.statusCode).toBe(401);
});
