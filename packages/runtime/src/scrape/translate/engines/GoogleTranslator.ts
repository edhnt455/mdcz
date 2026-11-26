import { z } from "@mdcz/shared/zod";
import type { RuntimeNetworkClient } from "../../../network";
import { getScrapeConcurrency } from "../../executionPolicy";
import { throwIfAborted } from "../../utils/abort";
import type { LanguageTarget, MachineTranslator } from "../types";

const googleTranslateResponseSchema = z.array(z.unknown());
const MAX_BATCH_URL_LENGTH = 8000;

const extractGoogleTranslatedText = (payload: unknown): string | null => {
  const parsed = googleTranslateResponseSchema.safeParse(payload);
  if (!parsed.success) {
    return null;
  }

  const root = parsed.data;
  const first = root[0];
  if (!Array.isArray(first)) {
    return null;
  }

  const segments: string[] = [];
  for (const segment of first) {
    if (!Array.isArray(segment)) {
      continue;
    }
    const translated = segment[0];
    if (typeof translated === "string") {
      segments.push(translated);
    }
  }

  const result = segments.join("");
  return result.trim().length > 0 ? result : null;
};

export class GoogleTranslator {
  constructor(private readonly networkClient: RuntimeNetworkClient) {}

  readonly translate: MachineTranslator = async (texts, target, config, signal) => {
    const entries = texts.flatMap((text, index) => (text.trim() ? [{ text, index }] : []));
    const results: Array<string | null> = texts.map(() => null);
    if (!entries.length) return results;
    throwIfAborted(signal);
    this.networkClient.setDomainLimit?.("translate.googleapis.com", 5, getScrapeConcurrency(config));

    const lines = entries.map(({ text }) => text.match(/[^\r\n]+/gu)?.filter((line) => line.trim()) ?? []);
    const batch = lines.flat();
    const url = this.buildUrl(batch.join("\n"), target);
    if (entries.length > 1 && url.length <= MAX_BATCH_URL_LENGTH) {
      const translated = await this.request(url, signal);
      const output = translated?.split(/\r?\n/u).filter((line) => line.trim()) ?? [];
      if (output.length === batch.length) {
        let offset = 0;
        for (const [position, { index, text }] of entries.entries()) {
          const translatedLines = output.slice(offset, offset + lines[position].length);
          results[index] = text.replace(/[^\r\n]+/gu, (line) =>
            line.trim() ? (translatedLines.shift() ?? line) : line,
          );
          offset += lines[position].length;
        }
        return results;
      }
    }
    await Promise.all(
      entries.map(async ({ text, index }) => {
        results[index] = await this.request(this.buildUrl(text, target), signal);
      }),
    );
    return results;
  };

  private buildUrl(text: string, target: LanguageTarget): string {
    const url = new URL("https://translate.googleapis.com/translate_a/single");
    url.searchParams.set("client", "gtx");
    url.searchParams.set("sl", "auto");
    url.searchParams.set("tl", target === "zh_tw" ? "zh-TW" : "zh-CN");
    url.searchParams.set("dt", "t");
    url.searchParams.set("q", text);
    return url.toString();
  }

  private async request(url: string, signal?: AbortSignal): Promise<string | null> {
    return extractGoogleTranslatedText(await this.networkClient.getJson<unknown>(url, { signal }));
  }
}
