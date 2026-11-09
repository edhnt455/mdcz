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
  normalizeMediaServerPersons,
  parseMediaServerMode,
  updateMediaServerItem,
  uploadMediaServerPrimaryImage,
} from "./client";
import { isRecord, isString, pickAutoResolvedUserId, toStringArray, toStringRecord, toStringValue } from "./common";
import { runMediaServerConnectionCheck } from "./connectionCheck";
import {
  getHttpStatus,
  type MediaServerErrorMapping,
  MediaServerServiceError,
  toMediaServerServiceError,
} from "./errors";
import type { RuntimeInfoActorSourceProvider } from "./infoSync";
import { runMediaServerInfoSync } from "./infoSync";
import type { MediaServerSignalService } from "./jellyfin";
import type { PhotoSyncOptions, RuntimePhotoActorSourceProvider } from "./photoSync";
import { runMediaServerPhotoSync } from "./photoSync";
import type { PlannedPersonSyncState } from "./planner";

export type EmbyMode = MediaServerMode;
export type EmbyBatchResult = PersonSyncResult;
export type EmbyItemDetail = MediaServerItemDetail;

export interface EmbyPerson {
  Id: string;
  Name: string;
  ServerId?: string;
  Overview?: string;
  ImageTags?: Record<string, string>;
}

export class EmbyServiceError extends MediaServerServiceError {}

export interface EmbyActorServiceDependencies {
  signalService: MediaServerSignalService;
  networkClient: RuntimeNetworkClient;
  actorSourceProvider: RuntimeInfoActorSourceProvider & RuntimePhotoActorSourceProvider;
  logger: RuntimeLogger;
}

export const normalizeEmbyBaseUrl = normalizeMediaServerBaseUrl;
export const parseEmbyMode = parseMediaServerMode;

export { getHttpStatus };

export const toEmbyServiceError = (
  error: unknown,
  statusMappings: Partial<Record<number, MediaServerErrorMapping>>,
  fallback: MediaServerErrorMapping,
): EmbyServiceError => toMediaServerServiceError(error, EmbyServiceError, statusMappings, fallback);

export const buildEmbyUrl = (
  configuration: Configuration,
  path: string,
  query: Record<string, string | undefined> = {},
): string => buildMediaServerUrl(configuration, "emby", path, query);

export const buildEmbyHeaders = (configuration: Configuration, headers: MediaServerHeadersInit = {}): Headers =>
  buildMediaServerHeaders(configuration, "emby", headers);

export const hasEmbyPrimaryImage = (person: EmbyPerson): boolean =>
  typeof person.ImageTags?.Primary === "string" && person.ImageTags.Primary.trim().length > 0;

const ACTOR_PERSON_TYPES = ["Actor", "GuestStar"] as const;

type EmbyFetchPersonsOptions = {
  limit?: number;
  fields?: string[];
  userId?: string;
  personTypes?: string[];
};

const fetchAutoResolvedEmbyUserId = async (
  networkClient: RuntimeNetworkClient,
  configuration: Configuration,
): Promise<string> =>
  await fetchMediaServerResolvedUserId(
    {
      networkClient,
      configuration,
      serverKey: "emby",
      path: "/Users/Query",
      extractUsers: (response) => (isRecord(response) && Array.isArray(response.Items) ? response.Items : []),
      pickUserId: (users) => pickAutoResolvedUserId(users),
      createMissingUserContextError: () =>
        new EmbyServiceError(
          "EMBY_USER_CONTEXT_REQUIRED",
          "当前 Emby 服务器需要用户身份，请在设置中配置 Emby 用户 ID 后重试",
        ),
      toServiceError: toEmbyServiceError,
    },
    {
      statusMappings: {
        401: { code: "EMBY_AUTH_FAILED", message: "Emby API 密钥无效，无法读取用户列表" },
        403: { code: "EMBY_PERMISSION_DENIED", message: "当前 Emby 凭证无权读取用户列表" },
      },
      fallback: {
        code: "EMBY_USER_CONTEXT_REQUIRED",
        message: "当前 Emby 服务器需要用户身份，请在设置中配置 Emby 用户 ID 后重试",
      },
    },
  );

