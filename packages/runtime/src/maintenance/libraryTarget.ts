import type { PublicationTarget } from "@mdcz/shared/mediaLibrary";
import type { MaintenancePresetId } from "@mdcz/shared/types";
import { type MediaLibrary, toPublicationTarget } from "../library/mediaLibraryService";
import type { ConfiguredMediaRootService } from "../library/mediaRootService";
import { getMaintenancePreset } from "./presets";

/**
 * Moving presets organize files already in a library under its output directory and templates. Only libraries that
 * place videos there can be organized: the others leave videos at their source, which organizing would move.
 */
export const resolveMaintenanceTarget = async (
  presetId: MaintenancePresetId,
  library: MediaLibrary | undefined,
  mediaRoots: Pick<ConfiguredMediaRootService, "prepareOutputDirectory">,
): Promise<{ outputRootId: string; outputRelativeDirectory: string; target: PublicationTarget } | undefined> => {
  if (getMaintenancePreset(presetId).output !== "move") return undefined;
  if (!library) throw new Error("请选择整理目标媒体库");
  const target = toPublicationTarget(library);
  if (!["move", "hardlink", "copy"].includes(target.placement))
    throw new Error(`媒体库“${library.name}”将视频保留在来源位置，无法执行整理`);
  const output = await mediaRoots.prepareOutputDirectory({ hostPath: target.outputPath });
  return { outputRootId: output.id, outputRelativeDirectory: output.relativeDirectory, target };
};
