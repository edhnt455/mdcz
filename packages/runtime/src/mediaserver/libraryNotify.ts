import type { Configuration } from "@mdcz/shared/config";
import type { RuntimeNetworkClient } from "../network";
import { toErrorMessage } from "../shared";
import { buildMediaServerHeaders, buildMediaServerUrl, type MediaServerKey } from "./client";

/**
 * Tells Emby and Jellyfin that directories received movies, so each scans just those paths instead of waiting for a
 * scheduled library scan. Both servers accept this endpoint; a path outside their libraries is ignored.
 */
export const notifyMediaServersOfPublish = async (
  networkClient: Pick<RuntimeNetworkClient, "postText">,
  configuration: Configuration,
  directories: readonly string[],
  logger: { warn(message: string): void },
): Promise<{ notified: boolean; warnings: string[] }> => {
  if (!directories.length) return { notified: false, warnings: [] };
  const servers: MediaServerKey[] = (["emby", "jellyfin"] as const).filter((key) => {
    const server = configuration[key];
    return (
      (server.notifyAfterPublish || (key === "emby" && configuration.emby.autoSyncActorPhotos)) &&
      server.url.trim() &&
      server.apiKey.trim()
    );
  });
  const body = JSON.stringify({ Updates: directories.map((path) => ({ Path: path, UpdateType: "Created" })) });
  const warnings: string[] = [];
  let notified = 0;
  await Promise.all(
    servers.map(async (key) => {
      try {
        await networkClient.postText(buildMediaServerUrl(configuration, key, "/Library/Media/Updated"), body, {
          useProxy: false,
          headers: buildMediaServerHeaders(configuration, key, { "content-type": "application/json" }),
        });
        notified += 1;
      } catch (error) {
        const warning = `无法通知 ${key} 扫描 ${directories.join(", ")}：${toErrorMessage(error)}`;
        warnings.push(warning);
        logger.warn(warning);
      }
    }),
  );
  return { notified: servers.length > 0 && notified === servers.length, warnings };
};
