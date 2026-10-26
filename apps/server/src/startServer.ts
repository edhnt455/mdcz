import type { BuildServerOptions } from "./app";
import { buildServer } from "./app";
import { parseHost, parsePort } from "./config";

export const startServer = async (options: BuildServerOptions = {}): Promise<void> => {
  const port = parsePort(process.env.PORT);
  const host = parseHost(process.env.MDCZ_HOST);
  const { fastify, services } = buildServer(options);
  const logger = services.runtimeLogs.getLogger("server");
  let shutdownPromise: Promise<void> | undefined;

  const shutdown = (): Promise<void> => {
    shutdownPromise ??= fastify.close();
    return shutdownPromise;
  };

  const shutdownForSignal = (): void => {
    const deadline = setTimeout(() => {
      logger.error("Server shutdown exceeded 25 seconds; interrupted work will be recovered on restart");
      process.exit(1);
    }, 25_000);
    deadline.unref();
    void shutdown().then(
      () => process.exit(0),
      (error) => {
        console.error(error);
        process.exit(1);
      },
    );
  };

  process.once("SIGINT", shutdownForSignal);
  process.once("SIGTERM", shutdownForSignal);

  try {
    await fastify.listen({ host, port });
  } catch (error) {
    logger.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    try {
      await shutdown();
    } catch (closeError) {
      throw new AggregateError([error, closeError], "Server startup failed");
    }
    throw error;
  }
  logger.info(`MDCz server listening on http://${host}:${port}`);
};
