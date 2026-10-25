import {
  type Configuration,
  isMirrorableSite,
  type MirrorableSite,
  resolveSiteUrl,
  SITE_HOMEPAGE_URLS,
} from "@mdcz/shared/config";
import { Website } from "@mdcz/shared/enums";
import type { SiteConnectivityProbeResponse } from "@mdcz/shared/serverDtos";
import { failureReasonOf, type RuntimeNetworkClient, runWithCrawlerSource } from "../network";
import { buildCrawlerOptions } from "../scrape/crawlerOptions";
import { toErrorMessage } from "../shared";

const DEFAULT_SITE_CONNECTIVITY_URLS: Record<Exclude<Website, MirrorableSite>, string> = SITE_HOMEPAGE_URLS;

const appendCookie = (headers: Record<string, string>, cookie: string | undefined): void => {
  const normalized = cookie?.trim();
  if (!normalized) {
    return;
  }

  headers.cookie = headers.cookie ? `${headers.cookie}; ${normalized}` : normalized;
};

// A mirror whose homepage loads may still not serve the search pages the crawlers use.
const MIRROR_PROBE_PATHS: Record<MirrorableSite, string> = {
  [Website.JAVDB]: "/search?q=ABP-001",
  [Website.JAVBUS]: "/search/ABP-001",
};

export const resolveSiteConnectivityTargetUrl = (site: Website, configuration: Configuration): string =>
  isMirrorableSite(site)
    ? `${resolveSiteUrl(configuration.network, site)}${MIRROR_PROBE_PATHS[site]}`
    : DEFAULT_SITE_CONNECTIVITY_URLS[site];

export const buildSiteConnectivityHeaders = (site: Website, configuration: Configuration): Record<string, string> => {
  const headers: Record<string, string> = {};
  const crawlerOptions = buildCrawlerOptions({ site, configuration });
  appendCookie(headers, crawlerOptions.cookies);

  if (site === Website.MGSTAGE) {
    appendCookie(headers, "adc=1");
  }

  if (site === Website.SOKMIL) {
    appendCookie(headers, "AGEAUTH=ok");
  }

  return headers;
};

export const probeSiteConnectivity = async (
  site: Website,
  configuration: Configuration,
  networkClient: Pick<RuntimeNetworkClient, "probe">,
): Promise<SiteConnectivityProbeResponse> => {
  const url = resolveSiteConnectivityTargetUrl(site, configuration);
  const headers = buildSiteConnectivityHeaders(site, configuration);
  const timeout = Math.max(1, Math.trunc(configuration.network.timeout * 1000));
  const startedAt = Date.now();

  try {
    // Probing as the site gives the request the same proxy route the site's crawler takes.
    const result = await runWithCrawlerSource(
      site,
      async () => await networkClient.probe(url, { method: "GET", timeout, headers }),
    );
    // Expired mirror domains answer 200 after redirecting to an unrelated parking host.
    const resolvedHost = new URL(result.resolvedUrl).host;
    const redirectedHost = isMirrorableSite(site) && resolvedHost !== new URL(url).host ? resolvedHost : undefined;
    return {
      ok: result.ok && !redirectedHost,
      latencyMs: Date.now() - startedAt,
      status: result.status,
      resolvedUrl: result.resolvedUrl,
      redirectedHost,
      reason: result.reason,
    };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      error: toErrorMessage(error),
      reason: failureReasonOf(error),
    };
  }
};
