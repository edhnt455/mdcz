import {
  ActorSourceProvider,
  ActorSourceRegistry,
  AvbaseActorSource,
  AvjohoActorSource,
  GfriendsActorSource,
  LocalActorSource,
  OfficialActorSource,
} from "@mdcz/runtime/actorSource";
import type { NetworkClient } from "@mdcz/runtime/network";
import type { ActorImageService } from "@mdcz/runtime/scrape";
import { runtimeLoggerService } from "@mdcz/runtime/shared";

export const createServerActorSourceProvider = (
  networkClient: NetworkClient,
  actorImageService: ActorImageService,
  listLibraryDirectories?: () => Promise<string[]>,
): ActorSourceProvider =>
  new ActorSourceProvider({
    logger: runtimeLoggerService.getLogger("ActorSource"),
    registry: new ActorSourceRegistry([
      new LocalActorSource({ actorImageService, listLibraryDirectories }),
      new OfficialActorSource({ networkClient }),
      new GfriendsActorSource({ networkClient }),
      // Headless host: cookie challenges cannot open a browser window. Avjoho still has its session challenge path.
      new AvjohoActorSource({ networkClient }),
      new AvbaseActorSource({ networkClient }),
    ]),
  });
