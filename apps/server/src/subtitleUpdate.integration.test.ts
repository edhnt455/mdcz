import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { NfoGenerator } from "@mdcz/runtime/scrape";
import { Website } from "@mdcz/shared/enums";
import sharp from "sharp";
import { afterEach, expect, it } from "vitest";
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
  await writeFile(join(root, "259LUXU-1573.srt"), "subtitle");
  await writeFile(join(root, "movie.nfo"), nfo);
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
        { kind: "poster", uri: "poster.jpg", rootId, relativePath: "poster.jpg", published: true },
      ],
    },
    files: [{ fileId: "file-1", rootId, rootRelativePath: "259LUXU-1573.mp4" }],
  });
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
    )
    .toBe("completed");
  const job = (
    await fastify.inject({ method: "GET", url: `/api/automation/subtitles/jobs/${taskId}`, headers })
  ).json();
  expect(job.result).toMatchObject({ metadataUpdated: true, badgeStatus: "updated", mediaServerNotified: false });
  expect(await readFile(join(root, "movie.nfo"), "utf8")).toContain("<tag>中文字幕</tag>");
  expect(await readFile(join(root, "movie.nfo"), "utf8")).toContain("259LUXU-1573");
  expect((await state.repositories.library.getEntryById("movie-1")).assets).toContainEqual(
    expect.objectContaining({ kind: "subtitle", fileId: "file-1" }),
  );
  const firstPoster = await readFile(join(root, "poster.jpg"));
  const second = await fastify.inject({ ...request, payload: { ...input, eventId: randomUUID() } });
  const secondId = second.json().taskId;
  await expect
    .poll(
      async () =>
        (await fastify.inject({ method: "GET", url: `/api/automation/subtitles/jobs/${secondId}`, headers })).json()
          .status,
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
    payload: { ...input, eventId: randomUUID(), subtitlePath: "/media/missing.srt" },
  });
  await expect
    .poll(
      async () =>
        (
          await fastify.inject({ method: "GET", url: `/api/automation/subtitles/jobs/${bad.json().taskId}`, headers })
        ).json().status,
    )
    .toBe("failed");
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
      )
      .toBe("completed");
    expect((await restarted.fastify.inject(request)).json().taskId).toBe(taskId);
  } finally {
    await restarted.fastify.close();
  }
});
