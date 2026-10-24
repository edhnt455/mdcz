import {
  POSTER_TAG_BADGE_IMAGE_FILENAMES,
  POSTER_TAG_BADGE_POSITION_OPTIONS,
  POSTER_TAG_BADGE_TYPE_OPTIONS,
  TAG_BADGE_FIXED_POSITIONS,
  TAG_BADGE_LAYOUTS,
  TAG_BADGE_STYLES,
  TAG_BADGE_TARGETS,
  tagBadgeSettingsSchema,
  type WatermarkPreviewResult,
} from "@mdcz/shared/posterBadges";
import { FIELD_KEYS, unflattenConfig } from "@mdcz/shared/settingsRegistry";
import { Button, Switch } from "@mdcz/ui";
import { FolderOpen, Loader2 } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { useFormContext, useWatch } from "react-hook-form";
import {
  BoolField,
  ChipArrayFieldWrapper,
  EnumField,
  NumberField,
  PathFieldWrapper,
} from "../config-form/FieldRenderer";
import { useT } from "../i18n";
import { useOptionalSettingsSearch } from "./SettingsSearchContext";
import { useSettingsNotifier, useSettingsServices } from "./SettingsServices";
import { useHasRenderableFields } from "./sectionVisibility";

export const WATERMARK_FIELD_KEYS = FIELD_KEYS.filter((key) => key.startsWith("download.tagBadge"));

