import { CHINESE_SUBTITLE_FILENAME_TOKEN_HINTS, CHINESE_SUBTITLE_STRONG_HINTS } from "./subtitleFilename";

export const DEFAULT_FILENAME_KEYWORDS = {
  subtitleKeywords: [...CHINESE_SUBTITLE_FILENAME_TOKEN_HINTS, ...CHINESE_SUBTITLE_STRONG_HINTS],
  umrKeywords: ["C-U", "UMR", "破解"],
  uncensoredKeywords: ["U", "UC", "无码", "無碼", "UNCENSORED"],
  leakKeywords: ["流出", "LEAK"],
} as const;

export type FilenameKeywords = { [K in keyof typeof DEFAULT_FILENAME_KEYWORDS]: readonly string[] };

const DELIMITER = String.raw`[-_.\s\[\](){}【】（）/\\]`;

export const filenameKeywordPattern = (keywords: readonly string[]): RegExp => {
  const alternatives = keywords
    .map((keyword) => keyword.normalize("NFC").trim())
    .filter(Boolean)
    .sort((left, right) => right.length - left.length)
    .map((keyword) => {
      const literal = keyword.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
      // Short Latin flags must not match letters inside catalog codes or directory names.
      if (/^[a-z]{1,3}$/iu.test(keyword) || /^C-U$/iu.test(keyword)) {
        const token = /^C-U$/iu.test(keyword) ? String.raw`C[-_.\s\[\](){}【】（）]U` : literal;
        const start = /^(?:CHS|CH)$/iu.test(keyword) ? `(?:^|(?<=${DELIMITER})|(?<=\\d))` : `(?:^|(?<=${DELIMITER}))`;
        return `${start}${token}(?=$|${DELIMITER})`;
      }
      return literal;
    });
  return new RegExp(alternatives.length ? alternatives.join("|") : "(?!)", "giu");
};

export const stripFilenameKeywords = (value: string, keywords: FilenameKeywords): string =>
  value
    .normalize("NFC")
    .replace(
      filenameKeywordPattern([
        ...keywords.subtitleKeywords,
        ...keywords.umrKeywords,
        ...keywords.uncensoredKeywords,
        ...keywords.leakKeywords,
      ]),
      // A configured flag can also be a catalog prefix, such as CHS-123.
      (match: string, offset: number, source: string) =>
        /^[a-z0-9]+$/iu.test(match) && /^[-_.\s]+\d{2,}/u.test(source.slice(offset + match.length)) ? match : "",
    )
    .replace(/[[({【（]\s*[\])}】）]/gu, "")
    .replace(/[-_.\s]+$/gu, "");
