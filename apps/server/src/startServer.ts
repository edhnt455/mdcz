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
      logger.error("服务关闭超过 25 秒，中断的工作将在重启后恢复");
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
      throw new AggregateError([error, closeError], "服务启动失败");
    }
    throw error;
  }
  logger.info(`MDCz 服务正在监听 http://${host}:${port}`);
};
