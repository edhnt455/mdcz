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
  it.each([
    "complete",
    "missing pagination",
    "duplicate identity",
    "wrong parent",
    "numeric identity",
    "business failure",
  ] as const)("accepts only complete, typed directory evidence: %s", async (scenario) => {
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/api/v1/storage/list");
      expect(init?.method).toBe("POST");
      expect(init?.redirect).toBe("error");
      expect(new Headers(init?.headers).get("X-API-KEY")).toBe("test-token");
      expect(JSON.parse(String(init?.body))).toEqual(directory);
      const page = Number(url.searchParams.get("page"));
      const data = structuredClone(files.slice((page - 1) * 200, page * 200));
      if (scenario === "duplicate identity" && page === 2) data[0] = files[0];
      if (scenario === "wrong parent") data[0].parent_fileid = "other-root";
      if (scenario === "numeric identity") Object.assign(data[0], { fileid: Number(files[0].fileid) });
      return Response.json(
        { success: scenario !== "business failure", message: "", data },
        {
          headers:
            scenario === "missing pagination"
              ? {}
              : {
                  "X-Page": String(page),
                  "X-Page-Size": "200",
                  "X-Total-Count": "281",
                  "X-Result-Count": String(data.length),
                },
        },
      );
    });
    const client = new MoviePilotClient(
      { baseUrl: "https://mp.test", storage: "u115", rootPath: "/Media/AV" },
      "test-token",
      fetcher,
    );
    if (scenario === "complete") {
      const result = await client.list(directory);
      expect(result).toEqual(files);
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(new Set(result.map((file) => file.fileid)).size).toBe(281);
    } else await expect(client.list(directory)).rejects.toThrow();
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
    await expect(client.deleteFile(files[0])).rejects.toThrow("unsuccessful business response");
    await expect(client.deleteFile(files[0])).rejects.toThrow("connection failed or response lost");
    expect(fetcher).toHaveBeenCalledTimes(2);
    await expect(client.deleteFile(directory)).rejects.toThrow("verified file identity");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
