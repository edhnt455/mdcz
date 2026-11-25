import { toUniqueActorNames } from "@mdcz/shared/actorAliases";
import type { Configuration } from "@mdcz/shared/config";
import type { TranslateEngine } from "@mdcz/shared/enums";
import type { CrawlerData, TranslationFailures } from "@mdcz/shared/types";
import {
  isUnrecoverableNetworkError,
  type RuntimeNetworkClient,
  type RuntimeRequestInit,
  runWithNetworkChannel,
} from "../network";
import { detectLanguage, noopRuntimeLogger, type RuntimeLogger, toErrorMessage } from "../shared";
import { ActorNameNormalizer } from "./translate/ActorNameNormalizer";
import { BaiduTranslator } from "./translate/engines/BaiduTranslator";
import { DeeplTranslator } from "./translate/engines/DeeplTranslator";
import { GoogleTranslator } from "./translate/engines/GoogleTranslator";
import { LlmApiClient, type RuntimeNetworkJsonResponse } from "./translate/engines/LlmApiClient";
import { LlmRequestService } from "./translate/engines/LlmRequestService";
import { type LlmMetadataTranslationInput, OpenAiTranslator } from "./translate/engines/OpenAiTranslator";
import { GenreTranslator } from "./translate/GenreTranslator";
import {
  canKeepOriginalTranslation,
  ensureTargetChinese,
  normalizeNewlines,
  UNCHANGED_TRANSLATION_REASON,
} from "./translate/shared";
import { type LanguageTarget, type MachineTranslator, type TranslationMappingStore, toTarget } from "./translate/types";
import { isAbortError, throwIfAborted } from "./utils/abort";

/** Fields whose published translation is already decided; a present key with no value publishes the source text. */
export type SettledTranslations = Partial<Record<"title" | "plot", string | undefined>>;

export interface TranslateServiceOptions {
  logger?: RuntimeLogger;
  llmApiClient?: LlmApiClient;
  llmRequests?: LlmRequestService;
  mappingStore?: TranslationMappingStore;
}

const createLlmApiClient = (networkClient: RuntimeNetworkClient): LlmApiClient => {
  const postJsonDetailed = networkClient.postJsonDetailed;
  if (typeof postJsonDetailed === "function") {
    return new LlmApiClient({
      postJsonDetailed: async <TResponse>(url: string, payload: unknown, init?: RuntimeRequestInit) => {
        const response = await postJsonDetailed.call(networkClient, url, payload, init);
        return response as RuntimeNetworkJsonResponse<TResponse>;
      },
    });
  }

  return new LlmApiClient();
};

export class TranslateService {
  private readonly logger: RuntimeLogger;

  private readonly actorNameNormalizer: ActorNameNormalizer;

  private readonly openAiTranslator: OpenAiTranslator;

  private readonly translators: Record<Exclude<TranslateEngine, "openai">, MachineTranslator>;

  private readonly genreTranslator: GenreTranslator;

  constructor(networkClient: RuntimeNetworkClient, options: TranslateServiceOptions = {}) {
    this.logger = options.logger ?? noopRuntimeLogger;
    this.actorNameNormalizer = new ActorNameNormalizer(options.mappingStore);
    const llmRequests =
      options.llmRequests ??
      new LlmRequestService(this.logger, options.llmApiClient ?? createLlmApiClient(networkClient));
    this.openAiTranslator = new OpenAiTranslator(llmRequests);
    this.translators = {
      google: new GoogleTranslator(networkClient).translate,
      deepl: new DeeplTranslator(networkClient).translate,
      baidu: new BaiduTranslator(networkClient).translate,
    };
    this.genreTranslator = new GenreTranslator(options.mappingStore);
  }

