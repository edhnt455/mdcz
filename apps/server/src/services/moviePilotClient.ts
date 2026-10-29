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

const PAGE_SIZE = 200;
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
      throw new Error(`MoviePilot ${endpoint}: connection failed or response lost`);
    }
    if (!response.ok) throw new Error(`MoviePilot ${endpoint}: HTTP ${response.status}`);
    let bodyData: unknown;
    try {
      bodyData = await response.json();
    } catch {
      throw new Error(`MoviePilot ${endpoint}: invalid JSON response`);
    }
    const parsed = moviePilotEnvelopeSchema.safeParse(bodyData);
    if (!parsed.success || !parsed.data.success)
      throw new Error(`MoviePilot ${endpoint}: unsuccessful business response`);
    return { data: parsed.data.data, headers: response.headers };
  }

  async test(): Promise<{ storage: string }> {
    const { data } = await this.request("storage/options");
    const options = moviePilotOptionsSchema.parse(data);
    if (!options.some((option) => option.type === this.settings.storage))
      throw new Error("MoviePilot u115 storage is not available");
    return { storage: this.settings.storage };
  }

  async list(directory: MoviePilotFile): Promise<MoviePilotFile[]> {
    if (directory.storage !== this.settings.storage || directory.type !== "dir")
      throw new Error("MoviePilot directory identity is invalid");
    const items: MoviePilotFile[] = [];
    const seen = new Set<string>();
    let total: number | undefined;
    for (let page = 1; page <= Math.ceil(MAX_ENTRIES / PAGE_SIZE); page++) {
      const response = await this.request("storage/list", directory, `?sort=name&page=${page}&count=${PAGE_SIZE}`);
      const rows = moviePilotFilesSchema.parse(response.data);
      const currentTotal = Number(response.headers.get("X-Total-Count"));
      if (
        !response.headers.has("X-Total-Count") ||
        !Number.isSafeInteger(currentTotal) ||
        currentTotal < 0 ||
        currentTotal > MAX_ENTRIES ||
        (total !== undefined && total !== currentTotal) ||
        Number(response.headers.get("X-Page")) !== page ||
        Number(response.headers.get("X-Page-Size")) !== PAGE_SIZE ||
        Number(response.headers.get("X-Result-Count")) !== rows.length
      )
        throw new Error("MoviePilot pagination is incomplete, changed or exceeds the scan limit");
      total = currentTotal;
      for (const item of rows) {
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
          throw new Error("MoviePilot directory membership or file identity cannot be verified");
        seen.add(item.fileid);
        items.push(item);
      }
      if (items.length === total) return items;
      if (!rows.length || rows.length > PAGE_SIZE || items.length > total)
        throw new Error("MoviePilot pagination is incomplete");
      await delay(200);
    }
    throw new Error("MoviePilot directory exceeds the scan limit");
  }

  async resolveRoot(): Promise<{ root: MoviePilotFile; ancestors: MoviePilotFile[] }> {
    let directory: MoviePilotFile = { storage: this.settings.storage, path: "/", type: "dir", fileid: "0" };
    const ancestors: MoviePilotFile[] = [];
    for (const part of path.posix.normalize(this.settings.rootPath).split("/").filter(Boolean)) {
      const matches = (await this.list(directory)).filter((item) => item.type === "dir" && item.name === part);
      if (matches.length !== 1) throw new Error("MoviePilot allowed root cannot be uniquely resolved");
      directory = matches[0];
      ancestors.push(directory);
    }
    if (!ancestors.length) throw new Error("The cloud storage root cannot be used as the allowed directory");
    return { root: directory, ancestors };
  }

  async index(
    connection: MoviePilotConnection,
  ): Promise<Map<string, { target: MoviePilotFile; ancestors: MoviePilotFile[] }[]>> {
    const resolved = await this.resolveRoot();
    if (resolved.root.fileid !== connection.root.fileid)
      throw new Error("MoviePilot allowed root identity changed; reconnect and rebind");
    const queue = [{ directory: resolved.root, ancestors: resolved.ancestors }];
    const visited = new Set<string>();
    const index = new Map<string, { target: MoviePilotFile; ancestors: MoviePilotFile[] }[]>();
    let scanned = 0;
    for (let current = queue.shift(); current; current = queue.shift()) {
      if (visited.has(current.directory.fileid) || visited.size >= 1_000)
        throw new Error("MoviePilot directory traversal is ambiguous or exceeds the scan limit");
      visited.add(current.directory.fileid);
      for (const item of await this.list(current.directory)) {
        if (++scanned > MAX_ENTRIES) throw new Error("MoviePilot resource scan exceeds the limit");
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
      throw new Error("MoviePilot source binding changed");
    let directory: MoviePilotFile = { storage: connection.storage, path: "/", type: "dir", fileid: "0" };
    for (const ancestor of binding.ancestors) {
      const matches = (await this.list(directory)).filter(
        (item) => item.type === "dir" && item.fileid === ancestor.fileid && item.path === ancestor.path,
      );
      if (matches.length !== 1) throw new Error("MoviePilot bound directory moved or changed");
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
      throw new Error("MoviePilot target identity changed");
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
      throw new Error("MoviePilot deletion requires a verified file identity");
    await this.request("storage/delete", file);
  }
}
