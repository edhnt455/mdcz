import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActorImageService } from "@mdcz/runtime/scrape";
import { configurationSchema } from "@mdcz/shared/config";
import { afterEach, describe, expect, it } from "vitest";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("local actor upload sources", () => {
  it("resolves configured images without creating caches or movie assets, and honors source selection", async () => {
    const root = await mkdtemp(join(tmpdir(), "mdcz-actor-source-"));
    directories.push(root);
    const configuration = configurationSchema.parse({ paths: { actorPhotoFolder: root } });
    await writeFile(join(root, "Actor A.png"), "photo");
    await mkdir(join(root, "Actor B.jpg"));
    const service = new ActorImageService();
    expect(await service.resolveLocalImage(configuration, ["Missing", "Actor A"])).toBe(join(root, "Actor A.png"));
    expect(await service.resolveLocalImage(configuration, ["Actor B", "../missing"])).toBeUndefined();
    configuration.personSync.personImageSources = ["official"];
    expect(await service.resolveLocalImage(configuration, ["Actor A"])).toBeUndefined();
    expect((await readdir(root)).sort()).toEqual(["Actor A.png", "Actor B.jpg"]);
  });
});
