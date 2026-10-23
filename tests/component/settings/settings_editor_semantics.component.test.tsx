import { defaultConfiguration } from "@mdcz/shared/config";
import { FIELD_REGISTRY } from "@mdcz/shared/settingsRegistry";
import { OrderedSiteFieldEditor, ServerPathField } from "@mdcz/views/config-form";
import {
  AdvancedSettingsFooterContent,
  AssetDownloadsSection,
  type FieldAnchor,
  FilenameFilteringSection,
  flattenConfig,
  NamingSection,
  NetworkTopLevelSection,
  NfoSection,
  PathsSection,
  PathsTopLevelSection,
  ProfileCapsule,
  SectionAnchor,
  SettingsEditor,
  SettingsEditorAutosaveProvider,
  SettingsSectionModeProvider,
  type SettingsServices,
  SettingsServicesProvider,
  TranslateTopLevelSection,
} from "@mdcz/views/settings";
import { type ComponentProps, type ReactNode, useMemo } from "react";
import { type FieldValues, FormProvider, useForm } from "react-hook-form";
import { expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

const noop = vi.fn();

const baseSettingsServices = {
  browsePath: vi.fn(async () => ({})),
  checkCookies: vi.fn(async () => ({ results: [] })),
  decrementInFlightSaves: vi.fn(),
  ensureWatermarkDirectory: vi.fn(async () => ({ path: "" })),
  getInFlightSaves: vi.fn(() => 0),
  incrementInFlightSaves: vi.fn(),
  listCrawlerSites: vi.fn(async () => ({ sites: [] })),
  openWatermarkDirectory: vi.fn(async () => undefined),
  probeSiteConnectivity: vi.fn(async () => ({ ok: true, latencyMs: 0, status: 200 })),
  relaunchApp: vi.fn(async () => undefined),
  resetConfig: vi.fn(async () => undefined),
  saveConfig: vi.fn(async () => undefined),
  testTranslation: vi.fn(async () => ({ status: "ok" as const, sample: "" })),
} satisfies SettingsServices;

const createSettingsServices = (overrides: Partial<SettingsServices> = {}): SettingsServices => ({
  ...baseSettingsServices,
  ...overrides,
});

const settingsNotifier = {
  error: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
};

function FormHarness({
  children,
  services = baseSettingsServices,
  values = {},
}: {
  children?: ReactNode;
  services?: SettingsServices;
  values?: Record<string, unknown>;
}) {
  const flatValues = useMemo(() => flattenConfig(values), [values]);
  const form = useForm<FieldValues>({ defaultValues: flatValues });

  return (
    <SettingsServicesProvider notifier={settingsNotifier} services={services}>
      <FormProvider {...(form as ComponentProps<typeof FormProvider>)}>
        <SettingsEditorAutosaveProvider savedValues={flatValues} defaultValues={flatValues} defaultValuesReady>
          {children}
        </SettingsEditorAutosaveProvider>
      </FormProvider>
    </SettingsServicesProvider>
  );
}

function SettingsSurfaceHarness({
  engine = "openai",
  baiduService = "general",
  isServer = false,
  initialSection,
}: {
  engine?: "openai" | "deepl" | "baidu";
  baiduService?: "general" | "llm";
  isServer?: boolean;
  initialSection?: FieldAnchor;
}) {
  const configuration = useMemo(
    () => ({
      ...defaultConfiguration,
      translate: { ...defaultConfiguration.translate, engine, baiduService },
      download: {
        ...defaultConfiguration.download,
        downloadPoster: true,
        generateNfo: true,
        tagBadges: true,
      },
      titleRepair: {
        ...defaultConfiguration.titleRepair,
        enabled: true,
      },
    }),
    [engine, baiduService],
  );

  return (
    <SettingsServicesProvider notifier={settingsNotifier} services={{ ...baseSettingsServices, isServer }}>
      <SettingsEditor
        data={configuration}
        initialSection={initialSection}
        defaultConfig={configuration}
        defaultConfigReady
        profiles={["default"]}
        activeProfile="default"
        onSwitchProfile={noop}
        onCreateProfile={noop}
        onDeleteProfile={noop}
        onResetConfig={noop}
        onExportProfile={noop}
        onImportProfile={noop}
      />
    </SettingsServicesProvider>
  );
}

test("settings categories preserve fields, search across sections and adapt to the target", async () => {
  const screen = await render(<SettingsSurfaceHarness />);
  const navigation = screen.getByRole("navigation", { name: "设置分类" });
  await expect
    .element(navigation.getByRole("button", { name: "路径", exact: true }))
    .toHaveAttribute("aria-current", "page");
  await expect.element(screen.getByRole("region", { name: "路径", exact: true })).toBeVisible();
  await expect
    .element(screen.getByRole("region", { name: "网络连接", exact: true, includeHidden: true }))
    .not.toBeVisible();
  await expect.element(navigation.getByRole("button", { name: "集成", exact: true })).not.toBeInTheDocument();
  await screen.getByRole("button", { name: "显示高级设置" }).click();

  const expectedFields = FIELD_REGISTRY.filter((entry) => entry.visibility !== "hidden").map((entry) => entry.key);
  const renderedFields = new Set(
    Array.from(
      screen.container.querySelectorAll<HTMLElement>("[data-field-name]"),
      (element) => element.dataset.fieldName,
    ).filter((key): key is string => Boolean(key)),
  );

  await screen
    .getByRole("navigation", { name: "设置分类" })
    .getByRole("button", { name: "网络连接", exact: true })
    .click();

  for (const [javdbUrl, javbusUrl, javdbHost, javbusHost] of [
    ["localhost:8080", "ftp://example.com", "javdb.com", "www.javbus.com"],
    ["http://localhost:8082", "http://localhost:8081", "localhost:8082", "localhost:8081"],
  ]) {
    await screen.getByPlaceholder("https://javdb.com", { exact: true }).fill(javdbUrl);
    await screen.getByPlaceholder("https://www.javbus.com", { exact: true }).fill(javbusUrl);
    const siteField = screen.container.querySelector('[data-field-name="scrape.sites"]');
    if (!siteField) throw new Error("Site priority field is missing");
    await navigation.getByRole("button", { name: "刮削设置", exact: true }).click();
    await page.elementLocator(siteField).getByRole("button", { name: "编辑", exact: true }).click();
    const dialog = screen.getByRole("dialog");
    await expect.element(dialog.getByText(`javdb · ${javdbHost}`, { exact: true })).toBeVisible();
    await expect.element(dialog.getByText(`javbus · ${javbusHost}`, { exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: "完成", exact: true }).click();
    await navigation.getByRole("button", { name: "网络连接", exact: true }).click();
  }
  const search = screen.getByPlaceholder("搜索设置");
  await search.fill("代理");
  await expect.element(navigation).not.toBeInTheDocument();
  await expect.element(screen.getByRole("region", { name: "网络连接", exact: true })).toBeVisible();
  await search.fill("no-matching-mdcz-option");
  await expect.element(screen.getByText("没有匹配的设置")).toBeVisible();
  await screen.getByRole("button", { name: "清空搜索" }).click();
  await expect
    .element(navigation.getByRole("button", { name: "网络连接", exact: true }))
    .toHaveAttribute("aria-current", "page");
  await expect
    .element(screen.getByPlaceholder("https://javdb.com", { exact: true }))
    .toHaveValue("http://localhost:8082");
  await navigation.getByRole("button", { name: "高级设置", exact: true }).click();
  await expect.element(screen.getByRole("region", { name: "高级设置", exact: true })).toBeVisible();
  await screen.getByRole("button", { name: "隐藏高级设置" }).click();
  await expect
    .element(navigation.getByRole("button", { name: "路径", exact: true }))
    .toHaveAttribute("aria-current", "page");
  await screen.unmount();
  for (const [engine, baiduService] of [
    ["deepl", "general"],
    ["baidu", "general"],
    ["baidu", "llm"],
  ] as const) {
    const variant = await render(
      <SettingsSurfaceHarness engine={engine} baiduService={baiduService} isServer initialSection="translate" />,
    );
    await expect.element(variant.getByRole("region", { name: "翻译服务", exact: true })).toBeVisible();
    const serverNavigation = variant.getByRole("navigation", { name: "设置分类" });
    await expect.element(serverNavigation.getByRole("button", { name: "集成", exact: true })).toBeVisible();
    await expect
      .element(serverNavigation.getByRole("button", { name: "界面与快捷键", exact: true }))
      .not.toBeInTheDocument();
    await variant.getByRole("button", { name: "显示高级设置" }).click();
    for (const element of variant.container.querySelectorAll<HTMLElement>("[data-field-name]")) {
      if (element.dataset.fieldName) renderedFields.add(element.dataset.fieldName);
    }
    await variant.unmount();
  }
  expect(renderedFields).toEqual(new Set(expectedFields));
});

test("ordered site field exposes grouped priority semantics", async () => {
  const screen = await render(
    <FormHarness>
      <OrderedSiteFieldEditor
        value={["dmm"]}
        options={["dmm", "dmm_tv", "javdb"]}
        onChange={noop}
        rows={[
          {
            id: "dmm_family",
            label: "DMM/FANZA 系",
            description: "官方售卖与配信源",
            checkboxState: "indeterminate",
            trailingControl: <span>日文</span>,
            chips: [
              { label: "dmm / dmm_tv", monospace: true, variant: "outline" },
              { label: "已启用 1/2", variant: "soft" },
            ],
          },
        ]}
        selectedCount={1}
        totalCount={1}
        onToggleRow={noop}
        onMoveRow={noop}
        onSelectAll={noop}
        onClearAll={noop}
      />
    </FormHarness>,
  );

  await expect.element(screen.getByText("DMM/FANZA 系")).toBeVisible();
  await expect.element(screen.getByText("官方售卖与配信源")).toBeVisible();
  await expect.element(screen.getByText("日文")).toBeVisible();
  await expect.element(screen.getByText("dmm / dmm_tv")).toBeVisible();
  await expect.element(screen.getByText("已启用 1/2")).toBeVisible();
  await expect.element(screen.getByRole("checkbox")).toHaveAttribute("aria-checked", "mixed");
});

test("profile capsule marks loading busy state", async () => {
  const screen = await render(
    <ProfileCapsule
      profiles={[]}
      activeProfile={null}
      isLoading
      onSwitchProfile={noop}
      onCreateProfile={noop}
      onDeleteProfile={noop}
      onResetConfig={noop}
      onExportProfile={noop}
      onImportProfile={noop}
    />,
  );

  expect(screen.container.querySelector('[aria-busy="true"]')).not.toBeNull();
});

test("section anchors render section content and header", async () => {
  const rendered = await render(
    <SectionAnchor id="custom" label="Custom" title="Custom Title">
      <div>Section content</div>
    </SectionAnchor>,
  );
  await expect.element(rendered.getByText("Custom Title")).toBeVisible();
  await expect.element(rendered.getByText("Section content")).toBeVisible();
});

test("advanced settings footer hides while search filters are active", async () => {
  const filtered = await render(
    <AdvancedSettingsFooterContent hasActiveFilters isAdvancedVisible={false} onToggleShowAdvanced={noop} />,
  );
  await expect.element(filtered.getByRole("button", { name: "显示高级设置" })).not.toBeInTheDocument();

  const browse = await render(
    <AdvancedSettingsFooterContent hasActiveFilters={false} isAdvancedVisible={false} onToggleShowAdvanced={noop} />,
  );
  await expect.element(browse.getByRole("button", { name: "显示高级设置" })).toBeVisible();
});

test("server path fields keep autocomplete suggestions without browse buttons", async () => {
  const services = createSettingsServices({
    getPathSuggestions: () => [
      { label: "Movies", path: "E:/Movies" },
      { label: "Output", path: "E:/Output" },
    ],
    isServer: true,
  });

  const screen = await render(
    <FormHarness services={services} values={{ paths: { mediaPath: "" } }}>
      <ServerPathField
        field={{
          name: "paths.mediaPath",
          onBlur: noop,
          onChange: noop,
          ref: noop,
          value: "",
        }}
      />
    </FormHarness>,
  );

  expect(screen.container.querySelector('input[aria-autocomplete="list"]')).not.toBeNull();
  expect(screen.container.querySelector("button")).toBeNull();
  expect(screen.container.querySelector("datalist")).toBeNull();
});

test("paths section surfaces scan exclusions", async () => {
  const screen = await render(
    <FormHarness
      values={{
        paths: {
          defaultScanExcludeDirs: ["E:/Output", "failed_22"],
        },
      }}
    >
      <PathsSection />
    </FormHarness>,
  );

  await expect.element(screen.getByText("排除目录")).toBeVisible();
  const pathInputs = Array.from(
    screen.container.querySelectorAll('input[aria-autocomplete="list"]'),
  ) as HTMLInputElement[];
  expect(pathInputs.some((input) => input.value === "E:/Output")).toBe(true);
  expect(pathInputs.some((input) => input.value === "failed_22")).toBe(true);
  expect(pathInputs.length).toBeGreaterThanOrEqual(2);
});

test("classification keyword lists add, remove and save multiple values independently", async () => {
  const saveConfig = vi.fn(async () => undefined);
  const screen = await render(
    <FormHarness values={defaultConfiguration} services={createSettingsServices({ saveConfig })}>
      <FilenameFilteringSection />
    </FormHarness>,
  );
  for (const [key, values] of [
    ["subtitleKeywords", ["HANZI", "字幕组"]],
    ["umrKeywords", ["LTX", "restored"]],
    ["uncensoredKeywords", ["RAW", "无修正"]],
    ["leakKeywords", ["LEAKED", "流出版"]],
  ] as const) {
    const field = screen.container.querySelector(`[data-field-name="scrape.${key}"]`);
    if (!field) throw new Error(`Missing keyword list: ${key}`);
    const row = page.elementLocator(field);
    await row.getByRole("textbox").fill(values.join(","));
    await row.getByRole("button", { name: "添加", exact: true }).click();
    for (const value of values) await expect.element(row.getByText(value, { exact: true })).toBeVisible();
    await expect
      .poll(() => saveConfig.mock.calls)
      .toContainEqual([{ scrape: { [key]: [...defaultConfiguration.scrape[key], ...values] } }]);
    await row.getByRole("button", { name: `移除 ${values[0]}`, exact: true }).click();
    await expect.element(row.getByText(values[0], { exact: true })).not.toBeInTheDocument();
    await expect
      .poll(() => saveConfig.mock.calls)
      .toContainEqual([{ scrape: { [key]: [...defaultConfiguration.scrape[key], values[1]] } }]);
  }
});

test.each(["deepl", "baidu"] as const)("translation verification sends edited %s credentials", async (engine) => {
  const testTranslation = vi.fn(async () => ({ status: "ok" as const, sample: "测试译文" }));
  const screen = await render(
    <FormHarness
      values={{ ...defaultConfiguration, translate: { ...defaultConfiguration.translate, engine } }}
      services={createSettingsServices({ testTranslation })}
    >
      <TranslateTopLevelSection />
    </FormHarness>,
  );
  const credentials =
    engine === "deepl" ? { deeplApiKey: "edited-key" } : { baiduAppId: "edited-app", baiduSecretKey: "edited-secret" };
  const labels: Record<string, string> = {
    deeplApiKey: "DeepL API Key",
    baiduAppId: "百度翻译 APPID",
    baiduSecretKey: "百度翻译密钥",
  };
  for (const [key, value] of Object.entries(credentials)) {
    await screen.getByLabelText(labels[key], { exact: true }).fill(value);
  }
  await expect.element(screen.getByRole("switch", { name: "启用内容翻译" })).toBeVisible();
  expect(screen.container.querySelector('[data-field-name="translate.llmModelName"]')).toBeNull();
  await screen.getByRole("button", { name: "验证元数据翻译" }).click();
  expect(testTranslation).toHaveBeenCalledWith(
    expect.objectContaining({ engine, targetLanguage: "zh-CN", ...credentials }),
  );
});

test("settings sections expose public labels and the library template notice", async () => {
  const network = await render(
    <FormHarness
      values={{
        network: {
          proxyType: "none",
          proxy: "",
          useProxy: false,
          timeout: 30,
          retryCount: 3,
          javdbCookie: "",
          javbusCookie: "",
        },
      }}
    >
      <NetworkTopLevelSection />
    </FormHarness>,
  );
  await expect.element(network.getByText("网络连接")).toBeVisible();
  await expect.element(network.getByText("代理类型")).toBeVisible();
  await expect.element(network.getByText("JavDB Cookie")).toBeVisible();

  const translate = await render(
    <FormHarness
      values={{
        scrape: { aiNumberFallback: true },
        translate: {
          ...defaultConfiguration.translate,
          enableTranslation: false,
          engine: "google",
          targetLanguage: "zh-CN",
        },
      }}
    >
      <TranslateTopLevelSection />
    </FormHarness>,
  );
  await expect.element(translate.getByText("翻译服务")).toBeVisible();
  await expect.element(translate.getByText("翻译引擎")).toBeVisible();
  await expect.element(translate.getByLabelText("LLM 模型名称", { exact: true })).toBeVisible();
  await expect.element(translate.getByRole("button", { name: "验证元数据翻译" })).toBeVisible();

  const paths = await render(
    <FormHarness values={{ paths: { defaultScanExcludeDirs: [] } }}>
      <PathsTopLevelSection />
    </FormHarness>,
  );
  await expect.element(paths.getByText("路径", { exact: true })).toBeVisible();

  const naming = await render(
    <FormHarness values={{ naming: { assetNamingMode: "fixed" } }}>
      <NamingSection />
    </FormHarness>,
  );
  // Folder and file templates are per library now, so the naming section points there instead.
  await expect.element(naming.getByText("文件夹与文件名模板按库设置", { exact: false })).toBeVisible();

  const advancedDownload = await render(
    <FormHarness values={{ download: { downloadPoster: true, sceneImageConcurrency: 4 } }}>
      <SettingsSectionModeProvider mode="advanced">
        <AssetDownloadsSection />
      </SettingsSectionModeProvider>
    </FormHarness>,
  );
  await expect.element(advancedDownload.getByText("剧照下载并发")).toBeVisible();
  await expect.element(advancedDownload.getByText("下载海报")).not.toBeInTheDocument();
});

test("NFO settings render the configured enum list only while NFO generation is enabled", async () => {
  const disabled = await render(
    <FormHarness values={{ download: { generateNfo: false, nfoIgnoreFields: ["director", "trailer"] } }}>
      <NfoSection />
    </FormHarness>,
  );
  await expect.element(disabled.getByText("NFO 忽略字段")).not.toBeInTheDocument();

  const enabled = await render(
    <FormHarness
      values={{
        download: {
          generateNfo: true,
          nfoIgnoreFields: ["num", "director", "trailer"],
          nfoNaming: "both",
        },
      }}
    >
      <NfoSection />
    </FormHarness>,
  );

  await expect.element(enabled.getByText("NFO 忽略字段")).toBeVisible();
  await expect.element(enabled.getByText("num（番号兼容字段）")).toBeVisible();
  await expect.element(enabled.getByText("director（导演）")).toBeVisible();
  await expect.element(enabled.getByText("trailer（预告片）")).toBeVisible();
  await expect
    .element(
      enabled.getByText("选择不写入 NFO 的可选字段；标题、番号、演员等核心字段始终保留。空白表示写入全部可选字段。"),
    )
    .toBeVisible();
});

test("poster badge controls follow download and badge visibility gates", async () => {
  const posterDisabled = await render(
    <FormHarness values={{ download: { downloadPoster: false, tagBadges: true } }}>
      <AssetDownloadsSection />
    </FormHarness>,
  );
  await expect.element(posterDisabled.getByText("为封面添加标签角标")).not.toBeInTheDocument();
  await expect.element(posterDisabled.getByText("角标类型", { exact: true })).not.toBeInTheDocument();
  await expect.element(posterDisabled.getByText("角标位置", { exact: true })).not.toBeInTheDocument();
  await expect.element(posterDisabled.getByText("覆盖角标图片", { exact: true })).not.toBeInTheDocument();

  const badgeOff = await render(
    <FormHarness values={{ download: { downloadPoster: true, tagBadges: false } }}>
      <AssetDownloadsSection />
    </FormHarness>,
  );
  await expect.element(badgeOff.getByText("为封面添加标签角标")).toBeVisible();
  await expect.element(badgeOff.getByText("角标类型", { exact: true })).not.toBeInTheDocument();
  await expect.element(badgeOff.getByText("角标位置", { exact: true })).not.toBeInTheDocument();
  await expect.element(badgeOff.getByText("覆盖角标图片", { exact: true })).not.toBeInTheDocument();

  const badgeOn = await render(
    <FormHarness
      values={{
        download: {
          downloadPoster: true,
          tagBadges: true,
          tagBadgeTypes: ["subtitle", "leak"],
          tagBadgePosition: "topRight",
        },
      }}
    >
      <AssetDownloadsSection />
    </FormHarness>,
  );
  await expect.element(badgeOn.getByText("角标类型", { exact: true })).toBeVisible();
  await expect.element(badgeOn.getByText("角标位置", { exact: true })).toBeVisible();
  await expect.element(badgeOn.getByText("覆盖角标图片", { exact: true })).toBeVisible();
  await expect.element(badgeOn.getByText("中字")).toBeVisible();
  await expect.element(badgeOn.getByText("流出")).toBeVisible();
});
