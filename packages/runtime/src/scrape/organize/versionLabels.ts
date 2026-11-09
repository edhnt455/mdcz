import { dirname, join, parse } from "node:path";
import { filesystemPathKey } from "@mdcz/media-store";

export interface VersionCandidate {
  sourcePath: string;
  targetVideoPath: string;
  multipart: boolean;
  height?: number;
  filenameResolution?: string;
  size: number;
}

const FILENAME_K_HEIGHTS: Readonly<Record<string, number>> = { "8K": 4320, "4K": 2160 };

export const versionKey = (videoPath: string): string =>
  filesystemPathKey(join(dirname(videoPath), parse(videoPath).name));

// Only heights that parseFileInfo reads back as a `<height>p` token may become labels, or the next organize
// run could not tell the labeled file apart from its siblings.
const heightOf = (candidate: VersionCandidate): number | undefined => {
  const token = candidate.filenameResolution?.toUpperCase() ?? "";
  const height = candidate.height || FILENAME_K_HEIGHTS[token] || Number.parseInt(token, 10);
  return height >= 100 && height <= 9999 ? height : undefined;
};

/**
 * Emby, Jellyfin and Plex group `Name.ext` with `Name - 2160p.ext` in one folder as versions of one movie,
 * and Jellyfin sorts `<height>p` labels highest first. Keep existing labels stable and use numbered
 * versions when resolution is unknown or shared by several files.
 */
export const assignVersionLabels = (
  candidates: readonly VersionCandidate[],
  occupiedKeys: ReadonlySet<string> = new Set(),
): Array<string | undefined> => {
  const labels: Array<string | undefined> = candidates.map(() => undefined);
  const reserved = new Set([...occupiedKeys, ...candidates.map((candidate) => versionKey(candidate.targetVideoPath))]);
  const collisions = new Map<string, number[]>();
  for (const [index, candidate] of candidates.entries()) {
    const key = versionKey(candidate.targetVideoPath);
    const prefix = `${parse(candidate.targetVideoPath).name} - `;
    const source = parse(candidate.sourcePath);
    const label = source.name.startsWith(prefix) ? source.name.slice(prefix.length) : "";
    if (
      filesystemPathKey(source.dir) === filesystemPathKey(dirname(candidate.targetVideoPath)) &&
      /^(?:\d{3,4}p(?: - Version (?:[2-9]|[1-9]\d+))?|Version (?:[2-9]|[1-9]\d+))$/u.test(label)
    ) {
      labels[index] = label;
      reserved.add(versionKey(candidate.sourcePath));
    }
    collisions.set(key, [...(collisions.get(key) ?? []), index]);
  }
  for (const [key, indices] of collisions) {
    const occupied = occupiedKeys.has(key);
    if ((indices.length < 2 && !occupied) || indices.some((index) => candidates[index].multipart)) continue;
    const inPlace = indices.find(
      (index) =>
        filesystemPathKey(candidates[index].sourcePath) === filesystemPathKey(candidates[index].targetVideoPath),
    );
    const pending = indices.filter((index) => !labels[index]);
    const unknown = pending.filter((index) => !heightOf(candidates[index]));
    const [best] = pending.toSorted((left, right) => {
      const a = candidates[left];
      const b = candidates[right];
      return (
        (heightOf(b) ?? 0) - (heightOf(a) ?? 0) ||
        b.size - a.size ||
        Number(parse(b.sourcePath).name === parse(b.targetVideoPath).name) -
          Number(parse(a.sourcePath).name === parse(a.targetVideoPath).name) ||
        a.sourcePath.localeCompare(b.sourcePath)
      );
    });
    const unlabeled = occupied ? undefined : (inPlace ?? (unknown.length === 1 ? unknown[0] : best));
    for (const index of pending.toSorted((a, b) => candidates[a].sourcePath.localeCompare(candidates[b].sourcePath))) {
      if (index === unlabeled) continue;
      const candidate = candidates[index];
      const height = heightOf(candidate);
      // Unknown copies of an indexed movie must still enter the duplicate-review workflow.
      if (occupied && !height) continue;
      const target = parse(candidate.targetVideoPath);
      let version = 2;
      let label = height ? `${height}p` : `Version ${version++}`;
      let key = versionKey(join(target.dir, `${target.name} - ${label}${target.ext}`));
      while (reserved.has(key)) {
        label = height ? `${height}p - Version ${version++}` : `Version ${version++}`;
        key = versionKey(join(target.dir, `${target.name} - ${label}${target.ext}`));
      }
      labels[index] = label;
      reserved.add(key);
    }
  }
  return labels;
};
