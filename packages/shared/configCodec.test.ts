import { describe, expect, it } from "vitest";
import {
  configurationSchema,
  defaultConfiguration,
  NFO_FIELD_OPTIONS,
  type NfoField,
  normalizeScrapeSiteLists,
  SCRAPE_SITE_CATALOG,
} from "./config";
import { parseConfigurationContent, serializeConfiguration } from "./configCodec";
import { Website } from "./enums";
import { DEFAULT_FILENAME_KEYWORDS } from "./filenameKeywords";
import { mediaLibraryConfigSchema } from "./mediaLibrary";

describe("configuration codec", () => {
  it("validates and round-trips the optional daily Emby photo check time", () => {
    expect(defaultConfiguration.emby.actorPhotoDailySyncTime).toBe("");
    for (const time of ["", "00:00", "03:00", "23:59"]) {
      const configuration = configurationSchema.parse({ emby: { actorPhotoDailySyncTime: time } });
      for (const format of ["toml", "json"] as const) {
        expect(
          parseConfigurationContent(serializeConfiguration(configuration, format), format).emby.actorPhotoDailySyncTime,
        ).toBe(time);
      }
    }
    for (const time of ["3:00", "24:00", "12:60", "03:00:00", " 03:00", "invalid"]) {
      const result = configurationSchema.safeParse({ emby: { actorPhotoDailySyncTime: time } });
      expect(result.success).toBe(false);
      if (!result.success)
        expect(result.error.issues[0]).toMatchObject({
          path: ["emby", "actorPhotoDailySyncTime"],
          message: "actorPhotoSyncTimeInvalid",
        });
    }
  });
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
      libraries: [
        mediaLibraryConfigSchema.parse({
          id: "library",
          name: "Media",
          sourcePath: "/media",
          placement: "inPlace",
          createdAt: "2026-10-26T00:00:00.000Z",
          updatedAt: "2026-10-26T00:00:00.000Z",
        }),
      ],
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
    const library = configuration.libraries[0];
    for (const other of [
      { ...library, sourcePath: "/other" },
      { ...library, id: "other", sourcePath: "/media/nested" },
    ])
      expect(configurationSchema.safeParse({ ...configuration, libraries: [library, other] }).success).toBe(false);
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

  it("keeps disabled sites in the saved order and appends sites missing from older configs", () => {
    expect(new Set(SCRAPE_SITE_CATALOG).size).toBe(Object.values(Website).length);

    const legacy = parseConfigurationContent('[scrape]\nsites = ["javdb", "javbus"]\n', "toml");
    expect(legacy.scrape.sites).toEqual([Website.JAVDB, Website.JAVBUS]);
    expect(legacy.scrape.siteOrder[0]).toBe(Website.JAVDB);
    expect(legacy.scrape.siteOrder[1]).toBe(Website.JAVBUS);
    expect(legacy.scrape.siteOrder).toEqual(
      normalizeScrapeSiteLists([Website.JAVDB, Website.JAVBUS], undefined).siteOrder,
    );
    expect(legacy.scrape.siteOrder.at(-1)).toBe(Website.FANTIA);

    const parked = parseConfigurationContent(
      '[scrape]\nsites = ["javbus"]\nsiteOrder = ["javdb", "javbus", "dmm"]\n',
      "toml",
    );
    expect(parked.scrape.sites).toEqual([Website.JAVBUS]);
    expect(parked.scrape.siteOrder.slice(0, 3)).toEqual([Website.JAVDB, Website.JAVBUS, Website.DMM]);
    expect(parked.scrape.siteOrder).toHaveLength(SCRAPE_SITE_CATALOG.length);
  });
});
