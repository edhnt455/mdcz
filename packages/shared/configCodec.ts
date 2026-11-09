import { parse, stringify } from "smol-toml";
import { type Configuration, configurationSchema, withNormalizedScrapeSites } from "./config";

export type ConfigurationFileFormat = "json" | "toml";

export const DEFAULT_CONFIGURATION_FILE_FORMAT: ConfigurationFileFormat = "toml";
export const CONFIGURATION_FILE_EXTENSIONS: Record<ConfigurationFileFormat, string> = {
  json: ".json",
  toml: ".toml",
};

export const inferConfigurationFileFormat = (filePath: string): ConfigurationFileFormat => {
  const normalized = filePath.split(/[\\/]/u).at(-1) ?? filePath;
  const dotIndex = normalized.lastIndexOf(".");
  const extension = dotIndex >= 0 ? normalized.slice(dotIndex).toLowerCase() : "";
  return extension === CONFIGURATION_FILE_EXTENSIONS.json ? "json" : "toml";
};

const ACTOR_ALIASES_HEADER = "[personSync.actorAliases]";
const ACTOR_ALIASES_COMMENTS = [
  "# 演员别名映射：将不同来源的演员名称统一为标准名称。标准名称必须加引号，每行是一个独立的演员组。",
  "# 新刮削使用标准演员名作为演员、{actor} 路径及 NFO 名称，同时将原始写法保留为演员档案别名，用于头像及档案查询。",
  "# 修改当前档案文件后，请重启容器或通过导入/切换档案重新加载。现有影片和 NFO 不会自动重命名。",
  "# Example:",
  '# "河北彩花" = ["河北彩伽", "河北彩花（河北彩伽）"]',
  '# "三上悠亚" = ["鬼頭桃菜", "鬼头桃菜"]',
].join("\n");

const annotateTomlConfiguration = (toml: string, configuration: Configuration): string => {
  const target = `${ACTOR_ALIASES_HEADER}\n`;
  if (!toml.includes(target)) {
    return toml;
  }
  const isEmpty = Object.keys(configuration.personSync.actorAliases).length === 0;
  const replacement = isEmpty
    ? `${ACTOR_ALIASES_COMMENTS}\n${ACTOR_ALIASES_HEADER}\n\n`
    : `${ACTOR_ALIASES_COMMENTS}\n${ACTOR_ALIASES_HEADER}\n`;
  return toml.replace(target, replacement);
};

export const serializeConfiguration = (
  configuration: Configuration,
  format: ConfigurationFileFormat = DEFAULT_CONFIGURATION_FILE_FORMAT,
): string => {
  const parsed = withNormalizedScrapeSites(configurationSchema.parse(configuration));
  return format === "json"
    ? `${JSON.stringify(parsed, null, 2)}\n`
    : `${annotateTomlConfiguration(stringify(parsed), parsed)}\n`;
};

/** The file's document before schema validation. */
export const parseConfigurationDocument = (
  content: string,
  format: ConfigurationFileFormat = DEFAULT_CONFIGURATION_FILE_FORMAT,
): unknown => (format === "json" ? JSON.parse(content) : parse(content));

export const parseConfigurationContent = (
  content: string,
  format: ConfigurationFileFormat = DEFAULT_CONFIGURATION_FILE_FORMAT,
): Configuration => withNormalizedScrapeSites(configurationSchema.parse(parseConfigurationDocument(content, format)));

export const readConfigurationText = (content: string, filePath: string): Configuration =>
  parseConfigurationContent(content, inferConfigurationFileFormat(filePath));
