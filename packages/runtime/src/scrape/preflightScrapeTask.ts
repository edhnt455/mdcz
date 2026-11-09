import { dirname, join, parse } from "node:path";
import { filesystemPathKey } from "@mdcz/media-store";
import type { DirectoryInventory } from "./DirectoryInventory";

export interface ScrapeTargetMember {
  itemId: string;
  sourcePath: string;
  targetVideoPath: string;
  artifactPaths?: readonly string[];
}

export interface ScrapeTargetGroup {
  movieId?: string;
  members: readonly ScrapeTargetMember[];
}

export interface ScrapeTargetConflict {
  existingMovie?: boolean;
  itemId: string;
  sourcePath: string;
  targetPath: string;
  message: string;
}

export class ScrapeTargetConflictError extends Error {
  constructor(readonly conflicts: readonly ScrapeTargetConflict[]) {
    super(
      conflicts
        .map((conflict) => `${conflict.message}\n待处理文件：${conflict.sourcePath}\n目标路径：${conflict.targetPath}`)
        .join("\n\n"),
    );
    this.name = "ScrapeTargetConflictError";
  }
}

const addConflict = (
  conflicts: Map<string, ScrapeTargetConflict>,
  member: ScrapeTargetMember,
  targetPath: string,
  message: string,
  existingMovie = false,
): void => {
  if (conflicts.has(member.itemId)) return;
  conflicts.set(member.itemId, {
    itemId: member.itemId,
    sourcePath: member.sourcePath,
    targetPath,
    message,
    ...(existingMovie ? { existingMovie } : {}),
  });
};

const markGroup = (
  conflicts: Map<string, ScrapeTargetConflict>,
  group: ScrapeTargetGroup,
  targetPath: string,
  message: string,
): void => {
  for (const member of group.members) addConflict(conflicts, member, targetPath, message);
};

export async function checkScrapeTargets(
  groups: readonly ScrapeTargetGroup[],
  inventory: DirectoryInventory,
  sourceMembers: readonly Pick<ScrapeTargetMember, "itemId" | "sourcePath">[] = [],
): Promise<void> {
  const conflicts = new Map<string, ScrapeTargetConflict>();
  const sources = new Map<string, string>();
  const planned = new Map<string, Array<{ group: ScrapeTargetGroup; member: ScrapeTargetMember }>>();
  const directories = new Set<string>();
  const videos = new Map<string, { group: ScrapeTargetGroup; member: ScrapeTargetMember; kind: "source" | "target" }>();
  const artifacts = new Map<string, { group: ScrapeTargetGroup; path: string }[]>();
  const protectedSources = new Map<string, string>();
  for (const member of sourceMembers)
    protectedSources.set(filesystemPathKey(await inventory.entryPath(member.sourcePath)), member.itemId);

  for (const group of groups) {
    const groupArtifacts = new Set<string>();
    const memberIds = new Set(group.members.map((member) => member.itemId));
    for (const member of group.members) {
      const source = filesystemPathKey(await inventory.entryPath(member.sourcePath));
      sources.set(member.itemId, source);
      videos.set(source, { group, member, kind: "source" });
      const target = await inventory.entryPath(member.targetVideoPath);
      const targetKey = filesystemPathKey(target);
      const owner = protectedSources.get(targetKey);
      if (owner && !memberIds.has(owner)) addConflict(conflicts, member, target, "目标文件名与另一个源视频冲突");
      videos.set(targetKey, { group, member, kind: "target" });
      const key = filesystemPathKey(join(dirname(target), parse(target).name));
      const siblings = planned.get(key) ?? [];
      siblings.push({ group, member });
      planned.set(key, siblings);
      directories.add(dirname(target));
      for (const artifact of member.artifactPaths ?? []) {
        groupArtifacts.add(filesystemPathKey(await inventory.entryPath(artifact)));
      }
    }
    for (const path of groupArtifacts) {
      const owners = artifacts.get(path) ?? [];
      owners.push({ group, path });
      artifacts.set(path, owners);
    }
  }

  for (const siblings of planned.values()) {
    const distinctSources = new Set(siblings.map(({ member }) => sources.get(member.itemId)));
    if (distinctSources.size < 2) continue;
    const first = siblings[0];
    if (
      first.group.movieId &&
      siblings.every(({ group }) => group.movieId === first.group.movieId && group.members.length === 1) &&
      new Set(siblings.map(({ group }) => group)).size === siblings.length
    ) {
      // Publish one source before the terminal callback compares and cleans up its duplicates.
      for (const { member } of siblings.slice(1))
        addConflict(conflicts, member, first.member.targetVideoPath, "目标目录中已存在同名影片", true);
      continue;
    }
    const message =
      new Set(siblings.map(({ group }) => group)).size === 1
        ? "同一影片的多个视频生成了相同目标文件名，且无法通过分辨率区分，请调整命名规则"
        : "多部影片的目标文件名相同";
    for (const { member } of siblings) addConflict(conflicts, member, member.targetVideoPath, message);
  }

  for (const directory of directories) {
    for (const entry of await inventory.mediaEntries(directory)) {
      const targetPath = join(directory, entry.name);
      const matches = planned.get(filesystemPathKey(join(directory, parse(entry.name).name)));
      if (!matches) continue;
      for (const { member } of matches) {
        if (sources.get(member.itemId) === filesystemPathKey(targetPath)) continue;
        addConflict(conflicts, member, targetPath, "目标目录中已存在同名影片", true);
      }
    }
  }

  for (const [path, owners] of artifacts) {
    const distinctGroups = [...new Map(owners.map((owner) => [owner.group.movieId ?? owner.group, owner])).values()];
    if (distinctGroups.length > 1) {
      for (const owner of distinctGroups) markGroup(conflicts, owner.group, owner.path, "多部影片生成的文件路径冲突");
    }
    const sourceOwner = protectedSources.get(path);
    if (sourceOwner)
      for (const owner of distinctGroups)
        if (!owner.group.members.some((member) => member.itemId === sourceOwner))
          markGroup(conflicts, owner.group, owner.path, "生成文件与源视频文件名冲突");
    const video = videos.get(path);
    if (video && distinctGroups.some((owner) => owner.group !== video.group)) {
      markGroup(conflicts, video.group, video.member.targetVideoPath, "生成文件与视频文件名冲突");
      for (const owner of distinctGroups) {
        if (owner.group !== video.group) markGroup(conflicts, owner.group, owner.path, "生成文件与视频文件名冲突");
      }
    }
  }

  if (conflicts.size) throw new ScrapeTargetConflictError([...conflicts.values()]);
}
