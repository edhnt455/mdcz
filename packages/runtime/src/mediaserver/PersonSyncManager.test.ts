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

  it("waits for actors after committed publications, merges duplicates, and leaves existing images alone", async () => {
    const { manager, configuration, persons, uploaded, lookup } = fixture();
    persons.push({ Id: "a", Name: "Actor A", ImageTags: { Primary: "manual" } });
    manager.activate();
    manager.published(configuration, movie(["Actor A", "Actor B"]));
    manager.published(configuration, movie(["Actor B"]));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(uploaded).toEqual([]);
    expect(manager.snapshot().automatic).toMatchObject({ status: "waiting", waitingActors: 1 });
    persons.push({ Id: "b", Name: "Actor B" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(uploaded).toEqual(["b"]);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(manager.status()).toMatchObject({
      trigger: "automatic",
      status: "completed",
      result: { processedCount: 1 },
    });
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(uploaded).toEqual(["b"]);
  });

  it("recovers through startup and periodic checks, cools missing sources, and permits manual replacement", async () => {
    const { manager, persons, uploaded, lookup } = fixture();
    persons.push({ Id: "a", Name: "Actor A" });
    lookup.mockResolvedValueOnce({ profile: { name: "Actor A", photo_url: "" }, warnings: [] });
    manager.activate();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(uploaded).toEqual([]);
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(lookup).toHaveBeenCalledTimes(1);
    await manager.run({ server: "emby", kind: "photo", mode: "missing" });
    expect(uploaded).toEqual(["a"]);
    await manager.run({ server: "emby", kind: "photo", mode: "all" });
    expect(uploaded).toEqual(["a", "a"]);
    expect(manager.status()?.trigger).toBe("manual");
    persons.push({ Id: "b", Name: "Actor B" });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(uploaded).toEqual(["a", "a", "b"]);
  });

  it("pauses on rejected credentials, resumes on configuration changes, and honors disabling and shutdown", async () => {
    const { manager, configuration, persons, uploaded, networkClient } = fixture();
    persons.push({ Id: "a", Name: "Actor A" });
    networkClient.getJson.mockRejectedValueOnce(new Error("HTTP 401 Unauthorized"));
    manager.activate();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(manager.snapshot().automatic.status).toBe("blocked");
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(networkClient.getJson).toHaveBeenCalledTimes(1);
    manager.configurationChanged();
    await vi.advanceTimersByTimeAsync(0);
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
    await vi.advanceTimersByTimeAsync(5_000);
    expect(uploaded).toEqual(["a", "b"]);
    expect(manager.snapshot().automatic.waitingActors).toBe(0);
  });
});
