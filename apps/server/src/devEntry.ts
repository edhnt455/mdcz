import { resolveSiteProxyUrl } from "@mdcz/runtime/config";
import { attachNetworkFixtureCaseId } from "@mdcz/runtime/network/networkFixtureCase";
import { createDevNetworkClient } from "@mdcz/runtime/network/networkFixtureFactory";
import { startContainer } from "./processes/container";
import { ServerConfigService } from "./services/configService";

const config = new ServerConfigService();
const networkClient = createDevNetworkClient({
  getProxyUrl: (site) => resolveSiteProxyUrl(config.getComputed(), site),
  getTimeoutMs: () => config.getComputed().networkTimeoutMs,
  getRetryCount: () => config.getComputed().networkRetryCount,
});

void startContainer({
  services: { config },
  resources: { networkClient, prepareScrapeItem: attachNetworkFixtureCaseId },
});
