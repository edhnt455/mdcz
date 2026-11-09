import { z } from "@mdcz/shared/zod";
import type { RuntimeNetworkClient } from "../../../network";
import { throwIfAborted } from "../../utils/abort";
import type { MachineTranslator } from "../types";

const responseSchema = z.object({ translations: z.array(z.object({ text: z.string().trim().min(1) })) });
// DeepL accepts at most 50 texts per request.
const BATCH_SIZE = 50;

export class DeeplTranslator {
  constructor(private readonly networkClient: RuntimeNetworkClient) {}

  readonly translate: MachineTranslator = async (texts, target, config, signal) => {
    if (!texts.length) return [];
    const key = config.translate.deeplApiKey.trim();
    if (!key) throw new Error("DeepL 翻译需要 API 密钥");
    const url = key.endsWith(":fx") ? "https://api-free.deepl.com/v2/translate" : "https://api.deepl.com/v2/translate";
    const init = { signal, headers: { Authorization: `DeepL-Auth-Key ${key}` } };
    const target_lang = target === "zh_tw" ? "ZH-HANT" : "ZH-HANS";
    const results: string[] = [];
    for (let offset = 0; offset < texts.length; offset += BATCH_SIZE) {
      throwIfAborted(signal);
      const batch = texts.slice(offset, offset + BATCH_SIZE);
      const payload = responseSchema.parse(await this.networkClient.postJson(url, { text: batch, target_lang }, init));
      if (payload.translations.length !== batch.length) throw new Error("DeepL 翻译结果数量不匹配");
      results.push(...payload.translations.map((translation) => translation.text));
    }
    return results;
  };
}
