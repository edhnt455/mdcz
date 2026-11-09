import type { Configuration } from "@mdcz/shared/config";
import type { TranslateTestInputDto, TranslateTestResponse } from "@mdcz/shared/serverDtos";
import type { RuntimeNetworkClient } from "../network";
import { TranslateService, type TranslateServiceOptions } from "../scrape/TranslateService";
import { isMissingRequiredLlmApiKey } from "../scrape/translate/engines/LlmApiClient";
import { toTarget } from "../scrape/translate/types";
import { toErrorMessage } from "../shared";

export type TranslateTestInput = TranslateTestInputDto;

export const testTranslation = async (
  input: TranslateTestInput | undefined,
  configuration: Configuration,
  networkClient: RuntimeNetworkClient,
  options: TranslateServiceOptions = {},
): Promise<TranslateTestResponse> => {
  const config: Configuration = {
    ...configuration,
    translate: {
      ...configuration.translate,
      ...Object.fromEntries(Object.entries(input ?? {}).filter(([, value]) => value !== undefined)),
    },
  };
  try {
    const settings = config.translate;
    if (settings.engine === "openai" && !settings.llmModelName.trim()) return { status: "missing_model" };
    if (
      (settings.engine === "openai" && isMissingRequiredLlmApiKey(settings.llmBaseUrl, settings.llmApiKey)) ||
      (settings.engine === "deepl" && !settings.deeplApiKey.trim()) ||
      (settings.engine === "baidu" &&
        (!settings.baiduAppId.trim() ||
          !(settings.baiduService === "llm" ? settings.baiduApiKey : settings.baiduSecretKey).trim()))
    ) {
      return { status: "missing_credentials" };
    }
    const source = { title: "ある日の暮方", plot: "ある日の暮方の事である。", genres: ["ドラマ"] };
    const translated = await new TranslateService(networkClient, options).translateMetadata(
      source,
      toTarget(settings.targetLanguage),
      config,
    );
    const { title, plot } = translated;
    if (!title?.trim() || title === source.title) {
      throw new Error("翻译引擎未返回译后标题");
    }
    if (!plot?.trim() || plot === source.plot) {
      throw new Error("翻译引擎未返回译后简介");
    }
    if (translated.genres.length !== source.genres.length || translated.genres.some((genre) => !genre?.trim())) {
      throw new Error("翻译引擎返回的译后类别无效");
    }
    options.logger?.info(`翻译验证成功：engine=${settings.engine}`);
    return { status: "ok", sample: title };
  } catch (error) {
    const message = toErrorMessage(error);
    options.logger?.error(`翻译验证失败：${message}`);
    return { status: "failed", error: message };
  }
};
