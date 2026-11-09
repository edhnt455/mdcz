import type { Configuration } from "@mdcz/shared/config";
import type { MediaServerConnectionCheckResult, PersonSyncResult } from "@mdcz/shared/toolTypes";
import type { RuntimeNetworkClient } from "../network";
import type { RuntimeLogger } from "../shared";
import {
  buildMediaServerHeaders,
  buildMediaServerUrl,
  fetchMediaServerMetadataEditorInfo,
  fetchMediaServerPersons,
  fetchMediaServerResolvedUserId,
  fetchMediaServerUserScopedItemDetail,
  type MediaServerHeadersInit,
  type MediaServerItemDetail,
  type MediaServerMode,
  normalizeMediaServerBaseUrl,
  parseMediaServerMode,
  updateMediaServerItem,
  uploadMediaServerPrimaryImage,
} from "./client";
import {
  isRecord,
  pickAutoResolvedUserId,
  toBooleanValue,
  toStringArray,
  toStringRecord,
  toStringValue,
} from "./common";
import { runMediaServerConnectionCheck } from "./connectionCheck";
import { type MediaServerErrorMapping, MediaServerServiceError, toMediaServerServiceError } from "./errors";
import { type RuntimeInfoActorSourceProvider, runMediaServerInfoSync } from "./infoSync";
import { type RuntimePhotoActorSourceProvider, runMediaServerPhotoSync } from "./photoSync";
import type { PlannedPersonSyncState } from "./planner";

export type JellyfinMode = MediaServerMode;
export type JellyfinBatchResult = PersonSyncResult;
export type JellyfinItemDetail = MediaServerItemDetail;

export interface JellyfinPerson {
  Id: string;
  Name: string;
  Overview?: string;
  ImageTags?: Record<string, string>;
}

export class JellyfinServiceError extends MediaServerServiceError {}

export interface MediaServerSignalService {
  resetProgress(): void;
  setProgress(value: number, current?: number, total?: number): void;
  showLogText(message: string, level?: "info" | "warn" | "error"): void;
}