export const resolveEmbyUserId = async (
  networkClient: RuntimeNetworkClient,
  configuration: Configuration,
  overrideUserId?: string,
): Promise<string> => {
  const resolvedUserId = overrideUserId?.trim() || configuration.emby.userId.trim();
  return resolvedUserId || (await fetchAutoResolvedEmbyUserId(networkClient, configuration));
};

export const fetchEmbyPersons = async (
  networkClient: RuntimeNetworkClient,
  configuration: Configuration,
  options: EmbyFetchPersonsOptions = {},
): Promise<EmbyPerson[]> => {
  const userId = options.userId?.trim() || configuration.emby.userId.trim() || undefined;

  return await fetchMediaServerPersons(
    {
      networkClient,
      configuration,
      serverKey: "emby",
      query: {
        userid: userId,
        Limit: options.limit !== undefined ? String(options.limit) : undefined,
        Fields: options.fields?.join(","),
        PersonTypes: options.personTypes?.join(","),
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

        const id = item.Id;
        const name = item.Name;
        if (!isString(id) || !isString(name)) {
          return null;
        }

        return {
          Id: id,
          Name: name,
          ServerId: isString(item.ServerId) ? item.ServerId : undefined,
          Overview: toStringValue(item.Overview),
          ImageTags: isRecord(item.ImageTags) ? toStringRecord(item.ImageTags) : undefined,
        };
      },
      normalizePersons: normalizeMediaServerPersons,
      toServiceError: toEmbyServiceError,
    },
    {
      statusMappings: {
        400: { code: "EMBY_BAD_REQUEST", message: "Emby 人物读取请求参数无效" },
        401: { code: "EMBY_AUTH_FAILED", message: "Emby API 密钥无效或已过期" },
        403: { code: "EMBY_PERMISSION_DENIED", message: "当前 Emby 凭证无权读取人物信息" },
      },
      fallback: {
        code: "EMBY_UNREACHABLE",
        message: "读取 Emby 人物列表失败",
      },
    },
  );
};

export const fetchEmbyActorPersons = async (
  networkClient: RuntimeNetworkClient,
  configuration: Configuration,
  options: Omit<EmbyFetchPersonsOptions, "personTypes"> = {},
): Promise<EmbyPerson[]> => {
  const userId = await resolveEmbyUserId(networkClient, configuration, options.userId);
  return await fetchEmbyPersons(networkClient, configuration, {
    ...options,
    userId,
    personTypes: [...ACTOR_PERSON_TYPES],
  });
};

export const fetchEmbyPersonDetail = async (
  networkClient: RuntimeNetworkClient,
  configuration: Configuration,
  person: EmbyPerson,
  userId: string,
): Promise<EmbyItemDetail> =>
  await fetchMediaServerUserScopedItemDetail(
    {
      networkClient,
      configuration,
      serverKey: "emby",
      personId: person.Id,
      userId,
      createMissingUserContextError: () =>
        new EmbyServiceError(
          "EMBY_USER_CONTEXT_REQUIRED",
          "当前 Emby 服务器需要用户身份，请先获取并提供 Emby 用户 ID 后重试",
        ),
      toServiceError: toEmbyServiceError,
    },
    {
      statusMappings: {
        401: {
          code: "EMBY_AUTH_FAILED",
          message: `读取人物详情失败：Emby API 密钥无效，无法访问 ${person.Name}`,
        },
        403: {
          code: "EMBY_PERMISSION_DENIED",
          message: `读取人物详情失败：当前 Emby API 密钥无权访问 ${person.Name}`,
        },
        404: { code: "EMBY_NOT_FOUND", message: `Emby 中不存在人物 ${person.Name}` },
      },
      fallback: {
        code: "EMBY_UNREACHABLE",
        message: `读取 Emby 人物详情失败：${person.Name}`,
      },
    },
  );