  async translateCrawlerData(
    data: CrawlerData,
    config: Configuration,
    signal?: AbortSignal,
    {
      settled = {},
      kept = new Set(),
      allowFallbackModel = false,
    }: {
      settled?: SettledTranslations;
      kept?: ReadonlySet<keyof CrawlerData>;
      allowFallbackModel?: boolean;
    } = {},
  ): Promise<{ data: CrawlerData; error: string | null }> {
    if (!config.translate.enableTranslation) {
      return {
        data: { ...data, title_zh: settled.title, plot_zh: settled.plot },
        error: [...new Set(Object.values(data.translation_failures ?? {}))].join("; ") || null,
      };
    }

    throwIfAborted(signal);

    const target = toTarget(config.translate.targetLanguage);
    const startedAt = Date.now();
    this.logger.info(
      `[translation] number=${data.number} engine=${config.translate.engine} target=${target} model=${config.translate.engine === "openai" ? config.translate.llmModelName : "none"} reasoning=${config.translate.engine === "openai" ? config.translate.llmReasoning : "none"} titleChars=${data.title.length} plotChars=${data.plot?.length ?? 0} genres=${data.genres?.length ?? 0}`,
    );

    const keepActors = kept.has("actors");
    const mappedActors = keepActors
      ? (data.actors ?? [])
      : await Promise.all((data.actors ?? []).map((actor) => this.actorNameNormalizer.normalizeAlias(actor)));
    const mappedActorProfiles = keepActors
      ? []
      : await Promise.all(
          (data.actor_profiles ?? []).map((profile) => this.actorNameNormalizer.normalizeProfile(profile)),
        );
    const selectedFields = new Set(config.translate.fields);
    const failures: TranslationFailures = { ...data.translation_failures };
    const prepareField = (
      field: "title" | "plot",
      input: string | undefined,
    ): { source: string | null; translated: string | undefined } => {
      if (field in settled) return { source: null, translated: settled[field] };
      const text = normalizeNewlines(input ?? "").trim();
      if (!text || !selectedFields.has(field)) return { source: null, translated: undefined };
      if (!failures[field] && detectLanguage(text) === "zh")
        return { source: null, translated: ensureTargetChinese(text, target) };
      return { source: text, translated: undefined };
    };
    const fields = { title: prepareField("title", data.title), plot: prepareField("plot", data.plot) };
    const translateGenres = selectedFields.has("genres") && !kept.has("genres");
    const genres = await this.genreTranslator.resolve(translateGenres ? (data.genres ?? []) : [], target, signal);
    let pendingGenres = genres.unresolvedEntries.map(([, term], index) => ({ index, term }));
    const translatedGenres: Array<string | null> = pendingGenres.map(() => null);
    const fallbackModel = config.translate.llmFallbackModelName.trim();
    const useFallback =
      allowFallbackModel &&
      config.translate.engine === "openai" &&
      fallbackModel !== "" &&
      fallbackModel !== config.translate.llmModelName.trim();
    const attempts = [config];
    if (useFallback) {
      attempts.push({ ...config, translate: { ...config.translate, llmModelName: fallbackModel, llmMaxRetries: 0 } });
    }

    for (const attempt of attempts) {
      const input = {
        title: fields.title.source,
        plot: fields.plot.source,
        genres: pendingGenres.map(({ term }) => term),
      };
      if (!input.title && !input.plot && !input.genres.length) break;
      if (attempt !== config) {
        this.logger.info(`[translation] number=${data.number} fallbackModel=${fallbackModel}`);
      }

      let translation: Awaited<ReturnType<TranslateService["translateMetadata"]>>;
      try {
        translation = await this.translateMetadata(input, target, attempt, signal, useFallback);
      } catch (error) {
        throwIfAborted(signal);
        if (isAbortError(error) || isUnrecoverableNetworkError(error)) throw error;
        const translationError = toErrorMessage(error);
        if (input.title) failures.title = translationError;
        if (input.plot) failures.plot = translationError;
        if (input.genres.length) failures.genres = translationError;
        this.logger.warn(`${data.number} 翻译失败：${translationError}`);
        continue;
      }

      for (const field of ["title", "plot"] as const) {
        const source = input[field];
        if (!source) continue;
        const returned = normalizeNewlines(translation[field] ?? "").trim();
        if (returned && (returned !== source || canKeepOriginalTranslation(source))) {
          fields[field].source = null;
          if (returned !== source) fields[field].translated = ensureTargetChinese(returned, target);
          delete failures[field];
          continue;
        }
        const message = `翻译引擎未能翻译 ${field}（${data.number}），将返回原文：${returned ? UNCHANGED_TRANSLATION_REASON : "引擎未返回译文"}`;
        if (attempt === attempts.at(-1)) this.logger.warn(message);
        failures[field] = message;
      }

      if (translation.genres.length === pendingGenres.length) {
        pendingGenres = pendingGenres.filter(({ index }, responseIndex) => {
          const value = translation.genres[responseIndex]?.trim();
          if (!value) return true;
          translatedGenres[index] = value;
          return false;
        });
      }
      if (pendingGenres.length) failures.genres = "翻译引擎返回的类别不完整";
    }
    if (translateGenres && !pendingGenres.length) delete failures.genres;
    const mappedGenres = translateGenres
      ? this.genreTranslator.remember(genres, translatedGenres, target)
      : (data.genres ?? []);
    const { translation_failures: _previousFailures, ...sourceData } = data;

    throwIfAborted(signal);
    const title_zh = fields.title.translated;
    const plot_zh = fields.plot.translated;
    this.logger.info(
      `[translation] number=${data.number} durationMs=${Date.now() - startedAt} title=${title_zh ? "accepted" : "original"} plot=${!data.plot ? "absent" : plot_zh ? "accepted" : "original"} genresIn=${data.genres?.length ?? 0} genresOut=${mappedGenres.length} genresWithKana=${mappedGenres.filter((genre) => detectLanguage(genre) === "jp").length}`,
    );

    return {
      data: {
        ...sourceData,
        ...(Object.keys(failures).length ? { translation_failures: failures } : {}),
        title_zh,
        plot_zh,
        actors: keepActors ? mappedActors : toUniqueActorNames(mappedActors),
        actor_profiles: mappedActorProfiles.length > 0 ? mappedActorProfiles : data.actor_profiles,
        genres: mappedGenres,
      },
      error: [...new Set(Object.values(failures))].join("; ") || null,
    };
  }

