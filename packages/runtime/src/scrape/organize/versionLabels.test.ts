import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assignVersionLabels, type VersionCandidate, versionKey } from "./versionLabels";

const source = join("/downloads");
const target = join("/library", "ABC-123");
const candidate = (name: string, overrides: Partial<VersionCandidate> = {}): VersionCandidate => ({
  sourcePath: join(source, name),
  targetVideoPath: join(target, "ABC-123.mp4"),
  multipart: false,
  size: 1,
  ...overrides,
});

describe("assignVersionLabels", () => {
  it("assigns stable, unique labels across resolution, unknown, and multipart versions", () => {
    for (const { name, candidates, occupied, expected } of [
      {
        name: "keeps the highest probed resolution unlabeled",
        candidates: [candidate("a.mp4", { height: 1080 }), candidate("b.mp4", { height: 2160 })],
        expected: ["1080p", undefined],
      },
      {
        name: "prefers probed height over the filename token",
        candidates: [
          candidate("ABC-123-4K.mp4", { height: 1080, filenameResolution: "4K" }),
          candidate("b.mp4", { height: 2160 }),
        ],
        expected: ["1080p", undefined],
      },
      {
        name: "never renames the version already in place",
        candidates: [
          candidate("in-place", { sourcePath: join(target, "ABC-123.mp4"), height: 1080 }),
          candidate("b.mp4", { height: 2160 }),
        ],
        expected: [undefined, "2160p"],
      },
      {
        name: "leaves the only unknown resolution unlabeled",
        candidates: [candidate("ABC-123.mp4"), candidate("ABC-123-4K.mp4", { filenameResolution: "4K" })],
        expected: [undefined, "2160p"],
      },
      {
        name: "labels every new file next to an existing library version",
        candidates: [candidate("ABC-123 - 800p.mp4", { filenameResolution: "800P" })],
        occupied: true,
        expected: ["800p"],
      },
      {
        name: "numbers versions with unknown resolution",
        candidates: [candidate("a.mp4"), candidate("b.mkv", { targetVideoPath: join(target, "ABC-123.mkv") })],
        expected: [undefined, "Version 2"],
      },
      {
        name: "does not label multipart files",
        candidates: [
          candidate("a-cd1.mp4", { multipart: true, height: 1080 }),
          candidate("b-cd1.mp4", { multipart: true, height: 2160 }),
        ],
        expected: [undefined, undefined],
      },
      {
        name: "numbers the reported strm pair and retains the original basename",
        candidates: [
          candidate("SSIS-826.strm", { targetVideoPath: join(target, "SSIS-826.strm") }),
          candidate("SSIS-826(1).strm", { targetVideoPath: join(target, "SSIS-826.strm") }),
        ],
        expected: [undefined, "Version 2"],
      },
      {
        name: "numbers repeated resolutions",
        candidates: [
          candidate("a.mp4", { height: 1080 }),
          candidate("b.mp4", { height: 1080 }),
          candidate("c.mp4", { height: 1080 }),
        ],
        expected: [undefined, "1080p", "1080p - Version 2"],
      },
      {
        name: "keeps unknown copies of an existing movie in duplicate review",
        candidates: [candidate("a.strm")],
        occupied: true,
        expected: [undefined],
      },
      {
        name: "retains existing version labels during reorganization",
        candidates: [
          candidate("a", { sourcePath: join(target, "ABC-123.mp4") }),
          candidate("b", { sourcePath: join(target, "ABC-123 - Version 2.mp4") }),
        ],
        expected: [undefined, "Version 2"],
      },
      {
        name: "reserves other planned basenames",
        candidates: [
          candidate("a.mp4"),
          candidate("b.mp4"),
          candidate("c.mp4", { targetVideoPath: join(target, "ABC-123 - Version 2.mp4") }),
        ],
        expected: [undefined, "Version 3", undefined],
      },
    ]) {
      const occupiedKeys = new Set(occupied ? [versionKey(join(target, "ABC-123.mp4"))] : []);
      expect(assignVersionLabels(candidates, occupiedKeys), name).toEqual(expected);
    }
  });
});
