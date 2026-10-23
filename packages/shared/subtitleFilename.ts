export const CHINESE_SUBTITLE_STRONG_HINTS = ["中文字幕", "中字版", "简中字幕", "简中", "中字"] as const;
export const CHINESE_SUBTITLE_FILENAME_TOKEN_HINTS = ["UC", "CHS", "CH", "C", "中文"] as const;

export const normalizeSubtitleText = (value: string): string => value.normalize("NFC");