export interface JellyfinActorServiceDependencies {
  signalService: MediaServerSignalService;
  networkClient: RuntimeNetworkClient;
  actorSourceProvider: RuntimeInfoActorSourceProvider & RuntimePhotoActorSourceProvider;
  logger: RuntimeLogger;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export const normalizeJellyfinBaseUrl = normalizeMediaServerBaseUrl;
export const parseJellyfinMode = parseMediaServerMode;

export const isJellyfinUuid = (value: string): boolean => UUID_PATTERN.test(value.trim());

export const toJellyfinServiceError = (
  error: unknown,
  statusMappings: Partial<Record<number, MediaServerErrorMapping>>,
  fallback: MediaServerErrorMapping,
): JellyfinServiceError => toMediaServerServiceError(error, JellyfinServiceError, statusMappings, fallback);

export const buildJellyfinUrl = (
  configuration: Configuration,
  path: string,
  query: Record<string, string | undefined> = {},
): string => buildMediaServerUrl(configuration, "jellyfin", path, query);

export const buildJellyfinHeaders = (configuration: Configuration, headers: MediaServerHeadersInit = {}): Headers =>
  buildMediaServerHeaders(configuration, "jellyfin", headers);

const getConfiguredJellyfinUserId = (configuration: Configuration): string | undefined => {
  const trimmedUserId = configuration.jellyfin.userId.trim();
  if (trimmedUserId && !isJellyfinUuid(trimmedUserId)) {
    throw new JellyfinServiceError("JELLYFIN_INVALID_USER_ID", "Jellyfin 用户 ID 必须是 UUID");
  }
  return trimmedUserId || undefined;
};

const fetchAutoResolvedJellyfinUserId = async (
  networkClient: RuntimeNetworkClient,
  configuration: Configuration,
): Promise<string> =>
  await fetchMediaServerResolvedUserId(
    {
      networkClient,
      configuration,
      serverKey: "jellyfin",
      path: "/Users",
      extractUsers: (response) => (Array.isArray(response) ? response : []),
      pickUserId: (users) => pickAutoResolvedUserId(users),
      createMissingUserContextError: () =>
        new JellyfinServiceError(
          "JELLYFIN_USER_CONTEXT_REQUIRED",
          "当前 Jellyfin 服务器需要用户身份，请在设置中配置 Jellyfin 用户 ID 后重试",
        ),
      toServiceError: toJellyfinServiceError,
    },
    {
      statusMappings: {
        401: { code: "JELLYFIN_AUTH_FAILED", message: "Jellyfin API 密钥无效，无法读取用户列表" },
        403: {
          code: "JELLYFIN_PERMISSION_DENIED",
          message: "当前 Jellyfin 凭证无权读取用户列表",
        },
      },
      fallback: {
        code: "JELLYFIN_USER_CONTEXT_REQUIRED",
        message: "当前 Jellyfin 服务器需要用户身份，请在设置中配置 Jellyfin 用户 ID 后重试",
      },
    },
  );

export const resolveJellyfinUserId = async (
  networkClient: RuntimeNetworkClient,
  configuration: Configuration,
): Promise<string> =>
  getConfiguredJellyfinUserId(configuration) ?? (await fetchAutoResolvedJellyfinUserId(networkClient, configuration));

export const buildJellyfinPersonUpdatePayload = (
  person: JellyfinPerson,
  detail: JellyfinItemDetail,
  synced: PlannedPersonSyncState,
  lockOverview: boolean,
): Record<string, unknown> => {
  const genres = toStringArray(detail.Genres);
  const providerIds = toStringRecord(detail.ProviderIds);
  const lockedFields = Array.from(new Set(toStringArray(detail.LockedFields)));

  const payload: Record<string, unknown> = {
    Id: person.Id,
    Name: toStringValue(detail.Name) ?? person.Name,
    Overview: synced.overview ?? toStringValue(detail.Overview) ?? "",
    Genres: genres,
    Tags: synced.tags,
    ProviderIds: providerIds,
    Taglines: synced.taglines,
    ProductionLocations: synced.productionLocations ?? [],
  };

  const serverId = toStringValue(detail.ServerId);
  if (serverId) payload.ServerId = serverId;
  const type = toStringValue(detail.Type);
  if (type) payload.Type = type;
  const personType = toStringValue(detail.PersonType);
  if (personType) payload.PersonType = personType;
  if (synced.premiereDate) payload.PremiereDate = synced.premiereDate;
  if (synced.productionYear !== undefined) payload.ProductionYear = synced.productionYear;

  if (lockOverview && !lockedFields.includes("Overview")) {
    lockedFields.push("Overview");
  }
  payload.LockedFields = lockedFields;

  const lockData = toBooleanValue(detail.LockData);
  payload.LockData = lockOverview ? true : (lockData ?? false);

  return payload;
};

export const fetchJellyfinPersons = async (
  networkClient: RuntimeNetworkClient,
  configuration: Configuration,
  options: {
    limit?: number;
    fields?: string[];
    userId?: string;
  } = {},
): Promise<JellyfinPerson[]> => {
  const userId = options.userId ?? getConfiguredJellyfinUserId(configuration);

  return await fetchMediaServerPersons(
    {
      networkClient,
      configuration,
      serverKey: "jellyfin",
      query: {
        userId,
        personTypes: "Actor",
        Limit: options.limit !== undefined ? String(options.limit) : undefined,
        Fields: options.fields?.join(","),
      },
      extractItems: (response) => {
        if (!isRecord(response) || !Array.isArray(response.Items)) {
          return [];
        }
        return response.Items;
      },
      parsePerson: (item) => {
        if (!isRecord(item)) {
          return null;
        }

        const id = toStringValue(item.Id);
        const name = toStringValue(item.Name);
        if (!id || !name) {
          return null;
        }

        return {
          Id: id,
          Name: name,
          Overview: toStringValue(item.Overview),
          ImageTags: isRecord(item.ImageTags) ? toStringRecord(item.ImageTags) : undefined,
        };
      },
      toServiceError: toJellyfinServiceError,
    },
    {
      statusMappings: {
        400: { code: "JELLYFIN_BAD_REQUEST", message: "Jellyfin 人物请求参数无效" },
        401: { code: "JELLYFIN_AUTH_FAILED", message: "Jellyfin API 密钥无效或已过期" },
        403: {
          code: "JELLYFIN_PERMISSION_DENIED",
          message: "当前 Jellyfin 凭证无权读取人物信息",
        },
      },
      fallback: {
        code: "JELLYFIN_UNREACHABLE",
        message: "读取 Jellyfin 人物列表失败",
      },
    },
  );
};

export const fetchJellyfinPersonDetail = async (
  networkClient: RuntimeNetworkClient,
  configuration: Configuration,
  person: JellyfinPerson,
  options: { userId?: string } = {},
): Promise<JellyfinItemDetail> => {
  const userId = options.userId ?? (await resolveJellyfinUserId(networkClient, configuration));

  return await fetchMediaServerUserScopedItemDetail(
    {
      networkClient,
      configuration,
      serverKey: "jellyfin",
      personId: person.Id,
      userId,
      createMissingUserContextError: () =>
        new JellyfinServiceError(
          "JELLYFIN_USER_CONTEXT_REQUIRED",
          "当前 Jellyfin 服务器需要用户身份，请在设置中配置 Jellyfin 用户 ID 后重试",
        ),
      toServiceError: toJellyfinServiceError,
    },
    {
      statusMappings: {
        401: {
          code: "JELLYFIN_AUTH_FAILED",
          message: `读取人物详情失败：Jellyfin API 密钥无效，无法访问 ${person.Name}`,
        },
        403: {
          code: "JELLYFIN_PERMISSION_DENIED",
          message: `读取人物详情失败：当前 Jellyfin API 密钥无权访问 ${person.Name}`,
        },
        404: { code: "JELLYFIN_NOT_FOUND", message: `Jellyfin 中不存在人物 ${person.Name}` },
      },
      fallback: {
        code: "JELLYFIN_UNREACHABLE",
        message: `读取 Jellyfin 人物详情失败：${person.Name}`,
      },
    },
  );
};

export const hasJellyfinPrimaryImage = (person: JellyfinPerson): boolean =>
  typeof person.ImageTags?.Primary === "string" && person.ImageTags.Primary.trim().length > 0;

export const fetchJellyfinMetadataEditorInfo = async (
  networkClient: RuntimeNetworkClient,
  configuration: Configuration,
  personId: string,
): Promise<Record<string, unknown>> =>
  await fetchMediaServerMetadataEditorInfo(
    {
      networkClient,
      configuration,
      serverKey: "jellyfin",
      personId,
      toServiceError: toJellyfinServiceError,
    },
    {
      statusMappings: {
        401: {
          code: "JELLYFIN_AUTH_FAILED",
          message: "Jellyfin 凭证无效，无法核验人物写入权限",
        },
        403: {
          code: "JELLYFIN_PERMISSION_DENIED",
          message: "当前 Jellyfin 凭证无权写入人物信息",
        },
        404: { code: "JELLYFIN_NOT_FOUND", message: "Jellyfin 无法获取人物元数据编辑信息" },
      },
      fallback: {
        code: "JELLYFIN_UNREACHABLE",
        message: "读取 Jellyfin 人物元数据编辑信息失败",
      },
    },
  );

export const updateJellyfinPersonInfo = async (
  networkClient: RuntimeNetworkClient,
  configuration: Configuration,
  person: JellyfinPerson,
  detail: JellyfinItemDetail,
  synced: PlannedPersonSyncState,
  options: { lockOverview?: boolean } = {},
): Promise<void> => {
  const payload = buildJellyfinPersonUpdatePayload(person, detail, synced, options.lockOverview ?? false);
  await updateMediaServerItem(
    {
      networkClient,
      configuration,
      serverKey: "jellyfin",
      personId: person.Id,
      payload,
      toServiceError: toJellyfinServiceError,
    },
    {
      statusMappings: {
        400: { code: "JELLYFIN_BAD_REQUEST", message: `Jellyfin 拒绝更新人物：${person.Name}` },
        401: { code: "JELLYFIN_AUTH_FAILED", message: "Jellyfin 凭证无效，无法写入人物信息" },
        403: {
          code: "JELLYFIN_PERMISSION_DENIED",
          message: "当前 Jellyfin 凭证无权写入人物信息",
        },
        404: { code: "JELLYFIN_NOT_FOUND", message: `Jellyfin 中不存在人物 ${person.Name}` },
      },
      fallback: {
        code: "JELLYFIN_WRITE_FAILED",
        message: `写入 Jellyfin 人物信息失败：${person.Name}`,
      },
    },
  );
};

export const uploadJellyfinPrimaryImage = async (
  networkClient: RuntimeNetworkClient,
  configuration: Configuration,
  personId: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<void> => {
  const primaryPath = `/Items/${encodeURIComponent(personId)}/Images/Primary`;
  await uploadMediaServerPrimaryImage(
    {
      networkClient,
      configuration,
      serverKey: "jellyfin",
      personId,
      bytes,
      contentType,
      retryableStatuses: [404, 405],
      fallbackPath: `${primaryPath}/0`,
      toServiceError: toJellyfinServiceError,
    },
    {
      statusMappings: {
        400: { code: "JELLYFIN_BAD_REQUEST", message: "Jellyfin 拒绝人物照片上传请求" },
        401: { code: "JELLYFIN_AUTH_FAILED", message: "Jellyfin 凭证无效，无法上传人物照片" },
        403: {
          code: "JELLYFIN_PERMISSION_DENIED",
          message: "当前 Jellyfin 凭证无权写入人物照片",
        },
        415: { code: "JELLYFIN_UNSUPPORTED_MEDIA", message: "Jellyfin 不支持当前照片文件类型" },
      },
      fallback: {
        code: "JELLYFIN_WRITE_FAILED",
        message: "上传 Jellyfin 人物照片失败",
      },
    },
  );
};

interface PublicSystemInfo {
  ServerName?: string;
  Version?: string;
}

export const checkJellyfinConnection = async (
  networkClient: RuntimeNetworkClient,
  configuration: Configuration,
): Promise<MediaServerConnectionCheckResult> =>
  await runMediaServerConnectionCheck({
    includeAdminKeyStep: false,
    unreachableCode: "JELLYFIN_UNREACHABLE",
    authFailedCode: "JELLYFIN_AUTH_FAILED",
    fetchPublicServerInfo: async () => {
      const info = await networkClient.getJson<PublicSystemInfo>(
        buildJellyfinUrl(configuration, "/System/Info/Public"),
        {
          useProxy: false,
          headers: { accept: "application/json" },
        },
      );
      return {
        serverName: typeof info.ServerName === "string" ? info.ServerName : undefined,
        version: typeof info.Version === "string" ? info.Version : undefined,
      };
    },
    verifyAuth: async () => {
      await networkClient.getJson<Record<string, unknown>>(buildJellyfinUrl(configuration, "/System/Info"), {
        useProxy: false,
        headers: buildJellyfinHeaders(configuration, { accept: "application/json" }),
      });
    },
    fetchPersons: async () =>
      await fetchJellyfinPersons(networkClient, configuration, {
        limit: 1,
        fields: ["Overview"],
      }),
    getPersonId: (person) => person.Id,
    verifyWritePermission: async (personId) => {
      await fetchJellyfinMetadataEditorInfo(networkClient, configuration, personId);
    },
  });

export class JellyfinActorInfoService {
  private readonly networkClient: RuntimeNetworkClient;

  constructor(private readonly deps: JellyfinActorServiceDependencies) {
    this.networkClient = deps.networkClient;
  }

  async run(configuration: Configuration, mode: JellyfinMode): Promise<JellyfinBatchResult> {
    const resolvedUserId = await resolveJellyfinUserId(this.networkClient, configuration);
    return await runMediaServerInfoSync({
      configuration,
      mode,
      serviceName: "Jellyfin",
      signalService: this.deps.signalService,
      actorSourceProvider: this.deps.actorSourceProvider,
      logger: this.deps.logger,
      fetchPersons: async () =>
        await fetchJellyfinPersons(this.networkClient, configuration, {
          fields: ["Overview"],
          userId: resolvedUserId,
        }),
      getPersonName: (person) => person.Name,
      fetchPersonDetail: async (person) =>
        await fetchJellyfinPersonDetail(this.networkClient, configuration, person, {
          userId: resolvedUserId,
        }),
      buildExistingState: (person, detail) => ({
        overview: toStringValue(detail.Overview) ?? person.Overview,
        tags: toStringArray(detail.Tags),
        taglines: toStringArray(detail.Taglines),
        premiereDate: toStringValue(detail.PremiereDate),
        productionYear: typeof detail.ProductionYear === "number" ? detail.ProductionYear : undefined,
        productionLocations: toStringArray(detail.ProductionLocations),
      }),
      updatePersonInfo: async (person, detail, synced) => {
        await updateJellyfinPersonInfo(this.networkClient, configuration, person, detail, synced, {
          lockOverview: configuration.jellyfin.lockOverviewAfterSync,
        });
      },
    });
  }
}

export class JellyfinActorPhotoService {
  private readonly networkClient: RuntimeNetworkClient;

  constructor(private readonly deps: JellyfinActorServiceDependencies) {
    this.networkClient = deps.networkClient;
  }

  async run(configuration: Configuration, mode: JellyfinMode): Promise<JellyfinBatchResult> {
    return await runMediaServerPhotoSync({
      configuration,
      mode,
      serviceName: "Jellyfin",
      signalService: this.deps.signalService,
      networkClient: this.networkClient,
      actorSourceProvider: this.deps.actorSourceProvider,
      logger: this.deps.logger,
      fetchPersons: async () => await fetchJellyfinPersons(this.networkClient, configuration),
      getPersonName: (person) => person.Name,
      getPersonId: (person) => person.Id,
      hasPrimaryImage: hasJellyfinPrimaryImage,
      uploadPrimaryImage: async (personId, bytes, contentType) => {
        await uploadJellyfinPrimaryImage(this.networkClient, configuration, personId, bytes, contentType);
      },
    });
  }
}
