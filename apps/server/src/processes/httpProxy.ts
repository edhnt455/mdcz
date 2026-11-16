import { request } from "node:http";
import type { FastifyReply, FastifyRequest } from "fastify";

export const proxyHttp = (socketPath: string, incoming: FastifyRequest, reply: FastifyReply): void => {
  reply.hijack();
  const outgoing = request(
    { socketPath, path: incoming.raw.url, method: incoming.method, headers: incoming.headers },
    (response) => {
      reply.raw.writeHead(response.statusCode ?? 502, response.headers);
      response.on("error", () => reply.raw.destroy());
      response.pipe(reply.raw);
    },
  );
  outgoing.setTimeout(120_000, () => outgoing.destroy(new Error("上游服务响应超时")));
  outgoing.on("error", () => {
    if (reply.raw.headersSent) return reply.raw.destroy();
    reply.raw.writeHead(503, { "content-type": "application/json; charset=utf-8", "retry-after": "2" });
    reply.raw.end(JSON.stringify({ error: "服务正在恢复，请稍后重试" }));
  });
  incoming.raw.on("aborted", () => outgoing.destroy());
  reply.raw.on("close", () => {
    if (!reply.raw.writableFinished) outgoing.destroy();
  });
  incoming.raw.pipe(outgoing);
};
