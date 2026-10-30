import { normalizeActorName } from "@mdcz/shared/actorAliases";
import {
  type Configuration,
  configurationSchema,
  defaultConfiguration,
  NFO_FIELD_OPTIONS,
  NOTIFICATION_CHANNELS,
  notificationsSchema,
  TRANSLATION_FIELD_OPTIONS,
} from "@mdcz/shared/config";
import { TRANSLATION_TARGET_OPTIONS } from "@mdcz/shared/enums";
import { toErrorMessage } from "@mdcz/shared/error";

import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  FormControl,
  Input,
  Label,
  Switch,
  Textarea,
} from "@mdcz/ui";
import { CircleHelp, Loader2, X } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import type { FieldValues } from "react-hook-form";
import { useFormContext, useWatch } from "react-hook-form";
import {
  BaseField,
  BoolField,
  ChipArrayFieldWrapper,
  DurationFieldWrapper,
  EnumField,
  NumberField,
  PathArrayFieldWrapper,
  PathFieldWrapper,
  PromptFieldWrapper,
  SecretField,
  TextField,
  UrlField,
} from "../config-form/FieldRenderer";
import { useT } from "../i18n";
import { AggregationPriorityEditorField } from "./AggregationPriorityEditorField";
import { useOptionalSettingsSearch } from "./SettingsSearchContext";
import { useSettingsSectionMode } from "./SettingsSectionModeContext";
import { type SettingsIntegrationServices, useSettingsNotifier, useSettingsServices } from "./SettingsServices";
import { useHasRenderableFields } from "./sectionVisibility";
import { AGGREGATION_PRIORITY_KEYS, isRecord } from "./settingsRegistry";
import { WATERMARK_FIELD_KEYS, WatermarkSettings } from "./WatermarkSettings";

// ── Constants ──

const PROXY_TYPE_OPTIONS = ["none", "http", "https", "socks5"];
const LANGUAGE_OPTIONS = [...TRANSLATION_TARGET_OPTIONS];
const toEnumOptions = (labels: Record<string, string>): Array<{ value: string; label: string }> =>
  Object.entries(labels).map(([value, label]) => ({ value, label }));

const ASSET_DOWNLOAD_FIELD_KEYS = [
  "download.downloadThumb",
  "download.downloadPoster",
  ...WATERMARK_FIELD_KEYS,
  "download.downloadFanart",
  "download.downloadSceneImages",
  "download.downloadTrailer",
  "download.keepThumb",
  "download.keepPoster",
  "download.keepFanart",
  "download.keepSceneImages",
  "download.keepTrailer",
  "download.sceneImageConcurrency",
] as const;

const NAMING_SECTION_FIELD_KEYS = [
  "naming.assetNamingMode",
  "naming.nfoTitleTemplate",
  "naming.actorNameMax",
  "naming.actorNameMore",
  "naming.actorFallbackToStudio",
  "personSync.actorAliases",
  "naming.releaseRule",
  "naming.folderNameMax",
  "naming.fileNameMax",
  "naming.cnwordStyle",
  "naming.umrStyle",
  "naming.leakStyle",
  "naming.uncensoredStyle",
  "naming.censoredStyle",
  "naming.partStyle",
  "titleRepair.enabled",
] as const;

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string");
}

function toSiteOptions(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const outputs: string[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      outputs.push(item);
      continue;
    }
    if (isRecord(item) && typeof item.site === "string") {
      outputs.push(item.site);
    }
  }
  return outputs;
}

function shouldMountConditionalSettings(
  normalVisible: boolean,
  search: ReturnType<typeof useOptionalSettingsSearch>,
): boolean {
  return normalVisible || Boolean(search?.hasActiveFilters);
}