// Item details also include user state and image metadata, which are not part of this edit.
const EMBY_PERSON_METADATA_FIELDS = [
  "ServerId",
  "Type",
  "DateCreated",
  "OriginalTitle",
  "ForcedSortName",
  "EndDate",
  "CustomRating",
  "OfficialRating",
  "CommunityRating",
  "CriticRating",
  "PreferredMetadataLanguage",
  "PreferredMetadataCountryCode",
  "ProviderIds",
  "LockedFields",
  "LockData",
  "Genres",
  "Studios",
  "PremiereDate",
  "ProductionYear",
  "ProductionLocations",
] as const;

export const buildEmbyPersonUpdatePayload = (
  person: EmbyPerson,
  detail: EmbyItemDetail,
  synced: PlannedPersonSyncState,
): Record<string, unknown> => {
  const payload: Record<string, unknown> = Object.fromEntries(
    EMBY_PERSON_METADATA_FIELDS.filter((key) => Object.hasOwn(detail, key)).map((key) => [key, detail[key]]),
  );
  Object.assign(payload, {
    Id: person.Id,
    Name: toStringValue(detail.Name) ?? person.Name,
    Overview: synced.overview ?? toStringValue(detail.Overview) ?? "",
    ...(Object.hasOwn(detail, "Tags") ? { Tags: synced.tags } : {}),
    ...(Object.hasOwn(detail, "Taglines") ? { Taglines: synced.taglines } : {}),
  });

  const serverId = toStringValue(detail.ServerId) ?? person.ServerId;
  if (serverId) payload.ServerId = serverId;

  if (synced.productionLocations && synced.productionLocations.length > 0) {
    payload.ProductionLocations = synced.productionLocations;
  }
  if (synced.premiereDate) payload.PremiereDate = synced.premiereDate;
  if (synced.productionYear !== undefined) payload.ProductionYear = synced.productionYear;

  return payload;
};

export const fetchEmbyMetadataEditorInfo = async (
  networkClient: RuntimeNetworkClient,
  configuration: Configuration,
  personId: string,
): Promise<Record<string, unknown>> =>
  await fetchMediaServerMetadataEditorInfo(
    {
      networkClient,
      configuration,
      serverKey: "emby",
      personId,
      toServiceError: toEmbyServiceError,
    },
    {
      statusMappings: {
        401: {
          code: "EMBY_AUTH_FAILED",
          message: "Emby 凭证无效，无法核验人物写入权限",
        },
        403: { code: "EMBY_PERMISSION_DENIED", message: "当前 Emby 凭证无权写入人物信息" },
        404: { code: "EMBY_NOT_FOUND", message: "Emby 无法获取人物元数据编辑信息" },
      },
      fallback: {
        code: "EMBY_UNREACHABLE",
        message: "读取 Emby 人物元数据编辑信息失败",
      },
    },
  );

export const updateEmbyPersonInfo = async (
  networkClient: RuntimeNetworkClient,
  configuration: Configuration,
  person: EmbyPerson,
  detail: EmbyItemDetail,
  synced: PlannedPersonSyncState,
): Promise<void> => {
  const payload = buildEmbyPersonUpdatePayload(person, detail, synced);
  await updateMediaServerItem(
    {
      networkClient,
      configuration,
      serverKey: "emby",
      personId: person.Id,
      payload,
      toServiceError: toEmbyServiceError,
    },
    {
      statusMappings: {
        400: { code: "EMBY_BAD_REQUEST", message: `Emby 拒绝更新人物：${person.Name}` },
        401: { code: "EMBY_AUTH_FAILED", message: "Emby 凭证无效，无法写入人物信息" },
        403: { code: "EMBY_PERMISSION_DENIED", message: "当前 Emby 凭证无权写入人物信息" },
        404: { code: "EMBY_NOT_FOUND", message: `Emby 中不存在人物 ${person.Name}` },
      },
      fallback: {
        code: "EMBY_WRITE_FAILED",
        message: `写入 Emby 人物信息失败：${person.Name}`,
      },
    },
  );
};

