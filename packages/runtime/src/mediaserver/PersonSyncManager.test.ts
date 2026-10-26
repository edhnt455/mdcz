import { configurationSchema } from "@mdcz/shared/config";
import { Website } from "@mdcz/shared/enums";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActorSourceProvider } from "../actorSource";
import type { RuntimeNetworkClient } from "../network";
import { PersonSyncManager } from "./PersonSyncManager";

const photo = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6DbkAAAAASUVORK5CYII=",
  "base64",
);
const managers: PersonSyncManager[] = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.close()));
  vi.useRealTimers();
});

function fixture() {
  vi.useFakeTimers();
  const configuration = configurationSchema.parse({
    emby: { url: "http://emby.test", apiKey: "secret", userId: "user", refreshPersonAfterSync: false },
  });
  const persons: { Id: string; Name: string; ImageTags?: Record<string, string> }[] = [];
  const uploaded: string[] = [];
  const networkClient = {
    getJson: vi.fn(async (url: string) =>
      new URL(url).pathname === "/Persons"
        ? { Items: persons.map((person) => ({ ...person })) }
        : (persons.find((person) => url.endsWith(`/Items/${person.Id}`)) ?? {}),
    ),
    getContent: vi.fn(async () => photo),
    postText: vi.fn(async (url: string, _body?: string, _init?: { headers?: Headers }) => {
      const id = new URL(url).pathname.split("/")[2];
      uploaded.push(id);
      const person = persons.find((person) => person.Id === id);
      if (person) person.ImageTags = { Primary: "uploaded" };
      return "";
    }),
  };
  const lookup = vi.fn(async (_config: unknown, query: { name: string }) => ({
    profile: { name: query.name, photo_url: "https://photos.test/actor" },
    warnings: [],
  }));
  const manager = new PersonSyncManager({
    getConfiguration: async () => configuration,
    networkClient: networkClient as unknown as RuntimeNetworkClient,
    actorSourceProvider: { lookup, clearCache: vi.fn() } as unknown as ActorSourceProvider,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
  managers.push(manager);
  return { manager, configuration, persons, uploaded, networkClient, lookup };
}

const movie = (actors: string[]) => ({
  actors,
  website: Website.DMM,
  title: "Movie",
  number: "ABC-123",
  genres: [],
  scene_images: [],
});

describe("automatic Emby actor photos", () => {
  it("rejects invalid photos, detects newly added Emby images, and uploads valid bytes with their actual MIME type", async () => {
    const { manager, persons, uploaded, networkClient } = fixture();
    persons.push({ Id: "a", Name: "Actor A" }, { Id: "b", Name: "Actor B" }, { Id: "c", Name: "Actor C" });
    networkClient.getContent.mockResolvedValueOnce(Buffer.from("<html>not an image</html>"));
    networkClient.getContent.mockImplementationOnce(async () => {
      persons[1].ImageTags = { Primary: "set-by-user" };
      return photo;
    });
    const result = await manager.run({ server: "emby", kind: "photo", mode: "missing" });
    expect(uploaded).toEqual(["c"]);
    expect(result).toMatchObject({
      processedCount: 1,
      failedCount: 1,
      skippedCount: 1,
      failures: [{ personId: "a", message: "Invalid actor image content" }],
    });
    expect(networkClient.postText.mock.calls[0][2]?.headers?.get("content-type")).toBe("image/png");
  });

  it("checks only published actors once, merges duplicates, and leaves existing images alone", async () => {
    const { manager, configuration, persons, uploaded, lookup, networkClient } = fixture();
    persons.push({ Id: "a", Name: "Actor A", ImageTags: { Primary: "manual" } }, { Id: "c", Name: "Unrelated" });
    manager.activate();
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(networkClient.getJson).not.toHaveBeenCalled();
    manager.published(configuration, movie(["Actor A", "Actor B"]));
    manager.published(configuration, movie(["Actor B"]));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(uploaded).toEqual([]);
    expect(manager.snapshot().automatic).toMatchObject({ status: "idle", waitingActors: 0, nextRunAt: null });
    persons.push({ Id: "b", Name: "Actor B" });
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(networkClient.getJson).toHaveBeenCalledTimes(1);
    expect(lookup).not.toHaveBeenCalled();
    manager.published(configuration, movie(["Actor B"]));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(uploaded).toEqual(["b"]);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(manager.status()).toMatchObject({
      trigger: "automatic",
      status: "completed",
      result: { processedCount: 1 },
    });
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(uploaded).toEqual(["b"]);
  });

  it("leaves missing sources for manual sync and never follows manual sync with an automatic check", async () => {
    const { manager, configuration, persons, uploaded, lookup, networkClient } = fixture();
    persons.push({ Id: "a", Name: "Actor A" });
    lookup.mockResolvedValueOnce({ profile: { name: "Actor A", photo_url: "" }, warnings: [] });
    manager.activate();
    manager.published(configuration, movie(["Actor A"]));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(uploaded).toEqual([]);
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(lookup).toHaveBeenCalledTimes(1);
    await manager.run({ server: "emby", kind: "photo", mode: "missing" });
    expect(uploaded).toEqual(["a"]);
    await manager.run({ server: "emby", kind: "photo", mode: "all" });
    expect(uploaded).toEqual(["a", "a"]);
    expect(manager.status()?.trigger).toBe("manual");
    persons.push({ Id: "b", Name: "Actor B" });
    const calls = networkClient.getJson.mock.calls.length;
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(networkClient.getJson).toHaveBeenCalledTimes(calls);
    expect(uploaded).toEqual(["a", "a"]);
  });

  it("pauses on rejected credentials without retries, applies configuration without scanning, and honors disabling and shutdown", async () => {
    const { manager, configuration, persons, uploaded, networkClient } = fixture();
    persons.push({ Id: "a", Name: "Actor A" });
    networkClient.getJson.mockRejectedValueOnce(new Error("HTTP 401 Unauthorized"));
    manager.activate();
    manager.published(configuration, movie(["Actor A"]));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(manager.snapshot().automatic.status).toBe("blocked");
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(networkClient.getJson).toHaveBeenCalledTimes(1);
    manager.configurationChanged();
    await vi.advanceTimersByTimeAsync(0);
    expect(networkClient.getJson).toHaveBeenCalledTimes(1);
    manager.published(configuration, movie(["Actor A"]));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(uploaded).toEqual(["a"]);
    configuration.emby.autoSyncActorPhotos = false;
    manager.configurationChanged();
    await vi.advanceTimersByTimeAsync(0);
    expect(manager.snapshot().automatic.status).toBe("disabled");
    persons.push({ Id: "b", Name: "Actor B" });
    manager.published(configuration, movie(["Actor B"]));
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(uploaded).toEqual(["a"]);
    await manager.close();
    manager.configurationChanged();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(uploaded).toEqual(["a"]);
  });

  it("retains work arriving during an upload and invalidates uploads when the server changes", async () => {
    const { manager, configuration, persons, uploaded, lookup } = fixture();
    persons.push({ Id: "a", Name: "Actor A" });
    let resolveLookup!: (value: Awaited<ReturnType<typeof lookup>>) => void;
    lookup.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveLookup = resolve;
        }),
    );
    manager.activate();
    manager.published(configuration, movie(["Actor A"]));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(manager.status()?.status).toBe("running");
    const current = manager.start({ server: "emby", kind: "photo", mode: "all" });
    expect(current.trigger).toBe("automatic");
    persons.push({ Id: "b", Name: "Actor B" });
    manager.published(configuration, movie(["Actor B"]));
    await vi.advanceTimersByTimeAsync(5_000);
    configuration.emby.url = "http://new-emby.test";
    manager.configurationChanged();
    resolveLookup({ profile: { name: "Actor A", photo_url: "https://photos.test/actor" }, warnings: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(uploaded).toEqual([]);
    manager.published(configuration, movie(["Actor A", "Actor B"]));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(uploaded).toEqual(["a", "b"]);
    expect(manager.snapshot().automatic.waitingActors).toBe(0);
  });

  it("runs a configured daily check at local wall time, skips startup catch-up, and reschedules after edits", async () => {
    const { manager, configuration, persons, uploaded, networkClient } = fixture();
    vi.setSystemTime(new Date(2026, 9, 26, 2, 0));
    configuration.emby.actorPhotoDailySyncTime = "03:00";
    persons.push({ Id: "a", Name: "Actor A" });
    manager.activate();
    await vi.advanceTimersByTimeAsync(60 * 60_000 - 1);
    expect(networkClient.getJson).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(uploaded).toEqual(["a"]);
    expect(manager.snapshot().automatic.nextRunAt).toBe(new Date(2026, 9, 27, 3, 0).toISOString());
    persons.push({ Id: "b", Name: "Actor B" });
    await vi.advanceTimersByTimeAsync(23 * 60 * 60_000);
    expect(uploaded).toEqual(["a"]);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(uploaded).toEqual(["a", "b"]);

    configuration.emby.actorPhotoDailySyncTime = "02:00";
    manager.configurationChanged(configuration);
    expect(manager.snapshot().automatic.nextRunAt).toBe(new Date(2026, 9, 28, 2, 0).toISOString());
    persons.push({ Id: "c", Name: "Actor C" });
    configuration.emby.actorPhotoDailySyncTime = "";
    manager.configurationChanged(configuration);
    await vi.advanceTimersByTimeAsync(2 * 24 * 60 * 60_000);
    expect(uploaded).toEqual(["a", "b"]);
    expect(manager.snapshot().automatic).toMatchObject({ status: "idle", nextRunAt: null });
  });

  it("serializes daily and publication work with manual uploads and does not retry failed checks", async () => {
    const { manager, configuration, persons, uploaded, lookup, networkClient } = fixture();
    vi.setSystemTime(new Date(2026, 9, 26, 2, 59, 55));
    configuration.emby.actorPhotoDailySyncTime = "03:00";
    persons.push({ Id: "a", Name: "Actor A" });
    let resolveLookup!: (value: Awaited<ReturnType<typeof lookup>>) => void;
    lookup.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveLookup = resolve;
        }),
    );
    manager.activate();
    manager.start({ server: "emby", kind: "photo", mode: "missing" });
    await vi.advanceTimersByTimeAsync(0);
    persons.push({ Id: "b", Name: "Actor B" });
    manager.published(configuration, movie(["Actor B"]));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(uploaded).toEqual([]);
    resolveLookup({ profile: { name: "Actor A", photo_url: "https://photos.test/actor" }, warnings: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(uploaded).toEqual(["a", "b"]);
    expect(manager.snapshot().automatic.nextRunAt).toBe(new Date(2026, 9, 27, 3, 0).toISOString());

    networkClient.getJson.mockRejectedValueOnce(new Error("Connection reset"));
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000 - 5_000);
    expect(manager.status()?.status).toBe("failed");
    const calls = networkClient.getJson.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(networkClient.getJson).toHaveBeenCalledTimes(calls);
    expect(manager.snapshot().automatic.nextRunAt).toBe(new Date(2026, 9, 28, 3, 0).toISOString());
  });
});
