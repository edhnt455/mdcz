import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  type MoviePilotConnection,
  type MoviePilotFile,
  type MoviePilotSettings,
  moviePilotEnvelopeSchema,
  moviePilotFilesSchema,
  moviePilotOptionsSchema,
  type StrmCloudBinding,
} from "@mdcz/shared/moviePilot";

const MAX_ENTRIES = 10_000;

export class MoviePilotClient {
  constructor(
    private readonly settings: Omit<MoviePilotSettings, "token">,
    private readonly token: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  private async request(endpoint: string, body?: MoviePilotFile, query = "") {
    let response: Response;
    try {
      response = await this.fetcher(
        new URL(`api/v1/${endpoint}${query}`, `${this.settings.baseUrl.replace(/\/+$/u, "")}/`),
        {
          method: body ? "POST" : "GET",
          headers: { "X-API-KEY": this.token, "Content-Type": "application/json" },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(20_000),
          redirect: "error",
        },
      );
    } catch {
      throw new Error(`MoviePilot ${endpoint}：连接失败或响应丢失`);
    }
    if (!response.ok) throw new Error(`MoviePilot ${endpoint}：HTTP ${response.status}`);
    let bodyData: unknown;
    try {
      bodyData = await response.json();
    } catch {
      throw new Error(`MoviePilot ${endpoint}：JSON 响应无效`);
    }
    const parsed = moviePilotEnvelopeSchema.safeParse(bodyData);
    if (!parsed.success || !parsed.data.success) throw new Error(`MoviePilot ${endpoint}：业务请求未成功`);
    return { data: parsed.data.data, headers: response.headers };
  }

  async test(): Promise<{ storage: string }> {
    const { data } = await this.request("storage/options");
    const options = moviePilotOptionsSchema.parse(data);
    if (!options.some((option) => option.type === this.settings.storage))
      throw new Error("MoviePilot 的 u115 存储不可用");
    return { storage: this.settings.storage };
  }

  async list(directory: MoviePilotFile): Promise<MoviePilotFile[]> {
    if (directory.storage !== this.settings.storage || directory.type !== "dir")
      throw new Error("MoviePilot 目录身份无效");
    // MoviePilot 先读取整个目录再切片；一次读取避免跨页混用不同时间的目录结果。
    const response = await this.request("storage/list", directory, "?sort=name");
    const items = moviePilotFilesSchema.parse(response.data);
    const total = response.headers.get("X-Total-Count");
    const count = response.headers.get("X-Result-Count");
    if (items.length > MAX_ENTRIES || (total !== null && Number(total) > MAX_ENTRIES))
      throw new Error(`MoviePilot 目录超出 ${MAX_ENTRIES} 项扫描上限：${directory.path}`);
    if (
      total === null ||
      count === null ||
      !/^\d+$/u.test(total) ||
      !/^\d+$/u.test(count) ||
      Number(total) !== items.length ||
      Number(count) !== items.length ||
      response.headers.has("X-Page") ||
      response.headers.has("X-Page-Size")
    )
      throw new Error(
        `MoviePilot 未返回可核验的完整目录：${directory.path}（总数=${total ?? "缺失"}，返回数=${count ?? "缺失"}，实际=${items.length}）；请检查 MoviePilot 版本及代理是否保留数量响应头`,
      );
    const seen = new Set<string>();
    for (const item of items) {
      const itemPath = item.path.replace(/\/$/u, "");
      if (
        item.storage !== directory.storage ||
        item.parent_fileid !== directory.fileid ||
        !itemPath.startsWith("/") ||
        itemPath.includes("\\") ||
        itemPath.includes("\0") ||
        itemPath.split("/").some((part) => part === "." || part === "..") ||
        path.posix.dirname(itemPath) !== (path.posix.normalize(directory.path).replace(/\/$/u, "") || "/") ||
        seen.has(item.fileid)
      )
        throw new Error("无法核验 MoviePilot 目录归属或文件身份");
      seen.add(item.fileid);
    }
    return items;
  }

  async resolveRoot(): Promise<{ root: MoviePilotFile; ancestors: MoviePilotFile[] }> {
    let directory: MoviePilotFile = { storage: this.settings.storage, path: "/", type: "dir", fileid: "0" };
    const ancestors: MoviePilotFile[] = [];
    for (const part of path.posix.normalize(this.settings.rootPath).split("/").filter(Boolean)) {
      const matches = (await this.list(directory)).filter((item) => item.type === "dir" && item.name === part);
      if (matches.length !== 1) throw new Error("无法唯一确定 MoviePilot 允许访问的根目录");
      directory = matches[0];
      ancestors.push(directory);
    }
    if (!ancestors.length) throw new Error("不能将云盘根目录设为允许访问的目录");
    return { root: directory, ancestors };
  }

  async index(
    connection: MoviePilotConnection,
  ): Promise<Map<string, { target: MoviePilotFile; ancestors: MoviePilotFile[] }[]>> {
    const resolved = await this.resolveRoot();
    if (resolved.root.fileid !== connection.root.fileid)
      throw new Error("MoviePilot 允许访问的根目录身份已变化，请重新连接并绑定");
    const queue = [{ directory: resolved.root, ancestors: resolved.ancestors }];
    const visited = new Set<string>();
    const index = new Map<string, { target: MoviePilotFile; ancestors: MoviePilotFile[] }[]>();
    let scanned = 0;
    for (let current = queue.shift(); current; current = queue.shift()) {
      if (visited.has(current.directory.fileid) || visited.size >= 1_000)
        throw new Error("MoviePilot 目录遍历结果不明确或超出扫描上限");
      visited.add(current.directory.fileid);
      for (const item of await this.list(current.directory)) {
        if (++scanned > MAX_ENTRIES) throw new Error("MoviePilot 资源扫描超出上限");
        if (item.type === "dir") queue.push({ directory: item, ancestors: [...current.ancestors, item] });
        else {
          if (!item.pickcode) continue;
          const matches = index.get(item.pickcode) ?? [];
          matches.push({ target: item, ancestors: current.ancestors });
          index.set(item.pickcode, matches);
        }
      }
      if (queue.length) await delay(200);
    }
    return index;
  }

  async verify(connection: MoviePilotConnection, binding: StrmCloudBinding): Promise<MoviePilotFile | undefined> {
    if (
      binding.connectionId !== connection.id ||
      binding.target.storage !== connection.storage ||
      !binding.ancestors.some(
        (item) =>
          item.fileid === connection.root.fileid &&
          path.posix.normalize(item.path).replace(/\/$/u, "") ===
            path.posix.normalize(connection.rootPath).replace(/\/$/u, ""),
      )
    )
      throw new Error("MoviePilot 来源绑定已变化");
    let directory: MoviePilotFile = { storage: connection.storage, path: "/", type: "dir", fileid: "0" };
    for (const ancestor of binding.ancestors) {
      const matches = (await this.list(directory)).filter(
        (item) => item.type === "dir" && item.fileid === ancestor.fileid && item.path === ancestor.path,
      );
      if (matches.length !== 1) throw new Error("MoviePilot 绑定的目录已移动或变化");
      directory = matches[0];
    }
    const items = await this.list(directory);
    const target = items.find((item) => item.fileid === binding.target.fileid);
    if (!target) return undefined;
    if (
      target.type !== "file" ||
      target.pickcode !== binding.target.pickcode ||
      target.size !== binding.target.size ||
      target.path !== binding.target.path ||
      target.parent_fileid !== binding.target.parent_fileid ||
      items.filter((item) => item.pickcode === target.pickcode).length !== 1
    )
      throw new Error("MoviePilot 目标身份已变化");
    return target;
  }

  async deleteFile(file: MoviePilotFile): Promise<void> {
    if (
      file.type !== "file" ||
      file.storage !== this.settings.storage ||
      !file.fileid ||
      !file.parent_fileid ||
      !file.pickcode ||
      file.size == null
    )
      throw new Error("MoviePilot 删除操作需要已核验的文件身份");
    await this.request("storage/delete", file);
  }
}
