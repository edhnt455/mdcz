import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { NetworkClient } from "@mdcz/runtime/network";
import { NfoGenerator } from "@mdcz/runtime/scrape";
import { Website } from "@mdcz/shared/enums";
import sharp from "sharp";
import { afterEach, expect, it, vi } from "vitest";
import { buildServer } from "./app";
import {
  closeTestServers,
  createTempRoot,
  createTestLibrary,
  createTestServer,
  loginAsAdmin,
  startTestImageServer,
} from "./app.testSupport";
import { ServerConfigService } from "./services/configService";
import { ServerPersistenceService } from "./services/persistenceService";

afterEach(closeTestServers);
afterEach(() => vi.restoreAllMocks());

it("publishes and tracks subtitle updates by path with durable idempotency and clear failures", async () => {
  const root = await createTempRoot("subtitle-update");
  const image = await startTestImageServer();
  const { fastify, services } = await createTestServer();
  const token = await loginAsAdmin(fastify);
  const { rootId } = await createTestLibrary(fastify, token, root);
  const keyResponse = await fastify.inject({
    method: "POST",
    url: "/trpc/apiKeys.create",
    headers: { authorization: `Bearer ${token}` },
    payload: { name: "subtitles" },
  });
  const headers = { authorization: `Bearer ${keyResponse.json().result.data.secret}` };
  await services.config.update({
    download: {
      tagBadges: true,
      tagBadgeTargets: ["poster"],
      tagBadgeStyle: "ribbon",
      tagBadgeResolutionStyle: "ribbon",
    },
    automation: { pathMappings: [{ from: "/media", to: root }] },
  });
  const data = {
    title: "Original title",
    number: "259LUXU-1573",
    actors: ["Actor"],
    genres: [],
    scene_images: [],
    website: Website.JAVDB,
    poster_source_url: `${image.url}/cover.png`,
  };
  const nfo = new NfoGenerator().buildXml(data);
  await writeFile(join(root, "259LUXU-1573.mp4"), "video");
  await writeFile(join(root, "259LUXU-1573-CD2.mp4"), "video part 2");
  await writeFile(join(root, "259LUXU-1573.srt"), "subtitle");
  await writeFile(join(root, "movie.nfo"), nfo);
  await writeFile(join(root, "259LUXU-1573.nfo"), nfo);
  await sharp({ create: { width: 200, height: 300, channels: 3, background: "red" } })
    .jpeg()
    .toFile(join(root, "poster.jpg"));
  const state = await services.persistence.getState();
  await state.repositories.library.upsertEntry({
    movie: {
      id: "movie-1",
      number: data.number,
      title: data.title,
      crawlerDataJson: JSON.stringify(data),
      assets: [
        { kind: "nfo", uri: "movie.nfo", rootId, relativePath: "movie.nfo", published: true },
        { kind: "nfo", uri: "259LUXU-1573.nfo", rootId, relativePath: "259LUXU-1573.nfo", published: true },
        { kind: "poster", uri: "poster.jpg", rootId, relativePath: "poster.jpg", published: true },
      ],
    },
    files: [
      { fileId: "file-1", rootId, rootRelativePath: "259LUXU-1573.mp4" },
      { fileId: "file-2", rootId, rootRelativePath: "259LUXU-1573-CD2.mp4" },
    ],
  });
  state.database.sqlite
    .prepare(
      "INSERT INTO library_item_assets (id, item_id, kind, uri, root_id, relative_path, published, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(randomUUID(), "movie-1", "nfo", "./movie.nfo", rootId, "./movie.nfo", 1, Date.now());
  const input = {
    eventId: randomUUID(),
    mediaPath: "/media/259LUXU-1573.mp4",
    subtitlePath: "/media/259LUXU-1573.srt",
    language: "zh-CN",
  };
  expect(
    (await fastify.inject({ method: "POST", url: "/api/automation/subtitles/updated", payload: input })).statusCode,
  ).toBe(401);
  const request = { method: "POST" as const, url: "/api/automation/subtitles/updated", headers, payload: input };
  const first = await fastify.inject(request);
  expect(first.statusCode).toBe(202);
  const taskId = first.json().taskId;
  expect((await fastify.inject(request)).json().taskId).toBe(taskId);
  await expect
    .poll(
      async () =>
        (await fastify.inject({ method: "GET", url: `/api/automation/subtitles/jobs/${taskId}`, headers })).json()
          .status,
      { timeout: 10_000 },
    )
    .toBe("completed");
  const job = (
    await fastify.inject({ method: "GET", url: `/api/automation/subtitles/jobs/${taskId}`, headers })
  ).json();
  expect(job.result).toMatchObject({ metadataUpdated: true, badgeStatus: "updated", mediaServerNotified: false });
  expect(await readFile(join(root, "movie.nfo"), "utf8")).toContain("<tag>中文字幕</tag>");
  expect(await readFile(join(root, "259LUXU-1573.nfo"), "utf8")).toContain("<tag>中文字幕</tag>");
  expect(await readFile(join(root, "movie.nfo"), "utf8")).toContain("259LUXU-1573");
  expect(
    (await state.repositories.library.getEntryById("movie-1")).assets.filter((asset) => asset.kind === "nfo"),
  ).toHaveLength(3);
  expect((await state.repositories.library.getEntryById("movie-1")).assets).toContainEqual(
    expect.objectContaining({ kind: "subtitle", fileId: "file-1" }),
  );
  const firstPoster = await readFile(join(root, "poster.jpg"));
  let releaseDownload!: () => void;
  let downloadStarted!: () => void;
  const blocked = new Promise<void>((resolve) => {
    releaseDownload = resolve;
  });
  const downloading = new Promise<void>((resolve) => {
    downloadStarted = resolve;
  });
  const originalDownload = NetworkClient.prototype.getContent;
  const downloads = vi.spyOn(NetworkClient.prototype, "getContent").mockImplementationOnce(async function (
    this: NetworkClient,
    url,
    init,
  ) {
    downloadStarted();
    await blocked;
    return await originalDownload.call(this, url, init);
  });
  const second = await fastify.inject({ ...request, payload: { ...input, eventId: randomUUID() } });
  const secondId = second.json().taskId;
  let followupId = "";
  let batch: Array<{ eventId: string; mediaPath: string; subtitlePath: string; language: string }> = [];
  try {
    await downloading;
    expect(await services.subtitleUpdates.get(secondId)).toMatchObject({ status: "running", stage: "downloading" });
    await writeFile(join(root, "259LUXU-1573-CD2.chs.srt"), "new subtitle while running");
    batch = Array.from({ length: 200 }, (_, index) => ({
      ...input,
      eventId: randomUUID(),
      ...(index % 2
        ? {
            mediaPath: "/media/259LUXU-1573-CD2.mp4",
            subtitlePath: "/media/259LUXU-1573-CD2.chs.srt",
            language: "zh-TW",
          }
        : {}),
    }));
    const queued = await Promise.all(batch.map((payload) => fastify.inject({ ...request, payload })));
    followupId = queued[0].json().taskId;
    expect(new Set(queued.map((response) => response.json().taskId))).toEqual(new Set([followupId]));
    expect(followupId).not.toBe(secondId);
    const missing = await Promise.all(
      Array.from({ length: 120 }, (_, index) =>
        services.subtitleUpdates.enqueue({ ...input, eventId: randomUUID(), mediaPath: `/media/missing-${index}.mp4` }),
      ),
    );
    expect(new Set(missing.map((job) => job.taskId)).size).toBe(120);
    const firstPage = await services.subtitleUpdates.list({ offset: 0, limit: 50 });
    expect(firstPage).toMatchObject({ counts: { queued: 121, running: 1, completed: 1, failed: 0 }, total: 123 });
    expect(firstPage.jobs).toHaveLength(50);
    expect(firstPage.jobs[0].taskId).toBe(secondId);
    expect(firstPage.jobs[1]).toMatchObject({ taskId: followupId, notificationCount: 200 });
    const pageResponse = await fastify.inject({
      method: "GET",
      url: `/trpc/subtitleUpdates.list?input=${encodeURIComponent(JSON.stringify({ offset: 100, limit: 50 }))}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(pageResponse.statusCode).toBe(200);
    expect(pageResponse.json().result.data.jobs).toHaveLength(23);
    expect(
      (
        await fastify.inject({
          method: "GET",
          url: `/trpc/subtitleUpdates.list?input=${encodeURIComponent(JSON.stringify({ offset: 0, limit: 50 }))}`,
        })
      ).statusCode,
    ).toBe(401);
    const manual = services.libraryEdit.start({
      ids: ["movie-1"],
      edit: { field: "genres", operation: "add", value: "Manual tag" },
    });
    await expect
      .poll(async () => (await services.subtitleUpdates.list({ offset: 0, limit: 1 })).waitingForManual, {
        timeout: 10_000,
      })
      .toBe(true);
    expect(services.libraryEdit.status()).toBeNull();
    releaseDownload();
    await manual;
    await expect.poll(() => services.libraryEdit.status()?.status, { timeout: 10_000 }).toBe("completed");
    await expect
      .poll(async () => (await services.subtitleUpdates.get(followupId))?.status, { timeout: 10_000 })
      .toBe("completed");
    await expect
      .poll(async () => (await services.subtitleUpdates.list({ offset: 0, limit: 1 })).counts.failed, {
        timeout: 10_000,
      })
      .toBe(120);
    expect(await readFile(join(root, "movie.nfo"), "utf8")).toContain("Manual tag");
    expect(
      (await state.repositories.library.getEntryById("movie-1")).assets
        .filter((asset) => asset.kind === "subtitle")
        .map((asset) => asset.fileId),
    ).toEqual(expect.arrayContaining(["file-1", "file-2"]));
    expect(downloads).toHaveBeenCalledTimes(2);
    expect((await fastify.inject({ ...request, payload: batch[199] })).json().taskId).toBe(followupId);
  } finally {
    releaseDownload();
    downloads.mockRestore();
  }
  await expect
    .poll(
      async () =>
        (await fastify.inject({ method: "GET", url: `/api/automation/subtitles/jobs/${secondId}`, headers })).json()
          .status,
      { timeout: 10_000 },
    )
    .toBe("completed");
  const secondJob = (
    await fastify.inject({ method: "GET", url: `/api/automation/subtitles/jobs/${secondId}`, headers })
  ).json();
  expect(secondJob.result.badgeStatus).toBe("unchanged");
  expect(await readFile(join(root, "poster.jpg"))).toEqual(firstPoster);
  const currentNfo = await readFile(join(root, "movie.nfo"), "utf8");
  await writeFile(join(root, "movie.nfo"), currentNfo.replace(`${image.url}/cover.png`, ""));
  const noSource = await fastify.inject({ ...request, payload: { ...input, eventId: randomUUID() } });
  const noSourceId = noSource.json().taskId;
  await expect
    .poll(
      async () =>
        (await fastify.inject({ method: "GET", url: `/api/automation/subtitles/jobs/${noSourceId}`, headers })).json()
          .status,
      { timeout: 10_000 },
    )
    .toBe("completed");
  const skipped = (
    await fastify.inject({ method: "GET", url: `/api/automation/subtitles/jobs/${noSourceId}`, headers })
  ).json();
  expect(skipped.result).toMatchObject({ metadataUpdated: true, badgeStatus: "skipped" });
  expect(skipped.warnings).toEqual(expect.arrayContaining([expect.stringContaining("原图来源")]));
  expect(await readFile(join(root, "poster.jpg"))).toEqual(firstPoster);
  const conflict = await fastify.inject({ ...request, payload: { ...input, language: "en" } });
  expect(conflict.statusCode).toBe(409);
  const bad = await fastify.inject({
    ...request,
    payload: { ...input, eventId: randomUUID(), subtitlePath: "/media/259LUXU-1573.chs.srt" },
  });
  await expect
    .poll(
      async () =>
        (
          await fastify.inject({ method: "GET", url: `/api/automation/subtitles/jobs/${bad.json().taskId}`, headers })
        ).json().status,
      { timeout: 10_000 },
    )
    .toBe("failed");
  await writeFile(join(root, "259LUXU-1573.chs.srt"), "subtitle");
  const badId = bad.json().taskId;
  const retryResponse = await fastify.inject({
    method: "POST",
    url: "/trpc/subtitleUpdates.retry",
    headers: { authorization: `Bearer ${token}` },
    payload: { id: badId },
  });
  expect(retryResponse.statusCode).toBe(200);
  await expect.poll(async () => (await services.subtitleUpdates.get(badId))?.attempts, { timeout: 10_000 }).toBe(2);
  await expect
    .poll(async () => (await services.subtitleUpdates.get(badId))?.status, { timeout: 10_000 })
    .toBe("completed");
  state.database.sqlite.prepare("UPDATE subtitle_update_jobs SET status = 'running' WHERE task_id = ?").run(noSourceId);
  const paths = services.config.runtimePaths;
  await fastify.close();
  const config = new ServerConfigService(paths);
  const persistence = new ServerPersistenceService(paths);
  const restarted = buildServer({ services: { config, persistence }, webStaticDir: false });
  try {
    await expect
      .poll(
        async () =>
          (
            await restarted.fastify.inject({
              method: "GET",
              url: `/api/automation/subtitles/jobs/${noSourceId}`,
              headers,
            })
          ).json().status,
        { timeout: 10_000 },
      )
      .toBe("completed");
    expect((await restarted.fastify.inject(request)).json().taskId).toBe(taskId);
  } finally {
    await restarted.fastify.close();
  }
});
