import { describe, expect, it } from "vitest";
import { MediaPathOwnership } from "./mediaPathOwnership";

describe("MediaPathOwnership", () => {
  it("acquires physical paths atomically and allows independent files", () => {
    const ownership = new MediaPathOwnership();
    const first = ownership.acquire("/media/b.mp4");
    expect(() => ownership.acquireAll(["/media/a.mp4", "/media/b.mp4"])).toThrow("正在被修改");
    const independent = ownership.acquire("/media/a.mp4");
    independent();
    first();
    const release = ownership.acquireAll(["/media/b.mp4", "/media/a.mp4"]);
    expect(() => ownership.acquire("/media/a.mp4")).toThrow("正在被修改");
    release();
    release();
    ownership.acquire("/media/a.mp4")();
    expect(() => ownership.acquire("")).toThrow("必须提供媒体路径键");
  });

  it("merges aliases and preserves the outer reservation after a nested release", () => {
    const ownership = new MediaPathOwnership();
    const outer = ownership.acquire("/media/video.mp4", "maintenance");
    const inner = ownership.acquireAll(["/media/video.mp4", "/media/video.mp4", "/media/video.nfo"], "maintenance");
    inner();
    expect(() => ownership.acquire("/media/video.mp4")).toThrow("正在被修改");
    ownership.acquire("/media/video.nfo")();
    outer();
    ownership.acquire("/media/video.mp4")();
  });
});
