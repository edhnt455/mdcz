import { describe, expect, it } from "vitest";
import { configurationSchema, defaultConfiguration, NFO_FIELD_OPTIONS, type NfoField } from "./config";
import { parseConfigurationContent, serializeConfiguration } from "./configCodec";
import { DEFAULT_FILENAME_KEYWORDS } from "./filenameKeywords";

describe("configuration codec", () => {
  it("round-trips actor alias maps through TOML and validates alias groups", () => {
    const parsed = parseConfigurationContent(
      '[personSync.actorAliases]\n"河北彩花" = ["河北彩伽", "河北彩花（河北彩伽）"]\n',
      "toml",
    );

    expect(parsed.personSync.actorAliases).toEqual({ 河北彩花: ["河北彩伽", "河北彩花（河北彩伽）"] });
    expect(parseConfigurationContent(serializeConfiguration(parsed, "toml"), "toml")).toEqual(parsed);
    expect(
      parseConfigurationContent('[personSync]\npersonImageSources = ["local"]\n', "toml").personSync.actorAliases,
    ).toEqual({});

    expect(
      configurationSchema.parse({
        personSync: {
          actorAliases: { " 河北彩花 ": ["河北彩伽", " 河北彩伽 ", "河北彩花"] },
        },
      }).personSync.actorAliases,
    ).toEqual({ 河北彩花: ["河北彩伽"] });

    const collision = configurationSchema.safeParse({
      personSync: {
        actorAliases: {
          河北彩花: ["河北彩伽"],
          河北彩伽: ["别名"],
        },
      },
    });

    expect(collision.success).toBe(false);
    if (!collision.success) {
      expect(collision.error.issues[0]?.path).toEqual(["personSync", "actorAliases", "河北彩伽"]);
    }

    expect(
      configurationSchema.safeParse({
        personSync: { actorAliases: { 河北彩花: [] } },
      }).success,
    ).toBe(false);
  });
  it("defaults and round-trips filename filters and classification keyword lists", () => {
    expect(defaultConfiguration.scrape).toMatchObject({
      filenameIgnoreTokens: [],
      filenameBlacklistTokens: [],
      ...DEFAULT_FILENAME_KEYWORDS,
    });

    const configuration = {
      ...defaultConfiguration,
      scrape: {
        ...defaultConfiguration.scrape,
        filenameIgnoreTokens: ["[7SIS-001]+", "AD"],
        filenameBlacklistTokens: ["sample.", "广告"],
        subtitleKeywords: ["HANZI", "字幕组"],
        umrKeywords: ["restored", "[破解]+"],
        uncensoredKeywords: ["RAW", "无修正"],
        leakKeywords: ["LEAKED", "流出版"],
      },
    };

    for (const format of ["toml", "json"] as const) {
      expect(parseConfigurationContent(serializeConfiguration(configuration, format), format)).toEqual(configuration);
      const empty = {
        ...configuration,
        scrape: {
          ...configuration.scrape,
          subtitleKeywords: [],
          umrKeywords: [],
          uncensoredKeywords: [],
          leakKeywords: [],
        },
      };
      expect(parseConfigurationContent(serializeConfiguration(empty, format), format)).toEqual(empty);
    }
    expect(parseConfigurationContent("[scrape]\n", "toml").scrape).toMatchObject({
      filenameIgnoreTokens: [],
      filenameBlacklistTokens: [],
      ...DEFAULT_FILENAME_KEYWORDS,
    });
  });

  it("defaults, validates, and round-trips NFO fields through every configuration codec", () => {
    const expectedFields: NfoField[] = [
      "num",
      "plot",
      "outline",
      "release",
      "runtime",
      "fileinfo",
      "rating",
      "studio",
      "director",
      "publisher",
      "series",
      "genres",
      "tags",
      "poster",
      "thumb",
      "fanart",
      "sceneImages",
      "trailer",
      "sourceComment",
    ];
    expect(NFO_FIELD_OPTIONS).toEqual(expectedFields);
    expect(defaultConfiguration.download.nfoIgnoreFields).toEqual([]);

    const configuration = {
      ...defaultConfiguration,
      download: {
        ...defaultConfiguration.download,
        nfoIgnoreFields: ["num", "plot", "director"] as NfoField[],
      },
    };

    for (const format of ["toml", "json"] as const) {
      expect(
        parseConfigurationContent(serializeConfiguration(configuration, format), format).download.nfoIgnoreFields,
      ).toEqual(["num", "plot", "director"]);
      expect(
        parseConfigurationContent(
          serializeConfiguration(
            {
              ...configuration,
              download: { ...configuration.download, nfoIgnoreFields: [] },
            },
            format,
          ),
          format,
        ).download.nfoIgnoreFields,
      ).toEqual([]);
      expect(
        parseConfigurationContent(format === "toml" ? "[download]\n" : '{"download":{}}', format).download
          .nfoIgnoreFields,
      ).toEqual([]);
      expect(() =>
        parseConfigurationContent(
          format === "toml"
            ? '[download]\nnfoIgnoreFields = ["actors"]\n'
            : '{"download":{"nfoIgnoreFields":["actors"]}}',
          format,
        ),
      ).toThrow();
    }
  });
});
