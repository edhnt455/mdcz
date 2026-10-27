import { basename, dirname } from "node:path";
import type { Configuration } from "@mdcz/shared/config";
import { z } from "zod";
import { runWithNetworkChannel } from "../network";
import { isMissingRequiredLlmApiKey } from "./translate/engines/LlmApiClient";
import type { LlmRequestService } from "./translate/engines/LlmRequestService";
import { throwIfAborted } from "./utils/abort";

const recognitionSchema = z.strictObject({
  number: z.string().trim().min(1).max(100).nullable(),
  evidence: z.string().trim().min(1).max(1000).nullable(),
});

const normalizeEvidence = (value: string): string =>
  value
    .normalize("NFKC")
    .toUpperCase()
    .replace(/[^A-Z0-9]/gu, "")
    .replace(/^FC2PPV/u, "FC2")
    .replace(/^CARIBBEANCOM/u, "CARIB")
    .replace(/^1PONDO/u, "1PON")
    .replace(/^10MUSUME/u, "10MU")
    .replace(/^([A-Z]+)0+(?=\d)/u, "$1");

export class NumberRecognitionService {
  constructor(private readonly requests: LlmRequestService) {}

  async recognize(
    filePath: string,
    previousNumber: string,
    config: Configuration,
    signal?: AbortSignal,
  ): Promise<string | null> {
    throwIfAborted(signal);
    if (
      !config.translate.llmModelName.trim() ||
      isMissingRequiredLlmApiKey(config.translate.llmBaseUrl, config.translate.llmApiKey)
    ) {
      throw new Error("AI movie code recognition requires a model and the endpoint's required API key");
    }
    const source = { fileName: basename(filePath), parentDirectory: basename(dirname(filePath)) };
    const prompt = [
      config.translate.llmNumberRecognitionPrompt.trim(),
      '仅输出 JSON：{"number":"规范化番号或null","evidence":"包含该番号的原文片段或null"}，null 必须为 JSON null。',
      "evidence 必须逐字取自 fileName 或 parentDirectory。禁止解释、Markdown 和额外字段。",
      JSON.stringify({ ...source, previousNumber: previousNumber || null }),
    ].join("\n");
    const content = await runWithNetworkChannel("number-recognition", () =>
      this.requests.requestText(config.translate, prompt, signal, {
        name: "movie_code_recognition",
        schema: z.toJSONSchema(recognitionSchema),
      }),
    );
    throwIfAborted(signal);
    const parsed = recognitionSchema.parse(
      JSON.parse(content?.replace(/^<think>[\s\S]*?<\/think>\s*/iu, "").trim() ?? ""),
    );
    if (parsed.number === null) return null;
    const number = parsed.number.normalize("NFKC").toUpperCase();
    const evidence = parsed.evidence?.normalize("NFKC").toUpperCase();
    if (
      !/^(?=.*\d)[A-Z0-9]+(?:[-_][A-Z0-9]+)*$/u.test(number) ||
      !evidence ||
      !Object.values(source).some((value) => value.normalize("NFKC").toUpperCase().includes(evidence)) ||
      !normalizeEvidence(evidence).includes(normalizeEvidence(number))
    ) {
      throw new Error("AI movie code recognition returned a number without valid source evidence");
    }
    return number;
  }
}
