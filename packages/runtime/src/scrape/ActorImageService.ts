import { stat } from "node:fs/promises";
import { join } from "node:path";
import { toUniqueActorNames } from "@mdcz/shared/actorAliases";
import type { Configuration } from "@mdcz/shared/config";
import { resolveActorPhotoFolderPath, usesLocalActorImageSource } from "./actorImage/actorPhotoPath";
import { sanitizePathSegment } from "./utils/path";

export { resolveActorPhotoFolderPath, usesLocalActorImageSource } from "./actorImage/actorPhotoPath";

export class ActorImageService {
  async resolveLocalImage(configuration: Configuration, actorNames: string[]): Promise<string | undefined> {
    const root = resolveActorPhotoFolderPath(configuration);
    if (!root || !usesLocalActorImageSource(configuration)) return undefined;
    for (const name of toUniqueActorNames(actorNames)) {
      const safeName = sanitizePathSegment(name);
      for (const baseName of new Set([safeName, safeName.replaceAll(" ", "")])) {
        if (!baseName) continue;
        for (const extension of [".jpg", ".jpeg", ".png", ".webp"]) {
          const candidate = join(root, `${baseName}${extension}`);
          try {
            if ((await stat(candidate)).isFile()) return candidate;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }
      }
    }
    return undefined;
  }
}