export const uploadEmbyPrimaryImage = async (
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
      serverKey: "emby",
      personId,
      bytes,
      contentType,
      retryableStatuses: [400, 404, 405],
      fallbackPath: primaryPath,
      fallbackQuery: { Index: "0" },
      toServiceError: toEmbyServiceError,
    },
    {
      statusMappings: {
        400: { code: "EMBY_BAD_REQUEST", message: "Emby 拒绝人物照片上传请求" },
        401: { code: "EMBY_AUTH_FAILED", message: "Emby API 密钥无效，无法上传人物照片" },
        403: { code: "EMBY_ADMIN_KEY_REQUIRED", message: "上传 Emby 人物照片需要管理员 API 密钥" },
        415: { code: "EMBY_UNSUPPORTED_MEDIA", message: "Emby 不支持当前照片文件类型" },
      },
      fallback: {
        code: "EMBY_WRITE_FAILED",
        message: "上传 Emby 人物照片失败",
      },
      fallbackStatusMappings: {
        400: { code: "EMBY_BAD_REQUEST", message: "Emby 拒绝人物照片上传请求" },
        401: { code: "EMBY_AUTH_FAILED", message: "Emby API 密钥无效，无法上传人物照片" },
        403: { code: "EMBY_ADMIN_KEY_REQUIRED", message: "上传 Emby 人物照片需要管理员 API 密钥" },
        404: { code: "EMBY_NOT_FOUND", message: "Emby 中未找到要上传照片的人物" },
        415: { code: "EMBY_UNSUPPORTED_MEDIA", message: "Emby 不支持当前照片文件类型" },
      },
    },
  );
};

interface PublicSystemInfo {
  ServerName?: string;
  Version?: string;
}

export const checkEmbyConnection = async (
  networkClient: RuntimeNetworkClient,
  configuration: Configuration,
): Promise<MediaServerConnectionCheckResult> => {
  let resolvedUserId: string | undefined;
  const getResolvedUserId = async (): Promise<string> => {
    if (!resolvedUserId) {
      resolvedUserId = await resolveEmbyUserId(networkClient, configuration);
    }
    return resolvedUserId;
  };

  return await runMediaServerConnectionCheck({
    includeAdminKeyStep: true,
    unreachableCode: "EMBY_UNREACHABLE",
    authFailedCode: "EMBY_AUTH_FAILED",
    fetchPublicServerInfo: async () => {
      const info = await networkClient.getJson<PublicSystemInfo>(buildEmbyUrl(configuration, "/System/Info/Public"), {
        useProxy: false,
        headers: { accept: "application/json" },
      });
      return {
        serverName: typeof info.ServerName === "string" ? info.ServerName : undefined,
        version: typeof info.Version === "string" ? info.Version : undefined,
      };
    },
    verifyAuth: async () => {
      await networkClient.getJson<Record<string, unknown>>(buildEmbyUrl(configuration, "/System/Endpoint"), {
        useProxy: false,
        headers: buildEmbyHeaders(configuration, { accept: "application/json" }),
      });
    },
    // Reads people exactly as the sync does, so a server whose actor filter comes back empty fails here, not silently in sync.
    fetchPersons: async () =>
      await fetchEmbyActorPersons(networkClient, configuration, {
        limit: 1,
        fields: ["Overview"],
        userId: await getResolvedUserId(),
      }),
    getPersonId: (person) => person.Id,
    verifyWritePermission: async (personId) => {
      await fetchEmbyMetadataEditorInfo(networkClient, configuration, personId);
    },
  });
};

export class EmbyActorInfoService {
  private readonly networkClient: RuntimeNetworkClient;

