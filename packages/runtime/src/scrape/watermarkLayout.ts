import type { PosterTagBadgePosition, PosterTagBadgeType, TagBadgeSettings } from "@mdcz/shared/posterBadges";

interface BadgeSize {
  id: PosterTagBadgeType;
  width: number;
  height: number;
}

export interface WatermarkPlacement extends BadgeSize {
  left: number;
  top: number;
}

export function layoutWatermarkBadges(
  width: number,
  height: number,
  badges: readonly BadgeSize[],
  settings: TagBadgeSettings,
): WatermarkPlacement[] {
  if (badges.length === 0) return [];
  const corners: PosterTagBadgePosition[] = ["topLeft", "topRight", "bottomRight", "bottomLeft"];
  const start = corners.indexOf(settings.tagBadgePosition);
  const groups = new Map<PosterTagBadgePosition, BadgeSize[]>();
  let automaticIndex = 0;
  for (const badge of badges) {
    let position = settings.tagBadgePositions[badge.id];
    if (position === "auto") {
      const direction = settings.tagBadgeLayout === "counterclockwise" ? -1 : 1;
      position =
        settings.tagBadgeLayout === "horizontal"
          ? settings.tagBadgePosition
          : corners[(start + direction * (automaticIndex % 4) + 4) % 4];
      automaticIndex += 1;
    }
    const group = groups.get(position) ?? [];
    group.push(badge);
    groups.set(position, group);
  }

  const offsetX = Math.min(settings.tagBadgeOffsetX, Math.floor((width - 1) / 2));
  const offsetY = Math.min(settings.tagBadgeOffsetY, Math.floor((height - 1) / 2));
  const availableWidth = width - offsetX * 2;
  const availableHeight = height - offsetY * 2;
  const positions = [...groups.keys()];
  const splitWidth = positions.some((p) => p.endsWith("Left")) && positions.some((p) => p.endsWith("Right"));
  const splitHeight = positions.some((p) => p.startsWith("top")) && positions.some((p) => p.startsWith("bottom"));
  const widthLimit = Math.floor(availableWidth / (splitWidth ? 2 : 1));
  const heightLimit = Math.floor(availableHeight / (splitHeight ? 2 : 1));
  const desiredHeight = height / settings.tagBadgeScale;
  let scale = 1;
  for (const group of groups.values()) {
    const totalWidth =
      group.reduce((sum, badge) => sum + (desiredHeight * badge.width) / badge.height, 0) +
      settings.tagBadgeGap * (group.length - 1);
    scale = Math.min(scale, widthLimit / totalWidth, heightLimit / desiredHeight);
  }

  const gap = Math.floor(settings.tagBadgeGap * scale);
  const placements = new Map<PosterTagBadgeType, WatermarkPlacement>();
  for (const [position, group] of groups) {
    const sizes = group
      .toSorted(
        (left, right) =>
          Number(settings.tagBadgePositions[left.id] === "auto") -
          Number(settings.tagBadgePositions[right.id] === "auto"),
      )
      .map((badge) => ({
        id: badge.id,
        width: Math.max(1, Math.floor(((desiredHeight * badge.width) / badge.height) * scale)),
        height: Math.max(1, Math.floor(desiredHeight * scale)),
      }));
    const totalWidth = sizes.reduce((sum, badge) => sum + badge.width, 0) + gap * (sizes.length - 1);
    if (totalWidth > widthLimit || sizes.some((badge) => badge.height > heightLimit)) {
      throw new Error("Image is too small for the selected watermarks and margins");
    }
    const right = position.endsWith("Right");
    const bottom = position.startsWith("bottom");
    let cursor = right ? width - offsetX : offsetX;
    for (const badge of sizes) {
      const left = right ? cursor - badge.width : cursor;
      const top = bottom ? height - offsetY - badge.height : offsetY;
      placements.set(badge.id, { ...badge, left, top });
      cursor += (right ? -1 : 1) * (badge.width + gap);
    }
  }
  return badges.map((badge) => {
    const placement = placements.get(badge.id);
    if (!placement) throw new Error(`Missing watermark placement: ${badge.id}`);
    return placement;
  });
}
