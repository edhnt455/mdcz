import { isUnrecoverableNetworkError } from "@mdcz/runtime/network";
import { isAbortError } from "@mdcz/runtime/scrape/utils/abort";
import { mergeActorProfiles, toErrorMessage } from "@mdcz/runtime/shared";
import type { Configuration } from "@mdcz/shared/config";
import { actorProfilesAgree } from "../../profileAgreement";
import { mergeActorSourceHints } from "../../sourceHints";
import type { ActorLookupQuery, ActorSourceResult, BaseActorSource } from "../../types";
import { createOfficialAgencyAdapters } from "./agency";
import { toUniqueNames } from "./shared";
import { createOfficialStudioAdapters } from "./studio";
import type { OfficialActorSourceDependencies, OfficialLookupResult, OfficialSiteAdapter } from "./types";

export type { OfficialActorSourceDependencies } from "./types";

export class OfficialActorSource implements BaseActorSource {
  readonly name = "official" as const;

  private readonly adapters: OfficialSiteAdapter[];
  private networkKey = "";

  constructor(deps: OfficialActorSourceDependencies) {
    this.adapters = [...createOfficialAgencyAdapters(deps), ...createOfficialStudioAdapters(deps)];
  }

  clearCache(): void {
    for (const adapter of this.adapters) adapter.clearCache();
    this.networkKey = "";
  }

  async lookup(configuration: Configuration, query: ActorLookupQuery): Promise<ActorSourceResult> {
    const networkKey = JSON.stringify(configuration.network);
    if (networkKey !== this.networkKey) {
      for (const adapter of this.adapters) adapter.clearCache();
      this.networkKey = networkKey;
    }
    const hints = mergeActorSourceHints(query.sourceHints);
    const candidates = this.adapters.filter((adapter) => adapter.matchesHints(hints));

    const queryNames = toUniqueNames([query.name, ...(query.aliases ?? [])]);
    const warnings: string[] = [];

    // Every agency roster is checked on each lookup; each site has its own host and rate limit, so they load at once.
    const lookups = await Promise.all(
      candidates.map(async (adapter) => {
        try {
          const result = await adapter.lookup({ queryNames, fallbackName: query.name.trim() });
          return { site: adapter.key, success: true, result };
        } catch (error) {
          if (isAbortError(error) || isUnrecoverableNetworkError(error)) throw error;
          return {
            site: adapter.key,
            success: false,
            result: null,
            warning: `Failed to load official actor data from ${adapter.key}: ${toErrorMessage(error)}`,
          };
        }
      }),
    );
    const matchedResults: OfficialLookupResult[] = [];
    const siteResults: NonNullable<ActorSourceResult["siteResults"]> = [];
    for (const lookup of lookups) {
      const { result } = lookup;
      const siteResult = { site: lookup.site, success: lookup.success, photoFound: false };
      siteResults.push(siteResult);
      if (lookup.warning) warnings.push(lookup.warning);
      if (!result) continue;
      const current = mergeActorProfiles(matchedResults.map((item) => item.profile));
      if (current && !actorProfilesAgree(current, result.profile)) {
        warnings.push(`Conflicting official profile for ${query.name}; skipped`);
        continue;
      }
      siteResult.photoFound = Boolean(result.profile.photo_url?.trim());
      matchedResults.push(result);
    }

    if (matchedResults.length > 0) {
      const profile = mergeActorProfiles(matchedResults.map((result) => result.profile));
      if (profile) {
        return {
          source: this.name,
          success: true,
          profile,
          warnings,
          siteResults,
          sourceHints: mergeActorSourceHints(...matchedResults.map((result) => result.sourceHints)),
        };
      }
    }

    return {
      source: this.name,
      success: lookups.every((lookup) => lookup.success),
      warnings,
      siteResults,
    };
  }
}
