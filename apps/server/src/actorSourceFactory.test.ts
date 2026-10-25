import { configurationSchema, defaultConfiguration } from "@mdcz/shared/config";
import { describe, expect, it, vi } from "vitest";
import { createServerActorSourceProvider } from "./actorSourceFactory";

class FakeNetworkClient {
  readonly getJson = vi.fn(async () => ({}));
  readonly getText = vi.fn(async () => "");
  readonly getContent = vi.fn(async () => new Uint8Array());
  readonly postText = vi.fn(async () => "");
  readonly postJson = vi.fn(async () => ({}));
  readonly head = vi.fn(async () => ({ status: 200, ok: true }));
  readonly probe = vi.fn(async () => ({ ok: true, status: 200, contentLength: null, resolvedUrl: "" }));
  readonly download = vi.fn(async () => "");
  readonly createSession = vi.fn(() => ({ getText: vi.fn(async () => "") }));
  readonly registerSiteRequestConfigs = vi.fn();
}

describe("createServerActorSourceProvider", () => {
  it("wires server actor sources for lookup", async () => {
    const provider = createServerActorSourceProvider(
      new FakeNetworkClient() as never,
      {
        resolveLocalImage: async () => undefined,
      } as never,
    );
    const configuration = configurationSchema.parse({
      ...defaultConfiguration,
      personSync: {
        ...defaultConfiguration.personSync,
        personOverviewSources: ["official"],
        personImageSources: ["local"],
      },
    });

    const result = await provider.lookup(configuration, { name: "Actor A" });

    expect(result.profile.name).toBe("Actor A");
  });
});
