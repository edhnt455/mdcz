import type { Configuration } from "@mdcz/shared/config";
import { z } from "zod";
import { toErrorMessage } from "../../../shared";
import { throwIfAborted } from "../../utils/abort";
import { getTargetLanguageLabel } from "../shared";
import type { LanguageTarget } from "../types";
import { isMissingRequiredLlmApiKey, type LlmJsonSchema } from "./LlmApiClient";
import type { LlmRequestService } from "./LlmRequestService";

const COMPLETE_LEADING_THINK_PATTERN = /^<think>[\s\S]*?<\/think>\s*/iu;
const TRANSLATION_ONLY_INSTRUCTION = "只输出最终译文，不要输出思考过程、解释、提示词或原文。";
const JSON_TRANSLATION_INSTRUCTION = '只输出 JSON 对象，格式为 {"translation":"最终译文"}，不要添加其他字段。';

const textTranslationSchema = z.strictObject({ translation: z.string().trim().min(1) });
const metadataTranslationSchema = z.strictObject({
  title: z.string().trim().min(1).nullable(),
  plot: z.string().trim().min(1).nullable(),
  genres: z.array(z.string().trim().min(1)),
});

export const LLM_TEXT_TRANSLATION_SCHEMA: LlmJsonSchema = {
  name: "text_translation",
  schema: z.toJSONSchema(textTranslationSchema),
};

export const LLM_METADATA_TRANSLATION_SCHEMA: LlmJsonSchema = {
  name: "metadata_translation",
  schema: z.toJSONSchema(metadataTranslationSchema),
};

const buildTranslationPrompt = (prompt: string): string => `${prompt.trim()}

${TRANSLATION_ONLY_INSTRUCTION}`;

export const buildLlmTranslatePrompt = (
  promptTemplate: string,
  text: string,
  target: LanguageTarget,
  outputInstruction = TRANSLATION_ONLY_INSTRUCTION,
): string => {
  const prompt = promptTemplate.replace(/\{lang\}|\{content\}/gu, (placeholder) =>
    placeholder === "{lang}" ? getTargetLanguageLabel(target) : text,
  );
  return `${prompt.trim()}\n\n${outputInstruction}`;
};

export const cleanTranslationOutput = (
  output: string | null,
  prompt: string,
  source: string,
  structured = false,
): string | null => {
  if (typeof output !== "string") {
    return null;
  }

  const cleaned = output.replace(COMPLETE_LEADING_THINK_PATTERN, "").trim();
  let translated = cleaned;
  if (structured) {
    try {
      translated = textTranslationSchema.parse(JSON.parse(cleaned)).translation;
    } catch {
      return null;
    }
  }
  const normalizedPrompt = prompt.trim();
  const normalizedSource = source.trim();
  if (
    !translated ||
    translated === normalizedPrompt ||
    translated === normalizedSource ||
    translated === buildTranslationPrompt(prompt)
  ) {
    return null;
  }

  return translated;
};

export type LlmMetadataTranslationInput = z.infer<typeof metadataTranslationSchema>;
export type LlmMetadataTranslationResult = z.infer<typeof metadataTranslationSchema>;

export class OpenAiTranslator {
  constructor(private readonly requests: LlmRequestService) {}

  async translateText(
    text: string,
    target: LanguageTarget,
    config: Configuration,
    signal?: AbortSignal,
  ): Promise<string | null> {
    if (
      !config.translate.llmModelName.trim() ||
      isMissingRequiredLlmApiKey(config.translate.llmBaseUrl, config.translate.llmApiKey)
    ) {
      return null;
    }

    throwIfAborted(signal);

    const structured = config.translate.llmOutputFormat !== "none";
    const contractedPrompt = buildLlmTranslatePrompt(
      config.translate.llmPrompt,
      text,
      target,
      structured ? JSON_TRANSLATION_INSTRUCTION : TRANSLATION_ONLY_INSTRUCTION,
    );
    const content = await this.requests.requestText(
      config.translate,
      contractedPrompt,
      signal,
      structured ? LLM_TEXT_TRANSLATION_SCHEMA : undefined,
    );
    const translation = cleanTranslationOutput(content, config.translate.llmPrompt, text, structured);
    if (!translation) throw new Error("LLM translation returned invalid output");
    return translation;
  }

  async translateMetadata(
    input: LlmMetadataTranslationInput,
    target: LanguageTarget,
    config: Configuration,
    signal?: AbortSignal,
  ): Promise<LlmMetadataTranslationResult> {
    if (!input.title && !input.plot && input.genres.length === 0) {
      return { title: null, plot: null, genres: [] };
    }
    if (
      !config.translate.llmModelName.trim() ||
      isMissingRequiredLlmApiKey(config.translate.llmBaseUrl, config.translate.llmApiKey)
    ) {
      throw new Error("LLM metadata translation requires a model and the endpoint's required API key");
    }

    throwIfAborted(signal);

    const prompt = buildLlmTranslatePrompt(
      config.translate.llmPrompt,
      JSON.stringify(input),
      target,
      [
        '只返回一个 JSON 对象，字段固定为 "title"、"plot" 和 "genres"。',
        "title 和 plot 为 null 时保持 null，否则只返回最终译文。",
        `genres 必须返回 ${input.genres.length} 项，顺序与输入完全一致，每项只包含一个简短标签。`,
        "不要返回解释、Markdown、提示词或原文之外的额外字段。",
      ].join("\n"),
    );
    const content = await this.requests.requestText(config.translate, prompt, signal, LLM_METADATA_TRANSLATION_SCHEMA);
    try {
      const parsed = metadataTranslationSchema.parse(JSON.parse(content ?? ""));
      if (
        (input.title === null) !== (parsed.title === null) ||
        (input.plot === null) !== (parsed.plot === null) ||
        parsed.genres.length !== input.genres.length
      ) {
        throw new Error("title/plot nullability or genre count does not match the input");
      }
      return parsed;
    } catch (error) {
      throw new Error(`LLM metadata translation returned invalid structured output: ${toErrorMessage(error)}`, {
        cause: error,
      });
    }
  }
}