export function useCrawlerSiteOptions(flatDefaults: Record<string, unknown>): string[] {
  const services = useSettingsServices();
  const [sites, setSites] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;

    services
      .listCrawlerSites()
      .then((result) => {
        if (!cancelled) {
          setSites(toSiteOptions(result.sites));
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSites([]);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [services]);

  return useMemo(() => {
    const fromConfig = toStringArray(flatDefaults["scrape.sites"]);
    return Array.from(new Set([...sites, ...fromConfig]));
  }, [sites, flatDefaults]);
}

// ── Section renderers ──

export function PathsSection() {
  return (
    <>
      <PathArrayFieldWrapper name="paths.defaultScanExcludeDirs" />
      <PathFieldWrapper name="paths.actorPhotoFolder" isDirectory />
      <TextField name="paths.sceneImagesFolder" />
      <PathFieldWrapper name="paths.configDirectory" isDirectory />
    </>
  );
}

export function ScrapePacingSection() {
  return (
    <>
      <NumberField name="scrape.threadNumber" min={1} max={128} />
      <NumberField name="scrape.javdbDelaySeconds" min={0} max={120} />
      <NumberField name="scrape.restAfterCount" min={1} max={500} />
      <DurationFieldWrapper name="scrape.restDuration" />
    </>
  );
}
export function FilenameFilteringSection() {
  return (
    <>
      <BoolField name="scrape.aiNumberFallback" />
      <ChipArrayFieldWrapper name="scrape.filenameIgnoreTokens" />
      <ChipArrayFieldWrapper name="scrape.filenameBlacklistTokens" />
      <NumberField name="scrape.minVideoSizeMb" min={0} max={10240} />
      <ChipArrayFieldWrapper name="scrape.subtitleKeywords" />
      <ChipArrayFieldWrapper name="scrape.umrKeywords" />
      <ChipArrayFieldWrapper name="scrape.uncensoredKeywords" />
      <ChipArrayFieldWrapper name="scrape.leakKeywords" />
    </>
  );
}

export function NetworkConnectionSection() {
  return (
    <>
      <EnumField name="network.proxyType" options={PROXY_TYPE_OPTIONS} />
      <TextField name="network.proxy" />
      <BoolField name="network.useProxy" />
      <NumberField name="network.timeout" min={1} max={300} />
      <NumberField name="network.retryCount" min={0} max={10} />
    </>
  );
}

export function AssetDownloadsSection() {
  const hasRenderableFields = useHasRenderableFields(ASSET_DOWNLOAD_FIELD_KEYS);
  const search = useOptionalSettingsSearch();
  const form = useFormContext<FieldValues>();
  const [downloadThumb, downloadPoster, downloadFanart, downloadSceneImages, downloadTrailer] = form.watch([
    "download.downloadThumb",
    "download.downloadPoster",
    "download.downloadFanart",
    "download.downloadSceneImages",
    "download.downloadTrailer",
  ]) as [boolean | undefined, boolean | undefined, boolean | undefined, boolean | undefined, boolean | undefined];

  if (!hasRenderableFields) {
    return null;
  }

  return (
    <>
      <BoolField name="download.downloadThumb" />
      <BoolField name="download.downloadPoster" />
      <WatermarkSettings />
      <BoolField name="download.downloadFanart" />
      <BoolField name="download.downloadSceneImages" />
      <BoolField name="download.downloadTrailer" />
      {shouldMountConditionalSettings(Boolean(downloadThumb), search) && <BoolField name="download.keepThumb" />}
      {shouldMountConditionalSettings(Boolean(downloadPoster), search) && <BoolField name="download.keepPoster" />}
      {shouldMountConditionalSettings(Boolean(downloadFanart), search) && <BoolField name="download.keepFanart" />}
      {shouldMountConditionalSettings(Boolean(downloadSceneImages), search) && (
        <BoolField name="download.keepSceneImages" />
      )}
      {shouldMountConditionalSettings(Boolean(downloadTrailer), search) && <BoolField name="download.keepTrailer" />}
      <NumberField name="download.sceneImageConcurrency" min={1} max={20} />
    </>
  );
}

export function NfoSection() {
  const t = useT();
  const search = useOptionalSettingsSearch();
  const form = useFormContext<FieldValues>();
  const generateNfo = Boolean(form.watch("download.generateNfo"));

  return (
    <>
      <BoolField name="download.generateNfo" />
      {shouldMountConditionalSettings(generateNfo, search) && (
        <>
          <EnumField name="download.nfoNaming" options={toEnumOptions(t.settings.options.nfoNaming)} />
          <ChipArrayFieldWrapper
            name="download.nfoIgnoreFields"
            options={NFO_FIELD_OPTIONS.map((value) => ({
              value,
              label: t.settings.nfoFieldOption(value, t.settings.nfoFields[value]),
            }))}
            showBulkActions
          />
        </>
      )}
    </>
  );
}

function TitleRepairSection() {
  return (
    <>
      <BoolField name="titleRepair.enabled" />
      <BoolField name="titleRepair.stripTrailingActors" />
    </>
  );
}

type NamingTemplateHelpKind = "folder" | "file";

export function NamingTemplateHelp({ kind }: { kind: NamingTemplateHelpKind }) {
  const t = useT();
  const help = t.settings.namingTemplateHelp;
  const label = help[kind];

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="text-muted-foreground hover:text-foreground"
          aria-label={help.viewPlaceholders(label)}
        >
          <CircleHelp className="h-3.5 w-3.5" />
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-3xl gap-5 rounded-[var(--radius-quiet-xl)] border border-border/50 bg-surface-floating p-6">
        <DialogHeader className="gap-2 text-left">
          <DialogTitle>{help.placeholdersTitle(label)}</DialogTitle>
        </DialogHeader>
        <div className="max-h-[60vh] space-y-4 overflow-y-auto pr-1 text-sm">
          <div className="overflow-hidden rounded-xl border border-border/50">
            <table className="w-full text-left text-xs">
              <thead className="bg-surface-low text-muted-foreground">
                <tr>
                  <th className="w-[220px] px-3 py-2 font-medium">{help.placeholder}</th>
                  <th className="px-3 py-2 font-medium">{help.description}</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(help.placeholders).map(([placeholder, description]) => (
                  <tr key={placeholder} className="border-t border-border/40">
                    <td className="px-3 py-2 align-top font-mono text-[11px] text-foreground">{placeholder}</td>
                    <td className="px-3 py-2 align-top leading-5 text-muted-foreground">{description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="rounded-xl border border-border/50 bg-surface-low px-3 py-2.5">
            <div className="font-numeric text-xs font-bold text-foreground">{help.notesTitle(label)}</div>
            <ul className="mt-2 space-y-1.5 text-xs leading-5 text-muted-foreground">
              {help.notes[kind].map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          </div>
        </div>
        <DialogFooter className="gap-2">
          <DialogClose asChild>
            <Button type="button">{t.settings.gotIt}</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function NamingSection() {
  const t = useT();
  const sectionMode = useSettingsSectionMode();
  const hasRenderableFields = useHasRenderableFields(NAMING_SECTION_FIELD_KEYS);

  if (!hasRenderableFields) {
    return null;
  }

  return (
    <>
      {sectionMode === "public" && (
        <div className="rounded-md border border-border/70 bg-muted/50 p-3 text-xs text-muted-foreground">
          {t.settings.templatesMovedNotice}
        </div>
      )}
      <EnumField name="naming.assetNamingMode" options={toEnumOptions(t.settings.options.assetNaming)} />
      <TextField name="naming.nfoTitleTemplate" />
      <TitleRepairSection />
      <NumberField name="naming.actorNameMax" min={1} max={20} />
      <TextField name="naming.actorNameMore" />
      <BoolField name="naming.actorFallbackToStudio" />
      <ActorAliasesField />
      <TextField name="naming.releaseRule" />
      <EnumField name="naming.partStyle" options={toEnumOptions(t.settings.options.partStyle)} />
      <NumberField name="naming.folderNameMax" min={10} max={255} />
      <NumberField name="naming.fileNameMax" min={10} max={255} />
      <TextField name="naming.cnwordStyle" />
      <TextField name="naming.umrStyle" />
      <TextField name="naming.leakStyle" />
      <TextField name="naming.uncensoredStyle" />
      <TextField name="naming.censoredStyle" />
    </>
  );
}

export function TranslateSection() {
  const t = useT();
  const services = useSettingsServices();
  const notifier = useSettingsNotifier();
  const [testing, setTesting] = useState(false);
  const form = useFormContext<FieldValues>();
  const search = useOptionalSettingsSearch();
  const engine = useWatch({ control: form.control, name: "translate.engine" });
  const serviceType = useWatch({ control: form.control, name: "translate.llmServiceType" });
  const baiduService = useWatch({ control: form.control, name: "translate.baiduService" });
  const isLLM = engine === "openai";
  const aiNumberFallback = useWatch({ control: form.control, name: "scrape.aiNumberFallback" });

  const handleTestTranslation = async () => {
    const input = {
      engine,
      targetLanguage: form.getValues("translate.targetLanguage"),
      deeplApiKey: String(form.getValues("translate.deeplApiKey") ?? ""),
      baiduService: form.getValues("translate.baiduService") ?? "general",
      baiduAppId: String(form.getValues("translate.baiduAppId") ?? ""),
      baiduSecretKey: String(form.getValues("translate.baiduSecretKey") ?? ""),
      baiduApiKey: String(form.getValues("translate.baiduApiKey") ?? ""),
      llmModelName: String(form.getValues("translate.llmModelName") ?? ""),
      llmApiKey: String(form.getValues("translate.llmApiKey") ?? ""),
      llmBaseUrl: String(form.getValues("translate.llmBaseUrl") ?? ""),
      llmApiFormat: form.getValues("translate.llmApiFormat") ?? "responses",
      llmServiceType: form.getValues("translate.llmServiceType") ?? "openai-compatible",
      llmSystemPrompt: String(form.getValues("translate.llmSystemPrompt") ?? ""),
      llmPrompt: String(form.getValues("translate.llmPrompt") ?? ""),
      llmTemperature: form.getValues("translate.llmTemperature"),
      llmReasoning: form.getValues("translate.llmReasoning") ?? "default",
      llmOutputFormat: form.getValues("translate.llmOutputFormat") ?? "none",
      llmTimeout: Number(form.getValues("translate.llmTimeout") ?? 120),
      llmMaxRetries: Number(form.getValues("translate.llmMaxRetries") ?? 3),
      llmMaxRequestsPerSecond: Number(form.getValues("translate.llmMaxRequestsPerSecond") ?? 1),
    };

    setTesting(true);
    try {
      const result = await services.testTranslation(input);
      const text = t.settings.translationTest;
      if (result.status === "ok") notifier.success(text.ok(result.sample ?? ""));
      else if (result.status === "failed") notifier.error(`${text.failed}: ${result.error}`);
      else notifier.error(text[result.status]);
    } catch (error) {
      notifier.error(t.settings.testFailed(error instanceof Error ? error.message : t.common.unknownError));
    } finally {
      setTesting(false);
    }
  };

  return (
    <>
      <BaseField name="translate.enableTranslation">
        {(field) => (
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              onClick={handleTestTranslation}
              disabled={testing}
            >
              {testing ? (
                <>
                  <Loader2 className="h-3 w-3 mr-1 animate-spin" /> {t.settings.verifying}
                </>
              ) : (
                t.settings.verifyTranslation
              )}
            </Button>
            <FormControl>
              <Switch checked={Boolean(field.value)} onCheckedChange={field.onChange} />
            </FormControl>
          </div>
        )}
      </BaseField>
      <ChipArrayFieldWrapper
        name="translate.fields"
        options={TRANSLATION_FIELD_OPTIONS.map((value) => ({ value, label: t.settings.translateFields[value] }))}
      />
      <EnumField name="translate.engine" options={toEnumOptions(t.settings.options.translateEngine)} />
      {shouldMountConditionalSettings(engine === "deepl", search) && <SecretField name="translate.deeplApiKey" />}
      {shouldMountConditionalSettings(engine === "baidu", search) && (
        <>
          <EnumField name="translate.baiduService" options={toEnumOptions(t.settings.options.baiduService)} />
          <TextField name="translate.baiduAppId" />
          {shouldMountConditionalSettings(baiduService !== "llm", search) && (
            <SecretField name="translate.baiduSecretKey" />
          )}
          {shouldMountConditionalSettings(baiduService === "llm", search) && (
            <SecretField name="translate.baiduApiKey" />
          )}
        </>
      )}
      {shouldMountConditionalSettings(isLLM || aiNumberFallback, search) && (
        <>
          <TextField name="translate.llmModelName" />
          <SecretField name="translate.llmApiKey" />
          <UrlField name="translate.llmBaseUrl" />
          {serviceType === "openai-compatible" && (
            <EnumField name="translate.llmApiFormat" options={toEnumOptions(t.settings.options.llmApiFormat)} />
          )}
          <EnumField name="translate.llmServiceType" options={toEnumOptions(t.settings.options.llmServiceType)} />
          <PromptFieldWrapper name="translate.llmSystemPrompt" />
          <PromptFieldWrapper name="translate.llmPrompt" />
          <PromptFieldWrapper name="translate.llmNumberRecognitionPrompt" />
          <NumberField name="translate.llmTemperature" min={0} max={2} step={0.1} optional />
          <EnumField
            name="translate.llmReasoning"
            description={
              t.settingsFields.llmReasoningDescription[
                serviceType === "google" || serviceType === "deepseek"
                  ? (serviceType as "google" | "deepseek")
                  : "default"
              ]
            }
            options={toEnumOptions(
              serviceType === "deepseek" ? t.settings.options.llmReasoningDeepseek : t.settings.options.llmReasoning,
            )}
          />
          <EnumField
            name="translate.llmOutputFormat"
            options={toEnumOptions(t.settings.options.llmOutputFormat).filter(
              (option) => serviceType !== "deepseek" || option.value !== "json_schema",
            )}
          />
          <NumberField name="translate.llmTimeout" min={1} max={300} />
          <NumberField name="translate.llmMaxRetries" min={1} max={20} />
          <NumberField name="translate.llmMaxRequestsPerSecond" min={1} max={100} />
        </>
      )}
      <EnumField name="translate.targetLanguage" options={LANGUAGE_OPTIONS} />
      <NumberField name="translate.untranslatedJapaneseRunLength" min={1} />
    </>
  );
}

export function AggregationScrapeSection() {
  return (
    <>
      <NumberField name="aggregation.maxParallelCrawlers" min={1} max={10} />
      <NumberField name="aggregation.perCrawlerTimeoutMs" min={5000} max={120000} step={1000} />
      <NumberField name="aggregation.globalTimeoutMs" min={10000} max={300000} step={1000} />
    </>
  );
}

export function AggregationBehaviorSection() {
  return (
    <>
      <NumberField name="aggregation.behavior.maxSceneImages" min={0} max={100} />
      <NumberField name="aggregation.behavior.maxActors" min={1} max={100} />
      <NumberField name="aggregation.behavior.maxGenres" min={1} max={100} />
    </>
  );
}

export function AggregationPrioritySection({ siteOptions }: { siteOptions: string[] }) {
  return (
    <>
      {AGGREGATION_PRIORITY_KEYS.map((key) => (
        <AggregationPriorityEditorField key={key} name={key} options={siteOptions} />
      ))}
    </>
  );
}

export function NotificationsSection() {
  const t = useT();
  const services = useSettingsServices();
  const notifier = useSettingsNotifier();
  const form = useFormContext<FieldValues>();
  const [testing, setTesting] = useState(false);

  const integrations = services.integrations;
  const handleTestNotification = async ({ testNotification }: SettingsIntegrationServices) => {
    const settings = Object.fromEntries(
      Object.keys(notificationsSchema.shape).map((key) => [key, form.getValues(`notifications.${key}`)]),
    ) as Configuration["notifications"];
    setTesting(true);
    try {
      await testNotification(settings);
      notifier.success(t.settings.integrations.testSent);
    } catch (error) {
      notifier.error(t.settings.testFailed(toErrorMessage(error)));
    } finally {
      setTesting(false);
    }
  };

  return (
    <>
      <UrlField name="notifications.webhookUrl" />
      <SecretField name="notifications.webhookSecret" />
      <ChipArrayFieldWrapper
        name="notifications.channels"
        options={NOTIFICATION_CHANNELS.map((value) => ({ value, label: t.settings.notificationChannels[value] }))}
      />
      <SecretField name="notifications.telegramBotToken" />
      <TextField name="notifications.telegramChatId" />
      <UrlField name="notifications.barkUrl" placeholder="https://api.day.app/..." />
      <UrlField name="notifications.ntfyUrl" placeholder="https://ntfy.sh/..." />
      <SecretField name="notifications.ntfyToken" />
      {integrations ? (
        <div className="flex justify-end py-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            disabled={testing}
            onClick={() => void handleTestNotification(integrations)}
          >
            {testing ? (
              <>
                <Loader2 className="mr-1 h-3 w-3 animate-spin" /> {t.settings.integrations.sendingTest}
              </>
            ) : (
              t.settings.integrations.sendTest
            )}
          </Button>
        </div>
      ) : null}
      <BoolField name="notifications.dailyDigest" />
      <NumberField name="notifications.digestHour" min={0} max={23} />
    </>
  );
}

/** qBittorrent polling; the status line shows whether the settings as saved actually work. */
export function QbittorrentSection({ status }: { status: ReactNode }) {
  return (
    <>
      <UrlField name="automation.qbittorrent.url" placeholder="http://qbittorrent:8080" />
      <SecretField name="automation.qbittorrent.apiKey" />
      <TextField name="automation.qbittorrent.username" />
      <SecretField name="automation.qbittorrent.password" />
      <TextField name="automation.qbittorrent.category" />
      {status}
    </>
  );
}

function ActorAliasesField() {
  const t = useT();
  const [draft, setDraft] = useState<{ original?: string; name: string; aliases: string; snapshot: string } | null>(
    null,
  );
  const [error, setError] = useState("");
  return (
    <BaseField name="personSync.actorAliases" layout="vertical" commitMode="immediate">
      {(field) => {
        const groups = isRecord(field.value) ? (field.value as Record<string, string[]>) : {};
        const open = (name?: string) => {
          setError("");
          setDraft({
            original: name,
            name: name ?? "",
            aliases: name ? groups[name].join("\n") : "",
            snapshot: JSON.stringify(groups),
          });
        };
        const save = () => {
          if (!draft) return;
          if (draft.snapshot !== JSON.stringify(groups)) {
            setError(t.settings.actorAliases.changed);
            return;
          }
          const name = draft.name.trim();
          if (!name) {
            setError(t.settings.configValidation.issues.actorCanonicalNameEmpty ?? "actorCanonicalNameEmpty");
            return;
          }
          if (
            Object.keys(groups).some(
              (key) => key !== draft.original && normalizeActorName(key) === normalizeActorName(name),
            )
          ) {
            setError(t.settings.actorAliases.nameConflict);
            return;
          }
          const aliases = draft.aliases
            .split(/[,，\r\n]+/u)
            .map((alias) => alias.trim())
            .filter(Boolean);
          const next = Object.fromEntries([
            ...Object.entries(groups).filter(([key]) => key !== draft.original),
            [name, aliases],
          ]);
          const result = configurationSchema.safeParse({
            ...defaultConfiguration,
            personSync: { ...defaultConfiguration.personSync, actorAliases: next },
          });
          if (!result.success) {
            const issue = result.error.issues[0].message;
            setError(
              t.settings.configValidation.issues[issue as keyof typeof t.settings.configValidation.issues] ?? issue,
            );
            return;
          }
          field.onChange(result.data.personSync.actorAliases);
          setDraft(null);
        };
        return (
          <div className="space-y-2">
            {Object.entries(groups).length === 0 ? (
              <p className="text-xs text-muted-foreground">{t.settings.actorAliases.empty}</p>
            ) : null}
            {Object.entries(groups).map(([name, aliases]) => (
              <div key={name} className="flex flex-wrap items-center gap-2 rounded-md border p-3 text-sm">
                <div className="min-w-0 flex-1">
                  <strong>{name}</strong>
                  <p className="break-words text-xs text-muted-foreground">{aliases.join(" / ")}</p>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={`${t.settings.actorAliases.edit} ${name}`}
                  onClick={() => open(name)}
                >
                  {t.settings.actorAliases.edit}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={`${t.settings.actorAliases.remove} ${name}`}
                  onClick={() =>
                    field.onChange(Object.fromEntries(Object.entries(groups).filter(([key]) => key !== name)))
                  }
                >
                  {t.settings.actorAliases.remove}
                </Button>
              </div>
            ))}
            <Button type="button" variant="outline" size="sm" onClick={() => open()}>
              {t.settings.actorAliases.add}
            </Button>
            <Dialog
              open={draft !== null}
              onOpenChange={(open) => {
                if (!open) setDraft(null);
              }}
            >
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>
                    {draft?.original ? t.settings.actorAliases.edit : t.settings.actorAliases.add}
                  </DialogTitle>
                </DialogHeader>
                <div className="space-y-3">
                  <Label htmlFor="actor-alias-name">{t.settings.actorAliases.name}</Label>
                  <Input
                    id="actor-alias-name"
                    value={draft?.name ?? ""}
                    onChange={(event) => {
                      setError("");
                      setDraft((current) => current && { ...current, name: event.target.value });
                    }}
                  />
                  <Label htmlFor="actor-alias-values">{t.settings.actorAliases.aliases}</Label>
                  <Textarea
                    id="actor-alias-values"
                    value={draft?.aliases ?? ""}
                    onChange={(event) => {
                      setError("");
                      setDraft((current) => current && { ...current, aliases: event.target.value });
                    }}
                  />
                  <p className="text-xs text-muted-foreground">{t.settings.actorAliases.aliasesHint}</p>
                  {error ? (
                    <p role="alert" className="text-xs text-destructive">
                      {error}
                    </p>
                  ) : null}
                </div>
                <DialogFooter>
                  <Button type="button" variant="outline" onClick={() => setDraft(null)}>
                    {t.common.cancel}
                  </Button>
                  <Button type="button" onClick={save}>
                    {t.common.save}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>
        );
      }}
    </BaseField>
  );
}

export function PathMappingsField() {
  const t = useT();
  return (
    <BaseField name="automation.pathMappings" layout="vertical" commitMode="debounce">
      {(field) => {
        const mappings = Array.isArray(field.value) ? (field.value as Array<{ from: string; to: string }>) : [];
        const update = (next: Array<{ from: string; to: string }>) => field.onChange(next);
        return (
          <div className="space-y-2">
            {mappings.map((mapping, index) => (
              <div key={index} className="flex items-center gap-2">
                <Input
                  aria-label={t.settings.pathMappings.from}
                  placeholder={t.settings.pathMappings.fromPlaceholder}
                  value={mapping.from}
                  onChange={(event) =>
                    update(mappings.map((row, at) => (at === index ? { ...row, from: event.target.value } : row)))
                  }
                />
                <span className="text-muted-foreground">→</span>
                <Input
                  aria-label={t.settings.pathMappings.to}
                  placeholder={t.settings.pathMappings.toPlaceholder}
                  value={mapping.to}
                  onChange={(event) =>
                    update(mappings.map((row, at) => (at === index ? { ...row, to: event.target.value } : row)))
                  }
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={t.settings.pathMappings.remove}
                  onClick={() => update(mappings.filter((_row, at) => at !== index))}
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => update([...mappings, { from: "", to: "" }])}
            >
              {t.settings.pathMappings.add}
            </Button>
          </div>
        );
      }}
    </BaseField>
  );
}