  constructor(private readonly deps: EmbyActorServiceDependencies) {
    this.networkClient = deps.networkClient;
  }

  async run(configuration: Configuration, mode: EmbyMode): Promise<EmbyBatchResult> {
    const resolvedUserId = await resolveEmbyUserId(this.networkClient, configuration);
    return await runMediaServerInfoSync({
      configuration,
      mode,
      serviceName: "Emby",
      signalService: this.deps.signalService,
      actorSourceProvider: this.deps.actorSourceProvider,
      logger: this.deps.logger,
      fetchPersons: async () =>
        await fetchEmbyActorPersons(this.networkClient, configuration, {
          fields: ["Overview"],
          userId: resolvedUserId,
        }),
      getPersonName: (person) => person.Name,
      fetchPersonDetail: async (person) => {
        const { TagItems: tagItems, ...detail } = await fetchEmbyPersonDetail(
          this.networkClient,
          configuration,
          person,
          resolvedUserId,
        );
        if (tagItems === undefined || tagItems === null) return detail;
        if (!Array.isArray(tagItems) || tagItems.some((tag) => !isRecord(tag) || !toStringValue(tag.Name))) {
          throw new Error(`Emby 人物标签无效：${person.Name}`);
        }
        return { ...detail, Tags: tagItems.map((tag) => tag.Name as string) };
      },
      buildExistingState: (person, detail) => ({
        overview: toStringValue(detail.Overview) ?? person.Overview,
        tags: toStringArray(detail.Tags),
        taglines: toStringArray(detail.Taglines),
        premiereDate: toStringValue(detail.PremiereDate),
        productionYear: typeof detail.ProductionYear === "number" ? detail.ProductionYear : undefined,
        productionLocations: toStringArray(detail.ProductionLocations),
      }),
      updatePersonInfo: async (person, detail, synced) => {
        await updateEmbyPersonInfo(this.networkClient, configuration, person, detail, synced);
      },
      buildCompletionMessage: (result, total) =>
        `Emby 演员信息同步完成。总计：${total}，成功：${result.processedCount}，失败：${result.failedCount}，跳过：${result.skippedCount}`,
    });
  }
}

export class EmbyActorPhotoService {
  private readonly networkClient: RuntimeNetworkClient;

  constructor(private readonly deps: EmbyActorServiceDependencies) {
    this.networkClient = deps.networkClient;
  }

  async run(configuration: Configuration, mode: EmbyMode, options: PhotoSyncOptions = {}): Promise<EmbyBatchResult> {
    const resolvedUserId = await resolveEmbyUserId(this.networkClient, configuration);
    return await runMediaServerPhotoSync({
      ...options,
      configuration,
      mode,
      serviceName: "Emby",
      signalService: this.deps.signalService,
      networkClient: this.networkClient,
      actorSourceProvider: this.deps.actorSourceProvider,
      logger: this.deps.logger,
      fetchPersons: async () =>
        await fetchEmbyActorPersons(this.networkClient, configuration, {
          userId: resolvedUserId,
        }),
      getPersonName: (person) => person.Name,
      getPersonId: (person) => person.Id,
      hasPrimaryImage: hasEmbyPrimaryImage,
      hasPrimaryImageNow: async (person) => {
        const detail = await fetchEmbyPersonDetail(this.networkClient, configuration, person, resolvedUserId);
        return hasEmbyPrimaryImage({
          ...person,
          ImageTags: isRecord(detail.ImageTags) ? toStringRecord(detail.ImageTags) : undefined,
        });
      },
      uploadPrimaryImage: async (personId, bytes, contentType) => {
        await uploadEmbyPrimaryImage(this.networkClient, configuration, personId, bytes, contentType);
      },
      buildCompletionMessage: (result, total) =>
        `Emby 演员照片同步完成。总计：${total}，成功：${result.processedCount}，失败：${result.failedCount}，跳过：${result.skippedCount}`,
    });
  }
}