export function WatermarkSettings() {
  const t = useT();
  const text = t.settings.watermark;
  const services = useSettingsServices();
  const notifier = useSettingsNotifier();
  const search = useOptionalSettingsSearch();
  const form = useFormContext();
  const visible = useHasRenderableFields(WATERMARK_FIELD_KEYS);
  const values = useWatch({ control: form.control, name: WATERMARK_FIELD_KEYS });
  const parsed = tagBadgeSettingsSchema.safeParse(
    unflattenConfig(Object.fromEntries(WATERMARK_FIELD_KEYS.map((key, index) => [key, values[index]]))).download,
  );
  const enabled = Boolean(values[WATERMARK_FIELD_KEYS.indexOf("download.tagBadges")]);
  const customImages = Boolean(values[WATERMARK_FIELD_KEYS.indexOf("download.tagBadgeImageOverrides")]);
  const [target, setTarget] = useState<(typeof TAG_BADGE_TARGETS)[number]>("poster");
  const [showAll, setShowAll] = useState(false);
  const [preview, setPreview] = useState<WatermarkPreviewResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [directoryBusy, setDirectoryBusy] = useState(false);
  const [directory, setDirectory] = useState("");
  const showAllId = useId();
  const request = parsed.success ? JSON.stringify({ settings: parsed.data, target, showAll }) : null;

  useEffect(() => {
    setPreview(null);
    setError(null);
    if (!visible || !enabled || !request) {
      setLoading(false);
      return;
    }
    let active = true;
    setLoading(true);
    const timer = setTimeout(() => {
      void services
        .previewWatermark(JSON.parse(request))
        .then((result) => {
          if (active) setPreview(result);
        })
        .catch((reason: unknown) => {
          if (active) setError(reason instanceof Error ? reason.message : String(reason));
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    }, 300);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [request, enabled, visible, services]);

  if (!visible) return null;
  const positionOptions = POSTER_TAG_BADGE_POSITION_OPTIONS.map((value) => ({
    value,
    label: t.domain.posterBadgePositions[value],
  }));
  const showSettings = enabled || Boolean(search?.hasActiveFilters);

  return (
    <>
      <BoolField name="download.tagBadges" />
      {showSettings && (
        <>
          <EnumField
            name="download.tagBadgeStyle"
            options={TAG_BADGE_STYLES.map((value) => ({ value, label: text.styles[value] }))}
          />
          <EnumField
            name="download.tagBadgeResolutionStyle"
            options={TAG_BADGE_STYLES.map((value) => ({ value, label: text.styles[value] }))}
          />
          <ChipArrayFieldWrapper
            name="download.tagBadgeTargets"
            options={TAG_BADGE_TARGETS.map((value) => ({ value, label: text.targets[value] }))}
            showBulkActions
          />
          <ChipArrayFieldWrapper
            name="download.tagBadgeTypes"
            options={POSTER_TAG_BADGE_TYPE_OPTIONS.map((value) => ({ value, label: t.domain.posterBadgeTypes[value] }))}
            showBulkActions
          />
          <BoolField name="download.tagBadgeImageOverrides" />
          {(customImages || search?.hasActiveFilters) && (
            <>
              <PathFieldWrapper name="download.tagBadgeDirectory" isDirectory />
              <details className="rounded-xl border border-border/50 px-4 py-3 text-sm">
                <summary className="cursor-pointer font-medium">{text.customHelp}</summary>
                <p className="mt-3 text-muted-foreground">{text.customHint}</p>
                <div className="mt-2 grid gap-1 font-mono text-xs sm:grid-cols-2">
                  {POSTER_TAG_BADGE_TYPE_OPTIONS.map((type) => (
                    <div key={type}>
                      {t.domain.posterBadgeTypes[type]}: {POSTER_TAG_BADGE_IMAGE_FILENAMES[type][0]}.png
                    </div>
                  ))}
                </div>
                <Button
                  type="button"
                  className="mt-3"
                  variant="outline"
                  disabled={directoryBusy}
                  onClick={async () => {
                    setDirectoryBusy(true);
                    try {
                      const result = await services.ensureWatermarkDirectory();
                      setDirectory(result.path);
                      const opened = await services.openWatermarkDirectory();
                      if (opened?.message) notifier.info(opened.message);
                    } catch (reason) {
                      notifier.error(reason instanceof Error ? reason.message : String(reason));
                    } finally {
                      setDirectoryBusy(false);
                    }
                  }}
                >
                  <FolderOpen className="h-4 w-4" />
                  {text.defaultDirectory}
                </Button>
                {directory && <p className="mt-2 break-all font-mono text-xs">{directory}</p>}
              </details>
            </>
          )}
          <EnumField
            name="download.tagBadgeLayout"
            options={TAG_BADGE_LAYOUTS.map((value) => ({ value, label: text.layouts[value] }))}
          />
          <EnumField name="download.tagBadgePosition" options={positionOptions} />
          <NumberField name="download.tagBadgeScale" min={2} max={100} step={0.5} />
          <NumberField name="download.tagBadgeOffsetX" min={0} max={10000} />
          <NumberField name="download.tagBadgeOffsetY" min={0} max={10000} />
          <NumberField name="download.tagBadgeGap" min={0} max={10000} />
          <div className="grid gap-6 pt-4 lg:grid-cols-2">
            <div>
              <h4 className="mb-2 text-sm font-medium">{text.fixedPositions}</h4>
              <p className="mb-3 text-xs text-muted-foreground">{text.fixedHint}</p>
              {POSTER_TAG_BADGE_TYPE_OPTIONS.map((type) => (
                <EnumField
                  key={type}
                  name={`download.tagBadgePositions.${type}`}
                  options={TAG_BADGE_FIXED_POSITIONS.map((value) => ({
                    value,
                    label: value === "auto" ? text.auto : t.domain.posterBadgePositions[value],
                  }))}
                />
              ))}
            </div>
            {enabled && (
              <section aria-label={text.preview} className="space-y-3">
                <h4 className="text-sm font-medium">{text.preview}</h4>
                <fieldset className="flex flex-wrap gap-2" aria-label={text.previewTarget}>
                  {TAG_BADGE_TARGETS.map((value) => (
                    <Button
                      key={value}
                      type="button"
                      size="sm"
                      variant={target === value ? "default" : "outline"}
                      aria-pressed={target === value}
                      onClick={() => setTarget(value)}
                    >
                      {text.targets[value]}
                    </Button>
                  ))}
                </fieldset>
                <div
                  className="relative mx-auto flex w-full max-w-[320px] items-center justify-center overflow-hidden rounded-lg border bg-muted/20"
                  style={{ aspectRatio: target === "poster" ? "2 / 3" : "16 / 9" }}
                  aria-busy={loading}
                >
                  {preview && <img src={preview.dataUrl} alt={text.preview} className="h-full w-full object-contain" />}
                  {loading && (
                    <span role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      {text.loading}
                    </span>
                  )}
                  {!loading && !preview && !error && (
                    <p className="p-4 text-center text-xs text-muted-foreground">{text.invalid}</p>
                  )}
                  {error && (
                    <p role="alert" className="p-4 text-center text-xs text-destructive">
                      {text.failed}: {error}
                    </p>
                  )}
                </div>
                <div className="flex items-center justify-center gap-2">
                  <Switch id={showAllId} checked={showAll} onCheckedChange={setShowAll} />
                  <label htmlFor={showAllId} className="text-xs">
                    {text.showAll}
                  </label>
                </div>
                <p className="text-xs leading-5 text-muted-foreground">{text.previewHint}</p>
                {preview?.warnings.map((warning) => (
                  <p key={warning} role="status" className="text-xs text-amber-600">
                    {warning}
                  </p>
                ))}
              </section>
            )}
          </div>
        </>
      )}
    </>
  );
}