  async translateMetadata(
    input: LlmMetadataTranslationInput,
    target: LanguageTarget,
    config: Configuration,
    signal?: AbortSignal,
    allowPartialOutput = false,
  ): Promise<{ title: string | null; plot: string | null; genres: Array<string | null> }> {
    throwIfAborted(signal);
    return await runWithNetworkChannel("translation", async () => {
      if (config.translate.engine === "openai") {
        return await this.openAiTranslator.translateMetadata(input, target, config, signal, allowPartialOutput);
      }
      const sources = [input.title, input.plot].filter((text): text is string => text !== null);
      const translated = await this.translators[config.translate.engine](
        [...sources, ...input.genres],
        target,
        config,
        signal,
      );
      let index = 0;
      return {
        title: input.title !== null ? (translated[index++] ?? null) : null,
        plot: input.plot !== null ? (translated[index++] ?? null) : null,
        genres: translated.slice(index),
      };
    });
  }

  async translateText(
    input: string,
    target: LanguageTarget,
    config: Configuration,
    signal?: AbortSignal,
  ): Promise<string> {
    const text = normalizeNewlines(input).trim();
    if (!text) {
      return "";
    }

    throwIfAborted(signal);

    if (detectLanguage(text) === "zh") return ensureTargetChinese(text, target);

    const engine = config.translate.engine;

    const translated = await runWithNetworkChannel("translation", () =>
      engine === "openai"
        ? this.openAiTranslator.translateText(text, target, config, signal)
        : this.translators[engine]([text], target, config, signal).then((results) => results[0]),
    );
    if (translated?.trim() && translated.trim() !== text) return ensureTargetChinese(translated.trim(), target);

    this.logger.warn(`翻译引擎 ${engine} 未返回译文，将返回原文`);
    return text;
  }
}
