import { type Configuration, OFFICIAL_SITE_HOSTS, resolveSiteUrl } from "@mdcz/shared/config";
import { Website } from "@mdcz/shared/enums";
import type { NetworkClient } from "../network";
import { createScrapeRestGate, type ScrapeRestGate, type ScrapeRestGateLogger } from "./restGate";

export interface ScrapeExecutionPolicy {
  concurrency: number;
  restGate: ScrapeRestGate | null;
}

export const getScrapeConcurrency = (configuration: Configuration): number =>
  Math.max(1, Math.trunc(configuration.scrape.threadNumber));

export const createJavdbNetworkPolicy = (
  networkClient: Pick<NetworkClient, "setDomainInterval" | "clearDomainLimit">,
): ((configuration: Configuration) => void) => {
  let previousHosts = new Set<string>();
  return (configuration) => {
    const hosts = new Set([
      ...OFFICIAL_SITE_HOSTS[Website.JAVDB],
      new URL(resolveSiteUrl(configuration.network, Website.JAVDB)).hostname,
    ]);
    for (const host of previousHosts) {
      if (!hosts.has(host)) networkClient.clearDomainLimit(host);
    }
    const delayMs = configuration.scrape.javdbDelaySeconds * 1000;
    for (const host of hosts) {
      if (delayMs > 0) networkClient.setDomainInterval(host, delayMs, 1, 1);
      else networkClient.clearDomainLimit(host);
    }
    previousHosts = hosts;
  };
};

export const createScrapeExecutionPolicy = (
  configuration: Configuration,
  options: { logger?: ScrapeRestGateLogger } = {},
): ScrapeExecutionPolicy => ({
  concurrency: getScrapeConcurrency(configuration),
  restGate: createScrapeRestGate({
    restAfterCount: configuration.scrape.restAfterCount,
    restDurationSeconds: configuration.scrape.restDuration,
    logger: options.logger,
  }),
});
