import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";

export async function mediaSnapshot(paths: readonly string[]): Promise<string> {
  const state = await Promise.all(
    [...new Set(paths)].sort().map(async (filePath) => {
      try {
        const info = await stat(filePath, { bigint: true });
        return [filePath, info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].map(String);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        return [filePath, "missing"];
      }
    }),
  );
  return createHash("sha256").update(JSON.stringify(state)).digest("hex");
}
