import { isUnrecoverableNetworkError, runWithSharedNetworkData } from "@mdcz/runtime/network";
import { isAbortError } from "@mdcz/runtime/scrape/utils/abort";
import { CachedAsyncResolver } from "@mdcz/runtime/shared";
import type { ActorSourceHint } from "../../types";
import { createCacheBucket } from "./shared";
import type {
  OfficialActorSourceDependencies,
  OfficialLookupRequest,
  OfficialLookupResult,
  OfficialSiteAdapter,
} from "./types";

interface RosterOfficialAdapterConfig {
  key: string;
  rateLimitedHosts: string[];
}

export abstract class BaseRosterOfficialAdapter<TRoster> implements OfficialSiteAdapter {
  readonly key: string;

  protected readonly deps: OfficialActorSourceDependencies;

  private rosterResolver = new CachedAsyncResolver<string, TRoster>();

  private rosterBucket = "";
  private rosterFailure: { error: unknown; until: number } | undefined;
  private generation = 0;

  protected constructor(deps: OfficialActorSourceDependencies, config: RosterOfficialAdapterConfig) {
    this.deps = deps;
    this.key = config.key;

    for (const host of config.rateLimitedHosts) {
      deps.networkClient.setDomainLimit?.(host, 1, 1);
    }
  }

  clearCache(): void {
    this.rosterResolver = new CachedAsyncResolver<string, TRoster>();
    this.rosterFailure = undefined;
    this.rosterBucket = "";
    this.generation++;
  }

  protected async loadCachedRoster(loadRoster: () => Promise<TRoster>): Promise<TRoster> {
    const bucket = createCacheBucket();
    if (bucket !== this.rosterBucket) {
      this.clearCache();
      this.rosterBucket = bucket;
    }

    const generation = this.generation;
    if (this.rosterFailure && Date.now() < this.rosterFailure.until) throw this.rosterFailure.error;
    try {
      return await this.rosterResolver.resolve(this.key, async () => await runWithSharedNetworkData(loadRoster));
    } catch (error) {
      if (generation === this.generation && !isAbortError(error) && !isUnrecoverableNetworkError(error)) {
        this.rosterFailure = { error, until: Date.now() + 5 * 60_000 };
      }
      throw error;
    }
  }

  abstract matchesHints(hints: ActorSourceHint[]): boolean;
  abstract lookup(query: OfficialLookupRequest): Promise<OfficialLookupResult | null>;
}
