import type { ActorSourceProvider } from "@mdcz/runtime/actorSource";
import { PersonSyncManager } from "@mdcz/runtime/mediaserver";
import type { NetworkClient } from "@mdcz/runtime/network";
import { runtimeLoggerService } from "@mdcz/runtime/shared";
import type { TaskEventBus } from "../taskEvents";
import type { ServerConfigService } from "./configService";

export class PersonSyncService extends PersonSyncManager {
  constructor(
    config: ServerConfigService,
    taskEvents: TaskEventBus,
    deps: { networkClient: NetworkClient; actorSourceProvider: ActorSourceProvider },
  ) {
    super({
      ...deps,
      getConfiguration: () => config.get(),
      logger: runtimeLoggerService.getLogger("PersonSync"),
      onChange: (state) => {
        if (state.job) taskEvents.personSync(state.job);
      },
    });
  }
}
