import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { NetworkClient } from "@mdcz/runtime/network";
import { acquireMediaTask, movieTaskKey } from "@mdcz/runtime/publication/mediaTasks";
import { acquireOutputDirectories } from "@mdcz/runtime/publication/outputMutex";
import { NfoGenerator } from "@mdcz/runtime/scrape";
import { Website } from "@mdcz/shared/enums";
import sharp from "sharp";
import { afterEach, expect, it, vi } from "vitest";
import { buildServer } from "./app";
import {
  closeTestServers,
  createTempRoot,
  createTestAggregation,
  createTestLibrary,
  createTestServer,
  loginAsAdmin,
  startTestImageServer,
} from "./app.testSupport";
import { ServerConfigService } from "./services/configService";
import { ServerPersistenceService } from "./services/persistenceService";

afterEach(closeTestServers);
afterEach(() => vi.restoreAllMocks());

it("batch retries selected failure attempts across pages, including historical jobs for the same movie", async () => {
  const root = await createTempRoot("subtitle-batch-retry");
  let releaseScrape!: () => void;
  let scrapeStarted!: () => void;
  const scrapeHeld = new Promise<void>((resolve) => {
    releaseScrape = resolve;
  });
  const scraping = new Promise<void>((resolve) => {
    scrapeStarted = resolve;
  });
  const aggregation = createTestAggregation("https://unused.example/image.png");
  const { fastify, services } = await createTestServer({
    scrapeAggregation: {
      aggregate: async (number, options) => {
        scrapeStarted();
        await scrapeHeld;
        return await aggregation.aggregate(number, options);
      },
    },
  });
  const token = await loginAsAdmin(fastify);
  const headers = { authorization: `Bearer ${token}` };
  const { rootId, libraryId } = await createTestLibrary(fastify, token, root);
  const movie = { number: "ABC-001", title: "Movie", actors: [], genres: [], scene_images: [], website: Website.JAVDB };
  const mediaPath = join(root, "ABC-001.strm");
  const subtitlePath = join(root, "ABC-001.srt");
  const nfoPath = join(root, "ABC-001.nfo");
  await writeFile(mediaPath, "video");
  await writeFile(subtitlePath, "subtitle");
  await writeFile(nfoPath, new NfoGenerator().buildXml(movie));
  const { database, repositories } = await services.persistence.getState();
  await repositories.library.upsertEntry({
    movie: {
      ...movie,
      id: "movie-1",
      crawlerDataJson: JSON.stringify(movie),
      assets: [{ kind: "nfo", uri: "ABC-001.nfo", rootId, relativePath: "ABC-001.nfo", published: true }],
    },
    files: [{ fileId: "file-1", rootId, rootRelativePath: "ABC-001.strm" }],
  });
  const insert = database.sqlite.prepare(
    "INSERT INTO subtitle_update_jobs (task_id, movie_key, inputs_json, status, stage, attempts, error, created_at, updated_at) VALUES (?, ?, ?, ?, 'scanning', 0, ?, ?, ?)",
  );
  const first = { eventId: randomUUID(), mediaPath, subtitlePath, language: "zh-CN" };
  const duplicateError = `资源目标重复：${nfoPath}`;
  insert.run("old-a", "movie:movie-1", JSON.stringify([first]), "failed", duplicateError, 1, 1);
  insert.run("old-b", "movie:movie-1", JSON.stringify([first]), "failed", duplicateError, 2, 2);
  database.sqlite
    .prepare("INSERT INTO subtitle_update_events (event_id, task_id, input_json) VALUES (?, ?, ?)")
    .run(first.eventId, "old-a", JSON.stringify(first));
  for (let index = 0; index < 120; index += 1) {
    const missingPath = join(root, `missing-${index}.strm`);
    insert.run(
      `failed-${index}`,
      missingPath,
      JSON.stringify([{ ...first, eventId: randomUUID(), mediaPath: missingPath }]),
      "failed",
      index === 119 ? "字幕文件不属于指定影片" : duplicateError,
      index + 3,
      index + 3,
    );
  }
  insert.run("done", "movie:movie-1", JSON.stringify([first]), "completed", null, 200, 200);

  const list = { method: "GET" as const, url: "/trpc/subtitleUpdates.listFailed" };
  expect((await fastify.inject(list)).statusCode).toBe(401);
  const response = await fastify.inject({ ...list, headers });
  expect(response.statusCode).toBe(200);
  const failures = response.json().result.data as Awaited<ReturnType<typeof services.subtitleUpdates.listFailed>>;
  expect(failures).toHaveLength(122);
  expect(failures[0]).toMatchObject({ taskId: "failed-119", errorType: "subtitleMismatch" });
  expect(failures.at(-1)).toEqual({ taskId: "old-a", attempts: 0, mediaPath, errorType: "duplicateTarget" });
  const jobs = failures
    .filter(({ errorType }) => errorType === "duplicateTarget")
    .map(({ taskId, attempts }) => ({ taskId, attempts }));
  const retry = { method: "POST" as const, url: "/trpc/subtitleUpdates.retryBatch", payload: { jobs } };
  expect((await fastify.inject(retry)).statusCode).toBe(401);
  expect((await fastify.inject({ ...retry, headers, payload: { jobs: [] } })).statusCode).toBe(400);
  expect((await fastify.inject({ ...retry, headers })).json().result.data).toEqual({ queued: 121 });
  await expect
    .poll(async () => (await services.subtitleUpdates.list({ offset: 0, limit: 1 })).counts, { timeout: 10_000 })
    .toEqual({ queued: 0, running: 0, completed: 3, failed: 120 });
  expect(await services.subtitleUpdates.get("old-b")).toMatchObject({ status: "completed", attempts: 1 });
  expect(await services.subtitleUpdates.enqueue(first)).toEqual({ taskId: "old-a", status: "completed" });
  expect(await readFile(nfoPath, "utf8")).toContain("<tag>中文字幕</tag>");
  expect(await services.subtitleUpdates.get("failed-0")).toMatchObject({
    status: "failed",
    attempts: 1,
    error: expect.stringContaining("未找到已登记的影片"),
  });
  expect(await services.subtitleUpdates.get("failed-119")).toMatchObject({ status: "failed", attempts: 0 });
  expect((await fastify.inject({ ...retry, headers })).json().result.data).toEqual({ queued: 0 });

  const remaining = await services.subtitleUpdates.listFailed();
  const receiptInput = { ...first, eventId: randomUUID(), mediaPath: join(root, "missing-0.strm") };
  database.sqlite
    .prepare("INSERT INTO subtitle_update_events (event_id, task_id, input_json) VALUES (?, 'failed-0', ?)")
    .run(receiptInput.eventId, JSON.stringify(receiptInput));
  const original = await services.subtitleUpdates.get("failed-0");
  database.sqlite.prepare("UPDATE subtitle_update_jobs SET attempts = attempts + 1 WHERE task_id = 'failed-119'").run();
  database.sqlite.prepare("UPDATE subtitle_update_jobs SET status = 'completed' WHERE task_id = 'failed-118'").run();
  const ignore = {
    method: "POST" as const,
    url: "/trpc/subtitleUpdates.ignoreBatch",
    payload: {
      jobs: [...remaining, remaining[0], { taskId: "done", attempts: 0 }, { taskId: "missing", attempts: 0 }],
    },
  };
  expect((await fastify.inject(ignore)).statusCode).toBe(401);
  expect((await fastify.inject({ ...ignore, headers, payload: { jobs: [] } })).statusCode).toBe(400);
  expect((await fastify.inject({ ...ignore, headers })).json().result.data).toEqual({ ignored: 118 });
  expect((await fastify.inject({ ...ignore, headers })).json().result.data).toEqual({ ignored: 0 });
  expect(await services.subtitleUpdates.list({ offset: 0, limit: 50 })).toMatchObject({
    total: 5,
    counts: { queued: 0, running: 0, completed: 4, failed: 1 },
  });
  expect(await services.subtitleUpdates.listFailed()).toEqual([
    expect.objectContaining({ taskId: "failed-119", attempts: 1 }),
  ]);
  expect(await services.subtitleUpdates.get("failed-0", "workbench")).toBeNull();
  expect(await services.subtitleUpdates.get("failed-0")).toEqual(original);
  expect(await services.subtitleUpdates.enqueue(receiptInput)).toEqual({ taskId: "failed-0", status: "failed" });
  await expect(services.subtitleUpdates.retry("failed-0")).rejects.toThrow("只能重试失败");
  expect(await services.subtitleUpdates.retryBatch({ jobs: [{ taskId: "failed-0", attempts: 1 }] })).toEqual({
    queued: 0,
  });
  expect(await readFile(mediaPath, "utf8")).toBe("video");
  expect(await readFile(subtitlePath, "utf8")).toBe("subtitle");

  await mkdir(join(root, "independent"));
  const independent = {
    eventId: randomUUID(),
    mediaPath: join(root, "independent", "BBB-002.strm"),
    subtitlePath: join(root, "independent", "BBB-002.srt"),
    language: "zh-CN",
  };
  await writeFile(independent.mediaPath, "video");
  await writeFile(independent.subtitlePath, "subtitle");
  await writeFile(
    join(root, "independent", "BBB-002.nfo"),
    new NfoGenerator().buildXml({ ...movie, number: "BBB-002" }),
  );
  await repositories.library.upsertEntry({
    movie: {
      id: "movie-2",
      assets: [
        {
          kind: "nfo",
          uri: "independent/BBB-002.nfo",
          rootId,
          relativePath: "independent/BBB-002.nfo",
          published: true,
        },
      ],
    },
    files: [{ fileId: "file-2", rootId, rootRelativePath: "independent/BBB-002.strm" }],
  });
  for (const label of [
    "刮削当前影片",
    "维护当前影片",
    "批量编辑当前影片",
    "文件处理当前影片",
    "保存当前影片海报",
    "文件发布",
  ]) {
    const release =
      label === "文件发布"
        ? await acquireOutputDirectories([nfoPath])
        : await acquireMediaTask([movieTaskKey("movie-1")], label);
    let blockedId = "";
    try {
      blockedId = (await services.subtitleUpdates.enqueue({ ...first, eventId: randomUUID() })).taskId;
      const free = await services.subtitleUpdates.enqueue({ ...independent, eventId: randomUUID() });
      await expect
        .poll(async () => (await services.subtitleUpdates.get(free.taskId))?.status, { timeout: 10_000 })
        .toBe("completed");
      expect(await services.subtitleUpdates.get(blockedId)).toMatchObject({
        status: "queued",
        attempts: 0,
        progress: expect.stringContaining(label),
      });
      expect((await services.subtitleUpdates.list({ offset: 0, limit: 1 })).waitingForResources).toBe(1);
    } finally {
      release();
    }
    await expect
      .poll(async () => (await services.subtitleUpdates.get(blockedId))?.status, { timeout: 10_000 })
      .toBe("completed");
  }

  // Keep a real scrape session running while an already published movie finishes its subtitle chain.
  await services.config.update({
    translate: { enableTranslation: false },
    download: {
      downloadThumb: false,
      downloadPoster: false,
      downloadFanart: false,
      downloadSceneImages: false,
      downloadTrailer: false,
    },
  });
  await mkdir(join(root, "incoming"));
  await writeFile(join(root, "incoming", "CCC-003.strm"), "video");
  const scrape = await services.scrape.start({
    libraryId,
    executionMode: "batch",
    refs: [{ rootId, relativePath: "incoming/CCC-003.strm" }],
  });
  try {
    await scraping;
    const update = await services.subtitleUpdates.enqueue({ ...first, eventId: randomUUID() });
    await expect
      .poll(async () => (await services.subtitleUpdates.get(update.taskId))?.status, { timeout: 10_000 })
      .toBe("completed");
    expect((await services.scrape.liveRuns()).runs.some((run) => run.task.id === scrape.task.id)).toBe(true);
  } finally {
    releaseScrape();
  }
  await expect.poll(async () => (await services.scrape.liveRuns()).runs.length, { timeout: 10_000 }).toBe(0);

  await services.config.update({ emby: { url: "http://127.0.0.1:1", apiKey: "test", notifyAfterPublish: true } });
  const notifications = vi.spyOn(NetworkClient.prototype, "postText").mockResolvedValue("");
  const releaseMove = await acquireMediaTask([movieTaskKey("movie-1")], "维护当前影片");
  let movedId = "";
  const movedMedia = join(root, "moved", "RENAMED.strm");
  const movedSubtitle = join(root, "moved", "RENAMED.srt");
  const movedNfo = join(root, "moved", "RENAMED.nfo");
  try {
    movedId = (await services.subtitleUpdates.enqueue({ ...first, eventId: randomUUID() })).taskId;
    await mkdir(join(root, "moved"));
    await rename(mediaPath, movedMedia);
    await rename(subtitlePath, movedSubtitle);
    await rename(nfoPath, movedNfo);
    database.sqlite
      .prepare("UPDATE library_item_files SET root_relative_path = 'moved/RENAMED.strm' WHERE id = 'file-1'")
      .run();
    database.sqlite
      .prepare(
        "UPDATE library_item_assets SET relative_path = 'moved/RENAMED.nfo', uri = 'moved/RENAMED.nfo' WHERE item_id = 'movie-1' AND kind = 'nfo'",
      )
      .run();
  } finally {
    releaseMove();
  }
  await expect
    .poll(async () => (await services.subtitleUpdates.get(movedId))?.status, { timeout: 10_000 })
    .toBe("completed");
  expect(await readFile(movedNfo, "utf8")).toContain("<tag>中文字幕</tag>");
  expect(notifications).toHaveBeenCalledOnce();
  const beforeRepeat = (await stat(movedNfo)).mtimeMs;
  const duplicate = await services.subtitleUpdates.enqueue({
    ...first,
    eventId: randomUUID(),
    mediaPath: movedMedia,
    subtitlePath: movedSubtitle,
  });
  await expect
    .poll(async () => (await services.subtitleUpdates.get(duplicate.taskId))?.status, { timeout: 10_000 })
    .toBe("completed");
  expect((await services.subtitleUpdates.get(duplicate.taskId))?.result).toMatchObject({
    metadataUpdated: false,
    mediaServerNotified: false,
  });
  expect((await stat(movedNfo)).mtimeMs).toBe(beforeRepeat);
  expect(notifications).toHaveBeenCalledOnce();
  await writeFile(movedSubtitle, "changed subtitle content");
  const changed = await services.subtitleUpdates.enqueue({
    ...first,
    eventId: randomUUID(),
    mediaPath: movedMedia,
    subtitlePath: movedSubtitle,
  });
  await expect
    .poll(async () => (await services.subtitleUpdates.get(changed.taskId))?.status, { timeout: 10_000 })
    .toBe("completed");
  expect(notifications).toHaveBeenCalledTimes(2);

  notifications.mockRejectedValueOnce(new Error("refresh unavailable"));
  await writeFile(movedSubtitle, "subtitle requiring another refresh");
  const failedRefresh = await services.subtitleUpdates.enqueue({
    ...first,
    eventId: randomUUID(),
    mediaPath: movedMedia,
    subtitlePath: movedSubtitle,
  });
  await expect
    .poll(async () => (await services.subtitleUpdates.get(failedRefresh.taskId))?.status, { timeout: 10_000 })
    .toBe("completed");
  expect((await services.subtitleUpdates.get(failedRefresh.taskId))?.warnings.join(" ")).toContain(
    "refresh unavailable",
  );
  const beforeRefreshRetry = (await stat(movedNfo)).mtimeMs;
  const retryRefresh = await services.subtitleUpdates.enqueue({
    ...first,
    eventId: randomUUID(),
    mediaPath: movedMedia,
    subtitlePath: movedSubtitle,
  });
  await expect
    .poll(async () => (await services.subtitleUpdates.get(retryRefresh.taskId))?.status, { timeout: 10_000 })
    .toBe("completed");
  expect((await services.subtitleUpdates.get(retryRefresh.taskId))?.result).toMatchObject({
    metadataUpdated: false,
    mediaServerNotified: true,
  });
  expect((await stat(movedNfo)).mtimeMs).toBe(beforeRefreshRetry);
  expect(notifications).toHaveBeenCalledTimes(4);

  const releaseMissing = await acquireMediaTask([movieTaskKey("movie-1")], "文件处理当前影片");
  let missingId = "";
  try {
    missingId = (
      await services.subtitleUpdates.enqueue({
        ...first,
        eventId: randomUUID(),
        mediaPath: movedMedia,
        subtitlePath: movedSubtitle,
      })
    ).taskId;
    database.sqlite
      .prepare("UPDATE subtitle_update_jobs SET bindings_json = ? WHERE task_id = ?")
      .run(JSON.stringify({ [movedMedia]: "deleted-file" }), missingId);
  } finally {
    releaseMissing();
  }
  await expect
    .poll(async () => (await services.subtitleUpdates.get(missingId))?.status, { timeout: 10_000 })
    .toBe("failed");
  expect((await services.subtitleUpdates.get(missingId))?.error).toBe("未找到媒体库文件：deleted-file");
  expect(notifications).toHaveBeenCalledTimes(4);
});

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
  await writeFile(join(root, "259LUXU-1573.srt"), "updated subtitle content");
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
    const clearRequest = { method: "POST" as const, url: "/trpc/subtitleUpdates.clearCompleted", payload: {} };
    expect((await fastify.inject({ ...clearRequest, headers })).statusCode).toBe(401);
    const admin = { authorization: `Bearer ${token}` };
    const cleared = await fastify.inject({ ...clearRequest, headers: admin });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().result.data).toEqual({ cleared: 1 });
    expect((await fastify.inject({ ...clearRequest, headers: admin })).json().result.data).toEqual({ cleared: 0 });
    const afterClear = await services.subtitleUpdates.list({ offset: 0, limit: 50 });
    expect(afterClear).toMatchObject({ counts: { queued: 121, running: 1, completed: 0, failed: 0 }, total: 122 });
    expect(afterClear.jobs.map((job) => job.taskId)).not.toContain(taskId);
    const hidden = await fastify.inject({
      method: "GET",
      url: `/trpc/subtitleUpdates.get?input=${encodeURIComponent(JSON.stringify({ id: taskId }))}`,
      headers: admin,
    });
    expect(hidden.json().result.data).toBeNull();
    expect(
      (await fastify.inject({ method: "GET", url: `/api/automation/subtitles/jobs/${taskId}`, headers })).json(),
    ).toEqual(job);
    expect((await fastify.inject(request)).json()).toEqual({ taskId, status: "completed" });
    const pageResponse = await fastify.inject({
      method: "GET",
      url: `/trpc/subtitleUpdates.list?input=${encodeURIComponent(JSON.stringify({ offset: 100, limit: 50 }))}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(pageResponse.statusCode).toBe(200);
    expect(pageResponse.json().result.data.jobs).toHaveLength(22);
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
    await manual;
    expect(services.libraryEdit.status()?.status).toBe("running");
    expect(await readFile(join(root, "movie.nfo"), "utf8")).not.toContain("Manual tag");
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
    const unchangedNfoTime = (await stat(join(root, "movie.nfo"))).mtimeMs;
    const duplicate = await services.subtitleUpdates.enqueue({ ...input, eventId: randomUUID() });
    await expect
      .poll(async () => (await services.subtitleUpdates.get(duplicate.taskId))?.status, { timeout: 10_000 })
      .toBe("completed");
    expect((await services.subtitleUpdates.get(duplicate.taskId))?.result).toEqual({
      metadataUpdated: false,
      badgeStatus: "unchanged",
      mediaServerNotified: false,
    });
    expect(downloads).toHaveBeenCalledTimes(2);
    expect((await stat(join(root, "movie.nfo"))).mtimeMs).toBe(unchangedNfoTime);
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
  expect(skipped.result).toMatchObject({ metadataUpdated: false, badgeStatus: "skipped" });
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
    const remaining = await restarted.services.subtitleUpdates.clearCompleted();
    expect(remaining).toEqual({ cleared: 5 });
    expect(await restarted.services.subtitleUpdates.list({ offset: 0, limit: 1 })).toMatchObject({
      counts: { queued: 0, running: 0, completed: 0, failed: 120 },
      total: 120,
      jobs: [expect.objectContaining({ status: "failed" })],
    });
  } finally {
    await restarted.fastify.close();
  }
});
