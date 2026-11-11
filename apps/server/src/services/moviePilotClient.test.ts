import type { MoviePilotFile } from "@mdcz/shared/moviePilot";
import { describe, expect, it, vi } from "vitest";
import { MoviePilotClient } from "./moviePilotClient";

const directory: MoviePilotFile = { storage: "u115", type: "dir", path: "/Media/AV/", fileid: "3545480291139191977" };
const files: MoviePilotFile[] = Array.from({ length: 281 }, (_, i) => ({
  storage: "u115",
  type: "file",
  path: `/Media/AV/video-${i}.mp4`,
  name: `video-${i}.mp4`,
  fileid: `354594339842896${String(i).padStart(4, "0")}`,
  parent_fileid: directory.fileid,
  pickcode: `pick-${i}`,
  size: 123,
}));

describe("MoviePilot storage contract", () => {
  it("indexes independently available identities without hiding ambiguous pickcodes", async () => {
    const root = { ...directory, path: "/AV/", name: "AV", parent_fileid: "0" };
    const rows = [
      { ...files[0], path: "/AV/video.mp4" },
      { ...files[1], path: "/AV/incomplete.mp4", pickcode: null, size: null },
      { ...files[2], path: "/AV/ambiguous.mp4", pickcode: files[0].pickcode, size: null },
    ];
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as MoviePilotFile;
      const data = body.fileid === "0" ? [root] : rows;
      return Response.json(
        { success: true, message: "", data },
        {
          headers: {
            "X-Total-Count": String(data.length),
            "X-Result-Count": String(data.length),
          },
        },
      );
    });
    const client = new MoviePilotClient(
      { baseUrl: "https://mp.test", storage: "u115", rootPath: "/AV" },
      "token",
      fetcher,
    );
    const index = await client.index({
      id: "connection",
      baseUrl: "https://mp.test",
      storage: "u115",
      rootPath: "/AV",
      root,
    });
    expect(index.size).toBe(1);
    expect(index.get(files[0].pickcode ?? "")?.map((entry) => entry.target)).toEqual([rows[0], rows[2]]);
  });

  it("accepts only complete, typed directory snapshots without pagination", async () => {
    for (const scenario of [
      "complete",
      "empty",
      "missing total",
      "missing count",
      "invalid total",
      "invalid count",
      "truncated",
      "paginated",
      "over limit",
      "duplicate identity",
      "wrong parent",
      "numeric identity",
      "business failure",
    ]) {
      const fetcher = vi.fn<typeof fetch>(async (input, init) => {
        const url = new URL(String(input));
        expect(url.pathname).toBe("/api/v1/storage/list");
        expect(url.searchParams.has("page")).toBe(false);
        expect(url.searchParams.has("count")).toBe(false);
        expect(init?.method).toBe("POST");
        expect(init?.redirect).toBe("error");
        expect(new Headers(init?.headers).get("X-API-KEY")).toBe("test-token");
        expect(JSON.parse(String(init?.body))).toEqual(directory);
        const data = structuredClone(scenario === "empty" ? [] : files);
        if (scenario === "duplicate identity") data[200] = files[0];
        if (scenario === "wrong parent") data[0].parent_fileid = "other-root";
        if (scenario === "numeric identity") Object.assign(data[0], { fileid: Number(files[0].fileid) });
        const headers: Record<string, string> = {
          "X-Total-Count": String(data.length),
          "X-Result-Count": String(data.length),
        };
        if (scenario === "missing total") delete headers["X-Total-Count"];
        if (scenario === "missing count") delete headers["X-Result-Count"];
        if (scenario === "invalid total") headers["X-Total-Count"] = "";
        if (scenario === "invalid count") headers["X-Result-Count"] = "invalid";
        if (scenario === "truncated") headers["X-Total-Count"] = String(data.length + 1);
        if (scenario === "over limit") headers["X-Total-Count"] = "10001";
        if (scenario === "paginated") headers["X-Page"] = "1";
        return Response.json({ success: scenario !== "business failure", message: "", data }, { headers });
      });
      const client = new MoviePilotClient(
        { baseUrl: "https://mp.test", storage: "u115", rootPath: "/Media/AV" },
        "test-token",
        fetcher,
      );
      if (scenario === "complete" || scenario === "empty") {
        expect(await client.list(directory)).toEqual(scenario === "empty" ? [] : files);
      } else {
        await expect(client.list(directory)).rejects.toThrow(
          scenario === "over limit" ? "10000 项扫描上限" : undefined,
        );
      }
      expect(fetcher).toHaveBeenCalledOnce();
    }
  });

  it("requires explicit deletion success, never retries a lost response and redacts upstream errors", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ success: false, message: "secret-test-token", data: null }))
      .mockRejectedValueOnce(new Error("secret-test-token"));
    const client = new MoviePilotClient(
      { baseUrl: "https://mp.test", storage: "u115", rootPath: "/Media/AV" },
      "secret-test-token",
      fetcher,
    );
    await expect(client.deleteFile(files[0])).rejects.toThrow("业务请求未成功");
    await expect(client.deleteFile(files[0])).rejects.toThrow("连接失败或响应丢失");
    expect(fetcher).toHaveBeenCalledTimes(2);
    await expect(client.deleteFile(directory)).rejects.toThrow("已核验的文件身份");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
