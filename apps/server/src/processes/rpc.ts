import { request } from "node:http";
import { TRPCError } from "@trpc/server";
import { RemoteProcedureError } from "./remoteProcedureError";

export const callWorker = (
  socketPath: string,
  input: { path: string; input: unknown; token?: string },
): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const body = JSON.stringify(input);
    const req = request(
      {
        socketPath,
        path: "/internal/procedure",
        method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("error", reject);
        response.on("end", () => {
          try {
            const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            if (result.error)
              reject(
                new TRPCError({
                  code: result.error.code,
                  message: result.error.message,
                  cause: new RemoteProcedureError(result.error.message, result.error.domainError),
                }),
              );
            else resolve(result.data);
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.setTimeout(120_000, () => req.destroy(new Error("后台任务处理超时，请检查任务状态后再操作")));
    req.on("error", (error) =>
      reject(
        new TRPCError({ code: "SERVICE_UNAVAILABLE", message: "后台进程暂时不可用，请稍后查看任务状态", cause: error }),
      ),
    );
    req.end(body);
  });
